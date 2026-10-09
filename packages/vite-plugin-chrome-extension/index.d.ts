import type { Plugin } from 'vite'

export interface ChromeExtensionOptions {
  manifest?: Record<string, unknown>
  background?: string
  popup?: string
  contentScripts?: Array<Record<string, unknown>>
  outDir?: string
}

export default function chromeExtension(options?: ChromeExtensionOptions): Plugin
export const DEFAULT_MANIFEST: Record<string, unknown>
