# CASE-03：Content script source entry 编译

状态：现有（静态构建已验证；动态 import、MAIN world 等运行时边界仍需 CDP 验收）。

## 用户场景

Manifest 中可以直接把 `src/content.ts`、`src/content.js` 等源码写入
`content_scripts[].js`。插件会把存在的源码入口加入 Vite/Rollup 输入，并在产物阶段
将入口路径改写为真实输出路径。

```ts
chromeExtension({
  manifest: {
    name: 'Content entry',
    version: '1.0.0',
    content_scripts: [{
      matches: ['https://example.com/*'],
      js: ['src/content.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
    }],
  },
})
```

默认情况下，匹配到的 JS chunk 会被静态依赖内联并包在 IIFE 中。这样生成的脚本没有
顶层 `import`，可以直接由 Chrome content script 加载。动态 `import()` 仍保留为独立
输出文件，并由 CASE-04 的资源图收集纳入 WAR；需要动态加载的脚本应在 CDP 中验证。

现有 `contentScripts: [...]` shorthand 继续只负责写入 manifest 数组。传入
`contentScripts: { standalone: false }` 可以关闭源码入口的 IIFE 转换，适用于项目已
自行产出 Chrome 兼容脚本的场景。插件不会把不存在的源码路径伪装成已编译产物。

## 生成产物和错误边界

- `manifest.content_scripts[].js` 的源路径会重写为真实 bundle 文件名。
- 静态依赖 chunk 会内联到 content script；共享依赖 chunk 不会从其他入口删除。
- HTML 页面入口保持 HTML 输出路径，不会被错误替换为页面脚本 chunk。
- 真实构建中缺失的 manifest 本地引用会产生带字段路径和修复建议的错误。
- `world: 'MAIN'`、CSP、动态 import 和运行时 API 仍需要 Chrome CDP 验收。

## 验证

```bash
npm run typecheck
npm run test:unit -- --run packages/vite-plugin-chrome-extension/test/plugin.vitest.ts
npm run build --workspace @vite-react-chrome-extension/plugin
npm run build:example
```

单元测试覆盖入口路径回写、静态依赖内联、IIFE 无顶层 ESM import，以及
`autoPermissions` 继续保留的路径。HTTP 预览不能替代 unpacked extension 的 Chrome
runtime 验证。
