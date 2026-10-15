import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const rule = (changes = {}) => ({
  id: 'rule', enabled: true, urlContains: '/data', resourceTypes: ['Fetch'],
  headerScript: 'return headers', bodyScript: '', ...changes,
})
const response = (changes = {}) => ({
  requestId: 'request', request: { url: 'https://example.test/data' }, resourceType: 'Fetch',
  responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
  ...changes,
})
async function setup(storedRules = [rule()], delayedStorage = false) {
  vi.resetModules()
  let messageHandler: any
  let eventHandler: any
  let detachHandler: any
  let release: () => void = () => {}
  const ready = delayedStorage ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
  const sendCommand = vi.fn(async (_source: unknown, method: string) => {
    if (method === 'Fetch.getResponseBody') return { body: '/wCAQQ==', base64Encoded: true }
    return {}
  })
  const api = {
    storage: { local: { get: vi.fn(async () => { await ready; return { 'network-rewrite-rules': storedRules } }), set: vi.fn(async () => {}) } },
    tabs: { query: vi.fn(async () => [{ id: 42, url: 'https://example.test/', title: 'Example' }]) },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    offscreen: { hasDocument: vi.fn(async () => true), Reason: { IFRAME_SCRIPTING: 'IFRAME_SCRIPTING' } },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: (listener: any) => { messageHandler = listener } },
      sendMessage: vi.fn(async () => ({ ok: true, result: [{ name: 'x-rewritten', value: 'yes' }] })),
    },
    debugger: {
      attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand,
      onEvent: { addListener: (listener: any) => { eventHandler = listener } },
      onDetach: { addListener: (listener: any) => { detachHandler = listener } },
    },
  }
  vi.stubGlobal('chrome', api)
  await import('../modules/background/background')
  const message = (payload: unknown) => new Promise<any>(resolve => messageHandler(payload, {}, resolve))
  return { api, message, release, event: (payload: unknown) => eventHandler({ tabId: 42 }, 'Fetch.requestPaused', payload), detach: () => detachHandler({ tabId: 42 }) }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('response rewrite runtime', () => {
  it('lets Chrome open the side panel directly from the toolbar action', async () => {
    const runtime = await setup()
    expect(runtime.api.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true })
  })
  it('waits for persisted rules before returning initial state', async () => {
    const runtime = await setup([rule()], true)
    let settled = false
    const request = runtime.message({ type: 'GET_STATE' }).then(result => { settled = true; return result })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    runtime.release()
    expect((await request).data.rules).toHaveLength(1)
  })

  it('preserves binary bytes on header-only rewrites', async () => {
    const runtime = await setup()
    await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    runtime.event(response())
    await vi.waitFor(() => expect(runtime.api.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 }, 'Fetch.fulfillRequest', expect.objectContaining({ body: '/wCAQQ==' }),
    ))
  })

  it('reports failed scripts and continues the original response', async () => {
    const runtime = await setup()
    runtime.api.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'script exploded' } as any)
    await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    runtime.event(response())
    await vi.waitFor(() => expect(runtime.api.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 }, 'Fetch.continueRequest', { requestId: 'request' },
    ))
    const result = await runtime.message({ type: 'GET_STATE' })
    expect(result.data.stats.failed).toBe(1)
    expect(result.data.lastError).toContain('script exploded')
  })

  it('does not leave a request pending when Fetch.enable immediately emits an event', async () => {
    const runtime = await setup()
    const original = runtime.api.debugger.sendCommand.getMockImplementation()!
    runtime.api.debugger.sendCommand.mockImplementation(async (source, method) => {
      if (method === 'Fetch.enable') runtime.event(response({ request: { url: 'https://example.test/unmatched' } }))
      return original(source, method)
    })
    await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    await vi.waitFor(() => expect(runtime.api.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 }, 'Fetch.continueRequest', { requestId: 'request' },
    ))
  })

  it('rejects restricted URLs with a useful error', async () => {
    const runtime = await setup()
    runtime.api.tabs.query.mockResolvedValue([{ id: 42, url: 'chrome-extension://other/index.html', title: 'Extension' }])
    const result = await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP')
    expect(runtime.api.debugger.attach).not.toHaveBeenCalled()
  })

  it('clears state when Chrome detaches the debugger', async () => {
    const runtime = await setup()
    await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    runtime.detach()
    expect((await runtime.message({ type: 'GET_STATE' })).data.attachedTabId).toBeNull()
  })

  it.each([204, 304, 302])('continues status %i without attempting to read an unavailable body', async status => {
    const runtime = await setup()
    await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    runtime.event(response({ responseStatusCode: status }))
    await vi.waitFor(() => expect(runtime.api.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 }, 'Fetch.continueRequest', { requestId: 'request' },
    ))
    expect(runtime.api.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(), 'Fetch.getResponseBody', expect.anything(),
    )
  })

  it('detaches and clears state if enabling interception fails', async () => {
    const runtime = await setup()
    runtime.api.debugger.sendCommand.mockRejectedValueOnce(new Error('Fetch unavailable'))
    const result = await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule()] })
    expect(result.ok).toBe(false)
    expect(runtime.api.debugger.detach).toHaveBeenCalledWith({ tabId: 42 })
    expect((await runtime.message({ type: 'GET_STATE' })).data.attachedTabId).toBeNull()
  })

  it('rewrites UTF-8 vendor JSON and removes stale encoding headers', async () => {
    const runtime = await setup()
    runtime.api.runtime.sendMessage.mockResolvedValue({ ok: true, result: '中文🙂' } as any)
    await runtime.message({ type: 'ATTACH_ACTIVE', rules: [rule({ headerScript: '', bodyScript: 'return "中文🙂"' })] })
    runtime.event(response({
      responseHeaders: [
        { name: 'Content-Type', value: 'application/problem+json' },
        { name: 'Content-Encoding', value: 'gzip' }, { name: 'Content-Length', value: '5' },
      ],
    }))
    await vi.waitFor(() => expect(runtime.api.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 }, 'Fetch.fulfillRequest', expect.objectContaining({
        body: Buffer.from('中文🙂').toString('base64'),
        responseHeaders: [{ name: 'Content-Type', value: 'application/problem+json' }],
      }),
    ))
  })
})

it('awaits async sandbox scripts before posting a serializable result', async () => {
  let handler: any
  const posted: any[] = []
  const parent = { postMessage: (message: unknown) => posted.push(message) }
  runInNewContext(readFileSync(new URL('../public/sandbox.js', import.meta.url), 'utf8'), {
    parent, window: { addEventListener: (_event: string, listener: any) => { handler = listener } },
  })
  await handler({ source: parent, data: { type: 'RUN_SANDBOX_SCRIPT', id: 'test', body: 'original', headers: [], request: {}, code: 'return Promise.resolve("rewritten")' } })
  expect(posted[0]).toMatchObject({ ok: true, result: 'rewritten' })
})

function offscreen() {
  let messageHandler: any
  let frameLoad: () => void = () => {}
  let frameMessage: any
  const sent: any[] = []
  const contentWindow = { postMessage: (message: unknown) => sent.push(message) }
  runInNewContext(readFileSync(new URL('../public/offscreen.js', import.meta.url), 'utf8'), {
    document: { querySelector: () => ({
      contentWindow, addEventListener: (_event: string, listener: () => void) => { frameLoad = listener },
    }) },
    window: { addEventListener: (_event: string, listener: any) => { frameMessage = listener } },
    chrome: { runtime: { onMessage: { addListener: (listener: any) => { messageHandler = listener } } } },
    crypto: { randomUUID: () => 'internal-id' }, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  return { message: (payload: unknown, respond: any) => messageHandler(payload, {}, respond), load: () => frameLoad(), sent, result: (data: unknown) => frameMessage({ source: contentWindow, data }) }
}

it('correlates sandbox replies independently of caller IDs and clears timers', async () => {
  vi.useFakeTimers()
  const frame = offscreen()
  const respond = vi.fn()
  frame.message({ type: 'RUN_SANDBOX_SCRIPT', id: 'caller-id', code: 'return body' }, respond)
  frame.load()
  await vi.advanceTimersByTimeAsync(10)
  expect(frame.sent[0].id).toBe('internal-id')
  frame.result({ type: 'SANDBOX_RESULT', id: 'internal-id', ok: true, result: 'body' })
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: 'body' }))
  expect(vi.getTimerCount()).toBe(0)
})

it('times out even when the sandbox never becomes ready', async () => {
  vi.useFakeTimers()
  const frame = offscreen()
  const respond = vi.fn()
  frame.message({ type: 'RUN_SANDBOX_SCRIPT', code: 'return body' }, respond)
  await vi.advanceTimersByTimeAsync(5000)
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining('timed out') }))
  expect(vi.getTimerCount()).toBe(0)
})
