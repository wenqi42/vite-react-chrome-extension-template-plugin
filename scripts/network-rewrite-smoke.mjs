#!/usr/bin/env node
/** Real MV3 response rewrite acceptance. Node 22+ and Chrome for Testing required. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const chromePath = option('--chrome') || process.env.CHROME_PATH
const dist = path.resolve(option('--dist') || path.join(repository, 'examples/network-rewrite-extension/dist'))
const keep = args.includes('--keep')
if (!chromePath || typeof WebSocket === 'undefined') throw Error('Use Node 22+ and --chrome /path/to/chrome-for-testing')
const manifest = JSON.parse(await fs.readFile(path.join(dist, 'manifest.json'), 'utf8'))
const evidenceRoot = path.join(repository, '.cache', 'network-rewrite')
await fs.mkdir(evidenceRoot, { recursive: true })
const temporary = await fs.realpath(await fs.mkdtemp(path.join(keep ? evidenceRoot : os.tmpdir(), 'network-rewrite-smoke-')))
const profile = path.join(temporary, 'profile')
await fs.mkdir(profile)
const evidence = { startedAt: new Date().toISOString(), dist, checks: [], contexts: [], errors: [], assertions: [] }
const binary = Buffer.from([0, 1, 127, 128, 192, 255, 13, 10, 0, 248])
const originalText = 'ORIGINAL BODY 你好 🌍'
const server = createServer((request, response) => {
  response.setHeader('cache-control', 'no-store')
  if (request.url?.startsWith('/api/')) {
    response.setHeader('x-original', 'old')
    response.setHeader('x-remove', 'remove-me')
    if (request.url.startsWith('/api/empty')) { response.writeHead(204); response.end(); return }
    if (request.url.startsWith('/api/redirect')) { response.writeHead(302, { location: '/api/text' }); response.end(); return }
    if (request.url.startsWith('/api/binary')) { response.setHeader('content-type', 'application/octet-stream'); response.end(binary); return }
    if (request.url.startsWith('/api/json')) { response.setHeader('content-type', 'application/json; charset=utf-8'); response.end(JSON.stringify({ message: '原始', value: 1 })); return }
    if (request.url.startsWith('/api/gzip')) { response.setHeader('content-type', 'text/plain; charset=utf-8'); response.setHeader('content-encoding', 'gzip'); const data=gzipSync(Buffer.from(originalText)); response.setHeader('content-length',String(data.length)); response.end(data); return }
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.setHeader('content-length', String(Buffer.byteLength(originalText)))
    response.end(originalText)
  } else {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><title>Rewrite verification host</title></head><body>Network rewrite acceptance fixture</body></html>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let chrome, socket, stderr = '', nextId = 0
const pending = new Map(), sessions = new Map(), contextKeys = new Set()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result } catch (error) { last = error }
    await delay(100)
  }
  throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`)
}
function request(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
}
const targets = async () => (await request('Target.getTargets')).targetInfos
async function attach(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId)
  const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true })
  sessions.set(targetId, sessionId)
  await request('Runtime.enable', {}, sessionId)
  await request('Log.enable', {}, sessionId).catch(() => {})
  return sessionId
}
async function evaluate(targetId, expression, extra = {}) {
  const result = await request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...extra }, await attach(targetId))
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const check = (description, value) => { evidence.checks.push(description); if (value !== undefined) evidence.assertions.push({ description, value }) }
let worker, panel, host, extensionOrigin
async function panelText() { return evaluate(panel, 'document.body.innerText') }
async function saveRule(overrides = {}) {
  const values = { urlContains: '/api/', resourceTypes: 'Fetch, XHR', headerScript: 'return headers', bodyScript: 'return body', ...overrides }
  await evaluate(panel, `(() => {
    if (!document.querySelector('.rule')) document.querySelector('#add').click();
    const rule = document.querySelector('.rule');
    const values = ${JSON.stringify(values)};
    for (const [field, value] of Object.entries(values)) {
      const input = rule.querySelector('[data-field="' + field + '"]');
      if (field === 'enabled') input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('#save').click();
  })()`)
  await waitFor(async () => {
    const state = await evaluate(panel, `chrome.runtime.sendMessage({type:'GET_STATE'})`)
    return state?.ok && Object.entries(values).every(([key, value]) => key === 'resourceTypes' || state.data.rules[0]?.[key] === value)
  }, 'rules saved')
}
async function fetchPage(endpoint = '/api/text', xhr = false) {
  const expression = xhr ? `new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(endpoint)});x.onload=()=>resolve({body:x.responseText,header:x.getResponseHeader('x-added'),original:x.getResponseHeader('x-original'),removed:x.getResponseHeader('x-remove'),status:x.status});x.onerror=reject;x.send()})` : `fetch(${JSON.stringify(endpoint)}).then(async r=>({body:await r.text(),header:r.headers.get('x-added'),original:r.headers.get('x-original'),removed:r.headers.get('x-remove'),status:r.status,length:r.headers.get('content-length'),encoding:r.headers.get('content-encoding')}))`
  return evaluate(host, `Promise.race([${expression},new Promise((_,reject)=>setTimeout(()=>reject(Error('Host request remained pending')),12000))])`)
}
async function monitorExtension() {
  for (const target of await targets()) {
    if (target.url.startsWith(extensionOrigin)) {
      if (!evidence.contexts.some(item => item.targetId === target.targetId)) evidence.contexts.push({ targetId: target.targetId, type: target.type, url: target.url })
      await attach(target.targetId).catch(() => {})
    }
  }
}
async function screenshot(name) {
  const result = await request('Page.captureScreenshot', { format: 'png' }, await attach(panel))
  await fs.writeFile(path.join(temporary, name), Buffer.from(result.data, 'base64'))
}
try {
  chrome = spawn(chromePath, [`--user-data-dir=${profile}`, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...(args.includes('--headed') ? [] : ['--headless=new']), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr.on('data', data => { stderr += data })
  const port = await waitFor(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'debug port')
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  evidence.browser = browser.Browser
  socket = new WebSocket(browser.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const operation = pending.get(message.id)
      if (!operation) return
      clearTimeout(operation.timeout); pending.delete(message.id)
      if (message.error) operation.reject(Error(message.error.message)); else operation.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      evidence.errors.push({ sessionId: message.sessionId, error: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text })
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      evidence.errors.push({ sessionId: message.sessionId, error: message.params.args.map(item => item.value || item.description).join(' ') })
    } else if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params.context
      const key = `${message.sessionId}:${context.id}`
      if (!contextKeys.has(key)) { contextKeys.add(key); evidence.contexts.push({ sessionId: message.sessionId, executionContextId: context.id, origin: context.origin, name: context.name, frameId: context.auxData?.frameId }) }
    }
  })
  const { targetId: settings } = await request('Target.createTarget', { url: 'chrome://extensions' })
  await waitFor(() => evaluate(settings, `typeof chrome.developerPrivate?.updateProfileConfiguration === 'function'`), 'Developer mode control')
  await evaluate(settings, `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})`)
  await request('Target.closeTarget', { targetId: settings })
  worker = await waitFor(async () => {
    for (const target of await targets()) {
      if (target.type !== 'service_worker' || !target.url.startsWith('chrome-extension:') || !target.url.endsWith(`/${manifest.background.service_worker}`)) continue
      if (await evaluate(target.targetId, 'chrome.runtime.getManifest().name') === manifest.name) return target
    }
  }, 'extension worker')
  extensionOrigin = `chrome-extension://${new URL(worker.url).hostname}`
  evidence.extensionOrigin = extensionOrigin
  await attach(worker.targetId)
  evidence.runtimeManifest = await evaluate(worker.targetId, 'chrome.runtime.getManifest()')
  assert.equal(Object.hasOwn(evidence.runtimeManifest.action, 'default_popup'), false)
  check('loaded runtime Manifest uses native toolbar action without a popup')
  ;({ targetId: host } = await request('Target.createTarget', { url: origin }))
  await waitFor(() => evaluate(host, `document.title === 'Rewrite verification host'`), 'host loaded')
  const hostTabId = await evaluate(worker.targetId, `(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.startsWith(${JSON.stringify(origin)}))?.id})()`)
  evidence.permissions = await evaluate(worker.targetId, 'chrome.permissions.getAll()')
  evidence.tabs = await evaluate(worker.targetId, 'chrome.tabs.query({})')
  assert.equal(typeof hostTabId, 'number')
  // Exercise the real side panel surface, which does not steal active-tab selection.
  await request('Target.activateTarget', { targetId: host })
  const { targetId: controller } = await request('Target.createTarget', { url: `${extensionOrigin}/${manifest.side_panel.default_path}` })
  await waitFor(() => evaluate(controller, `!!document.querySelector('#attach')`), 'extension control document')
  const windowId = await evaluate(controller, '(async()=> (await chrome.windows.getCurrent()).id)()')
  await evaluate(controller, `(() => {
    const button=document.createElement('button');button.id='cdp-open-panel';button.textContent='Open side panel';
    button.style.cssText='position:fixed;top:0;left:0;width:200px;height:60px;z-index:99999';
    button.onclick=()=>chrome.sidePanel.open({windowId:${windowId}});
    document.body.append(button);
  })()`)
  await request('Target.activateTarget', { targetId: controller })
  const controllerSession = await attach(controller)
  await request('Input.dispatchMouseEvent', {type:'mousePressed',x:50,y:20,button:'left',clickCount:1}, controllerSession)
  await request('Input.dispatchMouseEvent', {type:'mouseReleased',x:50,y:20,button:'left',clickCount:1}, controllerSession)
  panel = await waitFor(async () => (await targets()).find(target => target.targetId !== controller && target.url === `${extensionOrigin}/${manifest.side_panel.default_path}`)?.targetId, 'real side panel target')
  evidence.panelSurface = 'real side panel opened by CDP pointer user gesture'
  evidence.panelBehavior = await evaluate(worker.targetId, 'chrome.sidePanel.getPanelBehavior()')
  await request('Target.closeTarget', { targetId: controller })
  await request('Target.activateTarget', { targetId: host })
  evidence.extensionContexts = await evaluate(worker.targetId, 'chrome.runtime.getContexts({})')
  assert(evidence.extensionContexts.some(context => context.contextType === 'SIDE_PANEL'))
  assert.equal(evidence.panelBehavior.openPanelOnActionClick, true)
  evidence.panelTarget = (await targets()).find(target => target.targetId === panel)
  await waitFor(() => evaluate(panel, `!!document.querySelector('#attach')`), 'panel rendered')
  assert.match(await panelText(), /No tab attached|未附加/i)
  check('panel opens unattached')
  await saveRule({ headerScript: `return [...headers.filter(h=>h.name.toLowerCase()!=='x-remove'&&h.name.toLowerCase()!=='x-original'),{name:'x-original',value:'new'},{name:'x-added',value:'yes'}]`, bodyScript: `return body.replace('ORIGINAL BODY','REWRITTEN BODY')` })
  assert.match(await panelText(), /No tab attached|未附加/i)
  assert.equal((await fetchPage()).body, originalText)
  check('saving rules does not attach or intercept')
  await request('Target.activateTarget', { targetId: host })
  await evaluate(panel, `document.querySelector('#attach').click()`)
  await waitFor(async () => /Attached:|已附加/i.test(await panelText()), 'panel attached')
  const rewritten = await fetchPage()
  assert.equal(rewritten.body, originalText.replace('ORIGINAL BODY', 'REWRITTEN BODY'))
  assert.equal(rewritten.header, 'yes'); assert.equal(rewritten.original, 'new'); assert.equal(rewritten.removed, null)
  check('page fetch receives UTF-8 body plus header add/remove/change', rewritten)
  await evaluate(host, `document.body.innerHTML='<h1>Actual page response</h1><pre></pre>';document.querySelector('pre').textContent=${JSON.stringify(JSON.stringify(rewritten, null, 2))}`)
  const hostScreenshot = await request('Page.captureScreenshot', { format: 'png' }, await attach(host))
  await fs.writeFile(path.join(temporary, 'host.png'), Buffer.from(hostScreenshot.data, 'base64'))
  await waitFor(async()=> /Rewritten [1-9]/.test(await panelText()), 'successful rewrite shown in panel')
  await screenshot('panel-success.png')
  const xhr = await fetchPage('/api/text', true)
  assert.equal(xhr.body, rewritten.body); assert.equal(xhr.header, 'yes')
  check('page XMLHttpRequest receives rewritten response', xhr)
  await monitorExtension()
  const offscreen = (await targets()).find(target => target.url === `${extensionOrigin}/offscreen.html`)
  assert(offscreen, 'offscreen runtime exists')
  const frames = await request('Page.getFrameTree', {}, await attach(offscreen.targetId))
  assert((await targets()).some(target => target.type === 'iframe' && target.url === `${extensionOrigin}/sandbox.html`), 'sandbox iframe runtime exists')
  evidence.sandboxFrameTree = frames
  check('worker, real side panel, offscreen document and sandbox iframe observed')
  await saveRule({ bodyScript: `const value=JSON.parse(body);value.message='已改写 🌍';value.value=2;return JSON.stringify(value)` })
  assert.deepEqual(JSON.parse((await fetchPage('/api/json')).body), { message: '已改写 🌍', value: 2 })
  check('JSON body rewritten in actual page response')
  await saveRule({ bodyScript: `return Promise.resolve(body + ' async')` })
  assert.equal((await fetchPage()).body, `${originalText} async`)
  check('asynchronous script result is awaited')
  await saveRule({ bodyScript: `return body + ' decompressed'` })
  const compressed = await fetchPage('/api/gzip')
  assert.equal(compressed.body, `${originalText} decompressed`)
  assert.equal(compressed.length, null); assert.equal(compressed.encoding, null)
  check('modified compressed response removes stale length and encoding headers', compressed)
  await saveRule({ urlContains: '/not-a-match/' })
  assert.equal((await fetchPage()).body, originalText)
  check('nonmatching rule preserves original response')
  await saveRule({ enabled: false, bodyScript: `return 'SHOULD NOT APPLY'` })
  assert.equal((await fetchPage()).body, originalText)
  check('disabled rule preserves original response')
  await saveRule({ enabled: true, headerScript: `return [...headers,{name:'x-added',value:'binary'}]`, bodyScript: '' })
  const bytes = await evaluate(host, `fetch('/api/binary').then(async r=>({bytes:Array.from(new Uint8Array(await r.arrayBuffer())),header:r.headers.get('x-added')}))`)
  assert.deepEqual(bytes.bytes, [...binary]); assert.equal(bytes.header, 'binary')
  check('header-only rewrite preserves binary bytes exactly', bytes)
  await saveRule({ bodyScript: `throw Error('intentional-verifier-error')` })
  assert.equal((await fetchPage()).body, originalText)
  await waitFor(async () => /intentional-verifier-error/.test(await panelText()), 'script error surfaced to panel')
  check('script exception continues original response and is reported in panel')
  await saveRule({ bodyScript: `return new Promise(()=>{})` })
  const timeoutStarted = Date.now()
  assert.equal((await fetchPage()).body, originalText)
  await waitFor(async () => /timed out|timeout|超时/i.test(await panelText()), 'script timeout surfaced to panel')
  check('asynchronous script timeout continues original response', { milliseconds: Date.now() - timeoutStarted })
  await saveRule({ bodyScript: `return body + ' changed'` })
  const empty = await fetchPage('/api/empty')
  assert.equal(empty.status, 204); assert.equal(empty.body, '')
  const redirect = await fetchPage('/api/redirect')
  assert.equal(redirect.status, 200); assert.equal(redirect.body, `${originalText} changed`)
  check('bodyless and redirect responses complete without hanging', { empty, redirect })
  await evaluate(panel, `document.querySelector('#attach').click()`)
  await waitFor(async () => /No tab attached|未附加/i.test(await panelText()), 'UI detach reflected')
  assert.equal((await fetchPage()).body, originalText)
  check('UI Detach restores original response')
  await request('Target.activateTarget', { targetId: host })
  await evaluate(panel, `document.querySelector('#attach').click()`)
  await waitFor(async () => /Attached:|已附加/i.test(await panelText()), 'reattached')
  // Closing the debuggee is a real browser-initiated detach, unlike calling
  // chrome.debugger.detach from the debugger-owning extension itself.
  await evaluate(panel, `document.querySelector('[data-field="urlContains"]').value='UNSAVED INPUT'`)
  await request('Target.closeTarget', { targetId: host })
  await waitFor(async () => /No tab attached|未附加/i.test(await panelText()), 'closed tab detach reflected')
  assert.equal(await evaluate(panel, `document.querySelector('[data-field="urlContains"]').value`), 'UNSAVED INPUT')
  check('browser-initiated detach updates state and preserves unsaved form')
  // Reload the actual panel page to exercise persisted rule hydration.
  await request('Page.reload', {}, await attach(panel))
  await waitFor(() => evaluate(panel, `document.querySelector('[data-field="bodyScript"]')?.value.includes(" changed")`), 'persisted rule hydration')
  check('persisted rules survive reopening panel')
  const { targetId: restricted } = await request('Target.createTarget', { url: 'chrome://version' })
  await request('Target.activateTarget', { targetId: restricted })
  await evaluate(panel, `document.querySelector('#attach').click()`)
  await waitFor(async () => /normal web page|HTTP|HTTPS|普通网页|受限/i.test(await panelText()), 'restricted tab attachment rejected')
  assert.match(await panelText(), /No tab attached|未附加/i)
  check('restricted page is rejected with understandable error')
  await screenshot('panel.png')
  await monitorExtension()
  evidence.extensionContexts = await evaluate(worker.targetId, 'chrome.runtime.getContexts({})')
  assert.deepEqual(evidence.errors, [])
  check('no unhandled exception or console.error in observed runtime contexts')
  evidence.result = 'PASS'
} catch (error) {
  evidence.targets = socket?.readyState === WebSocket.OPEN ? await targets().catch(()=>[]) : []
  if (worker) evidence.extensionContexts = await evaluate(worker.targetId, 'chrome.runtime.getContexts({})').catch(()=>[])
  evidence.result = 'FAIL'; evidence.failure = error.stack || String(error); evidence.chromeStderr = stderr.slice(-5000)
  if (panel && socket?.readyState === WebSocket.OPEN) {
    evidence.panelText = await panelText().catch(error => error.message)
    await screenshot('failure.png').catch(() => {})
    await monitorExtension().catch(() => {})
  }
  process.exitCode = 1
} finally {
  evidence.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  console.log(`Evidence: ${path.join(temporary, 'evidence.json')}`)
  if (socket?.readyState === WebSocket.OPEN) await request('Browser.close').catch(() => {})
  socket?.close()
  if (chrome?.exitCode === null) chrome.kill('SIGTERM')
  await new Promise(resolve => server.close(resolve))
  if (!keep) await fs.rm(temporary, { recursive: true, force: true })
}
