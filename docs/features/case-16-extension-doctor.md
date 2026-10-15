# CASE-16：Extension Doctor

状态：现有。Doctor 检查已构建的 Chrome MV3 扩展，输出可读诊断或 JSON 报告。它提供常见配置和资源诊断，不是完整的 Chrome schema 校验器。

## 使用

安装插件后，可以在扩展项目中运行：

```bash
npx chrome-extension-doctor --dist dist
npx chrome-extension-doctor --dist dist --json
```

仓库维护者使用：

```bash
npm run doctor -- --dist examples/basic-extension/dist --json
```

`--root` 指定项目目录，`--dist` 相对于该目录解析。静态与开发服务检查需要 Node.js 18+；Chrome CDP 诊断需要 Node.js 22+ 的内置 WebSocket。

## 检查范围

- Manifest 的常见 MV3 字段、扩展页面 CSP 和本地资源引用。
- HTML、JavaScript 静态导入、worker/content script、CSS 中可确定的本地引用。
- 构建产物中的权限，以及插件生成的权限来源证据。
- 可选的开发服务状态：revision、building、错误、连接地址与输出目录。
- 可选的 Chrome 扩展加载、worker/page 上下文、注册错误和运行时错误。

```bash
npx chrome-extension-doctor \
  --dist dist \
  --dev-url http://localhost:5173 \
  --json

npx chrome-extension-doctor \
  --dist dist \
  --cdp http://localhost:9222 \
  --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --json
```

使用 `--timeout-ms` 调整请求超时。CDP 检查连接到已启动且开放远程调试的 Chrome，不代替加载 unpacked 扩展。Doctor 不修改项目、权限、Chrome 配置或已有标签页；它会关闭自己创建的诊断标签页。

## 报告与退出码

JSON 包含 `ok`、`issues`、`checks` 和 `permissions`。每个 issue 包含稳定的 `code`、`level`、`message`、`hint`，可以附带 `field` 或 `file`。存在 error 时退出码为非零；warning 不单独导致失败。未请求的 dev/CDP 检查标记为 skipped，不能当作运行时通过。

权限报告区分最终 `actual`、显式 `explicit`、AST 推导 `inferred` 和手动配置的 `hostPermissions`。来源读取 `chrome-extension-diagnostics.json`，与构建产物一起检查。来源不可用时明确警告，不把未知权限归类为显式或推导。证据来自参与构建的模块；`autoPermissions: false` 仍关闭自动补充，host 权限仍由用户管理。

## 限制与验证

无法静态确定的运行时 URL、任意脚本生成的路径和完整 Chrome schema 不在静态诊断保证范围内。无活动 worker 时，Doctor 不会把声明了 background 的扩展判定为运行时通过；可先在 Chrome 扩展管理页唤醒并检查 worker 后重新诊断。诊断反映当前构建目录和浏览器状态，不是持续监控。

```bash
npx vitest run packages/vite-plugin-chrome-extension/test/doctor.vitest.ts
node scripts/doctor-smoke.mjs --chrome /path/to/chrome-for-testing
npm run test:coverage
```

具体准出条件见 [Doctor 验收标准](../spec/acceptance/extension-doctor.md)，支持状态见 [能力矩阵](../acceptance-matrix.md)。
