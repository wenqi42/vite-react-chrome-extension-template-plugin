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

For browser evidence use Chrome for Testing and the repository smoke script:

```bash
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
```

Do not describe HTTP rendering as Chrome runtime validation. Report the generated project path, selected tools, exact checks, browser version and any content-script or MAIN-world limitation.
