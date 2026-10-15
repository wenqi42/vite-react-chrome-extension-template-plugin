import fs from "node:fs";
import path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import type { Node } from "@babel/types";
import type { ConfigEnv, Plugin, ResolvedConfig, UserConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";
import { DEV_BUILD, configureExtensionDevServer, copyDevConfig } from "./dev.js";

export interface ManifestContentScript extends Record<string, unknown> {
  matches?: string[];
  js?: string[];
  css?: string[];
  world?: "ISOLATED" | "MAIN";
}

export interface ContentScriptsBuildOptions {
  /**
   * Build source entries as standalone scripts. This is enabled by default
   * for source files referenced by `manifest.content_scripts[].js`.
   */
  standalone?: boolean;
}

export interface BackgroundBuildOptions {
  /**
   * Source entry compiled by Vite/Rollup into the service worker.
   */
  entry: string;
  /**
   * Stable output path written to `manifest.background.service_worker`.
   * Defaults to `background.js`.
   */
  fileName?: string;
  /**
   * Manifest service-worker type. MV3 currently only accepts `module`.
   */
  type?: "module";
}

export interface ChromeExtensionOptions {
  manifest?: ManifestInput;
  pages?: Record<string, string> | false;
  pageRoot?: string;
  background?: string | BackgroundBuildOptions;
  popup?: string;
  contentScripts?:
    | Array<ManifestContentScript>
    | ContentScriptsBuildOptions;
  autoPermissions?: boolean;
  outDir?: string;
  /** Enable Tailwind CSS 4 compilation in dev and build (default: true). */
  tailwind?: boolean;
  /** Rollup asset pattern used for generated assets. */
  assetFileNames?: string;
  /** Build an unpacked extension in dev and reload it after successful writes. */
  liveReload?: boolean;
}

export interface Manifest extends Record<string, unknown> {
  permissions?: string[];
  icons?: Record<string, string>;
}

export type ManifestFactory = (
  env: ConfigEnv,
) => Manifest | Promise<Manifest>;
export type ManifestInput = Manifest | Promise<Manifest> | ManifestFactory;

export interface WebAccessibleResourceByMatch {
  resources: string[];
  matches?: string[];
  extension_ids?: string[];
  use_dynamic_url?: boolean;
}

export const DYNAMIC_RESOURCE = "<dynamic_resource>" as const;

export interface ManifestReference {
  field: string;
  value: string;
}

export interface ManifestDiagnostic {
  level: "warning" | "error";
  field: string;
  message: string;
}

export function defineManifest<T extends ManifestInput>(manifest: T): T {
  return manifest;
}

/**
 * Declare a TypeScript/JavaScript background source entry while keeping a
 * stable service-worker output path. The existing `background: 'background.js'`
 * shorthand remains unchanged and still supports a `public/background.js`
 * fallback.
 */
export function defineBackground(
  entry: string,
  options: Omit<BackgroundBuildOptions, "entry"> = {},
): BackgroundBuildOptions {
  return {
    entry,
    fileName: "background.js",
    type: "module",
    ...options,
  };
}

export function defineDynamicResource(
  options: Omit<WebAccessibleResourceByMatch, "resources"> = {},
): WebAccessibleResourceByMatch {
  return {
    matches: ["http://*/*", "https://*/*"],
    ...options,
    resources: [DYNAMIC_RESOURCE],
  };
}

const PERMISSION_MAP = JSON.parse(
  fs.readFileSync(
    new URL("./chrome-permission-map.json", import.meta.url),
    "utf8",
  ),
).apis as Record<string, string[]>;

const DEFAULT_MANIFEST: Manifest = {
  manifest_version: 3,
  name: "Vite React Chrome Extension",
  version: "0.1.0",
  description: "A Chrome extension built with Vite and React.",
};

const PAGE_MANIFEST: Record<string, (pages: Record<string, string>) => Manifest> = {
  popup: (pages) => ({ action: { default_popup: pages.popup } }),
  options: (pages) => ({
    options_ui: { page: pages.options, open_in_tab: true },
  }),
  sidepanel: (pages) => ({ side_panel: { default_path: pages.sidepanel } }),
  devtools: (pages) => ({ devtools_page: pages.devtools }),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge objects like lodash.merge while treating arrays as user-owned values.
 * This prevents default permissions/content scripts from leaking into user config.
 */
function deepMerge(base: Manifest, override: Manifest): Manifest;
function deepMerge(base: unknown, override: unknown): unknown;
function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override))
    return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      isPlainObject(result[key]) && isPlainObject(value)
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

function pageNameFromEntry(entry: string, pageRoot = "modules") {
  const relative = entry.split(path.sep).join("/");
  const prefix = `${pageRoot.split(path.sep).join("/")}/`;
  return relative
    .replace(new RegExp(`^${prefix}`), "")
    .replace(/\/index\.html$/, "");
}

function discoverPages(root: string, pageRoot = "modules"): Record<string, string> {
  const directory = path.resolve(root, pageRoot);
  if (!fs.existsSync(directory)) return {};

  return Object.fromEntries(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name, "index.html"))
      .filter((file) => fs.existsSync(file))
      .map((file) => [
        pageNameFromEntry(path.relative(root, file), pageRoot),
        file,
      ]),
  );
}

function normalizePages(root: string, pages: ChromeExtensionOptions["pages"], pageRoot?: string) {
  if (pages === false) return {};
  if (pages && isPlainObject(pages)) {
    return Object.fromEntries(
      Object.entries(pages).map(([name, entry]) => [
        name,
        path.resolve(root, entry),
      ]),
    );
  }
  return discoverPages(root, pageRoot);
}

function pageInputEntries(pages: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(pages).map(([name, entry]) => [`${name}/index`, entry]),
  );
}

function isPathReference(value: unknown): value is string {
  return typeof value === "string" && /\.[a-z0-9]+$/i.test(value);
}

function isExternalReference(value: string) {
  return (
    value.startsWith("<") ||
    value.startsWith("/") ||
    value.startsWith("#") ||
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    value.startsWith("//")
  );
}

function manifestReferenceEntries(manifest: Manifest): ManifestReference[] {
  const references: ManifestReference[] = [];
  const add = (field: string, value: unknown) => {
    if (typeof value !== "string" || isExternalReference(value)) return;
    references.push({ field, value });
  };
  const action = manifest.action;
  if (isPlainObject(action)) {
    add("manifest.action.default_popup", action.default_popup);
    const defaultIcon = action.default_icon;
    if (typeof defaultIcon === "string") {
      add("manifest.action.default_icon", defaultIcon);
    } else if (isPlainObject(defaultIcon)) {
      for (const [size, icon] of Object.entries(defaultIcon)) {
        add(`manifest.action.default_icon.${size}`, icon);
      }
    }
  }
  const background = manifest.background;
  if (isPlainObject(background)) {
    add("manifest.background.service_worker", background.service_worker);
  }
  add("manifest.options_page", manifest.options_page);
  add("manifest.devtools_page", manifest.devtools_page);
  const optionsUi = manifest.options_ui;
  if (isPlainObject(optionsUi)) add("manifest.options_ui.page", optionsUi.page);
  const sidePanel = manifest.side_panel;
  if (isPlainObject(sidePanel)) {
    add("manifest.side_panel.default_path", sidePanel.default_path);
  }
  const icons = manifest.icons;
  if (isPlainObject(icons)) {
    for (const [size, icon] of Object.entries(icons)) {
      add(`manifest.icons.${size}`, icon);
    }
  }
  const contentScripts = manifest.content_scripts;
  if (Array.isArray(contentScripts)) {
    for (const [index, script] of contentScripts.entries()) {
      if (!isPlainObject(script)) continue;
      for (const field of ["js", "css"]) {
        const paths = script[field];
        if (Array.isArray(paths)) {
          paths.forEach((value, pathIndex) =>
            add(`manifest.content_scripts[${index}].${field}[${pathIndex}]`, value),
          );
        }
      }
    }
  }
  const webAccessibleResources = manifest.web_accessible_resources;
  if (Array.isArray(webAccessibleResources)) {
    for (const [index, group] of webAccessibleResources.entries()) {
      if (!isPlainObject(group) || !Array.isArray(group.resources)) continue;
      group.resources.forEach((value, resourceIndex) =>
        add(
          `manifest.web_accessible_resources[${index}].resources[${resourceIndex}]`,
          value,
        ),
      );
    }
  }
  return references;
}

function manifestEntryReferences(manifest: Manifest): string[] {
  return [
    ...new Set(
      manifestReferenceEntries(manifest)
        .map((reference) => reference.value)
        .filter(isPathReference),
    ),
  ];
}

function manifestSourceReferences(manifest: Manifest): ManifestReference[] {
  return manifestReferenceEntries(manifest).filter(
    ({ field, value }) =>
      !field.includes(".icons.") &&
      !field.includes(".web_accessible_resources") &&
      /\.(?:html|css|cjs|mjs|js|jsx|ts|tsx|vue|svelte)$/i.test(value),
  );
}

function isArrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function manifestError(field: string, message: string, suggestion?: string): Error {
  return new Error(
    `[chrome-extension] ${field} ${message}${suggestion ? ` ${suggestion}` : ""}`,
  );
}

function validateCommonManifestFields(manifest: Manifest) {
  if (manifest.manifest_version !== 3) {
    throw manifestError("manifest.manifest_version", "must be 3.", "Only Manifest V3 is supported.");
  }
  for (const field of ["name", "version"]) {
    if (!manifest[field] || typeof manifest[field] !== "string") {
      throw manifestError(`manifest.${field}`, "must be a non-empty string.");
    }
  }
  for (const field of ["description"]) {
    if (field in manifest && typeof manifest[field] !== "string") {
      throw manifestError(`manifest.${field}`, "must be a string when provided.");
    }
  }
  for (const field of ["permissions", "optional_permissions", "host_permissions"]) {
    if (field in manifest && !isArrayOfStrings(manifest[field])) {
      throw manifestError(`manifest.${field}`, "must be an array of strings.");
    }
  }

  const action = manifest.action;
  if (action !== undefined && !isPlainObject(action)) {
    throw manifestError("manifest.action", "must be an object when provided.");
  }
  if (isPlainObject(action)) {
    for (const field of ["default_popup", "default_title"]) {
      if (field in action && typeof action[field] !== "string") {
        throw manifestError(`manifest.action.${field}`, "must be a string when provided.");
      }
    }
    const icon = action.default_icon;
    if (
      icon !== undefined &&
      typeof icon !== "string" &&
      !(isPlainObject(icon) && Object.values(icon).every((entry) => typeof entry === "string"))
    ) {
      throw manifestError(
        "manifest.action.default_icon",
        "must be a string or an object whose values are strings.",
      );
    }
  }

  const background = manifest.background;
  if (background !== undefined && !isPlainObject(background)) {
    throw manifestError("manifest.background", "must be an object when provided.");
  }
  if (isPlainObject(background)) {
    if (typeof background.service_worker !== "string" || !background.service_worker) {
      throw manifestError(
        "manifest.background.service_worker",
        "must be a non-empty string.",
        "Build a worker entry or place background.js under public/.",
      );
    }
    if (background.type !== undefined && background.type !== "module") {
      throw manifestError("manifest.background.type", "must be \"module\" in Manifest V3.");
    }
  }

  for (const field of ["options_page", "devtools_page"]) {
    if (field in manifest && typeof manifest[field] !== "string") {
      throw manifestError(`manifest.${field}`, "must be a string when provided.");
    }
  }
  for (const [field, value] of [
    ["options_ui", manifest.options_ui],
    ["side_panel", manifest.side_panel],
  ] as const) {
    if (value !== undefined && !isPlainObject(value)) {
      throw manifestError(`manifest.${field}`, "must be an object when provided.");
    }
    if (isPlainObject(value)) {
      const pathField = field === "options_ui" ? "page" : "default_path";
      if (value[pathField] !== undefined && typeof value[pathField] !== "string") {
        throw manifestError(`manifest.${field}.${pathField}`, "must be a string when provided.");
      }
    }
  }

  if (manifest.icons !== undefined) {
    if (
      !isPlainObject(manifest.icons) ||
      !Object.values(manifest.icons).every((entry) => typeof entry === "string")
    ) {
      throw manifestError("manifest.icons", "must be an object whose values are strings.");
    }
  }

  const contentScripts = manifest.content_scripts;
  if (contentScripts !== undefined) {
    if (!Array.isArray(contentScripts)) {
      throw manifestError("manifest.content_scripts", "must be an array of objects.");
    }
    const runsAt = new Set(["document_start", "document_end", "document_idle"]);
    const worlds = new Set(["ISOLATED", "MAIN"]);
    for (const [index, script] of contentScripts.entries()) {
      const field = `manifest.content_scripts[${index}]`;
      if (!isPlainObject(script)) throw manifestError(field, "must be an object.");
      if (!isArrayOfStrings(script.matches) || script.matches.length === 0) {
        throw manifestError(`${field}.matches`, "must be a non-empty array of strings.");
      }
      for (const fileField of ["js", "css"]) {
        if (script[fileField] !== undefined && !isArrayOfStrings(script[fileField])) {
          throw manifestError(`${field}.${fileField}`, "must be an array of strings.");
        }
      }
      if (script.run_at !== undefined && !runsAt.has(String(script.run_at))) {
        throw manifestError(`${field}.run_at`, "must be document_start, document_end or document_idle.");
      }
      if (script.world !== undefined && !worlds.has(String(script.world))) {
        throw manifestError(`${field}.world`, "must be ISOLATED or MAIN.");
      }
    }
  }

  const webAccessibleResources = manifest.web_accessible_resources;
  if (webAccessibleResources !== undefined) {
    if (!Array.isArray(webAccessibleResources)) {
      throw manifestError("manifest.web_accessible_resources", "must be an array of objects.");
    }
    for (const [index, group] of webAccessibleResources.entries()) {
      const field = `manifest.web_accessible_resources[${index}]`;
      if (!isPlainObject(group)) throw manifestError(field, "must be an object.");
      if (!isArrayOfStrings(group.resources) || group.resources.length === 0) {
        throw manifestError(`${field}.resources`, "must be a non-empty array of strings.");
      }
      for (const listField of ["matches", "extension_ids"]) {
        if (group[listField] !== undefined && !isArrayOfStrings(group[listField])) {
          throw manifestError(`${field}.${listField}`, "must be an array of strings.");
        }
      }
      if (
        group.use_dynamic_url !== undefined &&
        typeof group.use_dynamic_url !== "boolean"
      ) {
        throw manifestError(`${field}.use_dynamic_url`, "must be a boolean when provided.");
      }
    }
  }
}

function manifestInputEntries(root: string, manifest: Manifest) {
  return Object.fromEntries(
    manifestSourceReferences(manifest)
      .map(({ value: entry }, index) => {
        const absolute = path.resolve(root, entry);
        if (!fs.existsSync(absolute)) return null;
        const key = manifestInputKey(entry, index);
        return [key, absolute] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
}

function backgroundInputManifest(
  manifest: Manifest,
  background: ChromeExtensionOptions["background"],
): Manifest {
  if (
    "background" in manifest ||
    !background ||
    typeof background === "string"
  ) {
    return manifest;
  }
  return deepMerge(manifest, {
    background: {
      service_worker: background.entry,
      type: background.type || "module",
    },
  }) as Manifest;
}

type BundleItem = {
  type: string;
  fileName?: string;
  facadeModuleId?: string | null;
  originalFileName?: string | null;
  code?: string;
  imports?: string[];
  dynamicImports?: string[];
  referencedFiles?: string[];
  viteMetadata?: {
    importedCss?: Iterable<string>;
  };
};

type BundleLike = Record<string, BundleItem>;

interface ContentScriptSourceEntry {
  scriptIndex: number;
  field: "js" | "css";
  source: string;
  absolute: string;
}

function manifestContentScriptEntries(
  root: string,
  manifest: Manifest,
): ContentScriptSourceEntry[] {
  const entries: ContentScriptSourceEntry[] = [];
  const scripts = manifest.content_scripts;
  if (!Array.isArray(scripts)) return entries;
  scripts.forEach((value, scriptIndex) => {
    if (!isPlainObject(value)) return;
    for (const field of ["js", "css"] as const) {
      const values = value[field];
      if (!Array.isArray(values)) continue;
      values.forEach((source) => {
        if (typeof source !== "string" || source.startsWith("<")) return;
        entries.push({
          scriptIndex,
          field,
          source,
          absolute: path.resolve(root, source),
        });
      });
    }
  });
  return entries;
}

function manifestInputKey(entry: string, index: number) {
  return `manifest-${index}-${path.basename(entry).replace(/\W+/g, "-")}`;
}

function contentScriptInputNames(root: string, manifest: Manifest) {
  const references = manifestSourceReferences(manifest).map(({ value }) => value);
  const contentSources = new Set(
    manifestContentScriptEntries(root, manifest).map(({ source }) => source),
  );
  return new Set(
    references
      .map((entry, index) =>
        contentSources.has(entry) ? manifestInputKey(entry, index) : undefined,
      )
      .filter((name): name is string => Boolean(name)),
  );
}

function bundleItemByFileName(bundle: BundleLike, fileName: string) {
  return Object.values(bundle).find(
    (item) => item.fileName === fileName,
  );
}

function bundleFileNames(bundle: BundleLike) {
  return Object.values(bundle)
    .map((item) => item.fileName)
    .filter((fileName): fileName is string => Boolean(fileName));
}

function resolveBundleImport(
  imported: string,
  fromFileName: string,
  bundle: BundleLike,
) {
  if (bundleItemByFileName(bundle, imported)) return imported;
  const normalized = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFileName), imported),
  );
  if (bundleItemByFileName(bundle, normalized)) return normalized;
  const basename = path.posix.basename(imported);
  return bundleFileNames(bundle).find(
    (fileName) => path.posix.basename(fileName) === basename,
  );
}

function stripModuleSyntax(code: string) {
  return code
    .replace(/import\s+[^;]+from\s+["'][^"']+["'];?/g, "")
    .replace(/import\s*["'][^"']+["'];?/g, "")
    .replace(/export\s*\{[^}]*\};?/g, "")
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+(?=(?:const|let|var|function|class)\b)/g, "");
}

/**
 * Rollup uses one output format for all inputs. Content scripts need a
 * self-contained function when they are loaded by Chrome, so we inline their
 * static dependency chunks and wrap the resulting code in an IIFE. The
 * generated chunk remains in the bundle for other entries when it is shared.
 */
function makeStandaloneContentChunk(
  fileName: string,
  bundle: BundleLike,
  seen = new Set<string>(),
): string | undefined {
  const item = bundleItemByFileName(bundle, fileName);
  if (!item || item.type !== "chunk" || typeof item.code !== "string") {
    return undefined;
  }
  if (seen.has(fileName)) return "";
  seen.add(fileName);
  const dependencies = [
    ...(item.imports || []),
    // Dynamic imports cannot be inlined safely; they stay as output files and
    // are included in WAR below.
  ];
  const dependencyCode = dependencies
    .map((dependency) => {
      const resolved = resolveBundleImport(dependency, fileName, bundle);
      return resolved
        ? inlineContentChunk(resolved, bundle, seen)
        : undefined;
    })
    .filter((code): code is string => Boolean(code))
    .join("\n");
  const ownCode = stripModuleSyntax(item.code);
  return `(function () {\n${dependencyCode}\n${ownCode}\n})();\n`;
}

function inlineContentChunk(
  fileName: string,
  bundle: BundleLike,
  seen: Set<string>,
): string | undefined {
  const item = bundleItemByFileName(bundle, fileName);
  if (!item || item.type !== "chunk" || typeof item.code !== "string") {
    return undefined;
  }
  if (seen.has(fileName)) return "";
  seen.add(fileName);
  const dependencies = (item.imports || [])
    .map((dependency) => resolveBundleImport(dependency, fileName, bundle))
    .filter((dependency): dependency is string => Boolean(dependency))
    .map((dependency) => inlineContentChunk(dependency, bundle, seen))
    .filter((code): code is string => Boolean(code))
    .join("\n");
  return `${dependencies}\n${stripModuleSyntax(item.code)}`;
}

function contentScriptOutput(
  source: string,
  root: string,
  bundle: BundleLike,
) {
  if (bundleItemByFileName(bundle, source)) return source;
  return outputPathForSource(path.resolve(root, source), root, bundle);
}

function canonicalPath(value: string) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function contentScriptDependencyFiles(
  fileName: string,
  bundle: BundleLike,
  seen = new Set<string>(),
): string[] {
  if (seen.has(fileName)) return [];
  seen.add(fileName);
  const item = bundleItemByFileName(bundle, fileName);
  if (!item) return [];
  const dependencies = [
    ...(item.referencedFiles || []),
    ...(item.dynamicImports || []),
    ...(item.viteMetadata?.importedCss
      ? [...item.viteMetadata.importedCss]
      : []),
  ];
  const result = new Set<string>();
  for (const dependency of dependencies) {
    const resolved = resolveBundleImport(dependency, fileName, bundle);
    if (resolved) {
      result.add(resolved);
      contentScriptDependencyFiles(resolved, bundle, seen).forEach((value) =>
        result.add(value),
      );
    } else {
      result.add(dependency.replaceAll(path.sep, "/"));
    }
  }
  return [...result];
}

function canonicalResourceGroupKey(
  group: WebAccessibleResourceByMatch,
) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(group)
        .filter(([key]) => key !== "resources")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value].sort() : value,
        ]),
    ),
  );
}

/**
 * Merge generated WAR groups with user declarations. Groups with the same
 * match/extension metadata are combined; each resource list is deterministic.
 */
function mergeWebAccessibleResources(
  existing: unknown,
  generated: WebAccessibleResourceByMatch[],
) {
  const userGroups = (Array.isArray(existing) ? existing : []).filter(
    (group): group is WebAccessibleResourceByMatch =>
      isPlainObject(group) && Array.isArray(group.resources),
  );
  const groups = userGroups
    .map((group) => ({ group, generated: false }))
    .concat(generated.map((group) => ({ group, generated: true })))
    .filter(({ group }) =>
    isPlainObject(group) && Array.isArray(group.resources),
  );
  const merged = new Map<string, WebAccessibleResourceByMatch>();
  for (const { group, generated: isGenerated } of groups) {
    const normalized: WebAccessibleResourceByMatch = {
      ...group,
      resources: [...new Set(
        group.resources
          .filter((resource): resource is string => typeof resource === "string")
          .map((resource) => resource.replaceAll(path.sep, "/")),
      )].sort(),
    };
    const key = canonicalResourceGroupKey(normalized);
    let previous = merged.get(key);
    if (!previous && isGenerated && Array.isArray(normalized.matches)) {
      previous = [...merged.values()].find(
        (candidate) =>
          Array.isArray(candidate.matches) &&
          candidate.matches.length === normalized.matches?.length &&
          [...candidate.matches].sort().every(
            (match, index) => match === [...(normalized.matches || [])].sort()[index],
          ),
      );
    }
    if (previous) {
      previous.resources = [...new Set([
        ...previous.resources,
        ...normalized.resources,
      ])].sort();
    } else {
      merged.set(key, normalized);
    }
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
}

function generatedWebAccessibleResources(
  manifest: Manifest,
  root: string,
  bundle: BundleLike,
) {
  const generated: WebAccessibleResourceByMatch[] = [];
  const scripts = manifest.content_scripts;
  if (!Array.isArray(scripts)) return generated;
  scripts.forEach((value) => {
    if (!isPlainObject(value) || !Array.isArray(value.matches)) return;
    const resources = new Set<string>();
    for (const field of ["js", "css"] as const) {
      const paths = value[field];
      if (!Array.isArray(paths)) continue;
      for (const source of paths) {
        if (typeof source !== "string" || source.startsWith("<")) continue;
        const output = contentScriptOutput(source, root, bundle);
        if (!output) continue;
        resources.add(output.replaceAll(path.sep, "/"));
        contentScriptDependencyFiles(output, bundle).forEach((fileName) =>
          resources.add(fileName.replaceAll(path.sep, "/")),
        );
      }
    }
    if (resources.size > 0) {
      generated.push({
        matches: [...new Set(value.matches)].sort(),
        resources: [...resources].sort(),
      });
    }
  });
  return generated;
}

function outputPathForSource(
  source: string,
  root: string,
  bundle: BundleLike,
) {
  const normalized = canonicalPath(source);
  const relative = path
    .relative(canonicalPath(root), normalized)
    .split(path.sep)
    .join("/");
  if (normalized.endsWith(".html")) return relative;
  // CSS (and other static manifest entries) may also receive a Rollup
  // facade chunk when they are supplied as an input. Prefer the emitted
  // asset so content_scripts[].css points at the stylesheet rather than the
  // synthetic JavaScript wrapper.
  const asset = Object.values(bundle).find(
    (candidate) =>
      candidate.type === "asset" &&
      ((candidate.originalFileName &&
          canonicalPath(candidate.originalFileName) === normalized) ||
        candidate.originalFileName === relative ||
        candidate.fileName === relative),
  )?.fileName;
  if (asset && /\.(?:css|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|html)$/i.test(normalized)) {
    return asset;
  }
  const item = Object.values(bundle).find(
    (candidate) =>
      candidate.type === "chunk" &&
      candidate.facadeModuleId &&
      canonicalPath(candidate.facadeModuleId) === normalized,
  );
  if (item?.fileName) return item.fileName;
  return asset || (normalized.endsWith(".html") ? relative : undefined);
}

function rewriteManifestReferences(
  manifest: Manifest,
  root: string,
  bundle: BundleLike,
): Manifest {
  const result = structuredClone(manifest);
  const rewrite = (value: unknown): unknown => {
    if (!isPathReference(value)) return value;
    const output = outputPathForSource(path.resolve(root, value), root, bundle);
    return output || value.replaceAll(path.sep, "/");
  };
  const action = result.action;
  if (isPlainObject(action)) action.default_popup = rewrite(action.default_popup);
  const background = result.background;
  if (isPlainObject(background)) background.service_worker = rewrite(background.service_worker);
  if ("options_page" in result) result.options_page = rewrite(result.options_page);
  if ("devtools_page" in result) result.devtools_page = rewrite(result.devtools_page);
  const optionsUi = result.options_ui;
  if (isPlainObject(optionsUi)) optionsUi.page = rewrite(optionsUi.page);
  const sidePanel = result.side_panel;
  if (isPlainObject(sidePanel)) sidePanel.default_path = rewrite(sidePanel.default_path);
  const contentScripts = result.content_scripts;
  if (Array.isArray(contentScripts)) {
    for (const script of contentScripts) {
      if (!isPlainObject(script)) continue;
      for (const field of ["js", "css"]) {
        const paths = script[field];
        if (Array.isArray(paths)) script[field] = paths.map(rewrite);
      }
    }
  }
  return result;
}

function rewriteGeneratedPagePaths(
  manifest: Manifest,
  pages: Record<string, string>,
  root: string,
  bundle: BundleLike,
) {
  const replacements = new Map<string, string>();
  for (const [name, source] of Object.entries(pages)) {
    const output = outputPathForSource(source, root, bundle);
    if (output) replacements.set(`${name}/index.html`, output);
  }
  if (replacements.size === 0) return manifest;
  const result = structuredClone(manifest);
  const replace = (value: unknown) =>
    typeof value === "string" ? replacements.get(value) || value : value;
  const action = result.action;
  if (isPlainObject(action)) action.default_popup = replace(action.default_popup);
  const optionsUi = result.options_ui;
  if (isPlainObject(optionsUi)) optionsUi.page = replace(optionsUi.page);
  const sidePanel = result.side_panel;
  if (isPlainObject(sidePanel)) sidePanel.default_path = replace(sidePanel.default_path);
  if ("devtools_page" in result) result.devtools_page = replace(result.devtools_page);
  return result;
}

function memberChain(node: Node | null | undefined): string[] | null {
  if (node?.type === "Identifier") return [node.name];
  if (
    (node?.type === "MemberExpression" ||
      node?.type === "OptionalMemberExpression") &&
    !node.computed &&
    node.property?.type === "Identifier"
  ) {
    const objectChain = memberChain(node.object);
    return objectChain ? [...objectChain, node.property.name] : null;
  }
  return null;
}

function collectPermissions(code: string, id: string) {
  const plugins: ParserPlugin[] = ["topLevelAwait"];
  if (/\.(?:ts|tsx)$/.test(id)) plugins.push("typescript");
  if (/\.(?:jsx|tsx)$/.test(id)) plugins.push("jsx");
  const ast = parse(code, { sourceType: "unambiguous", plugins });
  const permissions = new Set<string>();
  const namespaces = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const candidate = node as Node;
    if (
      candidate.type === "MemberExpression" ||
      candidate.type === "OptionalMemberExpression"
    ) {
      const chain = memberChain(candidate);
      if (chain?.[0] === "chrome" || chain?.[0] === "browser") {
        const namespace = chain[1];
        if (namespace) {
          namespaces.add(namespace);
          for (const permission of PERMISSION_MAP[namespace] || []) {
            permissions.add(permission);
          }
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  return {
    permissions,
    unknownNamespaces: [...namespaces].filter(
      (name) => !(name in PERMISSION_MAP),
    ),
  };
}

function pagesToManifest(pages: Record<string, string>): Manifest {
  return Object.entries(pages).reduce<Manifest>((manifest, [name]) => {
    const outputPath = `${name}/index.html`;
    const builder = PAGE_MANIFEST[name];
    return builder
      ? deepMerge(manifest, builder({ [name]: outputPath }))
      : manifest;
  }, {});
}

function validateManifest(manifest: Manifest) {
  validateCommonManifestFields(manifest);
}

function referenceMatchesBundle(
  reference: string,
  root: string,
  outputDir: string,
  bundle: BundleLike,
  includePreviousOutput = true,
  publicDir: string | false = path.resolve(root, "public"),
) {
  const normalized = reference.replaceAll(path.sep, "/").replace(/^\.\/+/, "");
  const names = bundleFileNames(bundle).map((name) =>
    name.replaceAll(path.sep, "/"),
  );
  const diskFiles = (directory: string, prefix = ""): string[] => {
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) {
          return diskFiles(path.join(directory, entry.name), relative);
        }
        return entry.isFile() ? [relative] : [];
      });
  };
  const matches = (candidate: string) => {
    if (!candidate.includes("*") && !candidate.includes("?")) {
      return names.includes(candidate);
    }
    const pattern = new RegExp(
      `^${candidate
        .split("")
        .map((character) =>
          character === "*" ? ".*" : character === "?" ? "." : character.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("")}$`,
    );
    return names.some((name) => pattern.test(name));
  };
  if (matches(normalized)) return true;

  const diskMatches = (directory: string) => {
    const disk = diskFiles(directory);
    if (!normalized.includes("*") && !normalized.includes("?")) {
      return disk.includes(normalized);
    }
    const pattern = new RegExp(
      `^${normalized
        .split("")
        .map((character) =>
          character === "*" ? ".*" : character === "?" ? "." : character.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
        )
        .join("")}$`,
    );
    return disk.some((file) => pattern.test(file));
  };
  if ((includePreviousOutput && diskMatches(outputDir)) || (publicDir && diskMatches(publicDir))) {
    return true;
  }
  const outputPath = path.resolve(outputDir, normalized);
  if (includePreviousOutput && fs.existsSync(outputPath)) return true;
  const sourcePath = path.resolve(root, normalized);
  if (fs.existsSync(sourcePath)) return true;
  return Boolean(publicDir && fs.existsSync(path.resolve(publicDir, normalized)));
}

/**
 * Validate that local manifest references resolve to a generated bundle or a
 * file copied from the project/public directory. During unit-level hook tests
 * the bundle is often empty, so diagnostics are warnings; a real build with
 * emitted files escalates missing references to errors.
 */
function diagnoseManifestReferences(
  manifest: Manifest,
  root: string,
  outputDir: string,
  bundle: BundleLike,
  includePreviousOutput = true,
  publicDir: string | false = path.resolve(root, "public"),
): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];
  const hasOutput = bundleFileNames(bundle).length > 0;
  for (const { field, value } of manifestReferenceEntries(manifest)) {
    if (value === DYNAMIC_RESOURCE || value.includes("<dynamic_resource>")) continue;
    if (referenceMatchesBundle(value, root, outputDir, bundle, includePreviousOutput, publicDir)) continue;
    const level: ManifestDiagnostic["level"] = hasOutput ? "error" : "warning";
    const sourceLike = /\.(?:c|m)?tsx?|jsx?|vue|svelte$/i.test(value);
    const suggestion = sourceLike
      ? "Build this entry or place a compatible JavaScript file under public/."
      : "Check the path, Vite output, or public/ directory.";
    diagnostics.push({
      level,
      field,
      message: `${field} references "${value}", but no matching output file was found. ${suggestion}`,
    });
  }
  for (const field of ["permissions", "optional_permissions", "host_permissions"]) {
    const values = manifest[field];
    if (!Array.isArray(values)) continue;
    const seen = new Set<string>();
    const duplicates = values.filter((value) => {
      if (typeof value !== "string" || seen.has(value)) return true;
      seen.add(value);
      return false;
    });
    if (duplicates.length > 0) {
      diagnostics.push({
        level: "warning",
        field: `manifest.${field}`,
        message: `manifest.${field} contains duplicate values (${[
          ...new Set(duplicates),
        ].join(", ")}); duplicates will be removed.`,
      });
    }
  }
  return diagnostics;
}

/**
 * Generate a Chrome Manifest V3 extension from a Vite build.
 *
 * @param {{
 *   manifest?: Record<string, unknown>,
 *   pages?: Record<string, string> | false,
 *   pageRoot?: string,
 *   background?: string,
 *   popup?: string,
 *   contentScripts?: Array<Record<string, unknown>>,
 *   outDir?: string
 * }} options
 */
export default function chromeExtension(options: ChromeExtensionOptions = {}): Plugin {
  let resolvedConfig: ResolvedConfig;
  let originalConfig: UserConfig = {};
  let pageEntries: Record<string, string> = {};
  let manifestInput: Manifest =
    options.manifest &&
    typeof options.manifest === "object" &&
    !(options.manifest instanceof Promise)
      ? options.manifest
      : {};
  let inputManifest: Manifest = manifestInput;
  const modulePermissions = new Map<string, ReturnType<typeof collectPermissions>>();
  let contentInputNames = new Set<string>();
  let backgroundInputNames = new Set<string>();

  async function resolveManifest(env: ConfigEnv): Promise<Manifest> {
    const input = options.manifest;
    if (!input) return {};
    const value = typeof input === "function" ? await input(env) : await input;
    return value || {};
  }

  return {
    name: "vite-plugin-chrome-extension",
    async configureServer(server) {
      if (options.liveReload === false) return;
      if (!server.httpServer) {
        throw new Error("[chrome-extension] Auto reload requires Vite's HTTP server. Set liveReload: false in middleware mode.");
      }
      if (
        server.config.server.hmr === false ||
        (server.config.server as { ws?: boolean }).ws === false
      ) {
        throw new Error("[chrome-extension] Auto reload requires Vite WebSocket/HMR. Enable server.hmr or set liveReload: false.");
      }
      const cleanup = await configureExtensionDevServer(
        server,
        originalConfig,
        options,
        manifestInput,
        chromeExtension,
      );
      const close = server.close.bind(server);
      server.close = async () => {
        await cleanup();
        await close();
      };
    },
    transform(code, id) {
      if (
        resolvedConfig?.command === "serve" ||
        id.includes("/node_modules/") ||
        !/\.(?:m?[jt]sx?|vue|svelte)$/.test(id)
      ) {
        return null;
      }
      try {
        const result = collectPermissions(code, id);
        modulePermissions.set(id, result);
      } catch (error) {
        modulePermissions.delete(id);
        this.warn(
          `[chrome-extension] AST permission analysis skipped ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    },
    async config(userConfig, env) {
      originalConfig = copyDevConfig(userConfig);
      const root = userConfig.root || process.cwd();
      const postcss = userConfig.css?.postcss;
      const css = options.tailwind === false ? undefined : {
        postcss: {
          ...(typeof postcss === "object" ? postcss : {}),
          plugins: [
            ...(typeof postcss === "object" ? postcss.plugins || [] : []),
            tailwindcss({ base: path.resolve(root) }),
          ],
        },
      };
      pageEntries = normalizePages(root, options.pages, options.pageRoot);
      manifestInput = await resolveManifest(env);
      inputManifest = backgroundInputManifest(manifestInput, options.background);
      const manifestInputs = manifestInputEntries(root, inputManifest);
      contentInputNames = contentScriptInputNames(root, inputManifest);
      const backgroundEntry =
        typeof options.background === "object" &&
        !("background" in manifestInput)
          ? path.resolve(root, options.background.entry)
          : undefined;
      backgroundInputNames = new Set(
        backgroundEntry
          ? Object.entries(manifestInputs)
              .filter(([, entry]) => path.resolve(entry) === backgroundEntry)
              .map(([name]) => name)
          : [],
      );
      const userInput = userConfig.build?.rollupOptions?.input;
      const userOutput = userConfig.build?.rollupOptions?.output;
      if (
        Object.keys(pageEntries).length === 0 &&
        Object.keys(manifestInputs).length === 0
      ) {
        return css ? { css } : undefined;
      }

      const pageInput = {
        ...pageInputEntries(pageEntries),
        ...manifestInputs,
      };
      const input =
        userInput && typeof userInput === "object" && !Array.isArray(userInput)
          ? { ...pageInput, ...userInput }
          : userInput || pageInput;

      return {
        css,
        build: {
          rollupOptions: {
            input,
            output: {
              ...(userConfig.build?.rollupOptions?.output &&
              !Array.isArray(userConfig.build.rollupOptions.output)
                ? userConfig.build.rollupOptions.output
                : {}),
              assetFileNames:
                options.assetFileNames || "assets/css/[name][extname]",
              ...((contentInputNames.size > 0 || backgroundInputNames.size > 0) &&
              (!userOutput ||
                Array.isArray(userOutput) ||
                typeof userOutput !== "object" ||
                !("entryFileNames" in userOutput))
                ? {
                    entryFileNames: (chunk: { name: string }) =>
                      backgroundInputNames.has(chunk.name)
                        ? (typeof options.background === "object"
                          ? options.background.fileName || "background.js"
                          : "background.js")
                        : contentInputNames.has(chunk.name)
                        ? `content/${chunk.name
                            .replace(/^manifest-\d+-/, "")
                            .replace(/\W+/g, "-")}.js`
                        : "assets/[name]-[hash].js",
                  }
                : {}),
            },
          },
        },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
      inputManifest = backgroundInputManifest(manifestInput, options.background);
      contentInputNames = contentScriptInputNames(config.root, inputManifest);
      const backgroundEntry =
        typeof options.background === "object" &&
        !("background" in manifestInput)
          ? path.resolve(config.root, options.background.entry)
          : undefined;
      const manifestInputs = manifestInputEntries(config.root, inputManifest);
      backgroundInputNames = new Set(
        backgroundEntry
          ? Object.entries(manifestInputs)
              .filter(([, entry]) => path.resolve(entry) === backgroundEntry)
              .map(([name]) => name)
          : [],
      );
      if (
        Object.keys(pageEntries).length > 0 ||
        Object.keys(manifestInputs).length > 0
      ) {
        const pageInput = {
          ...pageInputEntries(pageEntries),
          ...manifestInputs,
        };
        const currentInput = config.build.rollupOptions.input;
        config.build.rollupOptions.input =
          currentInput &&
          typeof currentInput === "object" &&
          !Array.isArray(currentInput)
            ? { ...pageInput, ...currentInput }
            : currentInput || pageInput;
      }
    },
    async generateBundle(_outputOptions, bundle) {
      // Rollup may reuse unchanged transformed modules between watch builds.
      // Keep per-module results, but only merge modules still in the active graph.
      const activeModules = typeof this.getModuleIds === "function"
        ? new Set(this.getModuleIds())
        : new Set(modulePermissions.keys());
      const usedPermissions = new Set<string>();
      const unknownNamespaces = new Set<string>();
      for (const [id, result] of modulePermissions) {
        if (!activeModules.has(id)) continue;
        result.permissions.forEach((permission) => usedPermissions.add(permission));
        result.unknownNamespaces.forEach((namespace) => unknownNamespaces.add(namespace));
      }
      const autoManifest = deepMerge(
        DEFAULT_MANIFEST,
        pagesToManifest(pageEntries),
      );
      const shortcutManifest: Manifest = {};

      if (options.popup) {
        shortcutManifest.action = { default_popup: options.popup };
      }
      if (options.background) {
        const background =
          typeof options.background === "string"
            ? {
                service_worker: options.background,
                type: "module" as const,
              }
            : {
                service_worker: options.background.entry,
                type: options.background.type || "module",
              };
        shortcutManifest.background = {
          ...background,
        };
      }
      if (Array.isArray(options.contentScripts)) {
        shortcutManifest.content_scripts = options.contentScripts;
      }

      // Explicit manifest config is the final authority over convention and shortcuts.
      const generatedManifest = deepMerge(
        deepMerge(autoManifest, shortcutManifest),
        manifestInput,
      ) as Manifest;
      const contentBuildEnabled =
        !isPlainObject(options.contentScripts) ||
        options.contentScripts.standalone !== false;
      if (contentBuildEnabled) {
        const sourceEntries = manifestContentScriptEntries(
          resolvedConfig.root,
          generatedManifest,
        );
        for (const entry of sourceEntries) {
          if (entry.field !== "js") continue;
          const output = contentScriptOutput(
            entry.source,
            resolvedConfig.root,
            bundle,
          );
          if (!output) continue;
          const standalone = makeStandaloneContentChunk(output, bundle);
          const chunk = bundleItemByFileName(bundle, output);
          if (standalone && chunk && chunk.type === "chunk") {
            chunk.code = standalone;
            chunk.imports = [];
            chunk.dynamicImports = chunk.dynamicImports || [];
          }
        }
      }
      const rewrittenManifest = rewriteManifestReferences(
        rewriteGeneratedPagePaths(
          generatedManifest,
          pageEntries,
          resolvedConfig.root,
          bundle,
        ),
        resolvedConfig.root,
        bundle,
      );
      const generatedWar = generatedWebAccessibleResources(
        rewrittenManifest,
        resolvedConfig.root,
        bundle,
      );
      if (generatedWar.length > 0 || "web_accessible_resources" in rewrittenManifest) {
        rewrittenManifest.web_accessible_resources =
          mergeWebAccessibleResources(
            rewrittenManifest.web_accessible_resources,
            generatedWar,
          );
      }
      if (options.autoPermissions !== false && usedPermissions.size > 0) {
        rewrittenManifest.permissions = [
          ...new Set([
            ...(rewrittenManifest.permissions || []),
            ...usedPermissions,
          ]),
        ];
      } else if (Array.isArray(rewrittenManifest.permissions)) {
        rewrittenManifest.permissions = [...new Set(rewrittenManifest.permissions)];
      }
      if (unknownNamespaces.size > 0) {
        this.warn(
          `[chrome-extension] No permission mapping found for API namespaces: ${[
            ...unknownNamespaces,
          ].join(", ")}. Add required permissions manually.`,
        );
      }
      if (
        rewrittenManifest.icons &&
        Object.keys(rewrittenManifest.icons).length === 0
      ) {
        delete rewrittenManifest.icons;
      }
      validateManifest(rewrittenManifest);
      const outputDir = path.resolve(
        resolvedConfig.root,
        resolvedConfig.build.outDir,
      );
      const diagnostics = diagnoseManifestReferences(
        rewrittenManifest,
        resolvedConfig.root,
        outputDir,
        bundle,
        !Reflect.get(resolvedConfig, DEV_BUILD),
        resolvedConfig.publicDir,
      );
      for (const diagnostic of diagnostics) {
        if (diagnostic.level === "error") {
          throw new Error(`[chrome-extension] ${diagnostic.message}`);
        }
        this.warn(`[chrome-extension] ${diagnostic.message}`);
      }

      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
      });
      this.warn(
        `[chrome-extension] Manifest generated for ${path.resolve(options.outDir || resolvedConfig.build.outDir)}`,
      );
    },
  };
}

export {
  DEFAULT_MANIFEST,
  collectPermissions,
  deepMerge,
  discoverPages,
  diagnoseManifestReferences,
  generatedWebAccessibleResources,
  manifestContentScriptEntries,
  manifestEntryReferences,
  manifestReferenceEntries,
  mergeWebAccessibleResources,
  makeStandaloneContentChunk,
  pagesToManifest,
  rewriteManifestReferences,
  validateManifest,
};
