# Repository maintenance guide

This repository contains a Vite plugin, a project generator, examples and AI integration guides for Chrome Manifest V3 extensions. Keep public documentation in sync with the implementation and answer users in their language.

## Ownership

- `packages/vite-plugin-chrome-extension/index.ts`: public plugin API, Manifest generation, source-entry discovery, permission inference and build diagnostics.
- `packages/vite-plugin-chrome-extension/dev.ts`: development watch build, staging/publish flow, reload protocol and development-only Manifest changes.
- `packages/vite-plugin-chrome-extension/chrome-permission-map.json`: reviewed namespace-to-permission map.
- `packages/create-chrome-extension/bin/create.ts`: CLI validation, prompts, template copy and optional tooling.
- `packages/create-chrome-extension/template/`: generated React + TypeScript project.
- `packages/skills/`: distributable AI instructions; these are documentation sources, not runtime packages.
- `examples/`: build and runtime fixtures.

## Stable contracts

1. Manifest generation targets Chrome MV3. It validates common fields and local references; it is not a complete Chrome schema validator.
2. `manifest` is the final configuration layer. Objects merge recursively, arrays replace whole values, and explicit permissions merge with inferred permissions.
3. Permission inference uses Babel AST member expressions. Do not replace it with substring matching. `autoPermissions: false` remains the manual escape hatch; host permissions stay manual.
4. `defineBackground`, source-entry path rewriting, standalone content-script output, automatic WAR collection, Tailwind integration and `defineDynamicResource` are public behavior.
5. `vite dev` defaults to build-backed reload. It publishes only successful staged builds, preserves the last successful output on failure, and cleans watchers and temporary directories on close. `liveReload: false` disables this layer.
6. Default development updates use full reload, without UI state preservation or replacement of already injected content scripts. Opt-in `contentScripts: { hmr: true }` uses the client lifecycle for supported ISOLATED/MAIN entries, explicit data retention and disposal. It does not provide framework Fast Refresh or automatic cleanup of arbitrary scripts. Unsupported entries and shared/background/Manifest changes retain full reload; keep these boundaries explicit.
7. The template keeps TypeScript, `@types/chrome`, ESLint, Prettier and CSS/Less/Sass choices explicit and independent. Do not force optional tools into every project.
8. The CLI rejects non-empty targets and must not leave partial output after cancellation or invalid input.
9. Using CodeGraph to get the target code instead of `grep` to reduce false positives if CodeGraph is existed.

## Verification

Run from the repository root:

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build:example
npm run build:vanilla-example
npm run verify:extension -- --dist <dist>
```

For development reload, use Chrome for Testing with Developer mode enabled:

```bash
npm run test:dev-reload -- --chrome <chrome-for-testing>
npm run test:content-hmr -- --chrome <chrome-for-testing>
npm run test:doctor -- --chrome <chrome-for-testing>
npm run test:acceptance -- --chrome <chrome-for-testing>
```

`test:acceptance` without `--case` runs all 36 style/tool/Vite combinations from packed artifacts in external projects. A selected case is focused evidence only. Include `client.ts`, `content-hmr.ts`, `doctor.ts` and acceptance planning in core coverage; do not hide new runtime logic behind an old module's coverage result. Diagnostic provenance describes active build modules, and host permissions remain manual except development-only permissions explicitly needed by the enabled update layer.

Report the exact commands, generated-project checks, browser version, runtime contexts and any unverified boundary. HTTP preview does not prove extension runtime behavior.

## Documentation rules

- Public README and skills describe supported behavior and user-facing limits. Do not include temporary paths, agent names, internal debugging history or abandoned approaches.
- Feature documents record the contract, usage, validation command and stable limitations. Do not treat a local evidence path or a single browser version as a permanent API guarantee.
- Update Chinese and English README sections together.
- When changing plugin behavior, update the relevant API types, tests, package `files`, README, skills and feature document.
- Do not publish npm packages, configure remote repositories, force-push or modify global npm links unless explicitly requested.
- Preserve unrelated user changes and avoid lockfile edits unless dependency changes require them.
- Before making implementation changes, read and follow
[docs/spec/SPEC.md](docs/spec/SPEC.md).
Then read the relevant module acceptance criteria referenced by the matrix.
