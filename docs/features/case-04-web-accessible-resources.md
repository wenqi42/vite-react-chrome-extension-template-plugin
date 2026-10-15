# CASE-04：WAR 资源图和 `web_accessible_resources`

状态：现有（静态 bundle 资源图已验证；host 页面加载资源需 CDP 验收）。

## 用户场景

插件从 content script 的 JS/CSS 入口和 Rollup/Vite 输出图收集可访问资源：

- content script 输出 JS；
- `viteMetadata.importedCss` 关联的 CSS；
- `referencedFiles` 中的图片、字体和其他静态资源；
- `dynamicImports` 关联的动态 chunk；
- 用户已经声明的 WAR 分组。

自动分组使用对应 content script 的 `matches`，不会擅自扩大为 `<all_urls>`。用户的
`extension_ids`、`use_dynamic_url` 和其他字段会保留。相同匹配和元数据的分组会合并，
资源路径会使用 `/`、去重并稳定排序。

```json
{
  "web_accessible_resources": [
    {
      "matches": ["https://example.com/*"],
      "resources": [
        "assets/content.css",
        "content/content-ts.js",
        "assets/logo.png"
      ]
    }
  ]
}
```

`defineDynamicResource()` 返回的 `<dynamic_resource>` 占位符仍然是用户声明 helper；
它不会被静态资源图替换或删除。

## 生成产物和错误边界

- 用户 WAR 和自动 WAR 合并后，每个分组的 resources 只保留一份并按字典序排序。
- 同一 `matches` 的自动资源会补入用户分组，同时保留用户字段。
- `public/` 中的资源可作为用户声明的合法引用；其他不存在的资源在真实 bundle 中
  会给出字段定位错误。
- 资源图收集不推断 host permission；host 权限仍须在 manifest 中显式声明。
- 只有静态 build 通过不代表 host 页面可加载，必须用 unpacked extension + CDP 检查
  网络请求和页面控制台。

## 验证

```bash
npm run typecheck
npm run test:unit -- --run packages/vite-plugin-chrome-extension/test/plugin.vitest.ts
npm run test:coverage
```

测试覆盖 CSS、静态资源、动态 chunk、用户 WAR、去重、匹配分组和稳定排序。CDP
验收应在真实扩展中打开匹配 host 页面并确认资源请求没有 404。
