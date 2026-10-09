---
name: chrome-extension-plugin
description: "Integrate @vite-react-chrome-extension/plugin into Vite React apps and configure MV3 manifests, popup, background and content scripts. Use for plugin setup, generated extension path debugging, TypeScript background configuration or build validation; not for unrelated Vite plugins."
---

# Integrate the Chrome extension plugin

## Inspect first

Read current plugin `index.js` / `index.d.ts`, project Vite config, manifest and package.json.
Determine the Vite root, existing entries, output directory, permissions and target pages.
Preserve existing configuration. Confirm missing consequential requirements.
Use the sibling create skill for a new project.

## Install and configure

For unpublished code use README's npm link procedure. Never assume npm install can find an unpublished package.
For published code install plugin as a dev dependency.
Add `@types/chrome` as a dev dependency and merge `"chrome"` into tsconfig types without discarding existing entries.

Add `chromeExtension({ manifest: { name: 'My Extension', version: '0.1.0' }, background: 'background.js' })` to plugins alongside `react()`.

For TS background, merge this shape into Vite config (relative inputs assume project-root working directory):

```ts
base: './',
build: {
  rollupOptions: {
    input: { popup: 'index.html', background: 'src/background.ts' },
    output: {
      entryFileNames: chunk =>
        chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
    },
  },
},
```

Do not overwrite existing multi-page entries. Plain JS can instead use `public/background.js`; never create both outputs with the same name.

## API truth and pitfalls

- `manifest`: overrides default MV3 metadata. Plugin validation is limited to MV3 and nonempty name/version.
- `popup`: output-relative HTML path, defaults to index.html. An alternate page must actually be built.
- `background`: output-relative JS path, forces module worker type. Does not compile TS by itself.
- `contentScripts`: replaces the manifest array. Does not create, compile or hash-rewrite scripts.
- Plain content scripts cannot contain top-level ESM imports; use static compatible JS or an independently configured compatible bundle.
- `outDir` currently only affects logging. Set Vite `build.outDir` for real output.
- No built-in extension HMR, Chrome API mock, automatic options page creation or full manifest schema validation.
- Use least permissions. Keep secrets and remotely executed code out of the extension.

## Acceptance

Run project typecheck/build and any configured lint/format checks.
Inspect manifest.json, popup HTML/assets, worker and every configured content-script path in output.
Load unpacked dist in Chrome, open popup and inspect worker registration/errors when runtime verification is available.
If only a static build or HTTP preview was checked, explicitly state that Chrome runtime is unverified.
