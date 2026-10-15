# Vite React Chrome Extension

一个面向 Chrome Manifest V3 的 Vite 工具集，包含：

- `@vite-react-chrome-extension/plugin`：生成 Manifest、编译页面/background/content script，并提供开发自动 reload。
- `create-vite-react-chrome-extension`：创建 React + TypeScript 扩展模板。
- `examples/basic-extension`：React 示例。
- `examples/vanilla-extension`：不依赖 React 的原生 DOM 示例。
- `examples/network-rewrite-extension`：side panel 网络响应改写示例。

## 快速开始

```bash
npx create-vite-react-chrome-extension create my-extension --eslint --prettier
cd my-extension
npm install
npm run dev
```

开发时等待首次构建完成，在 `chrome://extensions` 开启开发者模式并加载 `dist`。修改页面、background 或 content script 后，扩展会根据变更范围刷新页面或重载扩展。生产构建使用：

```bash
npm run build
```

## 尚未发布时的本地使用

```bash
npm install
npm run build
npm link --workspace create-vite-react-chrome-extension --workspace @vite-react-chrome-extension/plugin
```

在仓库外的空目录中创建项目，并在安装依赖前链接本地插件：

```bash
create-vite-react-chrome-extension create my-extension --eslint --prettier
cd my-extension
npm link @vite-react-chrome-extension/plugin --save
npm install
```

`npm link` 只用于本地验证，不要把机器路径提交到模板或发布配置。

## 创建模板

CLI 支持以下选项：

```text
create [directory]
--eslint | --no-eslint
--prettier | --no-prettier
--css | --less | --sass
```

ESLint、Prettier 和样式预处理器可以独立选择。CLI 不会覆盖非空目录；取消输入、非法名称、未知参数和冲突参数都会直接失败。

模板默认提供：

- `modules/popup/index.tsx`
- `modules/options/index.tsx`
- `modules/background/background.ts`
- Tailwind CSS 4
- `@types/chrome`
- `npm run dev`、`npm run build`、`npm run typecheck`

## 接入现有 Vite 项目

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import chromeExtension, { defineBackground, defineManifest } from '@vite-react-chrome-extension/plugin'

const manifest = defineManifest(({ mode }) => ({
  name: `My Extension (${mode})`,
  version: '1.0.0',
  permissions: ['storage'],
}))

export default defineConfig({
  base: './',
  plugins: [
    react(),
    chromeExtension({
      manifest,
      background: defineBackground('src/background.ts'),
    }),
  ],
})
```

插件默认发现 `modules/*/index.html`：

| 入口 | Manifest 字段 |
| --- | --- |
| `modules/popup/index.html` | `action.default_popup` |
| `modules/options/index.html` | `options_ui.page` |
| `modules/sidepanel/index.html` | `side_panel.default_path` |
| `modules/devtools/index.html` | `devtools_page` |

`pages` 可以传对象指定入口，也可以传 `false` 关闭自动发现；`pageRoot` 可以修改约定目录。

没有 popup 页面入口时，`action` 可以只配置 `default_title` 或图标，无需声明 popup。例如侧栏项目可在 background 使用 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`，由扩展图标打开侧栏。若存在自动发现的 popup 页面，需移除该入口或调整 `pages` 配置。

## 插件 API

```ts
chromeExtension({
  manifest,
  pages,
  pageRoot: 'modules',
  popup: 'modules/popup/index.html',
  background: 'background.js',
  contentScripts: [{
    matches: ['https://example.com/*'],
    js: ['src/content.ts'],
    css: ['src/content.css'],
  }],
  autoPermissions: true,
  tailwind: true,
  assetFileNames: 'assets/[name]-[hash][extname]',
  liveReload: true,
})
```

- `manifest`：最终 Manifest 覆盖层，支持对象、Promise 和 Vite 环境工厂。
- `background`：字符串表示稳定输出路径；`defineBackground()` 会把 TS/JS source entry 纳入构建。
- `contentScripts`：数组替换 `content_scripts`；source entry 默认输出 standalone IIFE。传 `{ standalone: false }` 时由项目自行管理输出。
- `contentScripts: { hmr: true }`：显式开启 content script 原地更新，配合 `@vite-react-chrome-extension/plugin/client` 的生命周期 API 管理清理和数据保留，见下文。
- `autoPermissions`：默认开启，使用 Babel AST 分析 `chrome.*` / `browser.*`。`false` 时完全关闭自动补充。
- `tailwind`：默认开启 Tailwind CSS 4；已有独立 PostCSS 配置时设为 `false`。
- `liveReload`：默认开启，仅对 `vite dev` 生效；设为 `false` 时只运行普通 Vite 预览。
- `defineDynamicResource()`：声明包含 `<dynamic_resource>` 的 WAR 分组。

插件会把 Manifest 中可解析的 background、content script 和页面 source entry 纳入 Vite 输入，并在输出阶段回写真实文件名。content script 的 CSS、静态资源和动态 chunk 会合并到 `web_accessible_resources`。

## 自动权限

插件按 AST 成员访问推导权限，不使用字符串搜索。显式 `manifest.permissions` 会和推导结果去重合并，host permissions、`activeTab` 以及依赖上下文的权限仍需手动声明。

`chrome.runtime` 的生命周期、普通消息和 reload 不需要额外权限；`connectNative`、`sendNativeMessage` 等 native messaging API 仍需显式声明 `nativeMessaging`。未知 API namespace 只产生 warning，不会自动加入危险权限。

构建同时输出 `chrome-extension-diagnostics.json`，记录显式权限和参与构建模块的 AST 推导来源。它供 Doctor 诊断，不改变 Manifest 中的权限合并规则，也不推导 host permissions。

## Extension Doctor

检查已构建的扩展：

```bash
npx chrome-extension-doctor --dist dist --json
```

`--root` 指定项目目录；`--dev-url http://localhost:5173` 检查开发服务状态与输出目录；`--cdp http://localhost:9222 --extension-id <id>` 检查 Chrome 中已加载的扩展、worker/page 上下文与运行错误。静态和开发服务检查需要 Node.js 18+，CDP 诊断需要 Node.js 22+。

报告区分显式权限、AST 推导和未知来源，每项问题提供 code、位置与修复提示；未请求的检查标为 skipped。存在 error 时返回非零。Doctor 检查常见 MV3 配置和资源引用，不提供完整 Chrome schema 验证，也不修改项目或 Chrome 配置。用法和限制见 [Doctor](docs/features/case-16-extension-doctor.md)。

## 开发自动 reload

`vite dev` 会把扩展构建到 Vite 的 `build.outDir`，先写入暂存目录，成功后原子更新最终目录：

- 仅页面及其独占依赖变化：扩展页面调用 `location.reload()`，worker 保持运行。
- background、content script、Manifest 或共享依赖变化：调用 `chrome.runtime.reload()`，Chrome 会关闭已有扩展页面，重新打开即可看到新版本。
- 构建失败或后置插件失败：不发送 reload，保留上一份成功产物。
- 开发 worker 每 20 秒发送 WebSocket 心跳，支持 Chrome 116+ 的 MV3 worker 生命周期。
- 开发代码全部打包到本地扩展；Vite WebSocket 只传递版本事件。
- 服务器在相同 host/port 重启后会重新连接；端口或协议改变时需要重新加载开发扩展。

默认路径为完整 reload，不提供 React/Vue 状态保留。未启用 content HMR 时，content script 修改后刷新匹配的宿主网页；`world: 'MAIN'` 遵循相同边界。

开发 Manifest 会临时加入开发服务器 host permission 和 CSP `connect-src`；正式 `vite build` 不包含这些字段、reload client 或开发 worker。开发目录不要直接发布。

## Content script 原地 HMR

在插件中设置 `contentScripts: { hmr: true }`，并在 content source entry 使用生命周期 API：

```ts
import { defineContentScript } from '@vite-react-chrome-extension/plugin/client'

void defineContentScript('my-content', ({ data, signal, onDispose }) => {
  const input = document.createElement('input')
  input.value = typeof data.draft === 'string' ? data.draft : ''
  document.body.append(input)
  input.addEventListener('change', () => console.log(input.value), { signal })
  onDispose(previous => {
    previous.draft = input.value
    input.remove()
  })
})
```

相同 ID 的更新先清理旧实例，再挂载新实例；显式存入 `data` 的输入等值会传递给下一次挂载。通过 `signal` 或清理函数释放监听器、定时器和 UI。ISOLATED、MAIN、CSS 和 content 独占依赖可以在匹配宿主文档中原地更新。它不自动保存任意框架状态，也不提供 React Fast Refresh。

未使用生命周期或不兼容的条目会诊断并回退到完整 reload；background、Manifest 或与其他运行入口共享的依赖变化仍重载扩展。开发服务同地址重启可重连，扩展页面可能因 session 切换刷新。`liveReload: false` 关闭此开发层。

HMR 开发产物增加注入所需 `scripting` 与匹配 host 权限，使用扩展内的本地脚本和 Chrome 样式注入；生产会移除开发新增部分，保留用户显式权限。完整用法、初始 CSS 时序和匹配回退限制见 [Content script HMR](docs/features/case-07-content-reload-boundaries.md)。

## 构建与验证

```bash
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build:example
npm run build:vanilla-example
npm run build:network-example
npm run verify:extension -- --dist dist
```

仓库使用 ESLint flat config 检查 JS、MJS、TS 和 TSX，覆盖插件、CLI、模板源码、示例、测试及脚本；依赖、构建输出、覆盖率与临时缓存不参与检查。ESLint 工具链要求 Node.js 18.18 或更高版本。

```bash
npm run lint:fix   # 应用可自动修复的规则
npm run test:lint  # 验证问题检出、源码范围和忽略规则
```

也可使用 `pnpm run lint` 执行同一检查。依赖仍通过 npm 安装；pnpm 的运行兼容配置禁用了脚本执行前自动安装依赖。仓库自身的检查与 CLI 生成项目的可选 `--eslint` 配置独立。

真实扩展运行验证：

1. 构建或启动 `npm run dev`。
2. 在 Chrome 开发者模式加载 `dist`。
3. 打开 popup，检查 Service Worker 和错误信息。
4. 修改代码，观察页面 reload 或扩展重载。
5. content script 修改后刷新匹配的宿主网页。

HTTP 预览只能证明页面渲染，不能替代扩展上下文、权限、Service Worker、CSP 或 content script 验证。完整开发验收脚本：

```bash
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
npm run test:content-hmr -- --chrome /path/to/chrome-for-testing
npm run test:doctor -- --chrome /path/to/chrome-for-testing
```

完整生成项目验收使用真实 npm tarball，在仓库外安装生成项目，覆盖 CSS/Less/Sass × ESLint 开关 × Prettier 开关 × Vite 5/6/7 共 36 个组合，并在 Chrome 中检查页面和 worker：

```bash
npm run test:acceptance -- --list --json
npm run test:acceptance -- --chrome /path/to/chrome-for-testing
```

`--case <id>` 选择组合，`--report <path>` 指定报告，`--keep` 保留生成项目。报告记录运行范围、依赖版本、命令与退出码、tarball/产物标识和浏览器证据。筛选运行不代表完整矩阵通过。CI 运行相同检查并上传诊断证据，详见 [自动验收流水线](docs/features/case-17-acceptance-pipeline.md)。

## 项目结构

```text
packages/create-chrome-extension/       CLI、模板和可选工具
packages/vite-plugin-chrome-extension/  插件源码、开发 reload 和测试
packages/skills/                        AI 接入指南
examples/basic-extension/               React 示例
examples/vanilla-extension/             原生 DOM 示例
examples/network-rewrite-extension/    side panel 网络改写示例
docs/                                   能力、兼容性和验收文档
```

- [插件接入 Skill](packages/skills/chrome-extension-plugin/SKILL.md)
- [模板创建 Skill](packages/skills/chrome-extension-create/SKILL.md)
- [能力路线图](docs/feature-roadmap.md)
- 本项目在部分 Manifest 驱动构建和开发体验上参考了 CRXJS，同时保留自己的权限推导、Tailwind、Doctor、HMR 和 CLI 能力。
- [验收矩阵](docs/acceptance-matrix.md)
- [自动 reload 说明](docs/features/case-06-extension-auto-reload.md)
- [Content script 边界](docs/features/case-07-content-reload-boundaries.md)
- [Network rewrite sidebar](docs/features/case-14-network-rewrite-sidebar.md)
- [仓库 ESLint](docs/features/case-15-repository-lint.md)
- [Extension Doctor](docs/features/case-16-extension-doctor.md)
- [打包与生成项目自动验收](docs/features/case-17-acceptance-pipeline.md)

网络改写示例需要先打开 HTTP/HTTPS 网页，在侧栏点击 `Attach active tab`，再保存规则并重新发起请求。`No tab attached` 表示尚未开始拦截，保存规则不会自动附加。已完成的响应不会被追溯修改。

```bash
npm run build:network-example
npm run test:network-rewrite -- --chrome /path/to/chrome-for-testing
```

## English

This repository provides a Vite plugin and CLI for Chrome Manifest V3 extensions.

For repository development, run `npm run lint` (or `pnpm run lint`), `npm run lint:fix` for automatic fixes, and `npm run test:lint` to verify lint detection and file coverage. The flat config checks JS/MJS/TS/TSX in packages, template sources, examples, tests and scripts, excluding dependencies, build output, coverage and temporary caches. The ESLint toolchain requires Node.js 18.18+. Keep installing dependencies with npm; the pnpm compatibility setting disables automatic dependency installation before running scripts. Repository lint is independent of the generated project's optional `--eslint` setup.

```bash
npx create-vite-react-chrome-extension create my-extension --eslint --prettier
cd my-extension
npm install
npm run dev
```

Enable Developer mode in `chrome://extensions`, then load `dist` after the first successful development build. Use `npm run build` for production output.

The plugin discovers `modules/*/index.html`, supports `defineManifest`, `defineBackground`, `defineDynamicResource`, AST-based permission inference, standalone content-script IIFE output, automatic WAR generation, Tailwind CSS 4 integration and build-backed development reload.

Builds also emit `chrome-extension-diagnostics.json` with explicit permissions and AST inference sources from modules participating in the build. Host permissions remain manually configured.

Run `npx chrome-extension-doctor --dist dist --json` to inspect a built extension. Add `--dev-url http://localhost:5173` for development status and output-directory checks, or `--cdp http://localhost:9222 --extension-id <id>` to inspect an already loaded Chrome extension and its worker/page contexts. Static/dev checks require Node.js 18+; CDP requires Node.js 22+. Reports include actionable issue codes, distinguish unknown permission provenance, and mark unrequested checks as skipped. Errors produce a nonzero exit code. Doctor checks common MV3 fields and local references, does not provide complete Chrome schema validation, and does not modify projects or Chrome settings.

An `action` can declare only a title or icon, with no popup. A side panel project can call `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in its background worker to open the panel from the toolbar action. If the project has an automatically discovered popup page, remove that entry or adjust `pages`.

`liveReload` defaults to `true` for `vite dev`. Page-only edits refresh extension pages. By default, worker, content-script, Manifest or shared dependency edits reload the extension. Failed builds preserve the previous successful output. Existing content scripts on this default path require a host-page refresh. Production builds omit development clients, host permissions and CSP additions.

Opt into content updates with `contentScripts: { hmr: true }` and register a stable ID using `defineContentScript` from `@vite-react-chrome-extension/plugin/client`. Its setup receives `{ data, signal, onDispose }` and can return synchronous or asynchronous cleanup. Replacements await cleanup, abort old listeners and reuse explicitly saved data. ISOLATED/MAIN, CSS and content-exclusive dependencies update existing matching documents using local extension scripts and Chrome CSS injection. Arbitrary framework state and React Fast Refresh are not provided. The basic lifecycle also works in production.

Unsupported entries or scripts without lifecycle registration emit a diagnostic and retain full reload; background, Manifest and inputs shared with other runtime entries also reload the extension. Same-address dev restarts reconnect but may refresh extension pages on session changes. Development HMR temporarily adds `scripting` and matching host permissions; production removes development additions while preserving explicit user permissions. See the [content update guide](docs/features/case-07-content-reload-boundaries.md) for matching limits and initial CSS timing.

Use `liveReload: false` for ordinary web preview, middleware mode or a setup that disables Vite WebSocket. Chrome 116+ is required for the development worker heartbeat.

Run `npm run test:dev-reload -- --chrome /path/to/chrome-for-testing` for the real CDP smoke test. HTTP preview is not extension runtime validation.

Use `npm run test:content-hmr -- --chrome /path/to/chrome-for-testing` for content lifecycle/update acceptance and `npm run test:doctor -- --chrome /path/to/chrome-for-testing` for actual Chrome diagnostic scenarios.

Run `npm run test:acceptance -- --chrome /path/to/chrome-for-testing` for all 36 CSS/Less/Sass × ESLint × Prettier × Vite 5/6/7 combinations. It packs the actual CLI/plugin, installs generated projects outside the repository, executes typecheck/build and selected tools, verifies artifacts, and loads each extension in Chrome. Use `--list --json`, repeated `--case <id>`, `--report <path>` and `--keep` to inspect or narrow a run. Reports preserve dependency versions, commands, exit codes, artifact hashes and browser evidence. Selected cases do not prove the full matrix. CI runs the same checks and retains diagnostic artifacts.

The Network Rewrite example requires an HTTP/HTTPS page. Click `Attach active tab` in its side panel, save your rules, then issue a new request. `No tab attached` means interception has not started; saving rules does not attach automatically or modify completed responses. Build with `npm run build:network-example` and run its browser acceptance with `npm run test:network-rewrite -- --chrome /path/to/chrome-for-testing`.
