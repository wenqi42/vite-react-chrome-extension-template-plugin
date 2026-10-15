import './style.css'

type Rule = {
  id: string
  enabled: boolean
  urlContains: string
  resourceTypes: string[]
  headerScript: string
  bodyScript: string
}

type State = {
  attachedTabId: number | null; tabTitle: string; rules: Rule[]
  stats: { matched: number; rewritten: number; failed: number }; lastError: string; lastUrl: string
}
const app = document.querySelector<HTMLElement>('#app')!
let state: State = {
  attachedTabId: null, tabTitle: '', rules: [],
  stats: { matched: 0, rewritten: 0, failed: 0 }, lastError: '', lastUrl: '',
}
let pendingAction = false

const defaultRule = (): Rule => ({
  id: crypto.randomUUID(), enabled: true, urlContains: '', resourceTypes: [],
  headerScript: 'return headers',
  bodyScript: 'return body',
})

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
}

function render() {
  app.innerHTML = `
    <header><div><h1>Network Rewrite</h1><p id="connection"></p></div><button id="attach"></button></header>
    <section class="notice" id="attachment-notice"></section>
    <section class="activity"><p id="activity"></p><p id="last-error" role="status"></p></section>
    <section class="toolbar"><button id="add">Add rule</button><button id="save">Save rules</button><span>${state.rules.length} rule(s)</span></section>
    <div id="rules">${state.rules.map((rule, index) => `
      <article class="rule" data-index="${index}">
        <div class="rule-head"><label><input data-field="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}> enabled</label><button data-action="remove">Remove</button></div>
        <label>URL contains<input data-field="urlContains" value="${escapeHtml(rule.urlContains)}" placeholder="api.example.com/data"></label>
        <label>Resource types<input data-field="resourceTypes" value="${escapeHtml(rule.resourceTypes.join(', '))}" placeholder="XHR, Fetch, Document"></label>
        <label>Header script <small>return an array of {name, value}</small><textarea data-field="headerScript">${escapeHtml(rule.headerScript)}</textarea></label>
        <label>Body script <small>return a string or { body, headers }</small><textarea data-field="bodyScript">${escapeHtml(rule.bodyScript)}</textarea></label>
      </article>`).join('')}</div>
    <footer id="status"></footer>`
  bind()
  updateRuntimeState()
}

function updateRuntimeState() {
  const attached = state.attachedTabId !== null
  document.querySelector('#connection')!.textContent = attached
    ? `Attached: ${state.tabTitle || `Tab ${state.attachedTabId}`}` : 'No tab attached — rewriting is inactive'
  const attach = document.querySelector<HTMLButtonElement>('#attach')!
  attach.textContent = attached ? 'Detach' : 'Attach active tab'
  attach.disabled = pendingAction
  document.querySelector('#attachment-notice')!.textContent = attached
    ? 'New matching requests in this tab will be rewritten. Refresh the page or trigger the request again.'
    : 'Save rules, then click Attach active tab on an HTTP/HTTPS page to start. Saving alone does not intercept requests.'
  document.querySelector('#activity')!.textContent = `Matched ${state.stats.matched} · Rewritten ${state.stats.rewritten} · Failed ${state.stats.failed}`
  document.querySelector('#last-error')!.textContent = state.lastError ? `Last failure: ${state.lastError}` : ''
}

function readRulesFromForm() {
  document.querySelectorAll<HTMLElement>('.rule').forEach(node => {
    const index = Number(node.dataset.index)
    const value = (field: string) => node.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${field}"]`)!.value
    state.rules[index] = {
      ...state.rules[index],
      enabled: node.querySelector<HTMLInputElement>('[data-field="enabled"]')!.checked,
      urlContains: value('urlContains'),
      resourceTypes: value('resourceTypes').split(',').map(item => item.trim()).filter(Boolean),
      headerScript: value('headerScript'),
      bodyScript: value('bodyScript'),
    }
  })
}

function setStatus(message: string, error = false) {
  const node = document.querySelector<HTMLElement>('#status')
  if (node) { node.textContent = message; node.dataset.error = String(error) }
}

async function send<T>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw new Error(response?.error || 'Request failed')
  return response.data as T
}

function bind() {
  document.querySelector('#attach')?.addEventListener('click', async () => {
    pendingAction = true
    updateRuntimeState()
    try {
      readRulesFromForm()
      if (state.attachedTabId !== null) state = await send<State>({ type: 'DETACH' })
      else state = await send<State>({ type: 'ATTACH_ACTIVE', rules: state.rules })
      render()
    } catch (error) { setStatus(String(error), true) }
    finally { pendingAction = false; updateRuntimeState() }
  })
  document.querySelector('#add')?.addEventListener('click', () => { readRulesFromForm(); state.rules.push(defaultRule()); render() })
  document.querySelector('#save')?.addEventListener('click', async () => {
    try {
      readRulesFromForm()
      state = await send<State>({ type: 'SAVE_RULES', rules: state.rules })
      setStatus(state.attachedTabId === null ? 'Rules saved. Click Attach active tab to start rewriting.' : 'Rules saved. Applies to new requests.')
      updateRuntimeState()
    }
    catch (error) { setStatus(String(error), true) }
  })
  document.querySelectorAll<HTMLButtonElement>('[data-action="remove"]').forEach(button => button.addEventListener('click', () => {
    readRulesFromForm(); state.rules.splice(Number(button.closest<HTMLElement>('.rule')!.dataset.index), 1); render()
  }))
}

app.textContent = 'Loading rules…'
send<State>({ type: 'GET_STATE' }).then(next => {
  state = next
  render()
  // Refresh only runtime indicators; DOM form values remain owned by the editor.
  const timer = setInterval(() => {
    if (pendingAction) return
    send<State>({ type: 'GET_STATE' }).then(nextState => {
      state = { ...nextState, rules: state.rules }
      updateRuntimeState()
    }).catch(error => setStatus(String(error), true))
  }, 1000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
}).catch(error => { app.textContent = `Unable to load rules: ${String(error)}` })
