# Vite React Chrome Extension

[中文](#中文指南) | [English](#english-guide)

## 中文指南

React + TypeScript Chrome Manifest V3 工具集。推荐 Node.js 22 LTS 或更高版本、npm 10+；当前验证环境为 Node 24 / npm 11。根包声明的最低版本不代表所有可选工具在该版本上都经过测试。

一个可发布到 npm 的多 packages 项目，包含：

- `@vite-react-chrome-extension/plugin`：把 Vite/React 项目输出为 Chrome Manifest V3 扩展目录。
- `create-vite-react-chrome-extension`：通过 `npx create-vite-react-chrome-extension create my-extension` 创建模板项目。
- `examples/basic-extension`：可直接构建、加载到 Chrome 的示例。

## 快速开始

以下 `npx` 命令适用于包发布到 npm 之后；当前本地体验见下一节。

```bash
npx create-vite-react-chrome-extension create my-extension
cd my-extension
npm install
npm run dev
npm run build
```

也可以省略目录名，按提示输入项目名称，并分别用 `y/n` 选择 ESLint 和 Prettier（默认不启用）：

```bash
npx create-vite-react-chrome-extension create
```

自动化场景可显式指定开关，跳过对应问题：

```bash
npx create-vite-react-chrome-extension create my-extension --eslint --prettier
npx create-vite-react-chrome-extension create my-extension --no-eslint --no-prettier
```

### 发布前本地体验

推荐通过全局 link 体验，不需要发布 npm。下面命令中的 `/absolute/path/to/...` 请替换为你实际的绝对路径。

```bash
# 在仓库根目录安装依赖并注册全局命令与插件
npm install
npm link --workspace create-vite-react-chrome-extension --workspace @vite-react-chrome-extension/plugin

# 切到仓库外一个已存在的空闲目录
cd /absolute/path/to/playground
create-vite-react-chrome-extension create my-extension --eslint --prettier
cd my-extension

# 必须先 link 尚未发布的插件，避免 npm 去 registry 查找它
npm link @vite-react-chrome-extension/plugin --save
npm install
npm run build
npm run lint
npm run format:check
```

真正提供全局 bin 的是 CLI package，不是它内部的 `template/`。
`--save` 会把生成项目的插件依赖保存为本地 `file:` 路径；这是本地验证配置，不应作为公开模板提交。
切换 Node 版本可能改变全局 npm prefix，需要重新 link。若命令不可见，检查 `npm prefix -g` 对应的 `bin` 是否在 PATH 中。
撤销全局注册可执行 `npm uninstall -g create-vite-react-chrome-extension @vite-react-chrome-extension/plugin`；不要删除本地源码。

也可直接调用源码：

在仓库根目录运行：

```bash
node packages/create-chrome-extension/bin/create.js create
```

例如创建 `my-extension` 后，先把未发布的插件依赖指向本地包：

```bash
cd my-extension
npm pkg set 'devDependencies.@vite-react-chrome-extension/plugin=file:../packages/vite-plugin-chrome-extension'
npm install
npm run build
```

上面的相对路径适用于项目创建在仓库根目录内的情况；其他位置请使用插件包的绝对路径。

### 模板语言与开发工具

默认模板使用 TypeScript：页面入口为 `src/popup/main.tsx` 和 `src/options/main.tsx`，后台为 `src/background.ts`，配置为 `vite.config.ts`。
后台通过 Rollup 单独编译为 `dist/background.js`；`npm run build` 会先进行类型检查。
`@types/chrome` 已在 `devDependencies` 中默认安装，且 `tsconfig.json` 显式启用 `chrome` 类型。

- 选择 ESLint：生成 flat config，支持 TypeScript、React Hooks 和 React Refresh 检查，提供 `npm run lint` / `npm run lint:fix`。
- 选择 Prettier：生成 `.prettierrc.json`、`.prettierignore`，提供 `npm run format` / `npm run format:check`。
- 两者独立选择；未选择的工具不会加入依赖、配置或 npm scripts。
- `npm run dev` 用于普通网页预览；Chrome API 需要在加载构建产物的扩展上下文中使用。

构建后的 `dist` 可以在 Chrome 的 `chrome://extensions` 中打开「开发者模式」后，通过「加载已解压的扩展程序」加载。

## 在已有 Vite 项目中使用

```bash
npm install -D @vite-react-chrome-extension/plugin
```

```js
// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import chromeExtension from "@vite-react-chrome-extension/plugin";

export default defineConfig({
  plugins: [
    react(),
    chromeExtension({
      manifest: {
        name: "My Extension",
        description: "A React Chrome extension",
        permissions: ["storage", "activeTab"],
      },
      background: "background.js",
    }),
  ],
});
```

插件在 Vite 的 `generateBundle` 阶段生成 `manifest.json`，并自动发现 `modules/*/index.html` 作为页面入口。默认模板中的 `modules/popup` 和 `modules/options` 会分别构建为 `dist/popup/index.html` 与 `dist/options/index.html`。
此处的 `background.js` 必须存在于最终产物中：简单 JS 可以放到 `public/background.js` 原样复制；TypeScript 必须像默认模板一样显式配置 Rollup 入口。

约定页面名到 Manifest 的映射：

- `modules/popup/index.html` → `action.default_popup`
- `modules/options/index.html` → `options_ui.page`
- `modules/sidepanel/index.html` → `side_panel.default_path`
- `modules/devtools/index.html` → `devtools_page`

其他 `modules/<name>/index.html` 也会作为独立页面入口构建，但需要通过 `manifest` 显式配置它在 Chrome 中的用途。

### TypeScript background 配置

在上面的 `defineConfig` 中加入（工作目录为 Vite 项目根目录）：

```ts
base: './',
build: {
  rollupOptions: {
    input: { background: 'src/background.ts' },
    output: {
      entryFileNames: (chunk) =>
        chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
    },
  },
},
```

不要同时保留 `public/background.js` 和同名 TS 构建输出。
已有项目可运行 `npm install -D @types/chrome`，并在 tsconfig 的 `compilerOptions.types` 中合并加入 `"chrome"`。

### Plugin 配置与当前边界

| 选项             | 用途                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| `manifest`       | 最终优先级最高，深度合并 Manifest 字段；对象递归合并，数组整体替换                    |
| `pages`          | 默认自动发现 `modules/*/index.html`；传对象可显式指定入口，传 `false` 可关闭          |
| `pageRoot`       | 修改约定目录，默认为 `modules`                                                        |
| `popup`          | shorthand，覆盖 `action.default_popup`，但会被 `manifest.action.default_popup` 再覆盖 |
| `background`     | 设置输出 JS 路径及 `background.type: 'module'`                                        |
| `contentScripts` | 覆盖 `content_scripts` 数组，不负责编译脚本                                           |
| `outDir`         | 当前只影响日志显示，真正输出目录请配置 Vite `build.outDir`                            |

合并优先级从低到高为：约定页面生成值 → `popup` / `background` / `contentScripts` shorthand → `manifest`。
对象字段递归合并，数组整体使用后者替换；例如传入 `manifest.action.default_popup` 会覆盖 `modules/popup/index.html` 的默认映射。

重要限制：

- 插件只在 build 执行；`vite dev` 是普通网页预览，不提供扩展自动重载或 Chrome API mock。
- 自动发现和打包页面入口，但不自动发现/打包 background、content scripts；它们仍需使用 `public/` 或自定义 Rollup 入口。
- Manifest 检查仅覆盖 MV3、非空 name/version，不是完整 Chrome schema 校验，也不检查所有引用文件是否存在。
- Content scripts 必须引用实际生成的文件；普通 content script 不是 ESM，不能直接指向 TS 或包含顶层 import 的 Vite chunk。简单场景可使用 `public/content.js`，复杂场景需独立打包为兼容脚本。
- 使用最小权限；不要把密钥、远程执行脚本或不必要的 host permissions 放入扩展。

### Chrome 验证

1. `npm run build`，确认 `dist/manifest.json` 和其引用文件存在。
2. 打开 `chrome://extensions`，开启开发者模式，加载已解压的扩展程序，选择 `dist`。
3. 从扩展工具栏打开 popup，在扩展卡片检查 Service Worker 和错误信息。
4. 修改后重新构建，在扩展管理页点刷新，再重新打开 popup。

HTTP 预览页面成功不等于 Chrome 扩展运行验证成功；要单独确认权限、Service Worker、Chrome API 和 CSP。

## 开发说明

```bash
npm install
npm run test
npm run build:example
```

本项目刻意不把 Chrome 运行时 API 包装成自有抽象：用户可以直接使用官方 `chrome.*` API，并通过 `@types/chrome` 获得类型提示。

### 目录与 AI 协作

```text
packages/
  create-chrome-extension/       CLI、template、optional 配置、测试
  vite-plugin-chrome-extension/  ESM plugin 与类型声明
  skills/                       AI 使用指南（不是 npm runtime package）
examples/basic-extension/       JS 最小示例，不是默认 TS 模板
AGENTS.md                       后续开发约束与验证清单
```

AI 使用指南：

- [模板创建 skill](packages/skills/chrome-extension-create/SKILL.md)
- [Plugin 接入 skill](packages/skills/chrome-extension-plugin/SKILL.md)

`packages/skills` 是可分发的 skill 源文件，不会自动成为已安装 skill。可让 AI 直接读取；需要自动触发时，把相应目录安装到客户端支持的 skills 根目录，例如 `.comate/skills/<skill-name>/SKILL.md` 或 `.codex/skills/<skill-name>/SKILL.md`，再重新加载客户端。不要把两个 skill 嵌套安装在另一个 skill 内。

## English guide

### Overview and prerequisites

This npm-workspaces repository contains a build-only Vite plugin that emits a Chrome Manifest V3 manifest, a CLI that scaffolds React + TypeScript extensions, and a minimal JavaScript example.
Use Node.js 22 LTS or newer and npm 10+. The verified local environment is Node 24 / npm 11; the root engine minimum is not a compatibility guarantee for all optional tools.

### Local development without publishing

From the repository root:

```bash
npm install
npm link --workspace create-vite-react-chrome-extension --workspace @vite-react-chrome-extension/plugin
```

In a separate existing playground directory:

```bash
create-vite-react-chrome-extension create my-extension --eslint --prettier
cd my-extension
npm link @vite-react-chrome-extension/plugin --save
npm install
npm run build
npm run lint
npm run format:check
```

Link the **CLI package**, not its inner template directory. Link the unpublished plugin before running `npm install` in the generated project.
`--save` records a local `file:` dependency for testing; do not ship that machine-specific path in the public template.
Check `npm prefix -g` and PATH if the global command is missing. Switching Node installations may require linking again.
To unregister the global links, run `npm uninstall -g create-vite-react-chrome-extension @vite-react-chrome-extension/plugin`; keep the source directories.

After the packages are published, users can instead run:

```bash
npx create-vite-react-chrome-extension create my-extension
cd my-extension
npm install
npm run build
```

Omit the directory to enter a project name interactively. ESLint and Prettier are independent y/n questions, both defaulting to no.
For unattended use, specify both switches: `--eslint` or `--no-eslint`, and `--prettier` or `--no-prettier`.
The CLI rejects non-empty targets, invalid names, unknown flags and conflicting switches.

### Generated project

- `src/App.tsx`、`src/popup/main.tsx`、`src/options/main.tsx`: React page entries.
- `src/background.ts`: separately compiled module service worker.
- `vite.config.ts`: explicit popup and background Rollup entries.
- `@types/chrome`: default development dependency, enabled in tsconfig.
- `build`: runs TypeScript checks followed by Vite.
- Optional ESLint: `lint`, `lint:fix`, flat config with TS and React rules.
- Optional Prettier: `format`, `format:check`, config and ignore file.

### Using the plugin in an existing project

Install `@vite-react-chrome-extension/plugin` as a dev dependency once published, or use the local linking flow above. Install `@types/chrome` and add `"chrome"` to the existing tsconfig types list.
Use `react()` alongside `chromeExtension({ manifest: { name: 'My Extension', version: '0.1.0' }, background: 'background.js' })` in Vite's `plugins`.
See the full configuration examples in the Chinese section above and `packages/create-chrome-extension/template/vite.config.ts`.

The `background` option is an **output path**, not a source compiler entry. Either place plain JS at `public/background.js` or configure `src/background.ts` as a Rollup input with a stable `background.js` output. Do not use both.

Page entries follow `modules/<page>/index.html`; `popup`, `options`, `sidepanel` and `devtools` receive their corresponding Manifest V3 fields. Other page names are built but require an explicit manifest mapping.

Options:

- `manifest`: manifest overrides; defaults to MV3, version `0.1.0`, and uses `modules/popup/index.html` when that route exists.
- `popup`: overrides `action.default_popup`.
- `background`: sets `service_worker` and `type: 'module'`.
- `contentScripts`: assigns the manifest array; does not compile scripts.
- `outDir`: currently affects logging only. Use Vite's `build.outDir` for actual output.

Merge precedence is convention-generated values, then shorthand options, then `manifest`. Objects are recursively merged and arrays are replaced as whole values, so explicit user manifest data always wins.

### Limitations and validation

The plugin runs only during builds. It does not provide extension HMR, API mocks, automatic background/content-script discovery, hash rewriting, or full manifest/reference validation.
Plain content scripts cannot use top-level ESM imports: use a compatible plain JS file from `public/`, or a separate compatible bundle. Do not reference raw TS files in the manifest.
Grant only required permissions and never embed secrets.

Build, open `chrome://extensions`, enable Developer mode, and load the generated `dist` as an unpacked extension. Open its popup and inspect its service worker and errors. After edits, rebuild and reload the extension.
An HTTP preview verifies rendering only; it does not verify Chrome APIs, permissions, service workers or extension CSP.

### Contributing and AI assistance

```bash
npm run test
npm run create:smoke
npm run build:example
```

The root suite checks the example build, plugin declarations, CLI syntax and CLI creation scenarios. It does **not** replace an independent generated-project install/build/lint/format check or a real Chrome runtime test.
Follow [AGENTS.md](AGENTS.md) for maintenance.
Read [CLI skill](packages/skills/chrome-extension-create/SKILL.md) and [plugin skill](packages/skills/chrome-extension-plugin/SKILL.md) for AI-assisted usage.
These directories are skill sources, not automatically installed skills or npm packages. Install each as a direct child of your client's supported skills root if automatic discovery is desired.
