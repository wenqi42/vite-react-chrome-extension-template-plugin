const frame = document.querySelector('#sandbox')
const pending = new Map()
let ready = false
frame.addEventListener('load', () => { ready = true })
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.data?.type !== 'SANDBOX_RESULT') return
  const callback = pending.get(event.data.id)
  if (callback) callback(event.data)
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'RUN_SANDBOX_SCRIPT') return false
  const id = crypto.randomUUID()
  let sent = false
  const finish = result => {
    clearInterval(wait)
    clearTimeout(timeout)
    pending.delete(id)
    sendResponse(result)
  }
  const wait = setInterval(() => {
    if (!ready || sent) return
    sent = true
    pending.set(id, finish)
    frame.contentWindow.postMessage({ ...message, type: 'RUN_SANDBOX_SCRIPT', id }, '*')
  }, 10)
  const timeout = setTimeout(() => finish({ ok: false, error: 'Sandbox script timed out (5 seconds)' }), 5000)
  return true
})
