import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createServer } from 'vite'
import extension from '../index.js'

async function waitFor<T>(check: () => Promise<T | false>, label: string): Promise<T> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function snapshot(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(directory, entry.name), relative))
    else result[relative] = (await fs.readFile(path.join(directory, entry.name))).toString('base64')
  }
  return result
}

it('CASE-06 publishes only successful builds, protects public workers and rejects deleted public manifest entries', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-dev-integration-')))
  await fs.mkdir(path.join(root, 'public'))
  await fs.writeFile(path.join(root, 'popup.html'), '<head></head><body><script type="module" src="./popup.ts"></script></body>')
  await fs.writeFile(path.join(root, 'popup.ts'), 'document.body.dataset.version = "one";')
  await fs.writeFile(path.join(root, 'public/background.js'), 'globalThis.publicToken = "one";')
  await fs.writeFile(path.join(root, 'public/content.js'), 'console.log("content");')
  let failWrite = false
  const server = await createServer({
    configFile: false, root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [extension({
      pages: false, tailwind: false, background: 'background.js',
      manifest: { name: 'Staging regression fixture', version: '1.0.0', action: { default_popup: 'popup.html' }, content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }] },
    }), { name: 'late-failure-fixture', writeBundle() { if (failWrite) throw new Error('late write failure') } }],
  })
  try {
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP server')
    const status = async (): Promise<any> => (await fetch(`http://127.0.0.1:${address.port}/__chrome_extension_dev_status__`)).json()
    await waitFor(async () => (await status()).revision === 1, 'initial build')
    const dist = path.join(root, 'dist')
    const initial = await snapshot(dist)
    expect(await fs.readFile(path.join(dist, 'background.js'), 'utf8')).toContain('chrome.runtime.reload()')

    await fs.writeFile(path.join(root, 'popup.ts'), 'const = invalid syntax;')
    await waitFor(async () => (await status()).error, 'syntax error')
    expect((await status()).revision).toBe(1)
    expect(await snapshot(dist)).toEqual(initial)

    await fs.writeFile(path.join(root, 'popup.ts'), 'document.body.dataset.version = "two";')
    await waitFor(async () => (await status()).revision === 2, 'syntax recovery')
    expect((await status()).reloadExtension).toBe(false)
    expect((await status()).lastExtensionReloadRevision).toBe(1)
    const good = await snapshot(dist)

    failWrite = true
    await fs.writeFile(path.join(root, 'popup.ts'), 'document.body.dataset.version = "bad build";')
    await waitFor(async () => (await status()).error?.includes('late write failure'), 'late write failure')
    expect((await status()).revision).toBe(2)
    expect(await snapshot(dist)).toEqual(good)

    failWrite = false
    await fs.writeFile(path.join(root, 'popup.ts'), 'document.body.dataset.version = "three";')
    await waitFor(async () => (await status()).revision === 3, 'late-error recovery')
    const recovered = await snapshot(dist)
    await fs.unlink(path.join(root, 'public/content.js'))
    await waitFor(async () => (await status()).error?.includes('content.js'), 'deleted public entry')
    expect((await status()).revision).toBe(3)
    expect(await snapshot(dist)).toEqual(recovered)
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30000)

it('CASE-06 loads custom public worker/content files and publicDir false rejects stale copies', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-dev-custom-public-')))
  await fs.mkdir(path.join(root, 'static'))
  await fs.writeFile(path.join(root, 'popup.html'), '<head></head><body>Custom public</body>')
  await fs.writeFile(path.join(root, 'static/worker.js'), 'globalThis.customWorker = "ready";')
  await fs.writeFile(path.join(root, 'static/content.js'), 'console.log("custom content");')
  const plugin = () => extension({ pages: false, tailwind: false, background: 'worker.js', manifest: { name: 'Custom public fixture', version: '1.0.0', action: { default_popup: 'popup.html' }, content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }] } })
  let first: Record<string, string> = {}
  try {
    for (const publicDir of ['static', false] as const) {
      const server = await createServer({ configFile: false, root, publicDir, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [plugin()] })
      try {
        await server.listen()
        const address = server.httpServer!.address()
        if (!address || typeof address === 'string') throw new Error('Expected TCP server')
        const status = async (): Promise<any> => (await fetch(`http://127.0.0.1:${address.port}/__chrome_extension_dev_status__`)).json()
        if (publicDir) {
          await waitFor(async () => (await status()).revision === 1, 'custom public worker')
          first = await snapshot(path.join(root, 'dist'))
          expect(await fs.readFile(path.join(root, 'dist/worker.js'), 'utf8')).toContain('chrome.runtime.reload()')
          expect(await fs.readFile(path.join(root, 'dist/content.js'), 'utf8')).toContain('custom content')
          expect(Object.keys(first).some(file => file.startsWith('_'))).toBe(false)
        } else {
          await waitFor(async () => (await status()).error?.includes('worker.js'), 'disabled public directory error')
          expect((await status()).revision).toBe(0)
          expect(await snapshot(path.join(root, 'dist'))).toEqual(first)
        }
      } finally { await server.close() }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30000)
