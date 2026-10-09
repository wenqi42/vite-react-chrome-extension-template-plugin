---
name: chrome-extension-create
description: "Create and validate React TypeScript Chrome extensions using create-vite-react-chrome-extension. Use when asked to create this template, choose ESLint/Prettier, use its npx CLI, or test unpublished packages via npm link in a separate directory. Not for creating generic Comate plugins."
---

# Create a Chrome extension

1. Locate the repository and read `packages/create-chrome-extension/bin/create.js`, template package.json and root README. Do not assume npm publication.
2. Confirm the destination/project name and independent ESLint/Prettier choices when unspecified. Use lowercase npm-compatible names. Never overwrite a nonempty directory.
3. Choose published or local mode. For unattended invocation supply both tool flags to avoid waiting on prompts.

## Published mode

Only after publication is confirmed:

```bash
npx create-vite-react-chrome-extension create my-extension --eslint --no-prettier
```

The `create` subcommand is required. Omitting the directory prompts for project name. Optional switches are `--eslint`, `--no-eslint`, `--prettier`, `--no-prettier`.

## Unpublished local mode

Check `npm prefix -g` and existing global links before modifying them.
Register the CLI and plugin from the repo root:

```bash
npm install
npm link --workspace create-vite-react-chrome-extension --workspace @vite-react-chrome-extension/plugin
```

In an existing playground directory outside the repository:

```bash
create-vite-react-chrome-extension create my-extension --eslint --no-prettier
cd my-extension
npm link @vite-react-chrome-extension/plugin --save
npm install
```

Link **before** installing so npm does not request the unpublished plugin from the registry.
The CLI package has the global executable, not the nested `template` directory.
`--save` records a local file dependency; keep it in the test project only.
If global writes are unavailable, offer direct `node <repo>/packages/create-chrome-extension/bin/create.js create ...` and a local plugin file dependency rather than publishing.

## Verify and report

- Run typecheck and build in the generated project.
- Run lint and format:check only if their tools were selected.
- Confirm `src/App.tsx`, `src/background.ts`, `vite.config.ts`, `@types/chrome`, and selected/absent configuration files.
- Inspect manifest references and generated worker. Load unpacked `dist` in Chrome for runtime validation when possible.
- Report location, selections, exact checks, global links left installed and Chrome verification limits.
- Do not call a successful HTTP preview a successful extension runtime test.
- Refer to the sibling `chrome-extension-plugin/SKILL.md` when changing manifest/build configuration.
