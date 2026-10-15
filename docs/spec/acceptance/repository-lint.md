# 仓库 ESLint 接入

## 范围

在仓库根目录接入 ESLint，提供可直接运行的 `lint` 命令。保留现有 npm workspaces 和 lockfile 管理方式。

Implementer 允许修改根 ESLint 配置、`package.json`、`package-lock.json`，以及被规则检出的源码问题。源码修改必须保持现有行为，不进行无关重构或格式化。公开文档由 Orchestrator 同步。验证用例及验证脚本归独立 Verifier 所有。

## 验收条件

1. 根目录 `npm run lint` 和 `pnpm run lint` 均可执行，现有受检源码无 ESLint error；命令不得隐藏或吞掉失败退出码。
2. 使用适配当前 TypeScript 的 ESLint flat config。检查根配置、`packages/`、`examples/`、`scripts/` 下的 JS、MJS、TS、TSX 源码，包含测试、生成器模板源码和浏览器运行脚本。
3. 排除依赖目录、构建输出、覆盖率和临时缓存；不得通过忽略整个业务目录或全局关闭规则获得通过。
4. 验证无效 JavaScript、未声明的 JavaScript 变量和未使用的 TypeScript 变量会产生非零失败结果；验证正常 Node、浏览器、Chrome API 和 TSX 源码可接受。
5. 必要的兼容规则例外须明确说明作用和范围；不以大规模类型重构或新增格式风格约束扩大本次任务。
6. Verifier 在实现前提交验证用例并确认预期失败；Implementer 不得改动这些用例、断言或测试配置。最终由 Verifier 独立执行并逐条报告结论。
7. 遵守现有 spec 的 lint、test、typecheck 与核心覆盖率门槛，不修改其标准；不得新增原有测试失败。

## 失败标准

- 仅在生成模板中配置 ESLint，仓库自身没有可运行的 lint。
- lint 实际漏检约定范围内的源码，或命令无论检查结果如何均返回成功。
- 为了通过检查修改业务行为、弱化验证用例，或忽略整个示例、测试、模板目录。

## 报告

报告实际命令、检查结果、依赖版本、兼容例外和未验证边界。该变更不涉及扩展运行行为，无需重复浏览器运行时矩阵。
