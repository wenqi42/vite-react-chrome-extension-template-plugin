import test from "node:test";
import assert from "node:assert/strict";
import chromeExtension, {
  collectPermissions,
  deepMerge,
  pagesToManifest,
} from "../index.js";

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
  let output;
  plugin.configResolved({
    root: "/workspace",
    build: { outDir: "dist", rollupOptions: {} },
  });
  plugin.transform.call(
    { warn: () => {} },
    "chrome.tabs.query({ active: true });",
    "/workspace/src/main.ts",
  );
  plugin.generateBundle.call({
    emitFile: (asset) => {
      output = JSON.parse(asset.source);
    },
    warn: () => {},
  });
  assert.equal(output.action.default_popup, "user-popup.html");
  assert.equal(output.background.service_worker, "user-worker.js");
  assert.deepEqual(output.content_scripts, [
    { matches: ["https://user.example/*"], js: ["user.js"] },
  ]);
  assert.deepEqual(output.permissions, ["storage"]);
});

test("API usage adds mapped permissions when manifest.permissions is omitted", () => {
  const plugin = chromeExtension({
    manifest: { name: "Auto Permission Extension", version: "1.0.0" },
  });
  let output;
  plugin.configResolved({
    root: "/workspace",
    build: { outDir: "dist", rollupOptions: {} },
  });
  plugin.transform.call(
    { warn: () => {} },
    "chrome.tabs.query({ active: true });",
    "/workspace/src/main.ts",
  );
  plugin.generateBundle.call({
    emitFile: (asset) => {
      output = JSON.parse(asset.source);
    },
    warn: () => {},
  });
  assert.deepEqual(output.permissions, ["tabs"]);
});

test("collectPermissions uses AST member expressions instead of string matching", () => {
  const result = collectPermissions(
    `
      const text = "chrome.tabs should not count";
      chrome.tabs.query({ active: true });
      browser.storage.local.set({ ready: true });
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
  let output;
  plugin.configResolved({
    root: "/workspace",
    build: { outDir: "dist", rollupOptions: {} },
  });
  plugin.transform.call(
    { warn: () => {} },
    "chrome.tabs.query({ active: true });",
    "/workspace/src/main.ts",
  );
  plugin.generateBundle.call({
    emitFile: (asset) => {
      output = JSON.parse(asset.source);
    },
    warn: () => {},
  });
  assert.equal("permissions" in output, false);
});
