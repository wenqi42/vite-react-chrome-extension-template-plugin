# Acceptance matrix

本矩阵定义发布前需要验证的行为。状态使用：`现有`、`部分支持`、`待实现`、`不支持`。

## 质量门槛

| 项目 | 标准 | 命令/证据 |
| --- | --- | --- |
| TypeScript | 源码、脚本、CLI、插件、测试和示例无 error | `npm run typecheck` |
| ESLint | 仓库 JS/TS/TSX 源码无 error，独立验证检出能力 | `npm run lint`；[验收标准](spec/acceptance/repository-lint.md) |
| Unit tests | CLI、Manifest、资源图、reload 核心路径通过 | `npm test` |
| Coverage | lines/functions/statements/branches 均 ≥90% | `npm run test:coverage` |
| Build artifacts | Manifest、页面、worker、content script、CSS/WAR 引用闭合 | `npm run verify:extension -- --dist <dist>` |
| Template | ESLint/Prettier 四组合，CSS/Less/Sass 三种样式可生成和构建 | 外部空目录验证 |
| Chrome runtime | unpacked extension 可加载，页面/worker/content 无新增异常 | Chrome for Testing + CDP |
| Documentation | README、skills、API 类型和 feature 文档一致 | 文档审阅 |

## 功能状态

| ID | 功能 | 状态 | 验收 |
| --- | --- | --- | --- |
| BASE-01 | MV3 Manifest 生成 | 现有 | plugin tests + verifier |
| BASE-02 | Manifest 合并和优先级 | 现有 | deep merge、显式覆盖、权限去重 |
| BASE-03 | 页面发现 | 现有 | popup/options/sidepanel/devtools |
| BASE-04 | background source entry | 现有 | `defineBackground` + worker 文件 |
| BASE-05 | content script IIFE | 现有 | 无顶层 ESM import |
| BASE-06 | WAR 资源图 | 现有 | CSS、资源、动态 chunk 和用户 WAR |
| BASE-07 | AST 权限推导 | 现有 | 显式权限、unknown namespace、关闭开关 |
| BASE-08 | Tailwind/PostCSS | 现有 | 默认注入和 `tailwind:false` |
| BASE-09 | CLI 安全创建 | 现有 | 非空目录、非法参数、取消输入 |
| BASE-10 | 可选工具与样式 | 现有 | ESLint/Prettier × CSS/Less/Sass |
| DEV-01 | 页面自动 reload | 现有 | page-only source edit |
| DEV-02 | worker/extension reload | 现有 | background/content/Manifest edit |
| DEV-03 | 失败构建保护 | 现有 | syntax error、late write error、public 删除 |
| DEV-04 | worker heartbeat/reconnect | 现有 | 36 秒 idle、同端口重启 |
| DEV-05 | Content script 原地 HMR | 待实现 | 需要 host 无刷新 fixture |
| DEV-06 | 状态保留 HMR | 不支持 | 后续方向 |
| DEV-07 | Firefox target | 不支持 | 后续方向 |
| APP-01 | Network rewrite sidebar fixture | 现有 | 示例 15 项回归 + Chrome/CDP 20 项检查；真实 SIDE_PANEL、Fetch/XHR、header/body 改写及失败回退，见 [验收标准](spec/acceptance/network-rewrite.md) |

## 必跑命令

```bash
npm run lint
npm run test:lint
npm run typecheck
npm test
npm run test:coverage
npm run build:example
npm run build:vanilla-example
npm run verify:extension -- --dist examples/basic-extension/dist --json
npm run verify:extension -- --dist examples/vanilla-extension/dist --json
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
npm run build:network-example
npm run verify:extension -- --dist examples/network-rewrite-extension/dist --json
npm test --workspace @example/network-rewrite-extension
npm run test:network-rewrite -- --chrome /path/to/chrome-for-testing --headed
```

## 运行时边界

- Chrome 开发者模式必须开启；命令行首次加载不等于 reload 权限已验证。
- HTTP 页面预览不等于扩展 runtime 验收。
- 整扩展 reload 会关闭已有扩展页面，页面状态不会保留。
- content script 更新后需刷新匹配的宿主网页。
- `world: 'MAIN'` 只验证构建 fallback，不代表 MAIN world HMR 已支持。
