import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import type { EmittedFile, PluginContext, TransformPluginContext } from 'rollup'
import type { Plugin, ResolvedConfig } from 'vite'
import chromeExtension, {
  collectPermissions,
  defineBackground,
  defineDynamicResource,
  defineManifest,
  diagnoseManifestReferences,
  deepMerge,
  discoverPages,
  generatedWebAccessibleResources,
  makeStandaloneContentChunk,
  mergeWebAccessibleResources,
  manifestEntryReferences,
  manifestContentScriptEntries,
  manifestReferenceEntries,
  pagesToManifest,
  rewriteManifestReferences,
  validateManifest,
} from '../index.js'

function hook<T extends Function>(value: T | { handler: T } | undefined): T {
  if (!value) throw new Error('Expected Vite plugin hook to be defined')
  return typeof value === 'function' ? value : value.handler
}

async function setup(plugin: Plugin, config: Partial<ResolvedConfig> = {}) {
  const root = config.root || '/workspace'
  const configHook = hook(plugin.config)
  if (configHook) {
    await configHook(
      { root, build: { rollupOptions: {} } } as any,
      { command: (config.command || 'build') as 'build', mode: 'test' },
    )
  }
  hook(plugin.configResolved)({
    root,
    command: 'build',
    build: { outDir: 'dist', rollupOptions: {} },
    ...config,
  } as ResolvedConfig)
}

function transform(
  plugin: Plugin,
  code: string,
  id: string,
  warn = vi.fn(),
) {
  return hook(plugin.transform).call(
    { warn } as unknown as TransformPluginContext,
    code,
    id,
  )
}

async function manifest(plugin: Plugin, warn = vi.fn()) {
  let output: Record<string, any> = {}
  await hook(plugin.generateBundle).call({
    emitFile: (asset: EmittedFile) => {
      expect(asset.type).toBe('asset')
      if (asset.type === 'asset') output = JSON.parse(String(asset.source))
      return 'manifest'
    },
    warn,
  } as unknown as PluginContext, {} as any, {}, false)
  return { output, warn }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CASE-06 watch permission ownership', () => {
  it('preserves cached modules, replaces changed API use and drops removed modules', async () => {
    const plugin = chromeExtension({ pages: false, tailwind: false })
    await setup(plugin)
    transform(plugin, 'chrome.tabs.query({});', '/workspace/src/changed.ts')
    transform(plugin, 'chrome.bookmarks.getTree();', '/workspace/src/cached.ts')
    transform(plugin, 'chrome.history.search({}); chrome.unmapped.example();', '/workspace/src/removed.ts')
    let active = ['/workspace/src/changed.ts', '/workspace/src/cached.ts', '/workspace/src/removed.ts']
    const output = async () => {
      let value: any
      const warn = vi.fn()
      await hook(plugin.generateBundle).call({
        getModuleIds: () => active.values(),
        emitFile: (asset: any) => { value = JSON.parse(String(asset.source)); return 'manifest' },
        warn,
      } as any, {} as any, {}, false)
      return { value, warn }
    }
    expect((await output()).value.permissions).toEqual(['tabs', 'bookmarks', 'history'])
    transform(plugin, 'console.log("tabs API removed");', '/workspace/src/changed.ts')
    active = ['/workspace/src/changed.ts', '/workspace/src/cached.ts']
    const next = await output()
    expect(next.value.permissions).toEqual(['bookmarks'])
    expect(next.warn.mock.calls.flat().join(' ')).not.toContain('unmapped')
  })

  it('explicitly rejects unsupported dev modes and honors the complete opt-out', async () => {
    const disabled = chromeExtension({ liveReload: false })
    await expect(hook(disabled.configureServer)({} as any)).resolves.toBeUndefined()
    const enabled = chromeExtension({ pages: false })
    await expect(hook(enabled.configureServer)({ httpServer: null } as any)).rejects.toThrow('middleware mode')
    await expect(hook(enabled.configureServer)({ httpServer: {}, config: { server: { hmr: false } } } as any)).rejects.toThrow('requires Vite WebSocket')
    await expect(hook(enabled.configureServer)({ httpServer: {}, config: { server: { ws: false } } } as any)).rejects.toThrow('requires Vite WebSocket')
  })
})

describe('pure helpers', () => {
  it('returns typed manifest values and supports dynamic resource overrides', () => {
    const value = { name: 'Test', version: '1.0.0' }
    expect(defineManifest(value)).toBe(value)
    expect(defineDynamicResource({
      matches: ['https://example.com/*'],
      extension_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      use_dynamic_url: true,
    })).toEqual({
      matches: ['https://example.com/*'],
      extension_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      use_dynamic_url: true,
      resources: ['<dynamic_resource>'],
    })
    expect(defineBackground('src/background.ts')).toEqual({
      entry: 'src/background.ts',
      fileName: 'background.js',
      type: 'module',
    })
    expect(defineBackground('src/worker.ts', { fileName: 'worker.js' })).toEqual({
      entry: 'src/worker.ts',
      fileName: 'worker.js',
      type: 'module',
    })
  })

  it('merges objects, preserves undefined base values, and replaces arrays', () => {
    expect(deepMerge({ nested: { keep: true }, values: ['base'] }, { nested: { replace: true }, values: ['override'] })).toEqual({
      nested: { keep: true, replace: true },
      values: ['override'],
    })
    expect(deepMerge({ value: 1 }, undefined)).toEqual({ value: 1 })
    expect(deepMerge(undefined, { value: 2 })).toEqual({ value: 2 })
    expect(deepMerge({ value: 1 }, null)).toBeNull()
  })

  it('discovers pages from a page root and handles missing roots', () => {
    const root = `/tmp/vite-plugin-vitest-${Date.now()}`
    fs.mkdirSync(path.join(root, 'views', 'popup'), { recursive: true })
    fs.mkdirSync(path.join(root, 'views', 'options'), { recursive: true })
    fs.writeFileSync(path.join(root, 'views', 'popup', 'index.html'), '')
    fs.writeFileSync(path.join(root, 'views', 'options', 'index.html'), '')
    fs.mkdirSync(path.join(root, 'views', 'empty'), { recursive: true })
    expect(discoverPages(root, 'views')).toEqual({
      popup: path.join(root, 'views', 'popup', 'index.html'),
      options: path.join(root, 'views', 'options', 'index.html'),
    })
    expect(discoverPages(root, 'missing')).toEqual({})
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('maps only conventional page names', () => {
    expect(pagesToManifest({ popup: '/x', options: '/x', sidepanel: '/x', devtools: '/x', unknown: '/x' })).toEqual({
      action: { default_popup: 'popup/index.html' },
      options_ui: { page: 'options/index.html', open_in_tab: true },
      side_panel: { default_path: 'sidepanel/index.html' },
      devtools_page: 'devtools/index.html',
    })
  })

  it('parses JS, TSX, optional chains, and reports unknown namespaces', () => {
    const result = collectPermissions(
      'const a = chrome.tabs?.query({}); const b = browser.history.search({}); chrome.unknown.do(); chrome["tabs"].query({}); foo.bar();',
      '/workspace/src/popup/main.tsx',
    )
    expect([...result.permissions]).toEqual(expect.arrayContaining(['tabs', 'history']))
    expect(result.unknownNamespaces).toEqual(['unknown'])
    expect(collectPermissions('chrome.tabs.query({})', '/workspace/src/main.js').permissions).toContain('tabs')
    expect(collectPermissions('chrome.runtime.reload(); chrome.runtime.onMessage.addListener(() => {});', '/workspace/src/worker.ts')).toEqual({
      permissions: new Set(),
      unknownNamespaces: [],
    })
  })

  it('ignores non-chunk bundle entries when rewriting references', async () => {
    const { rewriteManifestReferences } = await import('../index.js')
    expect(rewriteManifestReferences(
      { name: 'x', version: '1', background: { service_worker: 'src/bg.ts' } },
      '/workspace',
      {
        'asset.txt': { type: 'asset', fileName: 'asset.txt' },
        'other.js': { type: 'chunk', fileName: 'other.js', facadeModuleId: null },
        'mismatch.js': { type: 'chunk', fileName: 'mismatch.js', facadeModuleId: '/workspace/src/other.ts' },
      },
    )).toMatchObject({ background: { service_worker: 'src/bg.ts' } })
  })

  it('rewrites matching chunk facade references while preserving unmatched fields', () => {
    expect(rewriteManifestReferences(
      {
        name: 'x',
        version: '1',
        action: { default_popup: 'src/popup.html' },
        content_scripts: [{ js: ['content.js'], css: ['content.css'] }],
      },
      '/workspace',
      {
        popup: {
          type: 'chunk',
          fileName: 'popup-abc.js',
          facadeModuleId: '/workspace/src/popup.html',
        },
        content: {
          type: 'chunk',
          fileName: 'content-def.js',
          facadeModuleId: '/workspace/content.js',
        },
      },
    )).toMatchObject({
      action: { default_popup: 'src/popup.html' },
      content_scripts: [{ js: ['content-def.js'], css: ['content.css'] }],
    })
  })

  it('covers optional manifest entry shapes and missing source files', async () => {
    expect(manifestEntryReferences({
      name: 'x',
      version: '1',
      action: 'not-an-object',
      background: { service_worker: '<dynamic_resource>' },
      options_ui: { page: 'options.html' },
      side_panel: { default_path: 'side.html' },
      content_scripts: [null, { js: 'not-an-array', css: ['src/a.css'] }],
    } as any)).toEqual(['options.html', 'side.html', 'src/a.css'])
    expect(defineDynamicResource()).toEqual({
      matches: ['http://*/*', 'https://*/*'],
      resources: ['<dynamic_resource>'],
    })
  })

  it('validates the supported MV3 manifest shapes with actionable errors', () => {
    const base = { manifest_version: 3, name: 'Validation', version: '1.0.0' }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, description: 1 }, 'manifest.description'],
      [{ ...base, permissions: 'tabs' }, 'manifest.permissions'],
      [{ ...base, action: 'button' }, 'manifest.action'],
      [{ ...base, action: { default_popup: 1 } }, 'manifest.action.default_popup'],
      [{ ...base, action: { default_title: 1 } }, 'manifest.action.default_title'],
      [{ ...base, action: { default_icon: { 16: 1 } } }, 'manifest.action.default_icon'],
      [{ ...base, background: 'worker.js' }, 'manifest.background'],
      [{ ...base, background: { service_worker: '' } }, 'manifest.background.service_worker'],
      [{ ...base, options_page: 1 }, 'manifest.options_page'],
      [{ ...base, options_ui: 'options' }, 'manifest.options_ui'],
      [{ ...base, options_ui: { page: 1 } }, 'manifest.options_ui.page'],
      [{ ...base, side_panel: 'side' }, 'manifest.side_panel'],
      [{ ...base, side_panel: { default_path: 1 } }, 'manifest.side_panel.default_path'],
      [{ ...base, icons: [] }, 'manifest.icons'],
      [{ ...base, icons: { 16: 1 } }, 'manifest.icons'],
      [{ ...base, content_scripts: 'scripts' }, 'manifest.content_scripts'],
      [{ ...base, content_scripts: [null] }, 'manifest.content_scripts[0]'],
      [{ ...base, content_scripts: [{ matches: [] }] }, 'manifest.content_scripts[0].matches'],
      [{ ...base, content_scripts: [{ matches: ['<all_urls>'], js: 'content.js' }] }, 'manifest.content_scripts[0].js'],
      [{ ...base, content_scripts: [{ matches: ['<all_urls>'], css: ['content.css'], run_at: 'late' }] }, 'manifest.content_scripts[0].run_at'],
      [{ ...base, content_scripts: [{ matches: ['<all_urls>'], world: 'WORKER' }] }, 'manifest.content_scripts[0].world'],
      [{ ...base, web_accessible_resources: 'resources' }, 'manifest.web_accessible_resources'],
      [{ ...base, web_accessible_resources: [null] }, 'manifest.web_accessible_resources[0]'],
      [{ ...base, web_accessible_resources: [{}] }, 'manifest.web_accessible_resources[0].resources'],
      [{ ...base, web_accessible_resources: [{ resources: ['x'], matches: 'https://*/*' }] }, 'manifest.web_accessible_resources[0].matches'],
      [{ ...base, web_accessible_resources: [{ resources: ['x'], extension_ids: 'id' }] }, 'manifest.web_accessible_resources[0].extension_ids'],
      [{ ...base, web_accessible_resources: [{ resources: ['x'], use_dynamic_url: 'yes' }] }, 'manifest.web_accessible_resources[0].use_dynamic_url'],
    ]
    for (const [manifest, field] of cases) {
      expect(() => validateManifest(manifest as any)).toThrow(field)
    }
    expect(() => validateManifest({
      ...base,
      permissions: ['tabs'],
      optional_permissions: ['storage'],
      host_permissions: ['https://example.com/*'],
      action: { default_popup: 'popup.html', default_title: 'Popup', default_icon: 'icon.png' },
      options_page: 'options.html',
      devtools_page: 'devtools.html',
      options_ui: { page: 'options-ui.html' },
      side_panel: { default_path: 'sidepanel.html' },
      icons: { 16: 'icon.png' },
      content_scripts: [{
        matches: ['<all_urls>'],
        js: ['content.js'],
        css: ['content.css'],
        run_at: 'document_idle',
        world: 'MAIN',
      }],
      web_accessible_resources: [{
        resources: ['asset.js'],
        matches: ['https://example.com/*'],
        extension_ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        use_dynamic_url: true,
      }],
    })).not.toThrow()
  })

  it('exercises bundle resolution, cycle guards, and fallback asset paths', () => {
    const bundle = {
      'content.js': {
        type: 'chunk',
        fileName: 'content.js',
        code: 'import "./dep.js"; export const ready = true;',
        imports: ['./dep.js'],
      },
      'assets/dep.js': {
        type: 'chunk',
        fileName: 'assets/dep.js',
        code: 'export const dep = true;',
        imports: ['dep.js'],
      },
      'assets/image.png': {
        type: 'asset',
        fileName: 'assets/image.png',
        originalFileName: 'src/image.png',
      },
    }
    expect(makeStandaloneContentChunk('missing.js', bundle)).toBeUndefined()
    expect(makeStandaloneContentChunk('assets/image.png', bundle)).toBeUndefined()
    expect(makeStandaloneContentChunk('content.js', bundle)).toContain('dep = true')
    expect(makeStandaloneContentChunk('content.js', bundle, new Set(['content.js']))).toBe('')
    expect(rewriteManifestReferences(
      {
        options_page: 'src/page.html',
        background: { service_worker: 'src/worker.js' },
        content_scripts: [{ js: ['src/image.png'], css: ['src/missing.css'] }],
      } as any,
      '/workspace',
      {
        page: { type: 'asset', fileName: 'page.html', originalFileName: 'src/page.html' },
        image: { type: 'asset', fileName: 'assets/image.png', originalFileName: 'src/image.png' },
      },
    )).toMatchObject({
      options_page: 'src/page.html',
      content_scripts: [{ js: ['assets/image.png'], css: ['src/missing.css'] }],
    })
  })

  it('builds a standalone IIFE from a content chunk and its static imports', () => {
    const bundle = {
      'content.js': {
        type: 'chunk',
        fileName: 'content.js',
        facadeModuleId: '/workspace/src/content.ts',
        code: 'import { helper } from "./dep.js"; console.log(helper); export {};',
        imports: ['assets/dep.js'],
      },
      'dep.js': {
        type: 'chunk',
        fileName: 'assets/dep.js',
        facadeModuleId: '/workspace/src/dep.ts',
        code: 'const helper = "ok"; export { helper };',
        imports: [],
      },
    }
    const output = makeStandaloneContentChunk('content.js', bundle)
    expect(output).toContain('(function ()')
    expect(output).toContain('const helper = "ok";')
    expect(output).toContain('console.log(helper)')
    expect(output).not.toMatch(/^\s*import\s/m)
    expect(output).not.toMatch(/^\s*export\s/m)
  })

  it('generates and merges deterministic WAR resources for content scripts', () => {
    const bundle = {
      'content.js': {
        type: 'chunk',
        fileName: 'content.js',
        facadeModuleId: '/workspace/src/content.ts',
        code: 'console.log("content")',
        referencedFiles: ['assets/logo.png', 'assets/content.css'],
        viteMetadata: { importedCss: new Set(['assets/content.css']) },
      },
      'content.css': {
        type: 'asset',
        fileName: 'assets/content.css',
        originalFileName: '/workspace/src/content.css',
      },
      'logo.png': {
        type: 'asset',
        fileName: 'assets/logo.png',
      },
    }
    const manifest = {
      name: 'WAR',
      version: '1',
      content_scripts: [{
        matches: ['https://example.com/*'],
        js: ['content.js'],
        css: ['assets/content.css'],
      }],
    }
    expect(manifestContentScriptEntries('/workspace', {
      ...manifest,
      content_scripts: [{ ...manifest.content_scripts[0], js: ['src/content.ts'] }],
    })).toEqual([
      { scriptIndex: 0, field: 'js', source: 'src/content.ts', absolute: '/workspace/src/content.ts' },
      { scriptIndex: 0, field: 'css', source: 'assets/content.css', absolute: '/workspace/assets/content.css' },
    ])
    const generated = generatedWebAccessibleResources(manifest, '/workspace', bundle)
    expect(generated).toEqual([{
      matches: ['https://example.com/*'],
      resources: ['assets/content.css', 'assets/logo.png', 'content.js'],
    }])
    expect(mergeWebAccessibleResources([
      {
        matches: ['https://example.com/*'],
        resources: ['user.js', 'assets/logo.png', 'user.js'],
        extension_ids: ['z', 'a'],
      },
      {
        matches: ['https://example.com/*'],
        resources: ['other.js'],
        extension_ids: ['a', 'z'],
      },
    ], generated)).toEqual([
      {
        extension_ids: ['z', 'a'],
        matches: ['https://example.com/*'],
        resources: ['assets/content.css', 'assets/logo.png', 'content.js', 'other.js', 'user.js'],
      },
    ])
  })
})

describe('plugin hooks', () => {
  it('emits a standalone content chunk and generated WAR in the manifest', async () => {
    const root = `/tmp/vite-plugin-content-${Date.now()}`
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'content.ts'), 'console.log("content")')
    fs.writeFileSync(path.join(root, 'src', 'content.css'), 'body { color: red }')
    const plugin = chromeExtension({
      pages: false,
      tailwind: false,
      manifest: {
        name: 'Content build',
        version: '1',
        content_scripts: [{
          matches: ['https://example.com/*'],
          js: ['src/content.ts'],
          css: ['src/content.css'],
        }],
      },
    })
    const configHook = hook(plugin.config)
    await configHook({
      root,
      build: { rollupOptions: {} },
    } as any, { command: 'build', mode: 'test' })
    hook(plugin.configResolved)({
      root,
      command: 'build',
      build: { outDir: 'dist', rollupOptions: {} },
    } as unknown as ResolvedConfig)
    const bundle: any = {
      'content.js': {
        type: 'chunk',
        fileName: 'content.js',
        facadeModuleId: path.join(root, 'src/content.ts'),
        code: 'console.log("content");',
        imports: [],
        viteMetadata: { importedCss: ['assets/content.css'] },
      },
      'assets/content.css': {
        type: 'asset',
        fileName: 'assets/content.css',
        originalFileName: path.join(root, 'src/content.css'),
      },
      // Vite can also emit a synthetic JS facade for a CSS input. Manifest
      // references must continue to point at the real stylesheet asset.
      'content-css-facade.js': {
        type: 'chunk',
        fileName: 'assets/content-css-facade.js',
        facadeModuleId: path.join(root, 'src/content.css'),
        code: '/* css facade */',
        imports: [],
      },
    }
    expect(manifestContentScriptEntries(root, {
      content_scripts: [{
        matches: ['https://example.com/*'],
        js: ['src/content.ts'],
        css: ['src/content.css'],
      }],
    })).toHaveLength(2)
    expect(makeStandaloneContentChunk('content.js', bundle)).toContain('(function ()')
    let output: Record<string, any> = {}
    await hook(plugin.generateBundle).call({
      emitFile: (asset: EmittedFile) => {
        if (asset.type === 'asset' && asset.fileName === 'manifest.json') {
          output = JSON.parse(String(asset.source))
        }
        return 'manifest'
      },
      warn: vi.fn(),
    } as unknown as PluginContext, {} as any, bundle, false)
    expect(bundle['content.js'].code).toContain('(function ()')
    expect(output.content_scripts).toEqual([{
      matches: ['https://example.com/*'],
      js: ['content.js'],
      css: ['assets/content.css'],
    }])
    expect(output.web_accessible_resources).toEqual([{
      matches: ['https://example.com/*'],
      resources: ['assets/content.css', 'content.js'],
    }])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('configures Tailwind while preserving user PostCSS plugins and can disable it', async () => {
    const existing = { postcssPlugin: 'existing-plugin' }
    const config = await resolveConfig({
      configFile: false,
      plugins: [chromeExtension({ pages: false })],
      css: { postcss: { plugins: [existing] } },
    }, 'serve')
    const postcss = config.css.postcss as { plugins?: unknown[] } | undefined
    expect(postcss?.plugins).toContain(existing)
    expect(postcss?.plugins?.some((plugin) => typeof plugin === 'object' && plugin !== null && 'postcssPlugin' in plugin && plugin.postcssPlugin === '@tailwindcss/postcss')).toBe(true)

    const manual = await resolveConfig({
      configFile: false,
      plugins: [chromeExtension({ pages: false, tailwind: false })],
      css: { postcss: { plugins: [existing] } },
    }, 'serve')
    expect(manual.css.postcss).toEqual({ plugins: [existing] })
  })

  it('returns no config when pages are disabled and Tailwind is disabled', async () => {
    const plugin = chromeExtension({ pages: false, tailwind: false })
    await expect(hook(plugin.config)({ root: '/workspace' } as any, { command: 'build', mode: 'test' })).resolves.toBeUndefined()
  })

  it('discovers pages, merges user Rollup input/output, and updates resolved input', async () => {
    const root = `/tmp/vite-plugin-config-${Date.now()}`
    fs.mkdirSync(path.join(root, 'modules', 'popup'), { recursive: true })
    fs.writeFileSync(path.join(root, 'modules', 'popup', 'index.html'), '')
    const plugin = chromeExtension()
    const result = await hook(plugin.config)({
      root,
      css: { postcss: { plugins: [] } },
      build: { rollupOptions: { input: { custom: '/custom.html' }, output: { entryFileNames: 'custom.js' } } },
    } as any, { command: 'build', mode: 'test' })
    expect(result?.build?.rollupOptions?.input).toEqual({
      'popup/index': path.join(root, 'modules', 'popup', 'index.html'),
      custom: '/custom.html',
    })
    expect(result?.build?.rollupOptions?.output).toMatchObject({ entryFileNames: 'custom.js' })
    await setup(plugin, {
      build: { outDir: 'dist', rollupOptions: { input: { custom: '/custom.html' } } } as any,
    })
    expect((plugin as any).configResolved).toBeDefined()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('adds manifest source entries to Vite input and preserves string input', async () => {
    const root = `/tmp/vite-plugin-manifest-${Date.now()}`
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'background.ts'), 'export default 1')
    const plugin = chromeExtension({
      manifest: {
        name: 'Manifest input',
        version: '1',
        background: { service_worker: 'src/background.ts' },
      },
    })
    const result = await hook(plugin.config)({
      root,
      build: { rollupOptions: { input: '/entry.ts' } },
    } as any, { command: 'build', mode: 'test' })
    expect(result?.build?.rollupOptions?.input).toBe('/entry.ts')
    hook(plugin.configResolved)({
      root,
      command: 'build',
      build: { outDir: 'dist', rollupOptions: { input: { main: '/main.ts' } } },
    } as unknown as ResolvedConfig)
    hook(plugin.configResolved)({
      root,
      command: 'build',
      build: { outDir: 'dist', rollupOptions: { input: '/main.ts' } },
    } as unknown as ResolvedConfig)
    expect((plugin as any).configResolved).toBeDefined()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('adds defineBackground source entries and gives them stable output names', async () => {
    const root = `/tmp/vite-plugin-background-helper-${Date.now()}`
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'src', 'background.ts'),
      'chrome.runtime.onInstalled.addListener(() => {})',
    )
    const plugin = chromeExtension({
      background: defineBackground('src/background.ts'),
      manifest: { name: 'Background helper', version: '1.0.0' },
    })
    const result = await hook(plugin.config)({
      root,
      build: { rollupOptions: {} },
    } as any, { command: 'build', mode: 'test' })
    expect(result?.build?.rollupOptions?.input).toMatchObject({
      'manifest-0-background-ts': path.join(root, 'src', 'background.ts'),
    })
    const entryFileNames = (result?.build?.rollupOptions?.output as any)?.entryFileNames
    expect(typeof entryFileNames).toBe('function')
    expect(entryFileNames({ name: 'manifest-0-background-ts' })).toBe('background.js')

    await setup(plugin, { root })
    let output: Record<string, any> = {}
    await hook(plugin.generateBundle).call({
      emitFile: (asset: EmittedFile) => {
        if (asset.type === 'asset') output = JSON.parse(String(asset.source))
        return 'manifest'
      },
      warn: () => {},
    } as unknown as PluginContext, {} as any, {
      'background.js': {
        type: 'chunk',
        fileName: 'background.js',
        facadeModuleId: path.join(root, 'src', 'background.ts'),
        code: 'chrome.runtime.onInstalled.addListener(() => {})',
      },
    } as any, false)
    expect(output).toMatchObject({
      background: { service_worker: 'background.js', type: 'module' },
    })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('keeps an explicit manifest background ahead of the helper shorthand', async () => {
    const plugin = chromeExtension({
      background: defineBackground('src/background.ts'),
      manifest: {
        name: 'Explicit background',
        version: '1.0.0',
        background: { service_worker: 'worker.js', type: 'module' },
      },
    })
    await setup(plugin, { root: '/workspace' })
    let output: Record<string, any> = {}
    await hook(plugin.generateBundle).call({
      emitFile: (asset: EmittedFile) => {
        if (asset.type === 'asset') output = JSON.parse(String(asset.source))
        return 'manifest'
      },
      warn: () => {},
    } as unknown as PluginContext, {} as any, {
      'worker.js': {
        type: 'chunk',
        fileName: 'worker.js',
        code: 'chrome.runtime.onInstalled.addListener(() => {})',
      },
    } as any, false)
    expect(output).toMatchObject({
      background: { service_worker: 'worker.js', type: 'module' },
    })
  })

  it('supports explicit pages and preserves direct user input', async () => {
    const plugin = chromeExtension({ pages: { popup: 'pages/popup.html' }, assetFileNames: 'styles/[name].css' })
    const result = await hook(plugin.config)({ root: '/workspace', build: { rollupOptions: { input: '/entry.ts' } } } as any, { command: 'build', mode: 'test' })
    expect(result?.build?.rollupOptions?.input).toBe('/entry.ts')
    expect((result?.build?.rollupOptions?.output as any)?.assetFileNames).toBe('styles/[name].css')
  })

  it('skips transforms in serve, node_modules, and unsupported files', async () => {
    const plugin = chromeExtension()
    await setup(plugin, { command: 'serve' })
    expect(transform(plugin, 'chrome.tabs.query({})', '/workspace/src/main.ts')).toBeNull()
    await setup(plugin, { command: 'build' })
    expect(transform(plugin, 'chrome.tabs.query({})', '/workspace/node_modules/a.ts')).toBeNull()
    expect(transform(plugin, 'chrome.tabs.query({})', '/workspace/src/style.css')).toBeNull()
  })

  it('warns and continues when AST parsing fails', async () => {
    const plugin = chromeExtension()
    await setup(plugin)
    const warn = vi.fn()
    expect(transform(plugin, 'const = ;', '/workspace/src/main.ts', warn)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AST permission analysis skipped'))
  })

  it('generates manifest with shortcuts, inferred permissions, and warning for unknown APIs', async () => {
    const plugin = chromeExtension({
      popup: 'shortcut.html',
      background: 'worker.js',
      contentScripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
      manifest: { icons: {}, permissions: ['storage'] },
      outDir: 'custom-dist',
    })
    await setup(plugin)
    transform(plugin, 'chrome.tabs.query({}); chrome.unknown.run();', '/workspace/src/main.ts')
    const warning = vi.fn()
    const { output } = await manifest(plugin, warning)
    expect(output).toMatchObject({
      manifest_version: 3,
      action: { default_popup: 'shortcut.html' },
      background: { service_worker: 'worker.js', type: 'module' },
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
      permissions: ['storage', 'tabs'],
    })
    expect(output.icons).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('No permission mapping found'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Manifest generated for'))
  })

  it('does not infer permissions when autoPermissions is disabled', async () => {
    const plugin = chromeExtension({ autoPermissions: false, manifest: { name: 'Manual', version: '1' } })
    await setup(plugin)
    transform(plugin, 'chrome.tabs.query({})', '/workspace/src/main.ts')
    expect((await manifest(plugin)).output.permissions).toBeUndefined()
  })

  it('rejects non-MV3 and incomplete manifests', async () => {
    const invalidVersion = chromeExtension({ manifest: { manifest_version: 2, name: 'x', version: '1' } })
    await setup(invalidVersion)
    await expect(manifest(invalidVersion)).rejects.toThrow('Only Manifest V3')

    const missingName = chromeExtension({ manifest: { name: '', version: '1' } })
    await setup(missingName)
    await expect(manifest(missingName)).rejects.toThrow('manifest.name must be a non-empty string')

    const missingVersion = chromeExtension({ manifest: { name: 'x', version: '' } })
    await setup(missingVersion)
    await expect(manifest(missingVersion)).rejects.toThrow('manifest.version must be a non-empty string')
  })

  it('validates common MV3 fields and reports duplicate permissions', () => {
    expect(() => validateManifest({
      manifest_version: 3,
      name: 'Valid',
      version: '1.0.0',
      action: { default_popup: 'popup.html' },
      background: { service_worker: 'background.js', type: 'module' },
      content_scripts: [{
        matches: ['https://example.com/*'],
        js: ['content.js'],
        world: 'ISOLATED',
      }],
    })).not.toThrow()
    expect(() => validateManifest({
      manifest_version: 3,
      name: 'Invalid',
      version: '1.0.0',
      background: { service_worker: 'background.js', type: 'classic' },
    })).toThrow('manifest.background.type')
    expect(() => validateManifest({
      manifest_version: 3,
      name: 'Invalid',
      version: '1.0.0',
      content_scripts: [{ matches: ['https://example.com/*'], world: 'worker' }],
    } as any)).toThrow('manifest.content_scripts[0].world')

    const diagnostics = diagnoseManifestReferences(
      {
        manifest_version: 3,
        name: 'Duplicate',
        version: '1.0.0',
        permissions: ['tabs', 'tabs'],
      },
      '/workspace',
      '/workspace/dist',
      {},
    )
    expect(diagnostics).toEqual([expect.objectContaining({
      field: 'manifest.permissions',
      level: 'warning',
    })])
  })

  it('locates manifest references and escalates missing files for a real bundle', () => {
    const manifest = {
      manifest_version: 3,
      name: 'References',
      version: '1.0.0',
      action: {
        default_popup: 'popup.html',
        default_icon: 'icons/action.png',
      },
      icons: { '128': 'icons/icon.png' },
      background: { service_worker: 'background.js' },
      content_scripts: [{
        matches: ['https://example.com/*'],
        js: ['content.js'],
        css: ['content.css'],
      }],
      web_accessible_resources: [{
        resources: ['assets/logo.png', '<dynamic_resource>'],
        matches: ['https://example.com/*'],
      }],
    }
    expect(manifestReferenceEntries(manifest)).toEqual(expect.arrayContaining([
      { field: 'manifest.action.default_popup', value: 'popup.html' },
      { field: 'manifest.action.default_icon', value: 'icons/action.png' },
      { field: 'manifest.icons.128', value: 'icons/icon.png' },
      { field: 'manifest.background.service_worker', value: 'background.js' },
      { field: 'manifest.content_scripts[0].js[0]', value: 'content.js' },
      { field: 'manifest.web_accessible_resources[0].resources[0]', value: 'assets/logo.png' },
    ]))
    const root = `/tmp/vite-plugin-diagnostics-${Date.now()}`
    fs.mkdirSync(path.join(root, 'public', 'icons'), { recursive: true })
    fs.writeFileSync(path.join(root, 'public', 'icons', 'icon.png'), '')
    const diagnostics = diagnoseManifestReferences(manifest, root, path.join(root, 'dist'), {
      background: { type: 'chunk', fileName: 'background.js' },
      content: { type: 'chunk', fileName: 'content.js' },
      css: { type: 'asset', fileName: 'content.css' },
    })
    expect(diagnostics.filter(({ level }) => level === 'error')).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'manifest.web_accessible_resources[0].resources[0]' }),
    ]))
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('diagnoses warnings, wildcards, filesystem references, and duplicate lists', () => {
    const root = `/tmp/vite-plugin-diagnostic-paths-${Date.now()}`
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'public'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'worker.js'), '')
    fs.writeFileSync(path.join(root, 'public', 'public.js'), '')
    fs.writeFileSync(path.join(root, 'dist', 'built.js'), '')
    const manifest = {
      manifest_version: 3,
      name: 'Diagnostics',
      version: '1',
      background: { service_worker: 'missing-worker.js' },
      action: { default_popup: 'https://example.com/popup.html' },
      content_scripts: [{
        matches: ['<all_urls>'],
        js: ['src/worker.js', 'missing.css'],
      }],
      web_accessible_resources: [{
        resources: ['assets/*.js', '<dynamic_resource>', 'public.js', 'built.js'],
        matches: ['https://example.com/*'],
      }],
      permissions: ['tabs', 'tabs', 1],
    }
    const warningDiagnostics = diagnoseManifestReferences(manifest as any, root, path.join(root, 'dist'), {})
    expect(warningDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', field: 'manifest.background.service_worker' }),
      expect.objectContaining({ level: 'warning', field: 'manifest.content_scripts[0].js[1]' }),
      expect.objectContaining({ field: 'manifest.permissions' }),
    ]))
    const bundleDiagnostics = diagnoseManifestReferences(manifest as any, root, path.join(root, 'dist'), {
      script: { type: 'chunk', fileName: 'assets/content.js' },
    })
    expect(bundleDiagnostics.some(({ level }) => level === 'error')).toBe(true)
    expect(diagnoseManifestReferences({
      ...manifest,
      permissions: ['tabs'],
      background: { service_worker: 'src/worker.js' },
      content_scripts: [{ matches: ['<all_urls>'], js: ['public.js'] }],
      web_accessible_resources: [{ resources: ['assets/content.js', 'built.js'], matches: ['https://example.com/*'] }],
    } as any, root, path.join(root, 'dist'), {
      content: { type: 'chunk', fileName: 'assets/content.js' },
    })).toEqual([])
    expect(diagnoseManifestReferences({
      manifest_version: 3,
      name: 'Deleted public entry',
      version: '1.0.0',
      content_scripts: [{ matches: ['<all_urls>'], js: ['built.js'] }],
    }, root, path.join(root, 'dist'), {
      popup: { type: 'asset', fileName: 'popup.html' },
    }, false)).toEqual([expect.objectContaining({
      level: 'error',
      field: 'manifest.content_scripts[0].js[0]',
    })])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('uses the configured public directory and honors publicDir false', () => {
    const root = fs.mkdtempSync('/tmp/extension-public-reference-')
    const publicDir = path.join(root, 'static')
    fs.mkdirSync(publicDir)
    fs.writeFileSync(path.join(publicDir, 'worker.js'), '')
    const manifest = { manifest_version: 3, name: 'Custom public', version: '1.0.0', background: { service_worker: 'worker.js' } }
    const bundle = { popup: { type: 'asset', fileName: 'popup.html' } }
    expect(diagnoseManifestReferences(manifest, root, path.join(root, 'dist'), bundle, false, publicDir)).toEqual([])
    expect(diagnoseManifestReferences(manifest, root, path.join(root, 'dist'), bundle, false, false)).toEqual([
      expect.objectContaining({ level: 'error', field: 'manifest.background.service_worker' }),
    ])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
