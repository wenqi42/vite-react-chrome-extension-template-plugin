# Vite React Chrome Extension

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

默认模板使用 TypeScript：React popup 为 `src/main.tsx`，后台为 `src/background.ts`，配置为 `vite.config.ts`。
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
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import chromeExtension from '@vite-react-chrome-extension/plugin'

export default defineConfig({
  plugins: [
    react(),
    chromeExtension({
      manifest: {
        name: 'My Extension',
        description: 'A React Chrome extension',
        permissions: ['storage', 'activeTab']
      },
      background: 'background.js'
    })
  ]
})
```

插件会在 Vite 的 `generateBundle` 阶段生成 `manifest.json`。`manifest.action.default_popup` 默认指向 `index.html`，`background` 指向的文件应放在 `public/` 中，以便 Vite 原样复制到产物目录。

## 开发说明

```bash
npm install
npm run test
npm run build:example
```

本项目刻意不把 Chrome 运行时 API 包装成自有抽象：用户可以直接使用官方 `chrome.*` API，并通过 `@types/chrome` 获得类型提示。
