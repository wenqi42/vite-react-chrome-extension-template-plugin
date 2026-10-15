# CRXJS compatibility

本项目参考 CRXJS 的 Manifest 驱动构建和开发体验，同时保留自己的权限自动推导、Tailwind 集成和 CLI 模板。

## 对标矩阵

| 能力 | 当前状态 |
| --- | --- |
| Manifest source/helper | 已支持：`defineManifest` 对象、Promise、factory |
| 多页面入口与路径回写 | 已支持：页面发现、Manifest 引用回写 |
| Background 编译 | 已支持：`defineBackground` 和稳定输出 |
| Content script 编译 | 已支持：source entry、standalone IIFE、CSS/资源依赖 |
| WAR 自动生成 | 已支持：按 matches 合并和去重 |
| 动态资源 helper | 已支持：`defineDynamicResource` |
| 页面自动 reload | 已支持：成功构建后刷新页面 |
| Background 自动 reload | 已支持：worker/content/Manifest 变化重载扩展 |
| Content script HMR | 未支持：宿主网页刷新后生效 |
| 状态保留页面 HMR | 未支持 |
| Firefox target | 未支持 |
| browser polyfill | 未支持 |
| 自定义 CRXJS hooks | 未支持 |

当前对标完成范围覆盖核心构建、资源、诊断、CLI 和页面/worker 自动 reload。CRXJS 的 content script 原地 HMR、状态保留 HMR、Firefox 目标和商店发布能力不在当前默认支持范围内。

## 保留的增强能力

- 使用 Babel AST 推导 `chrome.*` / `browser.*` namespace 权限。
- 显式权限与推导权限去重合并，`autoPermissions: false` 可完全关闭。
- 默认 Tailwind CSS 4，并保留传入的 PostCSS plugins。
- CLI 提供 React + TypeScript、ESLint/Prettier 和 CSS/Less/Sass 选择。
- 原生 DOM fixture 验证 plugin runtime 不依赖 React。

## 开发行为

`liveReload` 默认开启。插件先在暂存目录完成 watch build，再原子更新 `build.outDir`：

- 页面独占变化刷新页面。
- worker、content script、Manifest 或共享依赖变化重载扩展。
- 构建失败保留最后成功产物。
- 相同 host/port 的 Vite 重启会重新连接；端口变化需重新加载扩展。

这是真实 reload，不是保留状态的 HMR。content script 仍需刷新宿主网页。正式构建不包含开发 reload client、host permission 和 CSP additions。

## 后续兼容工作

1. 为 isolated world 和 MAIN world 设计可释放的 content script 更新机制。
2. 增加状态保留的页面 HMR 适配。
3. 扩展 Manifest 类型和 schema diagnostics。
4. 评估动态 content script、Firefox target 和 browser polyfill。

每项兼容能力都需要公开 API、focused tests、模板验证和真实浏览器证据；没有这些证据时保持“未支持”。
