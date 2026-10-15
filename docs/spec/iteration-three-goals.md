# 本轮三项目标任务书

本轮目标保持为完整自动验收流水线、Extension Doctor、Content Script 原地 HMR。三项均走验证路径 A，独立 Verifier 先建立失败用例，Implementer 不修改验证用例。

| 模块 | 允许实现范围 | 失败标准与验收 |
| --- | --- | --- |
| 自动验收流水线 | scripts/acceptance*.mjs、CI workflows、根 scripts、必要 CLI/模板修复 | [验收标准](acceptance/acceptance-pipeline.md) |
| Doctor | 插件 doctor/诊断模块、AST 来源报告、打包入口 | [验收标准](acceptance/extension-doctor.md) |
| Content HMR | 插件 dev/content runtime/client 与必要入口接入 | [验收标准](acceptance/content-hmr.md) |

公共 index.ts/package 配置变更串行协调，测试与全仓门禁由 Verifier 顺序执行。流水线实现与 Doctor 可并行；HMR 可先实现独立 client 生命周期模块，Doctor 完成 index/package 接入后再接开发服务。保留用户对 SPEC.md 的修改，不修改测试硬门槛，不提交或发布。

现有 AGENTS.md 的 full reload 说明是未启用新 HMR 时的兼容契约；新能力验收后同步公开边界。SPEC.md 中 E2E 的目标由对应模块验收文件明确为本仓库生成项目及扩展上下文，不引入其他项目路径。能力支持状态沿用矩阵枚举，任务报告单独使用 PASS/FAIL/BLOCKED。
