type RewriteRule = {
  id: string
  enabled: boolean
  urlContains: string
  resourceTypes: string[]
  headerScript: string
  bodyScript: string
}
type State = {
  attachedTabId: number | null
  tabTitle: string
  rules: RewriteRule[]
  stats: { matched: number; rewritten: number; failed: number }
  lastError: string
  lastUrl: string
}
type ResponseHeader = { name: string; value?: string; binaryValue?: string }
type DebuggerEvent = { requestId: string; request: { url: string; method?: string }; responseStatusCode?: number; responseHeaders?: ResponseHeader[]; responseErrorReason?: string; resourceType?: string }
type ScriptResult = string | { body?: string; headers?: ResponseHeader[] } | ResponseHeader[] | undefined

const STORAGE_KEY = 'network-rewrite-rules'
const state: State = {
  attachedTabId: null, tabTitle: '', rules: [],
  stats: { matched: 0, rewritten: 0, failed: 0 }, lastError: '', lastUrl: '',
}
let offscreenPromise: Promise<void> | undefined

async function loadRules() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  state.rules = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] as RewriteRule[] : []
}

async function saveRules(rules: RewriteRule[]) {
  const next = rules.map(rule => ({ ...rule, id: rule.id || crypto.randomUUID() }))
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  state.rules = next
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  offscreenPromise ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
    justification: 'Execute user-authored response rewrite scripts inside a sandboxed iframe.',
  }).finally(() => { offscreenPromise = undefined })
  await offscreenPromise
}

function debugTarget(tabId: number): chrome.debugger.Debuggee { return { tabId } }

async function detach() {
  if (state.attachedTabId === null) return
  try { await chrome.debugger.detach(debugTarget(state.attachedTabId)) } catch { /* tab may already be closed */ }
  state.attachedTabId = null
  state.tabTitle = ''
}

async function attachActive(rules: RewriteRule[]) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('Select a normal HTTP or HTTPS page before attaching.')
  await detach()
  await saveRules(rules)
  await chrome.debugger.attach(debugTarget(tab.id), '1.3')
  // Fetch.enable can dispatch paused events before its command promise resolves.
  state.attachedTabId = tab.id
  state.tabTitle = tab.title || tab.url
  state.stats = { matched: 0, rewritten: 0, failed: 0 }
  state.lastError = ''
  state.lastUrl = ''
  try {
    await chrome.debugger.sendCommand(debugTarget(tab.id), 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response' }],
    })
  } catch (error) {
    await detach()
    throw error
  }
  return state
}

function matches(rule: RewriteRule, event: DebuggerEvent) {
  if (!rule.enabled) return false
  if (rule.urlContains && !event.request.url.includes(rule.urlContains)) return false
  if (rule.resourceTypes.length && !rule.resourceTypes.some(type => type.toLowerCase() === event.resourceType?.toLowerCase())) return false
  return true
}

function responseHeaders(input: ResponseHeader[] | undefined): ResponseHeader[] {
  return (input || []).filter(header => header.name && header.value !== undefined).map(header => ({ name: header.name, value: header.value }))
}

function encodeBody(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBody(value: string, base64Encoded: boolean) {
  if (!base64Encoded) return value
  const binary = atob(value)
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

function isTextResponse(headers: ResponseHeader[]) {
  const contentType = headers.find(header => header.name.toLowerCase() === 'content-type')?.value?.toLowerCase() || ''
  return !contentType || /^(text\/|application\/([\w.-]+\+)?(json|xml)|application\/(javascript|x-www-form-urlencoded)|image\/svg\+xml)/.test(contentType)
}

function removeBodyLengthHeaders(headers: ResponseHeader[]) {
  return headers.filter(header => !['content-length', 'content-encoding', 'transfer-encoding'].includes(header.name.toLowerCase()))
}

async function executeScript(code: string, body: string, headers: ResponseHeader[], request: DebuggerEvent) {
  await ensureOffscreen()
  const response = await chrome.runtime.sendMessage({
    type: 'RUN_SANDBOX_SCRIPT',
    code,
    body,
    headers,
    request: { url: request.request.url, resourceType: request.resourceType, statusCode: request.responseStatusCode },
  }) as { ok: boolean; result?: ScriptResult; error?: string }
  if (!response?.ok) throw new Error(response?.error || 'Sandbox script failed')
  return response.result
}

function applyHeaderScript(headers: ResponseHeader[], result: ScriptResult): ResponseHeader[] {
  if (!result) return headers
  const next = Array.isArray(result) ? result : headers
  return next.filter(header => header && header.name && header.value !== undefined).map(header => ({ name: header.name, value: String(header.value) }))
}

async function rewritePausedRequest(source: chrome.debugger.Debuggee, event: DebuggerEvent, rules: RewriteRule[]) {
  const activeRules = rules.filter(rule => matches(rule, event))
  if (!activeRules.length) {
    await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: event.requestId })
    return
  }
  state.stats.matched++
  state.lastUrl = event.request.url
  try {
    // Redirects, HEAD and empty/error responses do not expose a readable body.
    if (event.responseErrorReason || !event.responseStatusCode || event.request.method === 'HEAD'
      || [204, 205, 304].includes(event.responseStatusCode)
      || (event.responseStatusCode >= 300 && event.responseStatusCode < 400)) {
      await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: event.requestId })
      return
    }
    const response = await chrome.debugger.sendCommand(source, 'Fetch.getResponseBody', { requestId: event.requestId }) as { body: string; base64Encoded?: boolean }
    let body = decodeBody(response.body, Boolean(response.base64Encoded))
    let headers = responseHeaders(event.responseHeaders)
    let bodyChanged = false
    for (const rule of activeRules) {
      if (rule.headerScript.trim()) headers = applyHeaderScript(headers, await executeScript(rule.headerScript, body, headers, event))
      if (rule.bodyScript.trim()) {
        if (!isTextResponse(headers)) throw new Error('Body scripts only support text responses.')
        const result = await executeScript(rule.bodyScript, body, headers, event)
        if (typeof result === 'string') { body = result; bodyChanged = true }
        else if (result && typeof result === 'object' && !Array.isArray(result)) {
          if (typeof result.body === 'string') { body = result.body; bodyChanged = true }
          if (result.headers) headers = applyHeaderScript(headers, result.headers)
        }
      }
    }
    // getResponseBody returns decoded entity bytes, so original transport metadata is stale.
    headers = removeBodyLengthHeaders(headers)
    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: event.responseStatusCode || 200,
      responseHeaders: headers,
      body: bodyChanged ? encodeBody(body) : response.base64Encoded ? response.body : encodeBody(response.body),
    })
    state.stats.rewritten++
  } catch (error) {
    state.stats.failed++
    state.lastError = `${event.request.url}: ${String(error)}`
    console.warn('[network-rewrite] rewrite failed; continuing response', error)
    await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined)
  }
}

const initialized = loadRules()
// Chrome owns the action's user gesture; a popup's asynchronous startup does not.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => {
  state.lastError = `Unable to enable the toolbar side panel: ${String(error)}`
})
chrome.runtime.onMessage.addListener((message: { type?: string; rules?: RewriteRule[] }, _sender, sendResponse) => {
  if (!['GET_STATE', 'SAVE_RULES', 'ATTACH_ACTIVE', 'DETACH'].includes(message?.type || '')) return false
  void (async () => {
    await initialized
    if (message.type === 'SAVE_RULES') await saveRules(message.rules || [])
    if (message.type === 'ATTACH_ACTIVE') await attachActive(message.rules || [])
    if (message.type === 'DETACH') await detach()
    return state
  })().then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: String(error) }))
  return true
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Fetch.requestPaused' || source.tabId !== state.attachedTabId) return
  void rewritePausedRequest(source, params as DebuggerEvent, state.rules).catch(error => {
    state.lastError = String(error)
    console.warn('[network-rewrite] request handling failed', error)
  })
})
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId === state.attachedTabId) { state.attachedTabId = null; state.tabTitle = '' }
})
