import test from "node:test";
import { resolveConfig } from "vite";
import assert from "node:assert/strict";
import type { Plugin, ResolvedConfig } from "vite";
import type { PluginContext, TransformPluginContext, EmittedFile } from "rollup";
import chromeExtension, {
  collectPermissions,
  defineDynamicResource,
  defineManifest,
  deepMerge,
  manifestEntryReferences,
  pagesToManifest,
  rewriteManifestReferences,
} from "../index.js";

test("Tailwind keeps inline PostCSS plugins and can be disabled", async () => {
  const existing = { postcssPlugin: "existing-plugin" };
  const config = await resolveConfig({
    configFile: false,
    plugins: [chromeExtension({ pages: false })],
    css: { postcss: { plugins: [existing] } },
  }, "serve");
  const postcss = config.css.postcss;
  assert.ok(postcss && typeof postcss === "object");
  assert.ok(postcss.plugins?.includes(existing));
  assert.ok(postcss.plugins?.some(plugin =>
    "postcssPlugin" in plugin && plugin.postcssPlugin === "@tailwindcss/postcss"));
  const manual = await resolveConfig({
    configFile: false,
    plugins: [chromeExtension({ pages: false, tailwind: false })],
    css: { postcss: { plugins: [existing] } },
  }, "serve");
  assert.deepEqual(manual.css.postcss, { plugins: [existing] });
});

function hook<T extends Function>(value: T | { handler: T } | undefined): T {
  assert.ok(value);
  return typeof value === "function" ? value : value.handler;
}

function setup(plugin: Plugin) {
  hook(plugin.configResolved)({
    root: "/workspace",
    build: { outDir: "dist", rollupOptions: {} },
  } as ResolvedConfig);
}

function transform(plugin: Plugin, code: string, id: string) {
  hook(plugin.transform).call({ warn: () => {} } as unknown as TransformPluginContext, code, id);
}

function manifest(plugin: Plugin): Record<string, any> {
  let output: Record<string, any> = {};
  hook(plugin.generateBundle).call({
    emitFile: (asset: EmittedFile) => {
      assert.equal(asset.type, "asset");
      if (asset.type === "asset") output = JSON.parse(String(asset.source));
      return "manifest";
    },
    warn: () => {},
  } as unknown as PluginContext, {} as never, {}, false);
  return output;
}

test("deepMerge recursively merges objects and replaces arrays", () => {
  assert.deepEqual(
    deepMerge(
      {
        action: { default_popup: "popup/index.html", extra: true },
        permissions: ["storage"],
      },
      { action: { default_popup: "custom.html" }, permissions: ["tabs"] },
    ),
    {
      action: { default_popup: "custom.html", extra: true },
      permissions: ["tabs"],
    },
  );
});

test("conventional page names map to Manifest V3 fields", () => {
  assert.deepEqual(
    pagesToManifest({
      popup: "/workspace/modules/popup/index.html",
      options: "/workspace/modules/options/index.html",
      sidepanel: "/workspace/modules/sidepanel/index.html",
      devtools: "/workspace/modules/devtools/index.html",
    }),
    {
      action: { default_popup: "popup/index.html" },
      options_ui: { page: "options/index.html", open_in_tab: true },
      side_panel: { default_path: "sidepanel/index.html" },
      devtools_page: "devtools/index.html",
    },
  );
});

test("explicit manifest config wins over convention and shorthand config", () => {
  const plugin = chromeExtension({
    pages: { popup: "modules/popup/index.html" },
    popup: "shortcut.html",
    background: "shortcut-worker.js",
    contentScripts: [
      { matches: ["https://example.com/*"], js: ["default.js"] },
    ],
    manifest: {
      action: { default_popup: "user-popup.html" },
      background: { service_worker: "user-worker.js", type: "module" },
      content_scripts: [
        { matches: ["https://user.example/*"], js: ["user.js"] },
      ],
      permissions: ["storage"],
    },
  });
  setup(plugin);
  transform(plugin,
    "chrome.tabs.query({ active: true });",
    "/workspace/src/main.ts",
  );
  const output = manifest(plugin);
  assert.equal(output.action.default_popup, "user-popup.html");
  assert.equal(output.background.service_worker, "user-worker.js");
  assert.deepEqual(output.content_scripts, [
    { matches: ["https://user.example/*"], js: ["user.js"] },
  ]);
  assert.deepEqual(output.permissions, ["storage", "tabs"]);
});

test("API usage adds mapped permissions when manifest.permissions is omitted", () => {
  const plugin = chromeExtension({
    manifest: { name: "Auto Permission Extension", version: "1.0.0" },
  });
  setup(plugin);
  transform(plugin,
    "chrome.tabs.query({ active: true });",
    "/workspace/src/main.ts",
  );
  const output = manifest(plugin);
  assert.deepEqual(output.permissions, ["tabs"]);
});

test("collectPermissions uses AST member expressions instead of string matching", () => {
  const result = collectPermissions(
    `
      const text = "chrome.tabs should not count";
      chrome.tabs.query({ active: true });
      browser.tabs.query({ active: true });
      chrome["history"].search({ text: "x" });
    `,
    "/workspace/src/popup/main.tsx",
  );
  assert.deepEqual([...result.permissions], ["tabs"]);
  assert.deepEqual(result.unknownNamespaces, []);
});

test("autoPermissions can be disabled", () => {
  const plugin = chromeExtension({
    autoPermissions: false,
    manifest: { name: "Manual Permission Extension", version: "1.0.0" },
  });
  setup(plugin);
  transform(plugin,
    "chrome.tabs.query({ active: true });",
    "/workspace/src/main.ts",
  );
  const output = manifest(plugin);
  assert.equal("permissions" in output, false);
});

test("manifest helpers support CRXJS-style factories and dynamic resources", async () => {
  const manifest = defineManifest(({ mode }) => ({
    name: `Factory ${mode}`,
    version: "1.0.0",
  }));
  assert.equal(typeof manifest, "function");
  assert.deepEqual(await manifest({ command: "build", mode: "production" }), {
    name: "Factory production",
    version: "1.0.0",
  });
  assert.deepEqual(defineDynamicResource({ use_dynamic_url: true }), {
    matches: ["http://*/*", "https://*/*"],
    use_dynamic_url: true,
    resources: ["<dynamic_resource>"],
  });
});

test("manifest source entries are discoverable and rewritten to output chunks", () => {
  const manifest = {
    name: "Entries",
    version: "1.0.0",
    background: { service_worker: "src/background.ts" },
    content_scripts: [{ matches: ["https://example.com/*"], js: ["src/content.ts"] }],
  };
  assert.deepEqual(manifestEntryReferences(manifest), [
    "src/background.ts",
    "src/content.ts",
  ]);
  assert.deepEqual(
    rewriteManifestReferences(
      manifest,
      "/workspace",
      {
        "background.js": {
          type: "chunk",
          fileName: "background.js",
          facadeModuleId: "/workspace/src/background.ts",
        },
        "content.js": {
          type: "chunk",
          fileName: "content.js",
          facadeModuleId: "/workspace/src/content.ts",
        },
      },
    ),
    {
      name: "Entries",
      version: "1.0.0",
      background: { service_worker: "background.js" },
      content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }],
    },
  );
});
