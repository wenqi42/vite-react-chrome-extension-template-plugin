# CASE-02：Manifest 常用字段与本地引用诊断

## 目标

在保留 `manifest` 最终覆盖、页面约定和 AST permission 自动补充的前提下，构建阶段对常用 MV3 字段给出可定位的错误，对本地文件引用给出字段路径和修复建议。

## 当前实现

- `validateManifest` 检查 `manifest_version`、`name`、`version`、`description`、权限数组、`action`、`background`、页面字段、图标、content scripts 和 `web_accessible_resources` 的常见形状。
- `manifestReferenceEntries` 收集 popup、worker、页面、图标、content script、WAR 资源引用，并保留 `manifest.<field>` 路径。
- `diagnoseManifestReferences` 在输出 bundle 中查找文件，也检查 `public/` 和最终 `outDir`。真实 bundle 中找不到的本地引用会使构建失败；空 bundle 的单元测试上下文只产生 warning。
- 重复的 `manifest.permissions` 会产生 warning，并在生成 manifest 时稳定去重。`autoPermissions: false` 仍然完全关闭 AST 推导。

## 典型输入

```ts
chromeExtension({
  manifest: {
    name: "Example",
    version: "1.0.0",
    background: { service_worker: "modules/background/background.ts" },
    content_scripts: [{
      matches: ["https://example.com/*"],
      js: ["modules/content/main.ts"],
    }],
  },
})
```

缺失入口的错误会带有 `manifest.background.service_worker` 或
`manifest.content_scripts[0].js[0]` 字段路径，并建议构建该入口或放入 `public/`。

## 验证

```bash
npm run typecheck --workspace @vite-react-chrome-extension/plugin
npx vitest run packages/vite-plugin-chrome-extension/test/plugin.vitest.ts
```

Chrome 完整 schema 仍由 Chrome 加载阶段最终判定；本 case 只覆盖常用字段和本地引用，不能替代 Chrome 对未知字段、权限上下文和商店规则的校验。
