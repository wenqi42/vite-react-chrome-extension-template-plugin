# 无 Popup 的扩展图标

范围：支持示例通过 Chrome 原生扩展图标打开 side panel。允许修改插件的 Manifest 路径重写、对应测试及相关公开能力文档；不得重构无关 API。

## 验收标准

- 合法的 `action: { default_title: '...' }` 无需提供 `default_popup`，可构建并通过 Manifest 验证。
- 路径重写不得向原本缺省的可选 Manifest 字段写入 `undefined` 属性；显式非法字段仍须报错。
- 原有 popup/source-entry 路径重写行为保留。
- 增加先失败后通过的回归，TypeScript、原有测试与覆盖率门槛通过。
- Network Rewrite 示例构建时无需使用空 popup 路径规避校验。

失败标准：要求用户设置虚假 popup、放宽显式非法值验证，或损坏既有页面路径重写。
