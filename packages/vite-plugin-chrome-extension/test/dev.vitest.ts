import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build, loadConfigFromFile } from 'vite'
import {
  DEV_CLIENT_FILE,
  DEV_HELLO_EVENT,
  DEV_RELOAD_EVENT,
  DEV_STATUS_PATH,
  DEV_WORKER_FILE,
  configureExtensionDevServer,
  copyDevConfig,
  createDevOutputPlugin,
  extensionReloadSnapshot,
  publishDevBuild,
  reloadClientSource,
  resolveDevInput,
  resolveReloadConnection,
} from '../dev.js'

vi.mock('vite', async (original) => ({
  ...await original<typeof import('vite')>(),
  build: vi.fn(),
  loadConfigFromFile: vi.fn(),
}))

function hook(value: any) { return typeof value === 'function' ? value : value.handler }
const connection = { socketUrl: 'ws://localhost:5173/?token=test', httpOrigin: 'http://localhost:5173', session: 'test-session', revision: 1 }
const state = { session: 'test-session', revision: 0, building: false, error: null, outDir: '/workspace/dist' }
const temporary: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function outputPlugin(manifest: Record<string, any>, extra: Record<string, any> = {}, publicDir: string | false = false) {
  const plugin = createDevOutputPlugin(() => connection)
  hook(plugin.configResolved)({ publicDir, root: '/workspace', build: { outDir: 'dist' } })
  const bundle: Record<string, any> = {
    'manifest.json': { type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest) },
    ...extra,
  }
  const emitFile = vi.fn((file: any) => { bundle[file.fileName] = file; return file.fileName })
  const run = () => hook(plugin.generateBundle).call({ emitFile }, {}, bundle, false)
  return { bundle, emitFile, run, plugin }
}

function fakeServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-server-unit-'))
  temporary.push(root)
  const httpServer = Object.assign(new EventEmitter(), { listening: true, address: () => ({ port: 5173 }) })
  const ws = Object.assign(new EventEmitter(), { send: vi.fn() })
  const watcher = new EventEmitter()
  let middleware: any
  const server: any = {
    httpServer, ws, watcher,
    middlewares: { use: (callback: any) => { middleware = callback } },
    config: {
      root, base: '/', mode: 'development', configFile: false,
      publicDir: path.join(root, 'public'), inlineConfig: {}, webSocketToken: 'test',
      server: {}, build: { outDir: 'dist' }, logger: { error: vi.fn(), info: vi.fn() },
    },
  }
  return { server, httpServer, ws, watcher, middleware: () => middleware }
}

async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('CASE-06 dev output', () => {
  it('copies config containers and keeps function values usable', () => {
    const callback = () => 1
    const original = { build: { target: ['es2022'] }, callback, date: new Date() }
    const copy = copyDevConfig(original)
    copy.build.target.push('es2020')
    expect(original.build.target).toEqual(['es2022'])
    expect(copy.callback).toBe(callback)
    expect(copy.date).toBe(original.date)
  })

  it('publishes complete builds atomically and restores the previous output when replacement fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-publish-unit-'))
    temporary.push(root)
    const staging = path.join(root, 'staging')
    const dist = path.join(root, 'dist')
    fs.mkdirSync(staging)
    fs.mkdirSync(dist)
    fs.writeFileSync(path.join(staging, 'worker.js'), 'new worker')
    fs.writeFileSync(path.join(dist, 'worker.js'), 'old worker')
    const rename = fs.renameSync
    let calls = 0
    const mock = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      calls += 1
      if (calls === 2) throw new Error('replacement failed')
      return rename(...args)
    })
    expect(() => publishDevBuild(staging, dist)).toThrow('replacement failed')
    mock.mockRestore()
    expect(fs.readFileSync(path.join(dist, 'worker.js'), 'utf8')).toBe('old worker')
    publishDevBuild(staging, dist)
    expect(fs.readFileSync(path.join(dist, 'worker.js'), 'utf8')).toBe('new worker')
    expect(fs.readdirSync(root).sort()).toEqual(['dist', 'staging'])
  })

  it('resolves file inputs from the project root while preserving virtual, alias and absolute IDs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-input-'))
    temporary.push(root)
    fs.mkdirSync(path.join(root, 'modules'), { recursive: true })
    fs.writeFileSync(path.join(root, 'modules/worker.ts'), '')
    const absolute = path.join(root, 'modules/worker.ts')
    expect(resolveDevInput('modules/worker.ts', root)).toBe(absolute)
    expect(resolveDevInput(['modules/worker.ts', '/absolute.ts', 'virtual:entry', '\0entry', '@/entry'], root)).toEqual([absolute, '/absolute.ts', 'virtual:entry', '\0entry', '@/entry'])
    expect(resolveDevInput({ worker: 'modules/worker.ts' }, root)).toEqual({ worker: absolute })
    expect(resolveDevInput(undefined, root)).toBeUndefined()
  })

  it('distinguishes page-only updates from worker/content dependencies and manifest registration changes', () => {
    const manifest = {
      background: { service_worker: 'worker.js' },
      content_scripts: [{ js: ['content.js'], css: ['content.css'] }],
    }
    const chunk = (code: string, overrides = {}) => ({ type: 'chunk', code, imports: [], dynamicImports: [], referencedFiles: [], ...overrides })
    const bundle: any = {
      'worker.js': chunk('worker', { imports: ['helper.js'] }),
      'helper.js': chunk('helper', { imports: ['worker.js'] }),
      'content.js': chunk('content', { dynamicImports: ['dynamic.js'], referencedFiles: ['image.svg'], viteMetadata: { importedCss: new Set(['content.css']), importedAssets: new Set(['image.svg']) } }),
      'dynamic.js': chunk('dynamic'),
      'content.css': { type: 'asset', source: 'css' },
      'image.svg': { type: 'asset', source: 'image' },
      'popup.js': chunk('popup'),
    }
    const first = extensionReloadSnapshot(manifest, bundle, false)
    bundle['popup.js'].code = 'new popup'
    expect(extensionReloadSnapshot(manifest, bundle, false)).toBe(first)
    for (const name of ['helper.js', 'content.js', 'dynamic.js']) {
      const before = bundle[name].code
      bundle[name].code += ' changed'
      expect(extensionReloadSnapshot(manifest, bundle, false)).not.toBe(first)
      bundle[name].code = before
    }
    expect(extensionReloadSnapshot({ ...manifest, permissions: ['tabs'] }, bundle, false)).not.toBe(first)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-snapshot-'))
    temporary.push(root)
    fs.writeFileSync(path.join(root, 'public.js'), 'worker one')
    const publicManifest = { background: { service_worker: 'public.js' } }
    const old = extensionReloadSnapshot(publicManifest, {}, root)
    fs.writeFileSync(path.join(root, 'public.js'), 'worker two')
    expect(extensionReloadSnapshot(publicManifest, {}, root)).not.toBe(old)
  })

  it('injects local clients, a coordinator worker and narrow development connection permissions', () => {
    const { bundle, run } = outputPlugin({ host_permissions: ['https://example.com/*'] }, {
      'modules/popup/index.html': { type: 'asset', fileName: 'modules/popup/index.html', source: '<head></head><body>Popup</body>' },
      'custom.html': { type: 'asset', fileName: 'custom.html', source: '<body>Custom</body>' },
    })
    run()
    const manifest = JSON.parse(bundle['manifest.json'].source)
    expect(manifest.background).toEqual({ service_worker: DEV_WORKER_FILE })
    expect(manifest.host_permissions).toEqual(['https://example.com/*', 'http://localhost:5173/*'])
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'self'; connect-src * ws://localhost:5173 http://localhost:5173;")
    expect(bundle[DEV_WORKER_FILE].source).toContain('chrome.runtime.reload()')
    expect(bundle[DEV_CLIENT_FILE].source).toContain('location.reload()')
    expect(bundle['modules/popup/index.html'].source).toContain(`src="../../${DEV_CLIENT_FILE}"`)
    expect(bundle['custom.html'].source).toContain(`src="${DEV_CLIENT_FILE}"`)
    expect(manifest.content_security_policy.extension_pages).not.toContain('unsafe-eval')
  })

  it('preserves worker modules and custom CSP, replacing a connect-src none restriction only in dev', () => {
    const { bundle, run } = outputPlugin({
      background: { service_worker: 'worker.js', type: 'module' },
      content_security_policy: { extension_pages: "script-src 'self'; connect-src 'none';", sandbox: 'sandbox allow-scripts' },
    }, { 'worker.js': { type: 'chunk', fileName: 'worker.js', code: 'console.log("background")' } })
    run()
    const manifest = JSON.parse(bundle['manifest.json'].source)
    expect(bundle['worker.js'].code).toContain('console.log("background")')
    expect(bundle['worker.js'].code).toContain('chrome.runtime.reload()')
    expect(manifest.background.type).toBe('module')
    expect(manifest.content_security_policy.sandbox).toBe('sandbox allow-scripts')
    expect(manifest.content_security_policy.extension_pages).toContain('connect-src ws://localhost:5173 http://localhost:5173')
  })

  it('supports asset/public workers and fails clearly for missing manifest or worker outputs', () => {
    const asset = outputPlugin({ background: { service_worker: 'worker.js' } }, { 'worker.js': { type: 'asset', fileName: 'worker.js', source: '/* asset worker */' } })
    asset.run()
    expect(asset.bundle['worker.js'].source).toContain('/* asset worker */')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-unit-'))
    temporary.push(root)
    fs.writeFileSync(path.join(root, 'public-worker.js'), '/* public worker */')
    const publicWorker = outputPlugin({ background: { service_worker: 'public-worker.js' } }, {}, root)
    publicWorker.run()
    expect(publicWorker.bundle['public-worker.js'].source).toContain('/* public worker */')
    const missingWorker = outputPlugin({ background: { service_worker: 'missing.js' } })
    expect(missingWorker.run).toThrow('missing worker missing.js')
    const missingManifest = outputPlugin({})
    delete missingManifest.bundle['manifest.json']
    expect(missingManifest.run).toThrow('did not emit manifest.json')
    expect(outputPlugin({}, { [DEV_CLIENT_FILE]: { type: 'asset', fileName: DEV_CLIENT_FILE, source: '' } }).run).toThrow('is reserved')
  })

  it('copies public files after successful writes and protects generated worker and manifest outputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-public-copy-'))
    temporary.push(root)
    const publicDir = path.join(root, 'public')
    const dist = path.join(root, 'dist')
    fs.mkdirSync(publicDir)
    fs.mkdirSync(dist)
    fs.writeFileSync(path.join(publicDir, 'worker.js'), 'raw worker')
    fs.writeFileSync(path.join(publicDir, 'data.json'), '{"ready":true}')
    fs.writeFileSync(path.join(dist, 'worker.js'), 'injected worker')
    const { plugin, bundle } = outputPlugin({}, { 'worker.js': { type: 'asset', source: 'injected worker' } }, publicDir)
    hook(plugin.writeBundle).call({}, { dir: dist }, bundle)
    expect(fs.readFileSync(path.join(dist, 'worker.js'), 'utf8')).toBe('injected worker')
    expect(fs.readFileSync(path.join(dist, 'data.json'), 'utf8')).toBe('{"ready":true}')
    const disabled = outputPlugin({})
    expect(() => hook(disabled.plugin.writeBundle).call({}, {}, disabled.bundle)).not.toThrow()
  })

  it('resolves tokenized WebSocket endpoints and rejects middleware mode', () => {
    const { server } = fakeServer()
    expect(resolveReloadConnection(server, state)).toEqual(connection)
    server.config.server = { https: {}, hmr: { host: '127.0.0.1', clientPort: 9000, protocol: 'wss', path: '/socket' } }
    expect(resolveReloadConnection(server, state).socketUrl).toBe('wss://127.0.0.1:9000/socket?token=test')
    expect(resolveReloadConnection(server, state).httpOrigin).toBe('https://localhost:5173')
    server.config.webSocketToken = ''
    server.config.server = { hmr: { port: 8000 } }
    expect(resolveReloadConnection(server, state).socketUrl).toBe('ws://localhost:8000/')
    server.httpServer.address = () => null
    expect(() => resolveReloadConnection(server, state)).toThrow('middleware mode is unsupported')
  })
})

describe('CASE-06 build-backed server lifecycle', () => {
  it('notifies only after successful writes, reports errors and cleans up watcher/listeners', async () => {
    const { server, ws, middleware } = fakeServer()
    const buildWatcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
    vi.mocked(build).mockResolvedValue(buildWatcher as any)
    const create = vi.fn(() => ({ name: 'vite-plugin-chrome-extension' }))
    const cleanup = await configureExtensionDevServer(server, {
      plugins: [Promise.resolve([{ name: 'vite-plugin-chrome-extension' }, { name: 'framework' }])],
      build: { target: 'es2022' },
    }, {}, { name: 'Serve manifest' }, create)
    await flush()
    expect(create).toHaveBeenCalledWith({ manifest: { name: 'Serve manifest' }, liveReload: false })
    const config: any = vi.mocked(build).mock.calls[0][0]
    expect(config.configFile).toBe(false)
    expect(config.build).toMatchObject({ target: 'es2022', watch: {}, minify: false, emptyOutDir: true, copyPublicDir: false })
    expect(config.build.outDir).not.toBe(path.join(server.config.root, 'dist'))
    expect(config.plugins.flat().filter(Boolean).map((plugin: any) => plugin.name)).toEqual(['framework', 'vite-plugin-chrome-extension', 'chrome-extension-dev-output'])
    const client = { send: vi.fn() }
    ws.emit(DEV_HELLO_EVENT, {}, client)
    expect(client.send).not.toHaveBeenCalled()
    buildWatcher.emit('event', { code: 'START' })
    buildWatcher.emit('event', { code: 'ERROR', error: new Error('Syntax error') })
    buildWatcher.emit('event', { code: 'END' })
    expect(ws.send).not.toHaveBeenCalled()
    const response = { setHeader: vi.fn(), end: vi.fn() }
    const next = vi.fn()
    middleware()({ url: '/another', headers: {} }, response, next)
    expect(next).toHaveBeenCalledOnce()
    middleware()({ url: DEV_STATUS_PATH, headers: { origin: `chrome-extension://${'a'.repeat(32)}` } }, response, next)
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({ error: 'Syntax error', revision: 0 })
    buildWatcher.emit('event', { code: 'START' })
    ws.emit(DEV_HELLO_EVENT, {}, client)
    expect(client.send).not.toHaveBeenCalled()
    buildWatcher.emit('event', { code: 'END' })
    expect(ws.send).toHaveBeenCalledWith(DEV_RELOAD_EVENT, expect.objectContaining({ revision: 1 }))
    ws.emit(DEV_HELLO_EVENT, {}, client)
    expect(client.send).toHaveBeenCalledWith(DEV_RELOAD_EVENT, expect.objectContaining({ revision: 1 }))
    await cleanup()
    expect(buildWatcher.close).toHaveBeenCalled()
    expect(ws.listenerCount(DEV_HELLO_EVENT)).toBe(0)
    expect(server.watcher.listenerCount('change')).toBe(0)
  })

  it('reloads config files in serve mode, starts after listening and rebuilds new pages/public files', async () => {
    vi.useFakeTimers()
    const { server, httpServer, watcher } = fakeServer()
    server.config.configFile = '/workspace/vite.config.ts'
    httpServer.listening = false
    const buildWatcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
    vi.mocked(build).mockResolvedValue(buildWatcher as any)
    vi.mocked(loadConfigFromFile).mockResolvedValue({ config: { plugins: [{ name: 'framework' }] } } as any)
    const cleanup = await configureExtensionDevServer(server, {}, {}, {}, () => ({ name: 'vite-plugin-chrome-extension' }))
    expect(build).not.toHaveBeenCalled()
    httpServer.emit('listening')
    await flush()
    expect(loadConfigFromFile).toHaveBeenCalledWith({ command: 'serve', mode: 'development' }, '/workspace/vite.config.ts', server.config.root)
    watcher.emit('add', path.join(server.config.root, 'unrelated.txt'))
    watcher.emit('change', path.join(server.config.root, 'entry.ts'))
    await vi.advanceTimersByTimeAsync(100)
    expect(build).toHaveBeenCalledTimes(1)
    watcher.emit('add', path.join(server.config.root, 'modules/new/index.html'))
    await vi.advanceTimersByTimeAsync(100)
    expect(build).toHaveBeenCalledTimes(2)
    watcher.emit('change', path.join(server.config.root, 'public/data.json'))
    await vi.advanceTimersByTimeAsync(100)
    expect(build).toHaveBeenCalledTimes(3)
    await cleanup()
    httpServer.emit('close')
    await flush()
  })

  it('reports startup failures and handles close before startup finishes', async () => {
    const { server, httpServer } = fakeServer()
    vi.mocked(build).mockRejectedValueOnce(new Error('Build setup failed'))
    const cleanup = await configureExtensionDevServer(server, {}, {}, {}, () => ({ name: 'vite-plugin-chrome-extension' }))
    await flush()
    expect(server.config.logger.error).toHaveBeenCalledWith(expect.stringContaining('Build setup failed'))
    await cleanup()
    httpServer.listening = false
    const late = await configureExtensionDevServer(server, {}, {}, {}, () => ({ name: 'vite-plugin-chrome-extension' }))
    await late()
    httpServer.emit('listening')
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('CASE-06 runtime client', () => {
  it('ignores initial/unrelated/malformed state, heartbeats and reloads once on a newer successful revision', () => {
    const sockets: any[] = []
    class Socket extends EventEmitter {
      static OPEN = 1
      readyState = 1
      send = vi.fn()
      close = vi.fn()
      addEventListener(name: string, listener: (...args: any[]) => void) { this.on(name, listener) }
      constructor(public url: string, public protocol: string) { super(); sockets.push(this) }
    }
    const reload = vi.fn()
    const heartbeat: any[] = []
    const pagehide: any[] = []
    vm.runInNewContext(reloadClientSource(connection, true), {
      WebSocket: Socket, chrome: { runtime: { reload } },
      setInterval: (fn: any) => { heartbeat.push(fn); return 1 }, clearInterval: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn(),
    })
    const socket = sockets[0]
    socket.emit('open')
    heartbeat[0]()
    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(socket.url).toBe(connection.socketUrl)
    const message = (data: unknown) => socket.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })
    message('invalid json')
    message({ type: 'connected' })
    message({ type: 'custom', event: DEV_RELOAD_EVENT })
    message({ type: 'custom', event: DEV_RELOAD_EVENT, data: { session: connection.session, revision: 1 } })
    expect(reload).not.toHaveBeenCalled()
    message({ type: 'custom', event: DEV_RELOAD_EVENT, data: { session: connection.session, revision: 2, reloadExtension: false } })
    expect(reload).not.toHaveBeenCalled()
    message({ type: 'custom', event: DEV_RELOAD_EVENT, data: { session: connection.session, revision: 3, reloadExtension: true } })
    expect(reload).toHaveBeenCalledOnce()
    message({ type: 'custom', event: DEV_RELOAD_EVENT, data: { session: 'another-session', revision: 4 } })
    expect(reload).toHaveBeenCalledOnce()
    expect(socket.close).toHaveBeenCalledOnce()
    vm.runInNewContext(reloadClientSource(connection, false), {
      WebSocket: Socket, location: { reload }, addEventListener: (...args: any[]) => pagehide.push(args),
      setInterval: vi.fn(), clearInterval: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn(),
    })
    pagehide[0][1]()
    expect(sockets[1].close).toHaveBeenCalledOnce()
    vm.runInNewContext(reloadClientSource(connection, true), {
      WebSocket: Socket, chrome: { runtime: { reload } },
      setInterval: vi.fn(), clearInterval: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn(),
    })
    // This worker missed a full revision 2 while offline, then reconnects after
    // a page-only revision 3. Catch up to the full runtime update.
    sockets[2].emit('message', { data: JSON.stringify({ type: 'custom', event: DEV_RELOAD_EVENT, data: {
      session: connection.session, revision: 3, reloadExtension: false, lastExtensionReloadRevision: 2,
    } }) })
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
