import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Plugin, ResolvedConfig } from 'vite'
import chromeExtension, { rewriteManifestReferences, validateManifest } from '../index.js'

const roots: string[] = []

function hook(value: any): (...args: any[]) => any {
  return typeof value === 'function' ? value : value.handler
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

async function generate(action: Record<string, unknown>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-action-')))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'modules', 'sidepanel'), { recursive: true })
  fs.writeFileSync(path.join(root, 'modules', 'sidepanel', 'index.html'), '')
  const plugin: Plugin = chromeExtension({
    tailwind: false,
    manifest: { name: 'Side panel', version: '1.0.0', action },
  })
  await hook(plugin.config)({ root, build: {} }, { command: 'build', mode: 'test' })
  hook(plugin.configResolved)({
    root,
    command: 'build',
    build: { outDir: 'dist', rollupOptions: {} },
  } as ResolvedConfig)
  let result: Record<string, any> | undefined
  await hook(plugin.generateBundle).call({
    warn: vi.fn(),
    emitFile: (asset: { source: string }) => {
      result = JSON.parse(String(asset.source))
      return 'manifest'
    },
  }, {}, {
    sidepanel: {
      type: 'asset',
      fileName: 'modules/sidepanel/index.html',
      originalFileName: path.join(root, 'modules', 'sidepanel', 'index.html'),
    },
    popup: {
      type: 'asset',
      fileName: 'popup.html',
      originalFileName: path.join(root, 'popup.html'),
    },
  }, false)
  return result!
}

it('keeps absent optional paths absent during source reference rewriting', () => {
  const input = {
    manifest_version: 3,
    name: 'Optional paths',
    version: '1.0.0',
    action: { default_title: 'Open panel' },
    background: {},
    options_ui: { open_in_tab: true },
    side_panel: {},
  }
  const output = rewriteManifestReferences(input, '/workspace', {})
  expect(output).toStrictEqual(input)
  for (const [container, field] of [
    ['action', 'default_popup'],
    ['background', 'service_worker'],
    ['options_ui', 'page'],
    ['side_panel', 'default_path'],
  ]) {
    expect(output[container]).not.toHaveProperty(field)
  }
})

it('builds a toolbar action without a popup alongside a generated side panel page', async () => {
  const result = await generate({ default_title: 'Open panel' })
  expect(result.action).toStrictEqual({ default_title: 'Open panel' })
  expect(result.side_panel).toStrictEqual({ default_path: 'modules/sidepanel/index.html' })
  expect(() => validateManifest(result)).not.toThrow()
})

it.each([undefined, 42, null])('retains explicitly invalid popup %s for validation', async (default_popup) => {
  const manifest = {
    manifest_version: 3,
    name: 'Invalid popup',
    version: '1.0.0',
    action: { default_popup },
  }
  const rewritten = rewriteManifestReferences(manifest, '/workspace', {})
  expect(rewritten.action).toHaveProperty('default_popup', default_popup)
  expect(() => validateManifest(rewritten)).toThrow('manifest.action.default_popup')
  await expect(generate({ default_popup })).rejects.toThrow('manifest.action.default_popup')
})

it('preserves valid popup paths while rewriting generated side panel paths', async () => {
  expect((await generate({ default_popup: 'popup.html' })).action)
    .toStrictEqual({ default_popup: 'popup.html' })
})
