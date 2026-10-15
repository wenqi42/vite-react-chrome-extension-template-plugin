import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import type { OutputAsset, OutputBundle, OutputChunk } from 'rollup'
import { prepareContentHmr, contentHmrRuntimeSource, createContentHmrRuntime } from '../content-hmr.js'
import { extensionReloadSnapshot } from '../dev.js'

// Path A: exercises public helper inputs/outputs, never reads implementation.
const temporary: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
function chunk(fileName: string, code = 'globalThis.fixtureRevision = 1', overrides = {}) {
  return {
    type: 'chunk', fileName, name: fileName, code, isEntry: true, isDynamicEntry: false,
    exports: [], imports: [], dynamicImports: [], referencedFiles: [], modules: {},
    facadeModuleId: '/source/content.ts', map: null, implicitlyLoadedBefore: [], importedBindings: {},
    contentHmrLifecycle: true, viteMetadata: { importedCss: new Set<string>() }, ...overrides,
  } as unknown as OutputChunk
}
type FixtureManifest = {
  manifest_version: number; name: string; version: string
  content_scripts: Array<{ matches: string[]; js: string[]; world?: string; [key: string]: unknown }>
}
function asset(fileName: string, source: string | Uint8Array): OutputAsset {
  return { type: 'asset', fileName, source, names: [], originalFileNames: [], name: undefined, originalFileName: null, needsCodeReference: false }
}
function manifest(content: Record<string, unknown> = {}): FixtureManifest {
  return {
    manifest_version: 3, name: 'HMR public contract fixture', version: '1.0.0',
    content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'], ...content }],
  }
}
function prepare(value = manifest(), bundle: OutputBundle = { 'content.js': chunk('content.js') }, publicDir: string | false = false) {
  const emitted = new Map<string, string>()
  const warnings: string[] = []
  const entries = prepareContentHmr(value, bundle, publicDir, (filename, source) => { emitted.set(filename, source) }, message => { warnings.push(message) })
  return { entries, emitted, warnings, manifest: value }
}

describe('Content HMR preparation public contract', () => {
  it('preserves production registration matching and emits only local bootstrap files', () => {
    const result = prepare(manifest({
      exclude_matches: ['https://example.com/private/*'], include_globs: ['*allowed*'],
      exclude_globs: ['*denied*'], all_frames: true, world: 'MAIN',
    }))
    expect(result.warnings).toEqual([])
    expect(result.entries).toHaveLength(1)
    const entry = result.entries[0]
    expect(entry.world).toBe('MAIN')
    expect(entry.allFrames).toBe(true)
    expect(entry.matches).toEqual(['https://example.com/*'])
    expect(entry.excludeMatches).toEqual(['https://example.com/private/*'])
    expect(entry.includeGlobs).toEqual(['*allowed*'])
    expect(entry.excludeGlobs).toEqual(['*denied*'])
    expect(entry.js.length).toBeGreaterThan(0)
    for (const filename of entry.js) expect(result.emitted.has(filename) || filename === 'content.js').toBe(true)
    expect(entry.hash).toMatch(/^[a-f\d]+$/)
    expect(result.emitted.size).toBeGreaterThan(0)
    for (const [filename, source] of result.emitted) {
      expect(filename).not.toMatch(/^(?:[./]|https?:)/)
      expect(source).not.toMatch(/eval\(|new Function|import\s*\(\s*['"]https?:\/\//)
    }
  })

  it('defaults to isolated world and combines manifest CSS with imported CSS once', () => {
    const value = manifest({ css: ['base.css'] })
    const output: OutputBundle = {
      'content.js': chunk('content.js', undefined, { viteMetadata: { importedCss: new Set(['base.css', 'imported.css']) } }),
      'base.css': asset('base.css', 'body{color:red}'),
      'imported.css': asset('imported.css', new TextEncoder().encode('body{background:blue}')),
    }
    const result = prepare(value, output)
    expect(result.entries[0].world).toBe('ISOLATED')
    expect(result.entries[0].allFrames).toBe(false)
    expect(result.entries[0].css).toContain('body{color:red}')
    expect(result.entries[0].css).toContain('body{background:blue}')
    expect(result.entries[0].css.match(/body\{color:red\}/g)).toHaveLength(1)
  })

  it('includes public CSS and changes fingerprint only when content changes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hmr-public-css-'))
    temporary.push(directory)
    await mkdir(path.join(directory, 'styles'))
    await writeFile(path.join(directory, 'styles/site.css'), 'body{color:red}')
    const first = prepare(manifest({ css: ['styles/site.css'] }), undefined, directory)
    const second = prepare(manifest({ css: ['styles/site.css'] }), undefined, directory)
    expect(first.entries[0].hash).toBe(second.entries[0].hash)
    expect(first.entries[0].css).toContain('body{color:red}')
    await writeFile(path.join(directory, 'styles/site.css'), 'body{color:green}')
    const third = prepare(manifest({ css: ['styles/site.css'] }), undefined, directory)
    expect(third.entries[0].css).toContain('body{color:green}')
    const changedJs = prepare(manifest(), { 'content.js': chunk('content.js', 'globalThis.fixtureRevision = 2') })
    expect(changedJs.entries[0].hash).not.toBe(prepare().entries[0].hash)
  })

  it.each([
    ['about:blank matching', { match_about_blank: true }],
    ['origin fallback matching', { match_origin_as_fallback: true }],
  ])('diagnoses unsupported %s and keeps the existing registration', (_label, content) => {
    const value = manifest(content)
    const original = structuredClone(value)
    const result = prepare(value)
    expect(result.entries).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/reload|unsupported|HMR/i)
    expect(value).toEqual(original)
  })

  it('diagnoses entries without verified lifecycle and preserves their reload registration', () => {
    const value = manifest()
    const original = structuredClone(value)
    const result = prepare(value, { 'content.js': chunk('content.js', 'console.log("legacy")', { contentHmrLifecycle: false }) })
    expect(result.entries).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/defineContentScript|lifecycle/i)
    expect(value).toEqual(original)
  })

  it('does not manage ESM content output or a missing source file', () => {
    const esm = prepare(manifest(), { 'content.js': chunk('content.js', 'import "dependency.js"', { imports: ['dependency.js'] }) })
    expect(esm.entries).toEqual([])
    expect(esm.warnings.length).toBeGreaterThan(0)
    const missing = prepare(manifest(), {})
    expect(missing.entries).toEqual([])
    expect(missing.warnings.length).toBeGreaterThan(0)
  })

  it('does not mutate an extension without content scripts', () => {
    const value = { manifest_version: 3, name: 'No content scripts', version: '1.0.0' }
    const result = prepare(value as ReturnType<typeof manifest>)
    expect(result.entries).toEqual([])
    expect(result.emitted.size).toBe(0)
    expect(result.warnings).toEqual([])
    expect(value.name).toBe('No content scripts')
  })

  it('assigns independent stable identities for separate worlds', () => {
    const value = manifest()
    value.content_scripts.push({ matches: ['https://example.com/*'], js: ['main.js'], world: 'MAIN' })
    const result = prepare(value, { 'content.js': chunk('content.js'), 'main.js': chunk('main.js') })
    expect(result.entries).toHaveLength(2)
    expect(new Set(result.entries.map(entry => entry.id)).size).toBe(2)
    expect(result.entries.map(entry => entry.world)).toEqual(['ISOLATED', 'MAIN'])
  })

  it('supports a stylesheet-only registration', () => {
    const value = manifest({ js: [], css: ['style.css'] })
    const result = prepare(value, { 'style.css': asset('style.css', 'body{color:red}') })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].js).toEqual([])
    expect(result.entries[0].css).toBe('body{color:red}')
    expect(result.warnings).toEqual([])
  })

  it('keeps dynamic JavaScript references local and reads public JavaScript as a legacy fallback', async () => {
    const dynamic = prepare(manifest(), { 'content.js': chunk('content.js', 'void import("other.js")', { dynamicImports: ['other.js'] }) })
    expect(dynamic.entries).toHaveLength(1)
    expect(dynamic.entries[0].js.every(file => !/^(?:https?:)?\/\//.test(file))).toBe(true)
    const directory = await mkdtemp(path.join(tmpdir(), 'hmr-public-js-'))
    temporary.push(directory)
    await writeFile(path.join(directory, 'content.js'), 'globalThis.publicScript = true')
    const legacy = prepare(manifest(), {}, directory)
    expect(legacy.entries).toEqual([])
    expect(legacy.warnings.join(' ')).toMatch(/lifecycle|defineContentScript/i)
  })
})

describe('Content HMR extension reload classification', () => {
  it('excludes managed content-only assets but retains background and registration changes', () => {
    const value = { ...manifest({ css: ['content.css'] }), background: { service_worker: 'background.js' } }
    const output: OutputBundle = {
      'content.js': chunk('content.js'),
      'content.css': asset('content.css', 'a{}'),
      'background.js': chunk('background.js', 'globalThis.backgroundRevision=1'),
    }
    const base = extensionReloadSnapshot(value, output, false, new Set([0]))
    const changed = { ...output, 'content.js': chunk('content.js', 'globalThis.fixtureRevision=2') }
    expect(extensionReloadSnapshot(value, changed, false, new Set([0]))).toBe(base)
    expect(extensionReloadSnapshot(value, { ...output, 'background.js': chunk('background.js', 'globalThis.backgroundRevision=2') }, false, new Set([0]))).not.toBe(base)
    expect(extensionReloadSnapshot({ ...value, version: '2.0.0' }, output, false, new Set([0]))).not.toBe(base)
    const registration = { ...value, content_scripts: [{ ...value.content_scripts[0], matches: ['https://other.example/*'] }] }
    expect(extensionReloadSnapshot(registration, output, false, new Set([0]))).not.toBe(base)
    expect(extensionReloadSnapshot(value, changed, false)).not.toBe(extensionReloadSnapshot(value, output, false))
  })
})

type Listener = (...parameters: unknown[]) => unknown
type Frame = { frameId: number; documentId?: string; url: string; hash: string | null }
type ScriptOptions = {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean }
  files?: string[]; func?: (...parameters: unknown[]) => unknown; args?: unknown[]; world?: string
}
function runtimeFixture(frames: Record<number, Frame[]>) {
  const messages: Listener[] = []
  const removed: Listener[] = []
  const injected: ScriptOptions[] = []
  const inserted: unknown[] = []
  const cssRemoved: unknown[] = []
  let nextHash = 'hash-one'
  let failTab: number | undefined
  let failInsert = false
  let failRemove = false
  let lastProbe: ScriptOptions | undefined
  const chrome = {
    runtime: { getURL: (filename: string) => `chrome-extension://fixture/${filename}`, onMessage: { addListener: (listener: Listener) => { messages.push(listener) } } },
    tabs: { query: async () => Object.keys(frames).map(id => ({ id: Number(id) })), onRemoved: { addListener: (listener: Listener) => { removed.push(listener) } } },
    scripting: {
      executeScript: async (options: ScriptOptions) => {
        if (options.target.tabId === failTab) throw new Error('Tab closed during update')
        const selected = (frames[options.target.tabId] ?? []).filter(frame =>
          (!options.target.frameIds || options.target.frameIds.includes(frame.frameId))
          && (!options.target.documentIds || options.target.documentIds.includes(frame.documentId ?? '')),
        )
        if (options.files) {
          injected.push(options)
          for (const frame of selected) frame.hash = nextHash
          return []
        }
        if (options.func && selected.length) {
          vi.stubGlobal('location', { href: selected[0].url })
          const observed = options.func(...(options.args ?? []))
          if (observed !== undefined) {
            expect(observed).toEqual(expect.objectContaining({ url: selected[0].url }))
            lastProbe = options
          } else {
            expect(lastProbe).toBeDefined()
            const updated = lastProbe!.func!(...(lastProbe!.args ?? []))
            expect(updated).toEqual(expect.objectContaining({ url: selected[0].url, hash: nextHash }))
          }
        }
        return selected.map(frame => ({ ...frame, result: { url: frame.url, hash: frame.hash } }))
      },
      insertCSS: async (options: unknown) => { inserted.push(options); if (failInsert) throw new Error('CSS target disappeared') },
      removeCSS: async (options: unknown) => { cssRemoved.push(options); if (failRemove) throw new Error('Old stylesheet already removed') },
    },
  }
  vi.stubGlobal('chrome', chrome)
  return {
    chrome, messages, removed, injected, inserted, cssRemoved,
    setHash: (value: string) => { nextHash = value },
    failTab: (value?: number) => { failTab = value },
    failCss: (insert: boolean, remove: boolean) => { failInsert = insert; failRemove = remove },
  }
}
function runtimeEntry(overrides = {}) {
  return {
    id: 'public-fixture', js: ['content-local.js'], css: 'body{color:red}', hash: 'hash-one',
    matches: ['https://example.com/*'], excludeMatches: [] as string[], includeGlobs: [] as string[], excludeGlobs: [] as string[],
    world: 'ISOLATED' as const, allFrames: false, ...overrides,
  }
}

describe('Content HMR generated worker public Chrome API', () => {
  it('exposes the actual worker runtime function for observable Chrome API testing', () => {
    expect(createContentHmrRuntime).toBeTypeOf('function')
  })

  it('creates an update function and registers Chrome message/tab lifecycle hooks', async () => {
    const registrations: Listener[] = []
    const removals: Listener[] = []
    const injected: unknown[] = []
    const chrome = {
      runtime: { getURL: (filename: string) => `chrome-extension://fixture/${filename}`, onMessage: { addListener: (listener: Listener) => { registrations.push(listener) } } },
      tabs: { query: async () => [], onRemoved: { addListener: (listener: Listener) => { removals.push(listener) } } },
      scripting: { executeScript: async (options: unknown) => { injected.push(options); return [] }, insertCSS: async () => {}, removeCSS: async () => {} },
    }
    const update = vm.runInNewContext(contentHmrRuntimeSource([]), { chrome, URL, console })
    expect(typeof update).toBe('function')
    await update([])
    expect(injected).toEqual([])
    expect(registrations).toHaveLength(1)
    expect(removals).toHaveLength(1)
    removals[0](123)
  })

  it('updates only matching frames and deduplicates repeated content versions', async () => {
    const fixture = runtimeFixture({
      1: [{ frameId: 0, documentId: 'match', url: 'https://example.com/allowed', hash: null }],
      2: [{ frameId: 0, documentId: 'other', url: 'https://other.example/allowed', hash: null }],
    })
    const first = runtimeEntry()
    const update = createContentHmrRuntime([first])
    await update([first])
    expect(fixture.injected.map(call => call.target.tabId)).toEqual([1])
    expect(fixture.injected[0].files).toEqual(['content-local.js'])
    expect(fixture.inserted).toHaveLength(1)
    await update([first])
    expect(fixture.injected).toHaveLength(1)
    fixture.setHash('hash-two')
    await update([{ ...first, hash: 'hash-two', js: ['new-local.js'] }])
    expect(fixture.injected).toHaveLength(2)
    expect(fixture.injected[1].files).toEqual(['new-local.js'])
  })

  it('replaces CSS by removing the previous text and avoids unchanged stylesheet insertion', async () => {
    const fixture = runtimeFixture({ 1: [{ frameId: 0, documentId: 'match', url: 'https://example.com/', hash: null }] })
    const first = runtimeEntry()
    const update = createContentHmrRuntime([first])
    await update([first])
    const injections = fixture.injected.length
    await update([{ ...first, css: 'body{color:blue}' }])
    expect(fixture.injected.length).toBe(injections)
    expect(fixture.cssRemoved).toEqual([expect.objectContaining({ css: 'body{color:red}' })])
    expect(fixture.inserted).toEqual([
      expect.objectContaining({ css: 'body{color:red}' }),
      expect.objectContaining({ css: 'body{color:blue}' }),
    ])
    await update([{ ...first, css: 'body{color:blue}' }])
    expect(fixture.inserted).toHaveLength(2)
    await update([{ ...first, css: '' }])
    expect(fixture.cssRemoved).toHaveLength(2)
  })

  it('honors match exclusions, include/exclude globs and MAIN/allFrames targets', async () => {
    const fixture = runtimeFixture({
      1: [
        { frameId: 0, documentId: 'top', url: 'https://example.com/allowed/top', hash: null },
        { frameId: 1, documentId: 'included', url: 'https://example.com/allowed/frame', hash: null },
        { frameId: 2, documentId: 'private', url: 'https://example.com/private/allowed', hash: null },
        { frameId: 3, documentId: 'denied', url: 'https://example.com/allowed/denied', hash: null },
        { frameId: 4, documentId: 'not-included', url: 'https://example.com/other', hash: null },
      ],
    })
    const entry = runtimeEntry({
      world: 'MAIN', allFrames: true, excludeMatches: ['https://example.com/private/*'],
      includeGlobs: ['*allowed*'], excludeGlobs: ['*denied*'],
    })
    await createContentHmrRuntime([entry])([entry])
    expect(fixture.injected).toHaveLength(2)
    expect(fixture.injected.every(call => call.world === 'MAIN')).toBe(true)
    expect(fixture.injected.map(call => call.target.documentIds?.[0])).toEqual(['top', 'included'])
  })

  it('continues updating surviving tabs when another tab closes during injection', async () => {
    const fixture = runtimeFixture({
      1: [{ frameId: 0, url: 'https://example.com/', hash: null }],
      2: [{ frameId: 0, url: 'https://example.com/', hash: null }],
    })
    fixture.failTab(1)
    const entry = runtimeEntry({ css: '' })
    await createContentHmrRuntime([entry])([entry])
    expect(fixture.injected.map(call => call.target.tabId)).toEqual([2])
  })

  it('handles a registered local bootstrap request and ignores unrelated runtime messages', async () => {
    const prepared = prepare(manifest({ css: ['style.css'] }), {
      'content.js': chunk('content.js'), 'style.css': asset('style.css', 'body{color:red}'),
    })
    const requests: unknown[] = []
    const bootstrapChrome = { runtime: { sendMessage: (message: unknown) => { requests.push(message); return Promise.resolve() }, getURL: (file: string) => `chrome-extension://fixture/${file}` } }
    for (const source of prepared.emitted.values()) vm.runInNewContext(source, {
      chrome: bootstrapChrome, URL, console, location: { href: 'https://example.com/' },
    })
    expect(requests.length).toBeGreaterThan(0)
    const fixture = runtimeFixture({ 1: [{ frameId: 0, documentId: 'boot', url: 'https://example.com/', hash: prepared.entries[0].hash }] })
    createContentHmrRuntime(prepared.entries)
    const sender = { tab: { id: 1 }, frameId: 0, documentId: 'boot', url: 'https://example.com/' }
    const responses: unknown[] = []
    for (const request of requests) fixture.messages[0](request, sender, (response: unknown) => { responses.push(response) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.inserted).toHaveLength(1)
    expect(responses.length).toBeGreaterThan(0)
    const before = fixture.inserted.length
    fixture.messages[0]({ type: 'other-extension-protocol' }, sender, () => {})
    fixture.messages[0](null, sender, () => {})
    fixture.messages[0](requests[0], {}, () => {})
    fixture.removed[0](1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.inserted.length).toBe(before)
  })

  it('reports CSS target failures and can apply a subsequent successful update', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixture = runtimeFixture({ 1: [{ frameId: 0, url: 'https://example.com/', hash: null }] })
    const entry = runtimeEntry()
    const update = createContentHmrRuntime([entry])
    await update([entry])
    fixture.failCss(false, true)
    await expect(update([{ ...entry, css: 'body{color:blue}' }])).rejects.toThrow('Old stylesheet already removed')
    fixture.failCss(true, false)
    await expect(update([{ ...entry, css: 'body{color:green}' }])).rejects.toThrow('CSS target disappeared')
    fixture.failCss(false, false)
    await update([{ ...entry, css: 'body{color:green}' }])
    expect(fixture.inserted.at(-1)).toEqual(expect.objectContaining({ css: 'body{color:green}' }))
    const successfulInsertions = fixture.inserted.length
    await update([{ ...entry, css: 'body{color:green}' }])
    expect(fixture.inserted).toHaveLength(successfulInsertions)
    expect(warning.mock.calls.flat().join(' ')).toContain('Content HMR update failed')
    warning.mockRestore()
  })

  it('matches universal patterns, top-frame-only entries and rejects malformed document URLs', async () => {
    const fixture = runtimeFixture({
      1: [
        { frameId: 0, url: 'https://arbitrary.example/path?q=1', hash: null },
        { frameId: 1, url: 'https://arbitrary.example/frame', hash: null },
      ],
      2: [{ frameId: 0, url: 'not-a-valid-url', hash: null }],
    })
    const entry = runtimeEntry({ matches: ['<all_urls>'], css: '' })
    await createContentHmrRuntime([entry])([entry])
    expect(fixture.injected).toHaveLength(1)
    expect(fixture.injected[0].target.frameIds).toEqual([0])
  })

  it('handles empty updates, tabs without frames and removed tabs idempotently', async () => {
    const fixture = runtimeFixture({})
    const update = createContentHmrRuntime([])
    await update([])
    await update([runtimeEntry({ css: '' })])
    fixture.removed[0]?.(404)
    fixture.removed[0]?.(404)
    expect(fixture.injected).toEqual([])
    expect(fixture.inserted).toEqual([])
  })

  it('covers optional content registration fields and absent CSS metadata', () => {
    const withOptions = manifest({
      js: ['content.js'], css: [], match_about_blank: false, match_origin_as_fallback: false,
      run_at: 'document_start', include_globs: [], exclude_globs: [], all_frames: false,
    })
    const result = prepare(withOptions, {
      'content.js': chunk('content.js', undefined, { viteMetadata: undefined, imports: [], dynamicImports: [], referencedFiles: [] }),
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].css).toBe('')
    expect(result.entries[0].matches).toEqual(['https://example.com/*'])
  })
})
