import path from 'node:path'

const DEFAULT_MANIFEST = {
  manifest_version: 3,
  name: 'Vite React Chrome Extension',
  version: '0.1.0',
  description: 'A Chrome extension built with Vite and React.',
  action: {
    default_popup: 'index.html'
  },
  icons: {}
}

function mergeManifest(base, override) {
  const result = { ...base, ...override }
  for (const key of ['action', 'background', 'content_scripts', 'web_accessible_resources']) {
    if (base[key] && override?.[key]) {
      result[key] = Array.isArray(base[key]) || Array.isArray(override[key])
        ? override[key]
        : { ...base[key], ...override[key] }
    }
  }
  return result
}

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error('[chrome-extension] Only Manifest V3 is supported.')
  }
  for (const field of ['name', 'version']) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      throw new Error(`[chrome-extension] manifest.${field} must be a non-empty string.`)
    }
  }
}

/**
 * Generate a Chrome Manifest V3 extension from a Vite build.
 *
 * @param {{
 *   manifest?: Record<string, unknown>,
 *   background?: string,
 *   popup?: string,
 *   contentScripts?: Array<Record<string, unknown>>,
 *   outDir?: string
 * }} options
 */
export default function chromeExtension(options = {}) {
  let resolvedConfig
  const manifest = mergeManifest(DEFAULT_MANIFEST, options.manifest)

  if (options.popup) {
    manifest.action = { ...(manifest.action || {}), default_popup: options.popup }
  }
  if (options.background) {
    manifest.background = {
      ...(manifest.background || {}),
      service_worker: options.background,
      type: 'module'
    }
  }
  if (options.contentScripts) {
    manifest.content_scripts = options.contentScripts
  }

  validateManifest(manifest)

  return {
    name: 'vite-plugin-chrome-extension',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config
    },
    generateBundle() {
      const outputDir = options.outDir || resolvedConfig.build.outDir
      const generatedManifest = {
        ...manifest,
        ...(manifest.icons && Object.keys(manifest.icons).length === 0 ? { icons: undefined } : {})
      }
      // Undefined is omitted so the generated manifest stays Chrome-valid.
      if (generatedManifest.icons === undefined) delete generatedManifest.icons
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(generatedManifest, null, 2)}\n`
      })
      this.warn(`[chrome-extension] Manifest generated for ${path.resolve(outputDir)}`)
    }
  }
}

export { DEFAULT_MANIFEST }
