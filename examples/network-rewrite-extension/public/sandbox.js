window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.type !== 'RUN_SANDBOX_SCRIPT') return
  const { id, code, body, headers, request } = event.data
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const result = await new AsyncFunction('body', 'headers', 'request', `'use strict';\n${code}`)(body, headers, request)
    parent.postMessage({ type: 'SANDBOX_RESULT', id, ok: true, result }, '*')
  } catch (error) {
    parent.postMessage({ type: 'SANDBOX_RESULT', id, ok: false, error: String(error) }, '*')
  }
})
