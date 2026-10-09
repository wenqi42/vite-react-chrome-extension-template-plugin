# Agent development guide / AI 开发指南

## Scope / 范围

维护 npm workspaces 中的 Chrome MV3 plugin、CLI 和 React TS 模板。先读 README，再读对应源码。回答使用用户语言。
Maintain the plugin, CLI and TS template. Read current source before relying on documentation.

## Ownership / 文件职责

- `packages/vite-plugin-chrome-extension/index.js`: build-only manifest emission.
- `packages/vite-plugin-chrome-extension/chrome-permission-map.json`: reviewed API namespace → permission data.
- `scripts/generate-chrome-permission-map.mjs`: official-doc fetcher and map generator.
- `packages/vite-plugin-chrome-extension/index.d.ts`: public API declarations; update with API changes.
- `packages/create-chrome-extension/bin/create.js`: prompts, validation, copy and optional tools.
- `packages/create-chrome-extension/template/`: generated TS application with `modules/*/index.html` page routes, not a workspace.
- `packages/create-chrome-extension/optional/`: conditional ESLint/Prettier files.
- `packages/create-chrome-extension/test/`: Node test runner CLI tests.
- `examples/basic-extension/`: minimal JS fixture, not the default TS template.
- `packages/skills/`: distributable AI instructions, not runtime packages.

## Guardrails / 开发约束

1. 只改请求范围；保留用户未提交修改，不擅自覆盖、reset 或删除。Inspect git status; preserve unrelated changes.
2. 不确定影响目标的决策先问。Do not silently expand scope.
3. 默认 TS、`@types/chrome`、ESLint/Prettier 独立 opt-in。Keep these template contracts.
4. 不自动发布 npm、配置远程仓库或强推。Global links modify the user's npm prefix; explain them and check existing links first.
5. CLI 拒绝覆盖非空目标；取消输入不得创建半成品。Keep tests for all four tool combinations and invalid input.
6. 包尚未发布时优先本地 link；不要把机器绝对路径写入正式模板。Do not assume registry availability.
7. 默认不要修改 lockfile；依赖发生变化时用 npm 更新并检查 diff。Do not overwrite user package-name edits.

## Known implementation limits / 真实边界

Plugin discovers `modules/*/index.html` and adds those pages as Vite inputs. It emits the Manifest; background/content script compilation remains an explicit project concern.
Plugin uses Babel AST member-expression analysis for `chrome.*` / `browser.*` permission inference. Never replace it with substring matching. Unknown APIs warn; host permissions remain manual.
Template Rollup configuration compiles TS background separately and uses page routes for popup/options.
`contentScripts` only assigns manifest data. Plain content scripts require non-ESM-compatible outputs.
`outDir` plugin option currently only changes the log; actual output is Vite `build.outDir`.
Validation only checks MV3 and nonempty name/version. Do not describe this as complete Chrome validation.
Vite dev is a web preview, not extension hot reload. HTTP rendering is not extension runtime acceptance.

## Validation / 验证

From the root run `npm run test`. Root typecheck only checks plugin declarations and CLI JS syntax; it does not typecheck the generated template.
For template changes, also create a new external project via the CLI, install dependencies, then run `npm run typecheck`, `npm run build`, and selected `lint` / `format:check`.
Follow README's tested global `npm link` sequence before npm install in that project.
Never reuse or erase a user's nonempty project for a smoke test.

Verify `dist/manifest.json`, popup assets and `background.js` exist. For runtime acceptance load `dist` in Chrome and inspect popup, worker, API interactions and errors.
Report exactly what ran, failures, test directory, browser verification limits and remaining blockers.

## Docs and skills / 文档同步

Keep Chinese and English README instructions aligned with current code.
When API permissions change, update the generator/fallback map, tests, README boundaries and the package files list together.
Update relevant skill when CLI flags or plugin behavior changes.
Use lowercase kebab-case names and valid YAML frontmatter for skills.
Read `packages/skills/chrome-extension-create/SKILL.md` for scaffolding and `packages/skills/chrome-extension-plugin/SKILL.md` for integration.
