---
name: chrome-extension-create
description: "Create and validate a React TypeScript Chrome extension with the project generator, including optional ESLint, Prettier and CSS/Less/Sass tooling."
---

# Create a Chrome extension

Use the CLI package for new projects. Confirm the destination, style format and optional tools when the request does not specify them.

## Published package

```bash
npx create-vite-react-chrome-extension create my-extension --eslint --prettier --css
cd my-extension
npm install
npm run typecheck
npm run build
```

The `create` command accepts a directory and these independent flags:

```text
--eslint | --no-eslint
--prettier | --no-prettier
--css | --less | --sass
```

Without flags, the CLI asks for the optional tools and stylesheet format. It rejects non-empty targets, invalid names, unknown options and conflicting choices.

## Local unpublished package

From the repository root:

```bash
npm install
npm run build
npm link --workspace create-vite-react-chrome-extension --workspace @vite-react-chrome-extension/plugin
```

In a separate empty directory:

```bash
create-vite-react-chrome-extension create my-extension --eslint --no-prettier
cd my-extension
npm link @vite-react-chrome-extension/plugin --save
npm install
```

Use a local file dependency instead of publishing when global linking is unsuitable. Do not commit machine-specific paths.

## Generated project

The template includes popup, options and background entries, Tailwind CSS 4, `@types/chrome`, TypeScript checks and Vite scripts. ESLint, Prettier and the selected stylesheet preprocessor are added only when requested.

Run the tools that exist in the generated project:

```bash
npm run typecheck
npm run build
npm run lint              # when ESLint was selected
npm run format:check      # when Prettier was selected
npm run verify:extension -- --dist dist
```

## Development reload

Run `npm run dev`, wait for the first successful extension build, enable Developer mode in `chrome://extensions` and load `dist`. Page-only edits refresh extension pages. Worker, content-script or Manifest edits reload the extension and close existing extension pages; reopen them to inspect the new output. Refresh matching host pages after content-script edits. `liveReload: false` keeps ordinary Vite preview only.

That is the template's default behavior. If the user needs in-place content updates, enable `contentScripts: { hmr: true }` and use the plugin client lifecycle to dispose old side effects and explicitly preserve data. Consult the plugin skill's content HMR guidance; do not promise automatic state preservation for an arbitrary existing script or framework.

For browser evidence use Chrome for Testing and the repository smoke script:

```bash
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
```

Do not describe HTTP rendering as Chrome runtime validation. Report the generated project path, selected tools, exact checks, browser version and any content-script or MAIN-world limitation.

## Packaged template matrix

For repository template changes, use `npm run test:acceptance -- --list --json` to inspect the CSS/Less/Sass × ESLint × Prettier × Vite 5/6/7 matrix. Run without `--case` for all 36 combinations; `--case <id>` gives focused evidence only.

The runner packs CLI/plugin artifacts, installs generated projects outside the repository, runs only selected tools, verifies local references, and loads extensions in Chrome. Pass `--chrome /path/to/chrome-for-testing`, optionally `--report <path>` and `--keep`. Inspect final case count, stage exit codes, artifact hashes and browser evidence before claiming full acceptance.

For a generated project's build problems, `npx chrome-extension-doctor --dist dist --json` reports common Manifest/resource/CSP issues and permission provenance. Add `--dev-url` for dev diagnostics; Chrome checks are explicitly requested with `--cdp` and `--extension-id`, requiring Node.js 22+.
