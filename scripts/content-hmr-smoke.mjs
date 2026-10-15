#!/usr/bin/env node
// Independent public-API browser acceptance. No runtime registry or plugin
// implementation internals are inspected by this probe.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, build } from 'vite'
import { chromium } from 'playwright-core'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parameters = process.argv.slice(2)
const flag = name => {
  const index = parameters.indexOf(name)
  return index < 0 ? undefined : parameters[index + 1]
}
const chrome = flag('--chrome') ?? process.env.CHROME_PATH
assert.ok(chrome, 'Pass --chrome <Chrome for Testing>')
const evidenceDir = path.resolve(flag('--evidence') ?? 'output/playwright/content-hmr')
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'content-hmr-verifier-')))
const fixture = path.join(temporary, 'fixture')
const report = { status: 'FAIL', startedAt: new Date().toISOString(), checks: [], errors: [], contexts: [], fixture }
let server
let context
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const write = async (name, text) => {
  const filename = path.join(fixture, name)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, text)
}
async function until(operation, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      const value = await operation()
      if (value) return value
    } catch (error) { last = error }
    await pause(100)
  }
  throw new Error(`${description} timed out${last ? `: ${last.message}` : ''}`)
}
async function tree(directory) {
  const entries = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) {
      for (const [name, digest] of await tree(path.join(directory, item.name))) entries.push([`${item.name}/${name}`, digest])
    } else entries.push([item.name, createHash('sha256').update(await readFile(path.join(directory, item.name))).digest('hex')])
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}
async function productionBuild(outDir) {
  await build({ root: fixture, configFile: path.join(fixture, 'vite.config.mjs'), logLevel: 'warn', build: { outDir } })
  report.checks.push({ name: `production build ${outDir}`, status: 'PASS', root: fixture, outDir })
}
const pass = (name, details = {}) => {
  report.checks.push({ name, status: 'PASS', ...details })
  console.log(`PASS ${name}`)
}
function entry(world, revision) {
  return `import { defineContentScript } from '@vite-react-chrome-extension/plugin/client'
import { dependency } from './${world}-dependency'
import { shared } from '../../shared'
import './${world}.css'
const world = ${JSON.stringify(world)}
const revision = ${revision}
globalThis['__contentVerifier_' + world] = { revision, dependency, shared }
void defineContentScript('verifier-' + world, ({data, onDispose, signal}) => {
  const root = globalThis.document.createElement('section')
  root.id = 'verifier-' + world
  root.dataset.revision = String(revision)
  root.dataset.dependency = dependency
  root.dataset.shared = shared
  const input = globalThis.document.createElement('input')
  input.value = String(data.input ?? '')
  input.setAttribute('aria-label', world + ' draft')
  const button = globalThis.document.createElement('button')
  button.textContent = world + ' action'
  const counter = globalThis.document.createElement('output')
  counter.textContent = '0'
  root.append(input, button, counter)
  globalThis.document.body.append(root)
  const key = world + '-' + revision + '-' + dependency
  const counts = () => JSON.parse(globalThis.document.documentElement.dataset.timers || '{}')
  const timer = setInterval(() => {
    const value = counts()
    value[key] = (value[key] || 0) + 1
    globalThis.document.documentElement.dataset.timers = JSON.stringify(value)
  }, 40)
  const action = () => { counter.textContent = String(Number(counter.textContent) + 1) }
  button.addEventListener('click', action, {signal})
  globalThis.document.addEventListener('verifier-probe-' + world, () => {
    const key = 'responses' + world
    globalThis.document.documentElement.dataset[key] = String(Number(globalThis.document.documentElement.dataset[key] || '0') + 1)
  }, {signal})
  globalThis.document.documentElement.dataset['mounts' + world] = String(Number(globalThis.document.documentElement.dataset['mounts' + world] || '0') + 1)
  onDispose(previous => { previous.input = input.value })
  return () => { clearInterval(timer); root.remove() }
})
`
}
const configure = async (version = '1.0.0', explicit = false) => write('vite.config.mjs', `
import chromeExtension, { defineBackground } from '@vite-react-chrome-extension/plugin'
export default {
  base: './',
  plugins: [chromeExtension({
    tailwind: false,
    contentScripts: { hmr: true },
    background: defineBackground('modules/background/background.ts'),
    manifest: {
      name: 'Content HMR independent verifier', version: '${version}',
      ${explicit ? "permissions: ['scripting'], host_permissions: ['https://example.com/*']," : ''}
      content_scripts: [
        { matches: ['http://127.0.0.1/*'], exclude_matches: ['http://127.0.0.1/nonmatching/*'], js: ['modules/content/isolated.ts'], world: 'ISOLATED' },
        { matches: ['http://127.0.0.1/*'], exclude_matches: ['http://127.0.0.1/nonmatching/*'], js: ['modules/content/main.ts'], world: 'MAIN' }
      ]
    }
  })]
}`)
async function start(port = 0) {
  server = await createServer({
    root: fixture, configFile: path.join(fixture, 'vite.config.mjs'),
    clearScreen: false, logLevel: 'warn', server: { host: '127.0.0.1', port, strictPort: Boolean(port) },
    plugins: [{
      name: 'verifier-host-csp',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/matching/') && !request.url?.startsWith('/nonmatching/')) return next()
          if (request.url.includes('strict')) response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'")
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><title>Host HMR acceptance</title><body><h1>Host state survives</h1><input id="host-input" aria-label="Host draft"></body>')
        })
      },
    }],
  })
  await server.listen()
  const address = server.httpServer.address()
  return `http://127.0.0.1:${address.port}`
}
try {
  await mkdir(evidenceDir, { recursive: true })
  await mkdir(fixture)
  await symlink(path.join(repository, 'node_modules'), path.join(fixture, 'node_modules'))
  await write('package.json', '{"type":"module","private":true}')
  await configure()
  await write('shared.ts', 'export const shared = "shared-zero"')
  await write('modules/background/background.ts', `import { shared } from '../../shared'; globalThis.__workerBoot = crypto.randomUUID(); globalThis.__workerShared = shared; chrome.runtime.onMessage.addListener((message, _sender, reply) => { if(message === 'verifier') reply({boot:globalThis.__workerBoot, shared}) })`)
  await write('modules/popup/index.html', '<!doctype html><title>Popup</title><body><p id="boot"></p><script type="module" src="./index.ts"></script></body>')
  await write('modules/popup/index.ts', `globalThis.document.querySelector('#boot').textContent = crypto.randomUUID()`)
  for (const world of ['isolated', 'main']) {
    await write(`modules/content/${world}.ts`, entry(world, 0))
    await write(`modules/content/${world}-dependency.ts`, 'export const dependency = "dep-zero"')
    await write(`modules/content/${world}.css`, `#verifier-${world} { color: rgb(1, 2, 3); border-top: 7px solid; }`)
  }
  const origin = await start()
  const status = async () => (await fetch(`${origin}/__chrome_extension_dev_status__`)).json()
  const initial = await until(async () => {
    const value = await status()
    return value.revision > 0 && !value.building && !value.error && value
  }, 'first successful dev build')
  report.initialStatus = initial
  const dist = path.join(fixture, 'dist')
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'))
  report.devManifest = manifest
  const profile = path.join(temporary, 'profile')
  await mkdir(path.join(profile, 'Default'), { recursive: true })
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }))
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: !parameters.includes('--headed'), ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run', '--no-default-browser-check'],
  })
  report.browserVersion = context.browser().version()
  context.on('weberror', event => report.errors.push({ type: 'exception', message: event.error().message, page: event.page()?.url() }))
  context.on('console', message => {
    if (message.type() === 'error') report.errors.push({ type: 'console', message: message.text(), page: message.page()?.url() })
  })
  const manager = await context.newPage()
  await manager.goto('chrome://extensions/')
  await manager.evaluate(async () => { await globalThis.chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }) })
  let worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'))
    ?? await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extensionOrigin = new URL(worker.url()).origin
  // WHATWG URL.origin returns null for Chrome's custom scheme.
  const extensionUrl = `chrome-extension://${new URL(worker.url()).hostname}`
  report.contexts.push({ type: 'service_worker', url: worker.url(), origin: extensionOrigin })
  let popup = await context.newPage()
  await popup.goto(`${extensionUrl}/${manifest.action.default_popup}`)
  await popup.locator('#boot').waitFor()
  let popupBoot = await popup.locator('#boot').textContent()
  const workerState = () => popup.evaluate(() => globalThis.chrome.runtime.sendMessage('verifier'))
  const workerBoot = (await until(workerState, 'worker message response')).boot
  const pages = []
  const navigation = new Map()
  const scriptUrls = []
  const cdpSessions = []
  async function openHost(route) {
    const page = await context.newPage()
    navigation.set(page, 0)
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.set(page, navigation.get(page) + 1) })
    const session = await context.newCDPSession(page)
    cdpSessions.push(session)
    session.on('Debugger.scriptParsed', parsed => scriptUrls.push({ page: route, url: parsed.url, sourceMapURL: parsed.sourceMapURL }))
    await session.send('Debugger.enable')
    await page.goto(`${origin}${route}`)
    await page.locator('#host-input').fill('host-owned-draft')
    await page.evaluate(() => { globalThis.__hostNonce = 'host-nonce-' + crypto.randomUUID() })
    pages.push(page)
    return page
  }
  const matching = [await openHost('/matching/one'), await openHost('/matching/two')]
  const unmatched = await openHost('/nonmatching/one')
  const strict = await openHost('/matching/strict')
  matching.push(strict)
  async function read(page) {
    return page.evaluate(() => ({
      roots: ['isolated', 'main'].map(world => ({
        world, count: globalThis.document.querySelectorAll('#verifier-' + world).length,
        revision: globalThis.document.querySelector('#verifier-' + world)?.getAttribute('data-revision'),
        dependency: globalThis.document.querySelector('#verifier-' + world)?.getAttribute('data-dependency'),
        value: globalThis.document.querySelector('#verifier-' + world + ' input')?.value,
        color: globalThis.document.querySelector('#verifier-' + world) ? globalThis.getComputedStyle(globalThis.document.querySelector('#verifier-' + world)).color : '',
        borderTopWidth: globalThis.document.querySelector('#verifier-' + world) ? globalThis.getComputedStyle(globalThis.document.querySelector('#verifier-' + world)).borderTopWidth : '',
      })),
      host: globalThis.document.querySelector('#host-input')?.value, hostNonce: globalThis.__hostNonce,
      mainGlobal: globalThis.__contentVerifier_main, isolatedGlobal: globalThis.__contentVerifier_isolated,
      timers: JSON.parse(globalThis.document.documentElement.dataset.timers || '{}'),
      mounts: [globalThis.document.documentElement.dataset.mountsisolated, globalThis.document.documentElement.dataset.mountsmain],
    }))
  }
  for (const page of matching) {
    await until(async () => (await read(page)).roots.every(root => root.count === 1 && root.revision === '0'), 'both worlds mount')
    const snapshot = await read(page)
    assert.equal(snapshot.mainGlobal?.revision, 0, 'MAIN must execute in page world')
    assert.equal(snapshot.isolatedGlobal, undefined, 'ISOLATED globals must stay out of page world')
    for (const world of ['isolated', 'main']) await page.locator(`#verifier-${world} input`).fill(`${world}-saved-draft`)
  }
  assert.deepEqual((await read(unmatched)).roots.map(root => root.count), [0, 0])
  pass('initial both worlds, strict CSP, multiple and unmatched tabs', { snapshots: await Promise.all(matching.map(read)) })
  await strict.screenshot({ path: path.join(evidenceDir, 'strict-initial.png') })
  if (parameters.includes('--explore')) {
    report.status = 'EXPLORED'
    report.scriptUrls = scriptUrls
  } else {
    const initialNonces = await Promise.all(matching.map(async page => (await read(page)).hostNonce))
    async function stableRuntime() {
      assert.equal((await workerState()).boot, workerBoot, 'content updates cannot restart the worker')
      assert.equal(await popup.locator('#boot').textContent(), popupBoot, 'content updates cannot reload popup')
      for (let index = 0; index < matching.length; index++) {
        const page = matching[index]
        const snapshot = await read(page)
        assert.equal(navigation.get(page), 1, 'host cannot navigate')
        assert.equal(snapshot.host, 'host-owned-draft')
        assert.equal(snapshot.hostNonce, initialNonces[index])
        for (const root of snapshot.roots) {
          assert.equal(root.count, 1)
          assert.equal(root.value, `${root.world}-saved-draft`)
        }
      }
      assert.deepEqual((await read(unmatched)).roots.map(root => root.count), [0, 0])
    }
    async function changed(operation) {
      const before = await status()
      await operation()
      return until(async () => {
        const value = await status()
        return value.revision > before.revision && !value.building && !value.error && value
      }, 'published content change')
    }
    for (let revision = 1; revision <= 3; revision++) {
      for (const world of ['isolated', 'main']) {
        const before = await Promise.all(matching.map(read))
        await changed(() => write(`modules/content/${world}.ts`, entry(world, revision)))
        for (const page of matching) await until(async () => (await read(page)).roots.find(root => root.world === world).revision === String(revision), `${world} revision ${revision}`)
        await stableRuntime()
        const frozen = await Promise.all(matching.map(read))
        await pause(160)
        for (let index = 0; index < matching.length; index++) {
          const after = await read(matching[index])
          const oldKey = `${world}-${revision - 1}-dep-zero`
          assert.equal(after.timers[oldKey], frozen[index].timers[oldKey], `${oldKey} timer must be cleaned`)
          assert.ok(Number(after.mounts[world === 'isolated' ? 0 : 1]) > Number(before[index].mounts[world === 'isolated' ? 0 : 1]))
          const responses = await matching[index].evaluate(worldName => {
            const key = 'responses' + worldName
            const previous = Number(globalThis.document.documentElement.dataset[key] || 0)
            globalThis.document.dispatchEvent(new Event('verifier-probe-' + worldName))
            return Number(globalThis.document.documentElement.dataset[key]) - previous
          }, world)
          assert.equal(responses, 1, 'one probe event must trigger one surviving listener')
        }
      }
    }
    pass('three updates in each world preserve data and clean DOM, listeners, timers without navigation or worker/page restart')
    for (const world of ['isolated', 'main']) {
      await changed(() => write(`modules/content/${world}-dependency.ts`, 'export const dependency = "dep-one"'))
      for (const page of matching) await until(async () => (await read(page)).roots.find(root => root.world === world).dependency === 'dep-one', `${world} exclusive dependency`)
      await changed(() => write(`modules/content/${world}.css`, `#verifier-${world} { color: rgb(11, 22, 33); }`))
      for (const page of matching) await until(async () => (await read(page)).roots.find(root => root.world === world).color === 'rgb(11, 22, 33)', `${world} CSS change including strict CSP`)
      for (const page of matching) assert.equal((await read(page)).roots.find(root => root.world === world).borderTopWidth, '0px', 'removed CSS declarations cannot accumulate')
    }
    await stableRuntime()
    pass('exclusive dependencies and CSS-only changes update both worlds under strict CSP')
    await changed(async () => {
      await write('modules/content/main.ts', entry('main', 4))
      await write('modules/content/main.css', '#verifier-main { color: rgb(44, 55, 66); }')
    })
    for (const page of matching) await until(async () => {
      const root = (await read(page)).roots.find(root => root.world === 'main')
      return root.revision === '4' && root.color === 'rgb(44, 55, 66)'
    }, 'joint JavaScript and CSS update')
    await stableRuntime()
    const late = await openHost('/matching/late')
    await until(async () => (await read(late)).roots.every(root => root.count === 1 && root.revision === (root.world === 'main' ? '4' : '3')), 'new tab latest revisions')
    const mounts = (await read(late)).mounts
    await pause(1200)
    assert.deepEqual((await read(late)).mounts, mounts, 'delayed/duplicate notification must not remount')
    pass('joint JS/CSS, newly opened matching tab, delayed duplicate observation')
    const goodStatus = await status()
    const goodDist = await tree(dist)
    const goodMounts = await Promise.all(matching.map(async page => (await read(page)).mounts))
    await write('modules/content/main.ts', 'export const invalid = ;')
    await until(async () => (await status()).error, 'invalid syntax error')
    await pause(400)
    assert.equal((await status()).revision, goodStatus.revision)
    assert.deepEqual(await tree(dist), goodDist)
    assert.deepEqual(await Promise.all(matching.map(async page => (await read(page)).mounts)), goodMounts)
    await stableRuntime()
    await changed(() => write('modules/content/main.ts', entry('main', 5)))
    for (const page of [...matching, late]) await until(async () => (await read(page)).roots.find(root => root.world === 'main').revision === '5', 'syntax error recovery')
    await stableRuntime()
    pass('syntax errors preserve last successful artifact and mounts; recovery resumes in place')
    const oldSession = (await status()).session
    await server.close()
    server = undefined
    const temporaryEntries = await readdir(fixture)
    assert.ok(!temporaryEntries.some(name => /(?:staging|stage-|\.chrome-extension-dev)/.test(name)), 'close must remove temporary staging output')
    await start(Number(new URL(origin).port))
    await until(async () => {
      const value = await status()
      return value.session !== oldSession && value.revision > 0 && !value.error && !value.building
    }, 'same-origin server restart')
    await pause(1400)
    report.restartPopup = { before: popupBoot, after: await popup.locator('#boot').textContent() }
    popupBoot = report.restartPopup.after
    await changed(() => write('modules/content/main.ts', entry('main', 6)))
    for (const page of [...matching, late]) await until(async () => (await read(page)).roots.find(root => root.world === 'main').revision === '6', 'content after dev restart')
    await stableRuntime()
    pass('same-origin restart reconnects existing hosts and close cleans staging files')
    report.scriptUrls = scriptUrls
    const remoteScripts = scriptUrls.filter(item => /^https?:/.test(item.url))
    assert.deepEqual(remoteScripts, [], 'extension content code cannot be loaded as remote JavaScript')
    const cspErrors = report.errors.filter(item => /unsafe-eval|violates.*script-src|Refused to evaluate|EvalError/i.test(item.message))
    assert.deepEqual(cspErrors, [], 'strict CSP must not require eval or remote extension JavaScript')
    pass('strict host CSP accepts both worlds without remote JavaScript or eval')
    const baselineWorker = worker
    await changed(() => write('shared.ts', 'export const shared = "shared-one"'))
    worker = await until(() => context.serviceWorkers().find(item => item !== baselineWorker && item.url().startsWith(extensionUrl)), 'shared runtime full reload', 45_000)
    popup = await context.newPage()
    await popup.goto(`${extensionUrl}/${manifest.action.default_popup}`)
    await until(async () => (await workerState()).shared === 'shared-one', 'shared worker new code')
    pass('shared runtime input falls back to full extension reload')
    const backgroundWorker = worker
    await changed(() => write('modules/background/background.ts', `import { shared } from '../../shared'; globalThis.__workerBoot = 'background-change'; globalThis.__workerShared = shared; chrome.runtime.onMessage.addListener((_message, _sender, reply) => reply('updated'))`))
    worker = await until(() => context.serviceWorkers().find(item => item !== backgroundWorker && item.url().startsWith(extensionUrl)), 'background full reload', 45_000)
    popup = await context.newPage()
    await popup.goto(`${extensionUrl}/${manifest.action.default_popup}`)
    await until(async () => await workerState() === 'updated', 'new background body')
    pass('background input falls back to full extension reload')
    const beforeManifest = worker
    await configure('1.0.1')
    worker = await until(() => context.serviceWorkers().find(item => item !== beforeManifest && item.url().startsWith(extensionUrl)), 'Manifest full reload', 45_000)
    pass('Manifest changes fall back to full extension reload')
    const errors = await manager.evaluate(async () => {
      const entries = await new Promise(resolve => globalThis.chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve))
      return entries.filter(item => item.name === 'Content HMR independent verifier').flatMap(item => [...item.runtimeErrors, ...item.manifestErrors])
    })
    report.extensionErrors = errors
    assert.deepEqual(errors, [], 'Chrome must report no extension errors')
    await server.close()
    server = undefined
    await productionBuild('dist-production')
    const production = path.join(fixture, 'dist-production')
    const productionManifest = JSON.parse(await readFile(path.join(production, 'manifest.json'), 'utf8'))
    assert.ok(!productionManifest.permissions?.includes('scripting'))
    assert.ok(!productionManifest.host_permissions?.some(value => value.includes('127.0.0.1')))
    assert.ok(!productionManifest.content_security_policy)
    const productionTree = await tree(production)
    for (const [name] of productionTree) {
      if (!/\.(?:js|json)$/.test(name)) continue
      const source = await readFile(path.join(production, name), 'utf8')
      assert.ok(!source.includes('__chrome_extension_dev_status__') && !source.includes('chrome-extension:dev:') && !source.includes(origin), `${name} has no dev transport`)
    }
    report.productionArtifact = { files: productionTree, sha256: createHash('sha256').update(JSON.stringify(productionTree)).digest('hex') }
    await configure('1.0.1', true)
    await productionBuild('dist-explicit')
    const explicit = JSON.parse(await readFile(path.join(fixture, 'dist-explicit', 'manifest.json'), 'utf8'))
    assert.ok(explicit.permissions.includes('scripting'))
    assert.ok(explicit.host_permissions.includes('https://example.com/*'))
    pass('production omits HMR transport, endpoints and inferred dev permissions; explicit permissions survive')
    report.status = 'PASS'
  }
} catch (error) {
  report.failure = error.stack
  console.error(error.stack)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
  await context?.close()
  await server?.close()
  if (!parameters.includes('--keep')) await rm(temporary, { recursive: true, force: true })
  console.log(`Evidence: ${path.join(evidenceDir, 'report.json')}`)
}
