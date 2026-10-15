# CASE-17：打包与生成项目自动验收

状态：现有。自动验收从 CLI 和插件的真实 npm tarball 创建外部项目，检查生成配置、构建产物和 Chrome 扩展运行。它不需要全局 `npm link` 或发布 npm 包。

## 矩阵与命令

完整矩阵为 CSS/Less/Sass × ESLint 开关 × Prettier 开关 × Vite 5/6/7，共 36 个独立项目。

```bash
npm run test:acceptance -- --list --json
npm run test:acceptance -- --chrome /path/to/chrome-for-testing
```

可用 `CHROME_PATH` 提供 Chrome 路径。先列出 case ID，再选择某个组合：

```bash
npm run test:acceptance -- \
  --case <listed-case-id> \
  --chrome /path/to/chrome-for-testing \
  --report .cache/acceptance/selected.json \
  --keep
```

`--case` 可以重复。指定组合的结果只代表对应组合；发布验收运行无筛选的完整矩阵。

## 每个项目检查什么

1. 从 tarball 安装 CLI，在仓库外的空目录生成项目。
2. 从本轮插件 tarball 安装插件，并安装指定 Vite 主版本；拒绝以 symlink 代替插件安装。
3. 执行 typecheck/build；启用 ESLint 才执行 lint，启用 Prettier 才执行 format:check。关闭工具时检查它没有意外安装。
4. 检查 Manifest 与输出资源引用闭合，为产物计算 SHA256 标识。
5. 在独立 Chrome for Testing profile 中加载 unpacked 扩展，检查 popup/options、worker、消息响应、加载状态及运行异常。

浏览器验收使用真实 `chrome-extension://` 上下文。HTTP 预览不替代扩展加载、权限、CSP 或 worker 验证。

## 报告与资源

默认报告为 `.cache/acceptance/report.json`，旁边的证据目录保留 tarball、SHA256、每阶段命令、退出码、安装锁文件、浏览器版本、上下文和截图。单项目失败后继续收集其余项目，整轮仍以非零退出。读取结果时同时检查完成时间、运行范围、case 数量和各阶段状态。

默认清理外部临时项目与浏览器 profile；`--keep` 保留生成项目供复查。证据目录保留用于排查失败。运行需要网络访问 npm 依赖，以及可执行的 Chrome for Testing。

## CI 与本地门禁

仓库 workflow 包含质量门禁、36 项生成项目矩阵和已有开发 reload/网络改写浏览器回归，上传诊断证据。远端执行由仓库 CI 触发，本地可运行相同命令：

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run test:acceptance -- --chrome /path/to/chrome-for-testing
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
npm run test:network-rewrite -- --chrome /path/to/chrome-for-testing
```

具体准出条件见 [流水线验收标准](../spec/acceptance/acceptance-pipeline.md)，支持状态见 [能力矩阵](../acceptance-matrix.md)。
