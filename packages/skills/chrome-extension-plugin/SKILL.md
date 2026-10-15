---
name: chrome-extension-plugin
description: "Integrate the Vite Chrome extension plugin into an existing project, configure Manifest V3 entries and permissions, and validate build or development reload behavior."
---

# Chrome extension plugin

Use this skill when adding `@vite-react-chrome-extension/plugin` to an existing Vite project or diagnosing its generated extension output.

## Inspect the project

Read the Vite config, package.json, tsconfig and existing Manifest before editing. Identify the project root, `build.outDir`, page inputs, background source, content scripts, permissions, `publicDir` and any existing PostCSS configuration.

Keep the existing Vite plugins and inputs. Use `@types/chrome` for TypeScript types and add `chrome` to `compilerOptions.types` without removing existing entries.

## Basic configuration

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import chromeExtension, { defineBackground } from '@vite-react-chrome-extension/plugin'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    chromeExtension({
      manifest: { name: 'My Extension', version: '1.0.0' },
      background: defineBackground('src/background.ts'),
    }),
  ],
})
```

`defineBackground(entry, { fileName })` compiles a source entry with a stable service-worker path. The string form `background: 'background.js'` remains available for an existing output or `public/background.js` fallback.

The plugin discovers `modules/<page>/index.html` and maps `popup`, `options`, `sidepanel` and `devtools` to their conventional Manifest fields. Use `pages` for explicit entries, `pageRoot` for a different convention directory, or `pages: false` to disable discovery.

## Manifest and content scripts

`defineManifest` accepts an object, Promise or `(env) => manifest` factory. Explicit `manifest` values are the final configuration layer. Existing source paths in background, content scripts and page fields are added to Vite inputs and rewritten to generated output paths.

An action does not require a popup: `action: { default_title: 'Open sidebar' }` is valid. For a toolbar action that opens a side panel, omit `default_popup`, configure `side_panel.default_path`, and call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in the worker. If the project has a discovered popup entry, remove that entry or disable its discovery. Do not rely on calling `sidePanel.open()` from popup startup without a user gesture.

Content-script source entries are emitted as standalone IIFEs by default. `contentScripts: { standalone: false }` leaves output ownership to the project. Imported CSS, static assets and dynamic chunks are collected into `web_accessible_resources`; use `defineDynamicResource()` for the `<dynamic_resource>` placeholder.

## Permissions

Permission inference parses `chrome.*` and `browser.*` member expressions with Babel AST and reads the checked-in permission map. It does not infer host patterns, `activeTab` or context-dependent permissions. Explicit permissions are deduplicated and merged. Set `autoPermissions: false` for complete manual control. Native messaging methods still require explicit `nativeMessaging`.

## Development reload

`liveReload` defaults to `true` for `vite dev`:

- page-only edits refresh extension pages;
- worker, content-script, Manifest or shared dependency edits reload the extension;
- failed builds preserve the last successful output and send no reload event;
- the development worker sends a 20-second WebSocket heartbeat for Chrome 116+;
- the watcher builds to staging and publishes only after the complete build succeeds.

This is full reload rather than state-preserving HMR. An already-injected content script runs its new version after the matching host page is refreshed. Set `liveReload: false` for ordinary web preview, middleware mode or disabled Vite WebSocket.

Enable Developer mode in `chrome://extensions`, load `build.outDir` and run the CDP smoke when runtime evidence is needed:

```bash
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
```

A successful HTTP preview is not extension runtime validation. Report popup, worker, content-script, permission, CSP and browser-version evidence separately.

For the network rewrite example, saving a rule does not start interception. Attach an HTTP/HTTPS tab, trigger a new matching request, and assert the response received by the page. Inspect side panel match/success/failure indicators; use `npm run test:network-rewrite -- --chrome /path/to/chrome-for-testing` for its browser acceptance.

## Validation

```bash
npm run typecheck
npm run build
npm run verify:extension -- --dist dist
npm run test:coverage
```

Inspect `manifest.json`, page HTML, background output, content-script files, CSS/assets and WAR entries. Production `vite build` must not contain the development client, development host permission or development CSP additions.
