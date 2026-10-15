#!/usr/bin/env node
// Public tarball boundary: installs outside the workspace, then verifies types,
// browser bundling and production mount/stop in both Chrome execution worlds.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const value = key => args[args.indexOf(key) + 1]
const tarball = path.resolve(value('--tarball') ?? '')
const chrome = value('--chrome') ?? process.env.CHROME_PATH
assert.ok(args.includes('--tarball') && chrome, 'Pass --tarball and --chrome')
const evidenceDir = path.resolve(args.includes('--evidence') ? value('--evidence') : 'output/playwright/content-client-package')
const project = await mkdtemp(path.join(tmpdir(), 'content-client-pack-verifier-'))
const report = { status: 'FAIL', project, tarball, checks: [], errors: [], stages: [] }
let context
let host
async function write(name, source) {
  const filename = path.join(project, name)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, source)
}
async function run(command, parameters) {
  const output = []
  const child = spawn(command, parameters, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => output.push(String(data)))
  child.stderr.on('data', data => output.push(String(data)))
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const result = { command: [command, ...parameters], exitCode: code, output: output.join('') }
  report.stages.push(result)
  assert.equal(code, 0, `${command} ${parameters.join(' ')} failed:\n${result.output}`)
}
async function files(directory) {
  const entries = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) for (const name of await files(path.join(directory, item.name))) entries.push(`${item.name}/${name}`)
    else entries.push(item.name)
  }
  return entries.sort()
}
try {
  await mkdir(evidenceDir, { recursive: true })
  report.tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  await write('package.json', JSON.stringify({
    type: 'module', private: true,
    scripts: { build: 'vite build', typecheck: 'tsc --noEmit' },
    devDependencies: { '@vite-react-chrome-extension/plugin': `file:${tarball}`, vite: '^6.4.1', typescript: '^5.9.3' },
  }))
  await write('tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], strict: true, skipLibCheck: true },
    include: ['modules/**/*.ts'],
  }))
  await write('vite.config.mjs', `import chromeExtension from '@vite-react-chrome-extension/plugin'
export default {plugins:[chromeExtension({tailwind:false,contentScripts:{hmr:true},manifest:{name:'Packed client production verifier',version:'1.0.0',content_scripts:[
  {matches:['http://127.0.0.1/*'],js:['modules/content/isolated.ts'],world:'ISOLATED'},
  {matches:['http://127.0.0.1/*'],js:['modules/content/main.ts'],world:'MAIN'}
]}})]}`)
  for (const world of ['isolated', 'main']) {
    await write(`modules/content/${world}.ts`, `import { defineContentScript } from '@vite-react-chrome-extension/plugin/client'
let stop: () => Promise<void>
void defineContentScript('packed-${world}', ({data, onDispose, signal}) => {
  data.world = '${world}'
  const root = document.createElement('section')
  root.id = 'packed-${world}'
  const button = document.createElement('button')
  button.textContent = 'Stop ${world}'
  button.onclick = () => { void stop() }
  root.append(button)
  document.body.append(root)
  onDispose(previous => { document.documentElement.dataset['disposed${world}'] = String(previous.world) })
  signal.addEventListener('abort', () => { document.documentElement.dataset['aborted${world}'] = 'yes' })
  return () => { root.remove() }
}).then(value => { stop = value })
`)
  }
  await run('npm', ['install', '--no-audit', '--no-fund'])
  await run('npm', ['run', 'typecheck'])
  await run('npm', ['run', 'build'])
  const installed = path.join(project, 'node_modules/@vite-react-chrome-extension/plugin')
  report.installedPackage = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
  const dist = path.join(project, 'dist')
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'))
  assert.ok(!manifest.permissions?.includes('scripting'))
  assert.ok(!manifest.host_permissions)
  assert.ok(!manifest.content_security_policy)
  for (const name of await files(dist)) {
    if (!/\.(js|json)$/.test(name)) continue
    const text = await readFile(path.join(dist, name), 'utf8')
    assert.ok(!/node:|__chrome_extension_dev_status__|chrome-extension:dev:|localhost:|127\.0\.0\.1:/.test(text), `${name} must be browser-only production output`)
  }
  report.checks.push({ name: 'external tarball installation, client declarations and Vite browser build', status: 'PASS' })
  host = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; style-src 'none'")
    response.end('<!doctype html><title>Production client host</title><body><h1>Production host</h1></body>')
  })
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
  context = await chromium.launchPersistentContext(path.join(project, 'profile'), {
    executablePath: chrome, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })
  report.browserVersion = context.browser().version()
  context.on('weberror', error => report.errors.push(error.error().message))
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${host.address().port}/`)
  for (const world of ['isolated', 'main']) {
    await page.locator(`#packed-${world}`).waitFor()
    assert.equal(await page.locator(`#packed-${world}`).count(), 1)
    await page.getByRole('button', { name: `Stop ${world}` }).click()
    await page.locator(`#packed-${world}`).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(name => globalThis.document.documentElement.dataset[`disposed${name}`], world), world)
    assert.equal(await page.evaluate(name => globalThis.document.documentElement.dataset[`aborted${name}`], world), 'yes')
  }
  await page.screenshot({ path: path.join(evidenceDir, 'production-cleaned.png') })
  assert.deepEqual(report.errors, [])
  report.checks.push({ name: 'packaged production lifecycle mounts and explicitly stops in both worlds under strict CSP', status: 'PASS' })
  report.status = 'PASS'
} catch (error) {
  report.failure = error.stack
  process.exitCode = 1
  console.error(error.stack)
} finally {
  await context?.close()
  await new Promise(resolve => host ? host.close(resolve) : resolve())
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
  if (!args.includes('--keep')) await rm(project, { recursive: true, force: true })
  console.log(`Evidence: ${path.join(evidenceDir, 'report.json')}`)
}
