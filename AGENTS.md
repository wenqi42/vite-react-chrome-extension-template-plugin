# Agent development guide / AI 开发指南

## Scope / 范围

维护 npm workspaces 中的 Chrome MV3 plugin、CLI 和 React TS 模板。先读 README，再读对应源码。回答使用用户语言。
Maintain the plugin, CLI and TS template. Read current source before relying on documentation.

## Ownership / 文件职责

- `packages/vite-plugin-chrome-extension/index.ts`: build-only manifest emission; `dist/index.js` is generated for publishing.
- `packages/vite-plugin-chrome-extension/chrome-permission-map.json`: reviewed API namespace → permission data.
- `scripts/generate-chrome-permission-map.ts`: official-doc fetcher and map generator; run through the root build.
- `packages/vite-plugin-chrome-extension/index.ts`: public API source; its declaration is generated into `dist/index.d.ts`.
- `packages/create-chrome-extension/bin/create.ts`: prompts, validation, copy and optional tools; `dist/bin/create.js` is the published bin.
- `packages/create-chrome-extension/template/`: generated TS application with `modules/*/index.html` page routes, not a workspace.
- `packages/create-chrome-extension/optional/`: conditional ESLint/Prettier files.
- `packages/create-chrome-extension/test/`: CLI regression tests.
- `examples/basic-extension/`: minimal TypeScript fixture, not the default template.
- `packages/skills/`: distributable AI instructions, not runtime packages.

## Guardrails / 开发约束

1. 只改请求范围；保留用户未提交修改，不擅自覆盖、reset 或删除。Inspect git status; preserve unrelated changes.
2. 不确定影响目标的决策先问。Do not silently expand scope.
3. 默认 TS、`@types/chrome`、ESLint/Prettier 独立 opt-in。Keep these template contracts.
4. 不配置远程仓库或强推。Do not configure remotes or force-push.
5. CLI 拒绝覆盖非空目标；取消输入不得创建半成品。Preserve the CLI safety contract.
6. 发布包只包含构建产物、模板和必要配置，不包含源码测试文件或本地路径。
7. 依赖发生变化时同步更新 lockfile。Keep package metadata and lockfile aligned.

## Known implementation limits / 真实边界

Plugin discovers `modules/*/index.html` and adds those pages as Vite inputs. It emits the Manifest; background/content script compilation remains an explicit project concern.
Plugin uses Babel AST member-expression analysis for `chrome.*` / `browser.*` permission inference. Never replace it with substring matching. Explicit `manifest.permissions` is merged with inferred permissions; `autoPermissions: false` is the manual escape hatch. Unknown APIs warn; host permissions remain manual.
Template Rollup configuration compiles TS background separately and uses page routes for popup/options.
`contentScripts` only assigns manifest data. Plain content scripts require non-ESM-compatible outputs.
`outDir` plugin option currently only changes the log; actual output is Vite `build.outDir`.
Validation only checks MV3 and nonempty name/version. Do not describe this as complete Chrome validation.
Vite dev is a web preview, not extension hot reload. HTTP rendering is not extension runtime acceptance.

## Engineering checks / 工程检查

Run `npm run test` before merging implementation changes. Run `npm pack --dry-run --workspace <package>` before publishing and confirm that only intended runtime files, declarations, templates and metadata are included.

## Docs and skills / 文档同步

Keep Chinese and English README instructions aligned with current code.
When API permissions change, update the generator/fallback map, tests, README boundaries and the package files list together.
Update relevant skill when CLI flags or plugin behavior changes.
Use lowercase kebab-case names and valid YAML frontmatter for skills.
Read `packages/skills/chrome-extension-create/SKILL.md` for scaffolding and `packages/skills/chrome-extension-plugin/SKILL.md` for integration.
