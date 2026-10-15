#!/usr/bin/env node
/** Independent black-box Doctor acceptance. Only temporary projects/profiles are changed. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

export async function runDoctorSmoke(diagnoseExtension, options = {}) {
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = options.args ?? process.argv.slice(2)
const chromePath = args[args.indexOf('--chrome') + 1] || process.env.CHROME_PATH
if (!args.includes('--chrome') && !process.env.CHROME_PATH) throw new Error('Pass --chrome <Chrome for Testing executable>')
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doctor acceptance ')))
const evidence = { chrome: '', checks: [], reports: {}, startedAt: new Date().toISOString() }
const profile = path.join(temporary, 'profile')
let chrome
let browser
const check = (name) => evidence.checks.push(name)
async function waitFor(run, label) {
  const end = Date.now() + 15000
  let latest
  while (Date.now() < end) {
    try { const result = await run(); if (result) return result } catch (error) { latest = error }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out: ${label}${latest ? `: ${latest.message}` : ''}`)
}
async function extension(name, background, csp) {
  const directory = path.join(temporary, name)
  await fs.mkdir(directory)
  const manifest = { manifest_version: 3, name, version: '1.0.0', permissions: ['storage'], background: { service_worker: 'worker.js' }, action: { default_popup: 'popup.html' } }
  if (csp) manifest.content_security_policy = { extension_pages: csp }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  await fs.writeFile(path.join(directory, 'worker.js'), background)
  await fs.writeFile(path.join(directory, 'popup.html'), '<!doctype html><title>Doctor Fixture Popup</title><body><script src="popup.js"></script></body>')
  await fs.writeFile(path.join(directory, 'popup.js'), 'document.body.textContent="Doctor popup ready";')
  return directory
}
async function command(commandPath, values, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, values, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}
try {
  const good = await extension('Doctor Good', 'chrome.runtime.onInstalled.addListener(()=>{});')
  const broken = await extension('Doctor Broken Worker', 'const = syntax error;')
  const runtimeError = await extension('Doctor Runtime Error', 'throw new Error("doctor fixture runtime exploded");')
  const runtimeCsp = await extension('Doctor Runtime CSP', 'chrome.runtime.onInstalled.addListener(()=>{});')
  await fs.writeFile(path.join(runtimeCsp, 'popup.js'), 'document.body.textContent="CSP fixture"; eval("document.body.dataset.unexpected = true");')
  const noBackground = await extension('Doctor No Background', '')
  const noBackgroundManifest = JSON.parse(await fs.readFile(path.join(noBackground, 'manifest.json'), 'utf8'))
  delete noBackgroundManifest.background
  await fs.writeFile(path.join(noBackground, 'manifest.json'), JSON.stringify(noBackgroundManifest))
  const csp = await extension('Doctor Invalid CSP', 'console.log("csp");', "script-src 'self' 'unsafe-eval'; object-src 'self'")
  const loaded = [good, broken, runtimeError, runtimeCsp, noBackground].join(',')
  chrome = spawn(chromePath, [`--user-data-dir=${profile}`, `--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'], { stdio: 'ignore' })
  const port = await waitFor(async () => (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Chrome debugging port')
  const cdp = `http://127.0.0.1:${port}`
  browser = await chromium.connectOverCDP(cdp)
  evidence.chrome = browser.version()
  const context = browser.contexts()[0]
  const settings = await context.newPage()
  await settings.goto('chrome://extensions')
  await settings.waitForFunction(() => typeof chrome.developerPrivate?.getExtensionsInfo === 'function')
  await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }))
  const inventory = () => settings.evaluate(() => new Promise((resolve) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve)))
  const infos = await waitFor(async () => { const items = await inventory(); return items.length >= 5 ? items : false }, 'five extensions registered')
  const id = (name) => { const item = infos.find((value) => value.name === name); assert.ok(item, `${name} is in Chrome inventory`); return item.id }
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${id('Doctor Good')}/popup.html`)
  assert.equal(await popup.textContent('body'), 'Doctor popup ready')
  const cspPopup = await context.newPage()
  await cspPopup.goto(`chrome-extension://${id('Doctor Runtime CSP')}/popup.html`)
  const plainPopup = await context.newPage()
  await plainPopup.goto(`chrome-extension://${id('Doctor No Background')}/popup.html`)
  const session = await browser.newBrowserCDPSession()
  const targets = async () => (await session.send('Target.getTargets')).targetInfos
  const beforeTargets = await targets()
  const beforeConfig = await settings.evaluate(() => chrome.developerPrivate.getProfileConfiguration())
  const goodReport = await diagnoseExtension({ dist: good, cdp, extensionId: id('Doctor Good'), timeoutMs: 5000 })
  evidence.reports.good = goodReport
  assert.equal(goodReport.ok, true, JSON.stringify(goodReport))
  assert.match(JSON.stringify(goodReport.checks), /worker|service_worker/i)
  assert.match(JSON.stringify(goodReport.checks), /page/i)
  check('Real Chrome: loaded extension identifies existing worker and popup contexts')
  const browserVersion = await (await fetch(`${cdp}/json/version`)).json()
  const websocketReport = await diagnoseExtension({ dist: good, cdp: browserVersion.webSocketDebuggerUrl, extensionId: id('Doctor Good'), timeoutMs: 5000 })
  evidence.reports.websocketEndpoint = websocketReport
  assert.equal(websocketReport.ok, true, JSON.stringify(websocketReport))
  check('Real Chrome: direct browser WebSocket CDP endpoint is accepted')
  const brokenReport = await diagnoseExtension({ dist: broken, cdp, extensionId: id('Doctor Broken Worker'), timeoutMs: 5000 })
  evidence.reports.brokenWorker = brokenReport
  assert.equal(brokenReport.ok, false)
  assert.match(JSON.stringify(brokenReport.issues), /register|registration|syntax|worker/i)
  check('Real Chrome: worker registration failure returns failure')
  const runtimeReport = await diagnoseExtension({ dist: runtimeError, cdp, extensionId: id('Doctor Runtime Error'), timeoutMs: 5000 })
  evidence.reports.runtimeError = runtimeReport
  assert.equal(runtimeReport.ok, false)
  assert.match(JSON.stringify(runtimeReport.issues), /runtime exploded|runtime|worker/i)
  check('Real Chrome: runtime exception returns failure')
  const runtimeCspReport = await diagnoseExtension({ dist: runtimeCsp, cdp, extensionId: id('Doctor Runtime CSP'), timeoutMs: 5000 })
  evidence.reports.runtimeCsp = runtimeCspReport
  assert.equal(runtimeCspReport.ok, false)
  assert.match(JSON.stringify(runtimeCspReport.issues), /CSP|unsafe-eval|Content Security Policy/i)
  check('Real Chrome: actual popup CSP violation is diagnosed')
  const noBackgroundReport = await diagnoseExtension({ dist: noBackground, cdp, extensionId: id('Doctor No Background'), timeoutMs: 5000 })
  evidence.reports.noBackground = noBackgroundReport
  assert.equal(noBackgroundReport.ok, true, JSON.stringify(noBackgroundReport))
  check('Real Chrome: valid extension without a background uses its page context')
  const missingReport = await diagnoseExtension({ dist: good, cdp, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeoutMs: 5000 })
  evidence.reports.notLoaded = missingReport
  assert.equal(missingReport.ok, false)
  check('Real Chrome: requested extension not loaded returns failure')
  const cspReport = await diagnoseExtension({ dist: csp, cdp, extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', timeoutMs: 5000 })
  evidence.reports.csp = cspReport
  assert.equal(cspReport.ok, false)
  assert.match(JSON.stringify(cspReport.issues), /CSP|content_security_policy|unsafe-eval/i)
  check('Invalid extension CSP produces an actionable error')
  const afterTargets = await targets()
  assert.deepEqual(afterTargets.map((item) => item.targetId).sort(), beforeTargets.map((item) => item.targetId).sort())
  assert.deepEqual(await settings.evaluate(() => chrome.developerPrivate.getProfileConfiguration()), beforeConfig)
  check('Doctor preserves existing Chrome targets and profile configuration and closes its temporary targets')
  if (args.includes('--pack') || args.includes('--tarball')) {
    let tarball = args.includes('--tarball') ? args[args.indexOf('--tarball') + 1] : undefined
    if (!tarball) {
      const tarballs = path.join(temporary, 'tarballs')
      await fs.mkdir(tarballs)
      const packed = await command('npm', ['pack', '--workspace', '@vite-react-chrome-extension/plugin', '--ignore-scripts', '--json', '--pack-destination', tarballs], repository)
      assert.equal(packed.code, 0, packed.stderr)
      tarball = path.join(tarballs, JSON.parse(packed.stdout)[0].filename)
    }
    evidence.packageTarball = {
      path: tarball,
      sha256: createHash('sha256').update(await fs.readFile(tarball)).digest('hex'),
    }
    const external = path.join(temporary, 'external consumer')
    await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'package.json'), JSON.stringify({ name: 'doctor-consumer', version: '1.0.0', type: 'module', private: true }))
    const viteVersion = JSON.parse(await fs.readFile(path.join(repository, 'node_modules/vite/package.json'), 'utf8')).version
    const install = await command('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball, `vite@${viteVersion}`], external)
    assert.equal(install.code, 0, install.stderr)
    const bin = path.join(external, 'node_modules/.bin/chrome-extension-doctor')
    const json = await command(bin, ['--dist', good, '--json'], external)
    assert.equal(json.code, 0, json.stderr)
    assert.equal(JSON.parse(json.stdout).ok, true)
    const text = await command(bin, ['--dist', good], external)
    assert.equal(text.code, 0, text.stderr)
    assert.match(text.stdout, /pass|OK|healthy/i)
    const failed = await command(bin, ['--dist', csp, '--json'], external)
    assert.notEqual(failed.code, 0)
    assert.equal(JSON.parse(failed.stdout).ok, false)
    await fs.writeFile(path.join(external, 'consumer.ts'), "import { diagnoseExtension, type DoctorReport, type DoctorOptions } from '@vite-react-chrome-extension/plugin/doctor'; const options: DoctorOptions = {dist: '.'}; const report: Promise<DoctorReport> = diagnoseExtension(options); void report;\n")
    const types = await command(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', 'consumer.ts'], external)
    assert.equal(types.code, 0, types.stdout + types.stderr)
    check('npm pack: external install, executable bin, JSON/text output, failure exit and TypeScript export')
  }
  const output = path.join(repository, '.cache/doctor/validation.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ok: true, chrome: evidence.chrome, checks: evidence.checks, evidence: output }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await exited
  }
  if (!args.includes('--keep')) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

return evidence
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { diagnoseExtension } = await import('../packages/vite-plugin-chrome-extension/dist/doctor.js')
  await runDoctorSmoke(diagnoseExtension)
}
