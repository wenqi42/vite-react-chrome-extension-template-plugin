import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

async function bounded(operation, name) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after 10 seconds`)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Independent browser acceptance probe. The matrix runner owns installation,
// packing and build checks; this file verifies the unpacked Chrome artifact.
export async function verifyExtensionInChrome({ dist, chrome, evidenceDir }) {
  const extensionDirectory = path.resolve(dist)
  const directory = path.resolve(evidenceDir)
  await mkdir(directory, { recursive: true })
  const profile = await mkdtemp(path.join(tmpdir(), 'extension-acceptance-chrome-'))
  const result = { status: 'FAIL', browserVersion: '', contexts: [], checks: [], screenshots: [], errors: [] }
  let context
  try {
    const manifest = JSON.parse(await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.manifest_version, 3, 'generated extension must target Manifest V3')
    assert.ok(manifest.background?.service_worker, 'generated extension must register a background worker')
    assert.ok(manifest.action?.default_popup, 'generated extension must declare its popup')
    const optionsPath = manifest.options_ui?.page ?? manifest.options_page
    assert.ok(optionsPath, 'generated extension must declare its options page')

    await mkdir(path.join(profile, 'Default'), { recursive: true })
    await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      extensions: { ui: { developer_mode: true } },
    }))
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chrome,
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    })
    context.on('weberror', error => result.errors.push({ context: 'page', message: error.error().message }))
    context.on('console', message => {
      if (message.type() === 'error') {
        result.errors.push({ context: message.page()?.url() ?? 'worker', message: message.text() })
      }
    })
    result.browserVersion = context.browser()?.version() ?? ''
    assert.ok(result.browserVersion, 'Chrome version must be recorded')

    const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'))
      ?? await context.waitForEvent('serviceworker', { predicate: item => item.url().startsWith('chrome-extension://'), timeout: 20_000 })
    const extensionId = new URL(worker.url()).hostname
    assert.match(extensionId, /^[a-p]{32}$/)
    result.contexts.push({ type: 'service_worker', url: worker.url() })
    result.checks.push({ name: 'background-registered', status: 'PASS', extensionId })

    // Enable Chrome's own error collector and reload before exercising startup.
    // Module service workers are verified through extension messaging because
    // Playwright's worker utility context may not expose Chrome API bindings.
    const manager = await context.newPage()
    await manager.goto('chrome://extensions/')
    const developerMode = manager.locator('#devMode')
    if (!await developerMode.evaluate(element => element.checked)) await developerMode.click()
    assert.equal(await developerMode.evaluate(element => element.checked), true, 'Chrome Developer mode must be enabled')
    await bounded(manager.evaluate(async id => {
      await new Promise((resolve, reject) => {
        globalThis.chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true }, () => {
          const error = globalThis.chrome.runtime.lastError
          if (error) reject(new Error(error.message))
          else resolve()
        })
      })
      await new Promise((resolve, reject) => {
        globalThis.chrome.developerPrivate.reload(id, { failQuietly: true, populateErrorForUnpacked: true }, error => {
          const runtimeError = globalThis.chrome.runtime.lastError
          if (runtimeError || error) reject(new Error(runtimeError?.message ?? error.error ?? JSON.stringify(error)))
          else resolve()
        })
      })
    }, extensionId), 'enable-error-collection-and-reload')

    for (const [name, entry] of [['popup', manifest.action.default_popup], ['options', optionsPath]]) {
      const page = await context.newPage()
      page.on('requestfailed', request => {
        result.errors.push({ context: name, message: `${request.url()}: ${request.failure()?.errorText}` })
      })
      await page.goto(`chrome-extension://${extensionId}/${entry}`)
      await page.waitForFunction(() => {
        const root = globalThis.document.querySelector('#root') ?? globalThis.document.body
        return root.textContent.trim().length > 0 && root.getBoundingClientRect().height > 0
      })
      const text = await page.locator('body').innerText()
      assert.ok(text.trim().length > 0, `${name} must visibly render`)
      const runtimeManifest = await page.evaluate(() => globalThis.chrome.runtime.getManifest())
      assert.equal(runtimeManifest.name, manifest.name)
      assert.equal(runtimeManifest.version, manifest.version)
      result.contexts.push({ type: name, url: page.url(), visibleText: text })
      result.checks.push({ name: `${name}-rendered`, status: 'PASS' })
      const pong = await bounded(page.evaluate(() => globalThis.chrome.runtime.sendMessage({ type: 'PING' })), `${name} background response`)
      assert.deepEqual(pong, { pong: true }, `${name} must receive the template background response`)
      result.checks.push({ name: `${name}-worker-request-response`, status: 'PASS', response: pong })
      const screenshot = path.join(directory, `${name}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      result.screenshots.push(screenshot)
    }

    // Chrome retains early worker errors, including exceptions that occurred
    // before Playwright attached its runtime listeners.
    const registration = await bounded(manager.evaluate(async id => {
      const entries = await new Promise(resolve => {
        globalThis.chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve)
      })
      const entry = entries.find(item => item.id === id)
      return entry ? {
        id: entry.id, state: entry.state, errorCollection: entry.errorCollection,
        runtimeErrors: entry.runtimeErrors, manifestErrors: entry.manifestErrors,
      } : null
    }, extensionId), 'extension-manager evaluation')
    assert.ok(registration, 'Chrome extensions manager must contain the tested extension')
    assert.equal(registration.state, 'ENABLED', 'extension must be enabled in Chrome')
    assert.equal(registration.errorCollection?.isActive, true, 'Chrome must actively collect extension runtime errors')
    result.warnings = (registration.runtimeErrors ?? []).filter(error => error.severity === 'WARN')
    const chromeErrors = [
      ...(registration.runtimeErrors ?? []).filter(error => error.severity !== 'WARN'),
      ...(registration.manifestErrors ?? []),
    ]
    result.errors.push(...chromeErrors.map(error => ({ context: 'extension-manager', message: error.message, error })))
    result.registration = registration
    assert.deepEqual(result.errors, [], 'extension pages and worker must have no runtime or load errors')
    result.checks.push({ name: 'runtime-error-free', status: 'PASS' })
    result.status = 'PASS'
    return result
  } catch (error) {
    result.errors.push({ context: 'probe', message: error.message })
    error.details = result
    throw error
  } finally {
    await writeFile(path.join(directory, 'browser.json'), `${JSON.stringify(result, null, 2)}\n`)
    await context?.close()
    await rm(profile, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    assert.ok(['--dist', '--chrome', '--report'].includes(key), `Unknown argument: ${key}`)
    assert.ok(process.argv[index + 1], `${key} requires a value`)
    options[key.slice(2)] = process.argv[index + 1]
  }
  assert.ok(options.dist && options.chrome, '--dist and --chrome are required')
  const report = path.resolve(options.report ?? 'output/playwright/acceptance-browser.json')
  try {
    const result = await verifyExtensionInChrome({ ...options, evidenceDir: path.dirname(report) })
    await writeFile(report, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } catch (error) {
    await writeFile(report, `${JSON.stringify(error.details ?? { status: 'FAIL', error: error.message }, null, 2)}\n`)
    console.error(error.message)
    process.exitCode = 1
  }
}
