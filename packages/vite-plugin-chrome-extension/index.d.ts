import type { Plugin } from "vite";

export interface ChromeExtensionOptions {
  manifest?: Record<string, unknown>;
  pages?: Record<string, string> | false;
  pageRoot?: string;
  background?: string;
  popup?: string;
  contentScripts?: Array<Record<string, unknown>>;
  autoPermissions?: boolean;
  outDir?: string;
}

export default function chromeExtension(
  options?: ChromeExtensionOptions,
): Plugin;
export const DEFAULT_MANIFEST: Record<string, unknown>;
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T;
export function discoverPages(
  root: string,
  pageRoot?: string,
): Record<string, string>;
export function pagesToManifest(
  pages: Record<string, string>,
): Record<string, unknown>;
export function collectPermissions(
  code: string,
  id: string,
): { permissions: Set<string>; unknownNamespaces: string[] };
