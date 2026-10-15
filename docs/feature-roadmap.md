# Feature roadmap

本文档说明当前库提供的能力、公开边界和后续方向。它面向使用者和维护者，不记录实现过程。

## 产品组成

| 模块 | 能力 |
| --- | --- |
| Vite plugin | Manifest V3、页面发现、background/content source entry、权限推导、WAR、Tailwind 和开发 reload |
| CLI/template | React + TypeScript 模板、popup/options/background、CSS/Less/Sass、可选 ESLint/Prettier |
| AI guides | 插件接入、模板创建、构建验证和运行时验收指南 |

## 已支持能力

- MV3 Manifest 生成、常用字段校验和本地引用诊断。
- `defineManifest` 对象、Promise 和 Vite 环境工厂。
- `modules/*/index.html` 页面发现，以及 popup/options/sidepanel/devtools 映射。
- `defineBackground` 稳定编译 background 输出；字符串路径和 `public/background.js` 仍兼容。
- content script source entry 编译为 standalone IIFE；可关闭 standalone 模式交给项目自行管理。
- CSS、静态资源和动态 chunk 的 WAR 自动收集与用户配置合并。
- `defineDynamicResource` 动态资源占位符。
- Babel AST 权限推导、显式权限合并、未知 namespace warning 和 `autoPermissions: false`。
- Tailwind CSS 4 集成和独立 PostCSS 配置支持。
- `vite dev` 构建到暂存目录，成功后原子发布并自动 reload。
- React 与原生 DOM 示例，以及 CLI 的 CSS/Less/Sass、ESLint/Prettier 组合。
- 网络改写示例：side panel 规则管理、当前标签页主动 debugger 附加、响应 header/body 改写，带命中和失败反馈及独立 Chrome/CDP 验收。

## 开发 reload 契约

`liveReload` 默认为 `true`，只在 Vite serve 阶段生效。

- 页面及独占依赖变化：刷新扩展页面。
- background、content script、Manifest 或共享依赖变化：重载扩展。
- 失败构建：保持最后一次成功目录，不发送 reload。
- 服务器同 host/port 重启：客户端重连并同步 session；地址变化需要重新加载扩展。
- Chrome 116+：开发 worker 使用 20 秒 WebSocket 心跳。
- 正式构建：不包含 reload client、开发 host permission 或开发 CSP。

这是真实的完整 reload，不保留组件状态，也不替换已注入到宿主网页的 content script。

## CRXJS 对标状态

| 能力 | 状态 |
| --- | --- |
| Manifest 驱动构建 | 已支持 |
| 多页面与路径回写 | 已支持 |
| Background source entry | 已支持 |
| Content script IIFE 与资源图 | 已支持 |
| WAR 自动生成 | 已支持 |
| Manifest/reference diagnostics | 已支持 |
| 页面和 background 自动 reload | 已支持 |
| Content script 原地 HMR | 未支持，刷新宿主网页后生效 |
| 保留状态的页面 HMR | 未支持 |
| Firefox target | 未支持，当前以 Chrome MV3 为目标 |
| 完整 Chrome schema 校验 | 未支持 |
| 自定义 CRXJS hooks | 未支持 |

## 后续方向

1. Content script 的可释放更新机制，覆盖 isolated world 和 MAIN world。
2. 页面状态保留的 HMR 适配。
3. 更完整的 Manifest 类型和 schema diagnostics。
4. 动态 content script 注册与更多框架 fixture。
5. 可选 Firefox target 和 browser polyfill。
6. 将网络改写示例扩展为规则集导入导出、请求阶段改写和更细粒度的响应类型策略。

每个后续能力都需要同步 API 类型、测试、模板验证、公开文档和 Chrome runtime 证据后再标记为支持。

## 相关文档

- [CRXJS 对标](crxjs-compatibility.md)
- [验收矩阵](acceptance-matrix.md)
- [Content script 编译](features/case-03-content-script-entry.md)
- [WAR 资源图](features/case-04-web-accessible-resources.md)
- [Background verifier](features/case-05-background-verifier.md)
- [开发自动 reload](features/case-06-extension-auto-reload.md)
- [Content script 边界](features/case-07-content-reload-boundaries.md)
- [框架无关 fixture](features/case-13-framework-agnostic.md)
- [Network rewrite sidebar](features/case-14-network-rewrite-sidebar.md)
