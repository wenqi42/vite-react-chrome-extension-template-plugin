import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

const PERMISSION_MAP = JSON.parse(
  fs.readFileSync(
    new URL("./chrome-permission-map.json", import.meta.url),
    "utf8",
  ),
).apis;

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
      .map((file) => [
        pageNameFromEntry(path.relative(root, file), pageRoot),
        file,
      ]),
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

function memberChain(node) {
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

function collectPermissions(code, id) {
  const plugins = ["topLevelAwait"];
  if (/\.(?:ts|tsx)$/.test(id)) plugins.push("typescript");
  if (/\.(?:jsx|tsx)$/.test(id)) plugins.push("jsx");
  const ast = parse(code, { sourceType: "unambiguous", plugins });
  const permissions = new Set();
  const namespaces = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression"
    ) {
      const chain = memberChain(node);
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
  const usedPermissions = new Set();
  const unknownNamespaces = new Set();

  return {
    name: "vite-plugin-chrome-extension",
    apply: "build",
    transform(code, id) {
      if (options.autoPermissions === false) return null;
      if (
        id.includes("/node_modules/") ||
        !/\.(?:m?[jt]sx?|vue|svelte)$/.test(id)
      ) {
        return null;
      }
      try {
        const result = collectPermissions(code, id);
        result.permissions.forEach((permission) =>
          usedPermissions.add(permission),
        );
        result.unknownNamespaces.forEach((namespace) =>
          unknownNamespaces.add(namespace),
        );
      } catch (error) {
        this.warn(
          `[chrome-extension] AST permission analysis skipped ${id}: ${error.message}`,
        );
      }
      return null;
    },
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
      const shouldInferPermissions = !Object.prototype.hasOwnProperty.call(
        options.manifest || {},
        "permissions",
      );
      if (shouldInferPermissions && usedPermissions.size > 0) {
        generatedManifest.permissions = [
          ...new Set([
            ...(generatedManifest.permissions || []),
            ...usedPermissions,
          ]),
        ];
      }
      if (unknownNamespaces.size > 0) {
        this.warn(
          `[chrome-extension] No permission mapping found for API namespaces: ${[
            ...unknownNamespaces,
          ].join(", ")}. Add required permissions manually.`,
        );
      }
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

export {
  DEFAULT_MANIFEST,
  collectPermissions,
  deepMerge,
  discoverPages,
  pagesToManifest,
};
