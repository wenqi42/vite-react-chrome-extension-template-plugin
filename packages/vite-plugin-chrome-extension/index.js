import fs from "node:fs";
import path from "node:path";

const DEFAULT_MANIFEST = {
  manifest_version: 3,
  name: "Vite React Chrome Extension",
  version: "0.1.0",
  description: "A Chrome extension built with Vite and React.",
};

const PAGE_MANIFEST = {
  popup: (pages) => ({ action: { default_popup: pages.popup } }),
  options: (pages) => ({
    options_ui: { page: pages.options, open_in_tab: true },
  }),
  sidepanel: (pages) => ({ side_panel: { default_path: pages.sidepanel } }),
  devtools: (pages) => ({ devtools_page: pages.devtools }),
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge objects like lodash.merge while treating arrays as user-owned values.
 * This prevents default permissions/content scripts from leaking into user config.
 */
function deepMerge(base, override) {
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

function pageNameFromEntry(entry, pageRoot = "modules") {
  const relative = entry.split(path.sep).join("/");
  const prefix = `${pageRoot.split(path.sep).join("/")}/`;
  return relative
    .replace(new RegExp(`^${prefix}`), "")
    .replace(/\/index\.html$/, "");
}

function discoverPages(root, pageRoot = "modules") {
  const directory = path.resolve(root, pageRoot);
  if (!fs.existsSync(directory)) return {};

  return Object.fromEntries(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name, "index.html"))
      .filter((file) => fs.existsSync(file))
      .map((file) => [pageNameFromEntry(path.relative(root, file), pageRoot), file]),
  );
}

function normalizePages(root, pages, pageRoot) {
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

function pageInputEntries(pages) {
  return Object.fromEntries(
    Object.entries(pages).map(([name, entry]) => [`${name}/index`, entry]),
  );
}

function pagesToManifest(pages) {
  return Object.entries(pages).reduce((manifest, [name, entry]) => {
    const outputPath = `${name}/index.html`;
    const builder = PAGE_MANIFEST[name];
    return builder
      ? deepMerge(manifest, builder({ [name]: outputPath }))
      : manifest;
  }, {});
}

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error("[chrome-extension] Only Manifest V3 is supported.");
  }
  for (const field of ["name", "version"]) {
    if (!manifest[field] || typeof manifest[field] !== "string") {
      throw new Error(
        `[chrome-extension] manifest.${field} must be a non-empty string.`,
      );
    }
  }
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
export default function chromeExtension(options = {}) {
  let resolvedConfig;
  let pageEntries = {};

  return {
    name: "vite-plugin-chrome-extension",
    apply: "build",
    config(userConfig) {
      const root = userConfig.root || process.cwd();
      pageEntries = normalizePages(root, options.pages, options.pageRoot);
      const userInput = userConfig.build?.rollupOptions?.input;
      if (Object.keys(pageEntries).length === 0) return undefined;

      const pageInput = pageInputEntries(pageEntries);
      const input =
        userInput && typeof userInput === "object" && !Array.isArray(userInput)
          ? { ...pageInput, ...userInput }
          : userInput || pageInput;

      return {
        build: {
          rollupOptions: {
            input,
          },
        },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
      if (Object.keys(pageEntries).length > 0) {
        const pageInput = pageInputEntries(pageEntries);
        const currentInput = config.build.rollupOptions.input;
        config.build.rollupOptions.input =
          currentInput &&
          typeof currentInput === "object" &&
          !Array.isArray(currentInput)
            ? { ...pageInput, ...currentInput }
            : currentInput || pageInput;
      }
    },
    generateBundle() {
      const autoManifest = deepMerge(
        DEFAULT_MANIFEST,
        pagesToManifest(pageEntries),
      );
      const shortcutManifest = {};

      if (options.popup) {
        shortcutManifest.action = { default_popup: options.popup };
      }
      if (options.background) {
        shortcutManifest.background = {
          service_worker: options.background,
          type: "module",
        };
      }
      if (options.contentScripts) {
        shortcutManifest.content_scripts = options.contentScripts;
      }

      // Explicit manifest config is the final authority over convention and shortcuts.
      const generatedManifest = deepMerge(
        deepMerge(autoManifest, shortcutManifest),
        options.manifest || {},
      );
      if (
        generatedManifest.icons &&
        Object.keys(generatedManifest.icons).length === 0
      ) {
        delete generatedManifest.icons;
      }
      validateManifest(generatedManifest);

      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(generatedManifest, null, 2)}\n`,
      });
      this.warn(
        `[chrome-extension] Manifest generated for ${path.resolve(options.outDir || resolvedConfig.build.outDir)}`,
      );
    },
  };
}

export { DEFAULT_MANIFEST, deepMerge, discoverPages, pagesToManifest };
