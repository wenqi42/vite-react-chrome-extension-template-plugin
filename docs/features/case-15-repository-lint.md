# CASE-15：仓库 ESLint

## 使用

在仓库根目录安装依赖后执行：

```bash
npm run lint
npm run lint:fix
npm run test:lint
```

`lint` 检查源码，存在错误或警告时以非零状态退出。`lint:fix` 应用 ESLint 可自动修复的规则。ESLint 9 工具链要求 Node.js 18.18 或更高版本。

依赖继续通过 `npm install` 或 `npm ci` 安装，使用现有 npm workspaces 与 `package-lock.json`。也可使用 `pnpm run lint` 等脚本命令；根 `pnpm-workspace.yaml` 仅设置 `verifyDepsBeforeRun: false`，防止 pnpm 11 在运行脚本前自动重新安装依赖，不声明新的 workspace 或 pnpm lockfile。

## 检查范围

根 `eslint.config.js` 使用 flat config，检查 JS、MJS、TS、TSX：

- 根配置和维护脚本；
- 插件、CLI 和测试；
- CLI 模板源码与可选工具配置；
- 示例项目及浏览器脚本。

依赖、构建输出、覆盖率和工具缓存不参与检查。Node 脚本使用 Node globals；示例和模板的浏览器源码使用浏览器 globals 与只读 `chrome`。

JavaScript 使用 ESLint recommended，TypeScript 使用 typescript-eslint recommended。保留现有 Chrome 协议数据、Manifest 和测试 mock 中的显式 `any`，关闭 `@typescript-eslint/no-explicit-any`；未使用变量等其余推荐检查保留。TypeScript 名称与类型检查继续由 `typecheck` 完成。

## 验证

独立验证依据[验收条件](../spec/acceptance/repository-lint.md)，检查正常源码、错误检出、目录覆盖、忽略规则及命令退出码。验证脚本会创建并清理临时源码探针，应与 lint、构建及类型检查顺序执行。

当前独立验收通过：16 项 lint 行为检查通过，npm/pnpm 命令均能保留错误退出码；类型检查、原有测试和既定核心覆盖率门槛通过。本能力不改变扩展运行行为，不要求重复 Chrome/CDP 矩阵。

```bash
npm run test:lint
npm run lint
npm run typecheck
npm test
npm run test:coverage
```

该配置用于仓库开发。CLI 生成项目的 ESLint 仍由 `--eslint` 独立选择。
