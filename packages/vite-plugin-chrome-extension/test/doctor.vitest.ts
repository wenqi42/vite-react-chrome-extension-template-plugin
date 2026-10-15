import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build, createServer } from 'vite'
import extension from '../index.js'

// Public API contract only: this suite intentionally does not import or inspect
// the diagnostic implementation. Fixture changes model user-visible failures.
type Report = {
  ok: boolean
  issues: Array<{ code: string; level: string; message: string; hint: string }>
  permissions: {
    actual: string[]
    explicit: string[] | null
    inferred: Array<{ permission: string; sources: Array<{ file: string; api: string }> }>
    autoPermissions: boolean | null
    hostPermissions: string[]
  }
  checks: Array<{ id: string; status: 'pass' | 'fail' | 'skipped'; message: string }>
}
type Options = { root?: string; dist?: string; devUrl?: string; cdp?: string; extensionId?: string; timeoutMs?: number }
const moduleName = '../doctor.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())) })
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
const browserDirectories = await fs.readdir(browserCache).catch(() => [] as string[])
const installedChromium = browserDirectories.filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))[0]
const localChrome = installedChromium ? path.join(browserCache, installedChromium, process.platform === 'darwin' ? `chrome-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` : 'chrome-linux64/chrome') : undefined
const chromeForTesting = process.env.CHROME_PATH || localChrome

async function diagnose(options: Options): Promise<Report> {
  const api = await import(moduleName)
  expect(api.diagnoseExtension).toBeTypeOf('function')
  return api.diagnoseExtension(options)
}
async function cli(args: string[]) {
  const api = await import(moduleName)
  expect(api.runDoctorCli).toBeTypeOf('function')
  const output: string[] = []
  const code = await api.runDoctorCli(args, (text: string) => output.push(text))
  return { code, text: output.join('\n') }
}
async function fixture(manifest: Record<string, unknown> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension doctor with spaces ')))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const dist = path.join(root, 'output files')
  await fs.mkdir(dist)
  const value = { manifest_version: 3, name: 'Doctor Fixture', version: '1.0.0', ...manifest }
  await fs.writeFile(path.join(dist, 'manifest.json'), JSON.stringify(value))
  return { root, dist, value }
}
function contract(report: Report) {
  expect(report).toHaveProperty('ok')
  expect(report).toHaveProperty('permissions')
  expect(report).toHaveProperty('checks')
  expect(report.permissions.actual).toBeInstanceOf(Array)
  expect(report.permissions.hostPermissions).toBeInstanceOf(Array)
  expect(report.permissions.inferred).toBeInstanceOf(Array)
  for (const item of report.permissions.inferred) {
    expect(item.permission).toEqual(expect.any(String))
    for (const source of item.sources) {
      expect(source.file).toEqual(expect.any(String))
      expect(source.api).toEqual(expect.any(String))
    }
  }
  for (const check of report.checks) {
    expect(check.id.length).toBeGreaterThan(0)
    expect(['pass', 'fail', 'skipped']).toContain(check.status)
    expect(check.message.length).toBeGreaterThan(0)
  }
  expect(report.issues).toBeInstanceOf(Array)
  for (const issue of report.issues) {
    expect(issue.code).toEqual(expect.any(String))
    expect(issue.code.length).toBeGreaterThan(0)
    expect(issue.level).toEqual(expect.any(String))
    expect(issue.message.length).toBeGreaterThan(0)
    expect(issue.hint.length).toBeGreaterThan(0)
  }
}
function failure(report: Report, evidence: RegExp) {
  contract(report)
  expect(report.ok).toBe(false)
  expect(JSON.stringify(report.issues)).toMatch(evidence)
}
async function server(handler: http.RequestListener) {
  const instance = http.createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())))
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}`
}

describe('Extension Doctor public contract', () => {
  it('accepts a valid extension without a background and marks runtime unrequested', async () => {
    const fixtureRoot = await fixture({ permissions: ['storage'], host_permissions: ['https://example.com/*'] })
    const before = await fs.readFile(path.join(fixtureRoot.dist, 'manifest.json'), 'utf8')
    const report = await diagnose(fixtureRoot)
    contract(report)
    expect(report.ok).toBe(true)
    expect(JSON.stringify(report.permissions)).toContain('storage')
    expect(JSON.stringify(report.permissions)).toContain('https://example.com/*')
    expect(JSON.stringify(report.checks)).toMatch(/(not.requested|not.run|skip|未)/i)
    expect(await fs.readFile(path.join(fixtureRoot.dist, 'manifest.json'), 'utf8')).toBe(before)
    expect((await fs.readdir(fixtureRoot.dist)).sort()).toEqual(['manifest.json'])
  })

  it.each(['missing', 'corrupt'] as const)('rejects %s manifest with actionable issues', async (kind) => {
    const item = await fixture()
    const filename = path.join(item.dist, 'manifest.json')
    if (kind === 'missing') await fs.rm(filename)
    else await fs.writeFile(filename, '{broken json')
    failure(await diagnose(item), /manifest/i)
  })

  it('rejects MV2 and a missing required name', async () => {
    const first = await fixture({ manifest_version: 2 })
    failure(await diagnose(first), /manifest.version|MV3|manifest_version/i)
    const second = await fixture({ name: '' })
    failure(await diagnose(second), /name/i)
  })

  it.each([
    { permissions: 'storage' },
    { background: { service_worker: 42 } },
    { content_scripts: 'not-an-array' },
    { host_permissions: 'https://example.com/*' },
  ])('returns a structured failure for malformed common manifest fields %#', async (manifest) => {
    const report = await diagnose(await fixture(manifest))
    contract(report)
    expect(report.ok).toBe(false)
    expect(report.issues.length).toBeGreaterThan(0)
  })

  it.each([
    ['background', { background: { service_worker: 'missing worker.js', type: 'module' } }, /missing worker|service_worker|background/i],
    ['content', { content_scripts: [{ matches: ['https://example.com/*'], js: ['missing content.js'] }] }, /missing content|content_scripts/i],
    ['icon', { icons: { 16: 'missing icon.png' } }, /missing icon|icons/i],
    ['web accessible', { web_accessible_resources: [{ resources: ['missing asset.json'], matches: ['https://example.com/*'] }] }, /missing asset|web_accessible_resources/i],
  ] as const)('diagnoses missing %s resource locations', async (_label, manifest, expression) => {
    failure(await diagnose(await fixture(manifest)), expression)
  })

  it('checks HTML script, stylesheet and image references including URL encoding', async () => {
    const item = await fixture({ action: { default_popup: 'popup page.html' } })
    await fs.writeFile(path.join(item.dist, 'popup page.html'), '<script src="./missing%20script.js?x=1#hash"></script><link rel="stylesheet" href="./missing.css"><img src="./missing.png">')
    const report = await diagnose(item)
    failure(report, /popup page.html/)
    expect(JSON.stringify(report.issues)).toMatch(/missing( |%20)script/)
    expect(JSON.stringify(report.issues)).toContain('missing.css')
    expect(JSON.stringify(report.issues)).toContain('missing.png')
  })

  it('accepts real local URL-encoded assets and ignores external or data references', async () => {
    const item = await fixture({ action: { default_popup: 'popup.html' } })
    await fs.writeFile(path.join(item.dist, 'popup.html'), '<link rel="stylesheet" href="./style%20file.css?version=1#part"><img src="data:image/png;base64,aA=="><img src="https://example.com/logo.png"><script src="./entry.js"></script>')
    await fs.writeFile(path.join(item.dist, 'style file.css'), 'body { color: red; }')
    await fs.writeFile(path.join(item.dist, 'entry.js'), 'console.log("ready")')
    const report = await diagnose(item)
    contract(report)
    expect(report.ok).toBe(true)
  })

  it.each([
    "script-src 'self' 'unsafe-eval'; object-src 'self'",
    "script-src 'self' https://example.com; object-src 'self'",
    "script-src 'self' 'unsafe-inline'; object-src 'self'",
    "default-src 'self' https://example.com; object-src 'self'",
    "script-src 'self'; object-src 'self'; worker-src https://example.com",
  ])('rejects clearly invalid extension CSP: %s', async (csp) => {
    failure(await diagnose(await fixture({ content_security_policy: { extension_pages: csp } })), /CSP|content_security_policy|script-src/i)
  })

  it('allows sandbox-specific unsafe-eval without applying extension-page restrictions', async () => {
    const item = await fixture({ sandbox: { pages: ['sandbox.html'] }, content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'", sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-eval'; child-src 'self'" } })
    await fs.writeFile(path.join(item.dist, 'sandbox.html'), '<!doctype html><title>Sandbox</title>')
    expect((await diagnose(item)).ok).toBe(true)
  })

  it('accepts restrictive default-src and local worker-src CSP directives', async () => {
    const item = await fixture({ content_security_policy: { extension_pages: "default-src 'self'; object-src 'self'; worker-src 'self'" } })
    expect((await diagnose(item)).ok).toBe(true)
  })

  it('reports unreachable dev server and unreachable CDP as failures, bounded by timeout', async () => {
    const item = await fixture()
    const start = Date.now()
    failure(await diagnose({ ...item, devUrl: 'http://127.0.0.1:1', timeoutMs: 100 }), /dev|connect|fetch|reach/i)
    failure(await diagnose({ ...item, cdp: 'http://127.0.0.1:1', extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeoutMs: 100 }), /CDP|Chrome|connect|reach/i)
    expect(Date.now() - start).toBeLessThan(2500)
  })

  it('times out a dev service that never responds', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const instance = http.createServer(() => {})
    instance.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => instance.close(() => resolve())) })
    const address = instance.address() as import('node:net').AddressInfo
    const start = Date.now()
    failure(await diagnose({ ...await fixture(), devUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 100 }), /time|abort/i)
    expect(Date.now() - start).toBeLessThan(2500)
  })

  it('diagnoses a failed development build and output-directory mismatch', async () => {
    const item = await fixture()
    const devUrl = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ revision: 4, building: false, error: 'fixture compile error', outDir: '/different/directory' })) })
    const report = await diagnose({ ...item, devUrl })
    failure(report, /fixture compile error|build/i)
    expect(JSON.stringify(report.issues)).toMatch(/out.?dir|directory|output/i)
  })

  it('reports development revision and building state from a reachable service', async () => {
    const item = await fixture()
    const devUrl = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ revision: 8, building: true, error: null, outDir: item.dist })) })
    const report = await diagnose({ ...item, devUrl })
    contract(report)
    const serialized = JSON.stringify(report.checks)
    expect(serialized).toContain('8')
    expect(serialized).toMatch(/building/i)
    expect(serialized).toContain(item.dist)
    expect(serialized).toContain(devUrl)
  })

  it('requires an extension id for requested CDP diagnostics', async () => {
    failure(await diagnose({ ...await fixture(), cdp: 'http://127.0.0.1:1', timeoutMs: 100 }), /extension.?id|--extension-id/i)
  })

  it('CLI writes valid JSON and successful exit code for explicit root and dist arguments', async () => {
    const item = await fixture()
    const result = await cli(['--root', item.root, '--dist', item.dist, '--json'])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.text) as Report
    contract(report)
    expect(report.ok).toBe(true)
  })

  it('CLI writes readable text and preserves failed diagnostic exit code', async () => {
    const item = await fixture()
    const success = await cli(['--dist', item.dist])
    expect(success.code).toBe(0)
    expect(success.text).toMatch(/pass|OK|healthy/i)
    await fs.rm(path.join(item.dist, 'manifest.json'))
    const failed = await cli(['--dist', item.dist])
    expect(failed.code).toBe(1)
    expect(failed.text).toMatch(/manifest/i)
  })

  it.each([
    ['--unknown', '--json'],
    ['--root', '--json'],
    ['--dist', '--json'],
    ['--dev-url', '--json'],
    ['--cdp', '--json'],
    ['--extension-id', '--json'],
  ])('CLI returns actionable JSON for invalid arguments %j', async (...args) => {
    const result = await cli(args)
    expect(result.code).toBe(1)
    const report = JSON.parse(result.text) as Report
    contract(report)
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'CLI_INVALID')).toBe(true)
  })

  it('CLI returns actionable text for unknown or missing arguments', async () => {
    for (const args of [['--unknown'], ['--dist']]) {
      const result = await cli(args)
      expect(result.code).toBe(1)
      expect(result.text).toMatch(/CLI_INVALID|unknown|requires|missing/i)
    }
  })

  it('CLI forwards dev and CDP diagnostics rather than silently ignoring them', async () => {
    const item = await fixture()
    const result = await cli(['--dist', item.dist, '--dev-url', 'http://127.0.0.1:1', '--cdp', 'http://127.0.0.1:1', '--extension-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--json'])
    expect(result.code).toBe(1)
    const report = JSON.parse(result.text) as Report
    expect(report.ok).toBe(false)
    expect(JSON.stringify(report.issues)).toMatch(/dev/i)
    expect(JSON.stringify(report.issues)).toMatch(/CDP|Chrome/i)
  })

  it('CLI prints help successfully without requiring a project output', async () => {
    const result = await cli(['--help'])
    expect(result.code).toBe(0)
    expect(result.text).toMatch(/--root/)
    expect(result.text).toMatch(/--dist/)
    expect(result.text).toMatch(/--json/)
  })

  it.each(['bad', '0', '-1', 'Infinity'])('CLI rejects invalid timeout value %s', async (timeout) => {
    const result = await cli(['--timeout-ms', timeout, '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.text).issues.some((issue: { code: string }) => issue.code === 'CLI_INVALID')).toBe(true)
  })

  it.each([true, false])('reports active AST sources separately from explicit permissions (autoPermissions=%s)', async (autoPermissions) => {
    const item = await fixture()
    await fs.writeFile(path.join(item.root, 'index.html'), '<script type="module" src="./active.ts"></script>')
    await fs.writeFile(path.join(item.root, 'active.ts'), 'chrome.storage.local.get("fixture"); console.log("chrome.history.search({})");')
    await fs.writeFile(path.join(item.root, 'unused.ts'), 'chrome.bookmarks.getTree();')
    await build({
      root: item.root, configFile: false, logLevel: 'silent',
      plugins: [extension({
        pages: false, tailwind: false, autoPermissions,
        manifest: { name: 'Permission Sources', version: '1.0.0', permissions: ['tabs'], host_permissions: ['https://example.com/*'] },
      })],
      build: { outDir: item.dist, emptyOutDir: true },
    })
    const report = await diagnose(item)
    contract(report)
    expect(report.ok).toBe(true)
    expect(report.permissions.explicit).toEqual(['tabs'])
    expect(report.permissions.hostPermissions).toEqual(['https://example.com/*'])
    expect(report.permissions.autoPermissions).toBe(autoPermissions)
    expect(report.permissions.actual).toEqual(autoPermissions ? ['tabs', 'storage'] : ['tabs'])
    const evidence = JSON.stringify(report.permissions.inferred)
    expect(evidence).not.toContain('bookmarks')
    expect(evidence).not.toContain('history')
    if (autoPermissions) {
      expect(evidence).toContain('storage')
      expect(evidence).toContain('active.ts')
      expect(evidence).toMatch(/chrome\.storage/)
    }
  })

  it('does not invent source attribution for a prebuilt third-party extension', async () => {
    const report = await diagnose(await fixture({ permissions: ['tabs'] }))
    expect(report.permissions.explicit).toBeNull()
    expect(report.permissions.autoPermissions).toBeNull()
    expect(report.permissions.inferred).toEqual([])
    expect(JSON.stringify(report.issues)).toMatch(/rebuild|build|构建/i)
  })

  it('reports corrupted permission attribution without treating it as valid provenance', async () => {
    const item = await fixture({ permissions: ['storage'] })
    await fs.writeFile(path.join(item.dist, 'chrome-extension-diagnostics.json'), '{invalid')
    const report = await diagnose(item)
    expect(report.permissions.explicit).toBeNull()
    expect(report.permissions.inferred).toEqual([])
    expect(report.issues.some((issue) => /diagnostic|source|provenance|permission/i.test(issue.code + issue.message))).toBe(true)
  })

  it.each([
    { explicit: [4], autoPermissions: true, inferred: [] },
    { explicit: [], autoPermissions: true, inferred: [{}] },
    { explicit: [], autoPermissions: true, inferred: [{ permission: 'storage' }] },
    { explicit: [], autoPermissions: true, inferred: [{ permission: 'storage', sources: [{ api: 'chrome.storage' }] }] },
    { explicit: [], autoPermissions: 'enabled', inferred: [] },
    { explicit: [''], autoPermissions: true, inferred: [] },
    { explicit: [], autoPermissions: true, inferred: [{ permission: '', sources: [] }] },
    { explicit: [], autoPermissions: true, inferred: [{ permission: 'storage', sources: [{ file: '', api: 'chrome.storage' }] }] },
    { explicit: [], autoPermissions: true, inferred: [{ permission: 'storage', sources: [{ file: 'active.ts', api: '' }] }] },
  ])('rejects malformed permission provenance rather than trusting invalid source shapes %#', async (permissions) => {
    const item = await fixture({ permissions: ['storage'] })
    await fs.writeFile(path.join(item.dist, 'chrome-extension-diagnostics.json'), JSON.stringify({ version: 1, permissions }))
    const report = await diagnose(item)
    contract(report)
    expect(report.permissions.explicit).toBeNull()
    expect(report.permissions.inferred).toEqual([])
    expect(report.permissions.autoPermissions).toBeNull()
    expect(report.issues.some((issue) => /diagnostic|source|provenance|permission/i.test(issue.code + issue.message))).toBe(true)
  })

  it.each([null, 5, 'metadata', [], { version: 2, permissions: { explicit: [], autoPermissions: true, inferred: [] } }])('does not trust non-object or unsupported-version provenance %#', async (metadata) => {
    const item = await fixture()
    await fs.writeFile(path.join(item.dist, 'chrome-extension-diagnostics.json'), JSON.stringify(metadata))
    const report = await diagnose(item)
    contract(report)
    expect(report.permissions.explicit).toBeNull()
    expect(report.permissions.inferred).toEqual([])
    expect(report.permissions.autoPermissions).toBeNull()
    expect(report.issues.some((issue) => /diagnostic|source|provenance|permission/i.test(issue.code + issue.message))).toBe(true)
  })

  it('rejects traversing manifest references without reading outside the output', async () => {
    const item = await fixture({ action: { default_popup: '../private.html' } })
    await fs.writeFile(path.join(item.root, 'private.html'), '<h1>Outside output</h1>')
    failure(await diagnose(item), /private.html|outside|travers/i)
  })

  it('finds missing script chunks referenced by a worker and stylesheets', async () => {
    const item = await fixture({ background: { service_worker: 'worker.js', type: 'module' }, content_scripts: [{ matches: ['https://example.com/*'], css: ['content.css'] }] })
    await fs.writeFile(path.join(item.dist, 'worker.js'), 'import "./missing-chunk.js";')
    await fs.writeFile(path.join(item.dist, 'content.css'), 'body { background: url("./missing-image.png"); }')
    const report = await diagnose(item)
    failure(report, /missing-chunk.js/)
    expect(JSON.stringify(report.issues)).toContain('missing-image.png')
  })

  it('accepts valid module imports and CSS assets without confusing JavaScript strings with imports', async () => {
    const item = await fixture({ background: { service_worker: 'worker.js', type: 'module' }, content_scripts: [{ matches: ['https://example.com/*'], css: ['content.css'] }] })
    await fs.writeFile(path.join(item.dist, 'worker.js'), 'import "./chunk.js"; console.log(\'import "./example-only.js"\'); // import "./comment-only.js"\n')
    await fs.writeFile(path.join(item.dist, 'chunk.js'), 'console.log("chunk");')
    await fs.writeFile(path.join(item.dist, 'content.css'), 'body { background: url("./real%20image.svg"); }')
    await fs.writeFile(path.join(item.dist, 'real image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const report = await diagnose(item)
    contract(report)
    expect(report.ok).toBe(true)
  })

  it('resolves the default output directory relative to the supplied project root', async () => {
    const item = await fixture()
    await fs.rename(item.dist, path.join(item.root, 'dist'))
    const report = await diagnose({ root: item.root })
    expect(report.ok).toBe(true)
  })

  it('resolves a relative output directory and validates nested CSS, dynamic imports and importScripts resources', async () => {
    const item = await fixture({
      background: { service_worker: 'worker.js' },
      action: { default_popup: 'popup.html' },
      web_accessible_resources: [{ resources: ['assets/*.svg'], matches: ['https://example.com/*'] }],
    })
    await fs.mkdir(path.join(item.dist, 'assets'))
    await fs.writeFile(path.join(item.dist, 'assets/icon.svg'), '<svg/>')
    await fs.writeFile(path.join(item.dist, 'worker.js'), 'importScripts("./shared.js"); import("./module.js");')
    await fs.writeFile(path.join(item.dist, 'shared.js'), 'console.log("shared");')
    await fs.writeFile(path.join(item.dist, 'module.js'), 'export const value=1;')
    await fs.writeFile(path.join(item.dist, 'popup.html'), '<a href="#part">jump</a><link rel="stylesheet" href="./style.css"><img src="https://example.com/img.png"><iframe src="about:blank"></iframe>')
    await fs.writeFile(path.join(item.dist, 'style.css'), '@import "./nested.css"; body{background:url("data:image/png;base64,aA==")}')
    await fs.writeFile(path.join(item.dist, 'nested.css'), 'body{background:url("./assets/icon.svg")}')
    expect((await diagnose({ root: item.root, dist: 'output files' })).ok).toBe(true)
  })

  it('checks worker URL assets and reports a missing dynamic import or classic script', async () => {
    const item = await fixture({ background: { service_worker: 'worker.js', type: 'module' } })
    await fs.writeFile(path.join(item.dist, 'worker.js'), 'import("./dynamic.js"); importScripts("./classic.js"); new URL("./asset.json",import.meta.url); new URL("https://example.com");')
    const report = await diagnose(item)
    failure(report, /dynamic.js/)
    expect(JSON.stringify(report.issues)).toContain('classic.js')
    expect(JSON.stringify(report.issues)).toContain('asset.json')
    await fs.writeFile(path.join(item.dist, 'dynamic.js'), 'export default 1;')
    await fs.writeFile(path.join(item.dist, 'classic.js'), 'console.log("classic");')
    await fs.writeFile(path.join(item.dist, 'asset.json'), '{}')
    expect((await diagnose(item)).ok).toBe(true)
  })

  it('reports WAR wildcard patterns with zero matching files', async () => {
    const item = await fixture({ web_accessible_resources: [{ resources: ['assets/*.png'], matches: ['https://example.com/*'] }] })
    failure(await diagnose(item), /assets\/\*\.png|web_accessible_resources/i)
  })

  it('handles malformed percent escapes in local URLs without losing file attribution', async () => {
    const item = await fixture({ action: { default_popup: 'popup.html' } })
    await fs.writeFile(path.join(item.dist, 'popup.html'), '<body><script src="./broken%escape.js"></script></body>')
    failure(await diagnose(item), /broken%escape.js/)
    await fs.writeFile(path.join(item.dist, 'broken%escape.js'), 'console.log("literal filename");')
    expect((await diagnose(item)).ok).toBe(true)
  })

  it('distinguishes an absent or malformed manifest object from a valid JSON document', async () => {
    for (const value of [null, [], 3, 'manifest']) {
      const item = await fixture()
      await fs.writeFile(path.join(item.dist, 'manifest.json'), JSON.stringify(value))
      const report = await diagnose(item)
      contract(report)
      expect(report.ok).toBe(false)
    }
  })

  it('returns a structured report when no options or output are available', async () => {
    const api = await import(moduleName)
    const report = await api.diagnoseExtension()
    contract(report)
    expect(report.issues).toBeInstanceOf(Array)
  })

  it('rejects malformed dev status responses and HTTP error pages', async () => {
    const item = await fixture()
    const malformed = await server((_req, res) => { res.end('not json') })
    failure(await diagnose({ ...item, devUrl: malformed }), /dev|status|JSON|server/i)
    const httpError = await server((_req, res) => { res.statusCode = 503; res.end('Unavailable') })
    failure(await diagnose({ ...item, devUrl: httpError }), /503|dev|server/i)
  })

  it.each([null, {}, [], { revision: 'unknown', building: 'yes', error: null }])('does not accept an invalid development-status schema %#', async (status) => {
    const item = await fixture()
    const devUrl = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status)) })
    const report = await diagnose({ ...item, devUrl })
    failure(report, /dev|status|revision|directory|output/i)
  })

  it('reports malformed CDP version responses and avoids treating arbitrary JSON as a browser', async () => {
    const item = await fixture()
    const cdp = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}') })
    failure(await diagnose({ ...item, cdp, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeoutMs: 100 }), /CDP|Chrome|browser|websocket/i)
  })

  it('returns a bounded failure when the advertised CDP WebSocket connection is rejected', async () => {
    const instance = http.createServer((_req, res) => {
      const address = instance.address() as import('node:net').AddressInfo
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fixture` }))
    })
    instance.on('upgrade', (_request, socket) => socket.destroy())
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => instance.close(() => resolve())))
    const address = instance.address() as import('node:net').AddressInfo
    const start = Date.now()
    failure(await diagnose({ ...await fixture(), cdp: `http://127.0.0.1:${address.port}`, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeoutMs: 100 }), /CDP|Chrome|websocket|socket/i)
    expect(Date.now() - start).toBeLessThan(2500)
  })

  it('diagnoses an actual plugin development server without altering its output', async () => {
    const item = await fixture()
    await fs.writeFile(path.join(item.root, 'index.html'), '<script type="module" src="./active.ts"></script>')
    await fs.writeFile(path.join(item.root, 'active.ts'), 'console.log("doctor development");')
    const vite = await createServer({
      root: item.root, configFile: false, logLevel: 'silent',
      plugins: [extension({ pages: false, tailwind: false, manifest: { name: 'Development Doctor', version: '1.0.0' } })],
      build: { outDir: item.dist }, server: { host: '127.0.0.1', port: 0 },
    })
    cleanup.push(() => vite.close())
    await vite.listen()
    const address = vite.httpServer!.address() as import('node:net').AddressInfo
    const devUrl = `http://127.0.0.1:${address.port}`
    for (let n = 0; n < 100; n++) {
      const status = await (await fetch(`${devUrl}/__chrome_extension_dev_status__`)).json() as { revision?: number }
      if (status.revision) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const before = await fs.readFile(path.join(item.dist, 'manifest.json'), 'utf8')
    const report = await diagnose({ ...item, devUrl })
    contract(report)
    expect(report.ok).toBe(true)
    expect(report.checks.some((check) => check.status === 'pass' && /dev/i.test(check.id))).toBe(true)
    expect(await fs.readFile(path.join(item.dist, 'manifest.json'), 'utf8')).toBe(before)
  }, 10000)

  it.skipIf(!chromeForTesting)('validates real Chrome worker registration, runtime errors, contexts and read-only cleanup', async () => {
    const smokeModule = '../../../scripts/doctor-smoke.mjs'
    const { runDoctorSmoke } = await import(smokeModule)
    const report = await runDoctorSmoke(diagnose, { args: ['--chrome', chromeForTesting] })
    expect(report.checks).toHaveLength(9)
  }, 30000)
})
