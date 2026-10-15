# 自动验收流水线

验证路径：A。模块核心规划、失败传播和报告先由独立 Verifier 编写失败用例；浏览器交互先明确操作与观察结果。

## 范围与所有权

Implementer 负责打包、矩阵执行与 CI 调度代码，允许修改 `scripts/acceptance*.mjs`、`.github/workflows/`、根 package scripts，以及为通过真实生成项目检查所必需的 CLI/模板修复。不得修改 Verifier 的测试、断言和浏览器探针。

Verifier 负责该模块的单元验证、浏览器验收探针与报告检查。公开文档由 Orchestrator 维护。全仓门禁与其他模块构建输出顺序执行。

## 验收条件

1. 提供根 `test:acceptance` 命令，可列出矩阵、运行全部或指定 case；无筛选时覆盖 CSS/Less/Sass × ESLint 开关 × Prettier 开关 × Vite 5/6/7，共 36 个独立 case。
2. 使用本仓库 CLI 与插件的真实 `npm pack` 产物，在仓库以外的空目录安装并生成项目。不使用全局 npm link，不从仓库源码或父级 node_modules 隐式解析插件。
3. 每个 case 实际安装依赖、运行 typecheck/build；启用 ESLint 时执行 lint，启用 Prettier 时执行 format:check。关闭的工具不强制安装或执行。校验产物引用闭合。
4. 每个 case 在真实 Chrome for Testing 中加载 unpacked extension，检查 popup/options 渲染、background 注册与请求响应，确认无新增运行时异常。报告 Chrome 版本和上下文。不得以 HTTP 预览代替。
5. 声明支持的 Vite 5/6/7 全部有真实通过证据；矩阵、依赖版本、检查命令、退出码、阶段、产物标识和证据文件可机器读取，失败不能汇总为成功。
6. 单 case 或单阶段失败须返回非零，报告失败阶段；支持在不中断其余 case 的情况下收集失败，最终总结果仍失败。资源关闭、临时目录清理与保留证据行为明确。
7. 配置自动 CI：lint、typecheck、测试与覆盖率，以及完整生成项目矩阵和已有 reload/网络改写浏览器回归；失败上传诊断证据。本地可执行同样的脚本，不要求当前会话推送或触发远端 CI。
8. 根门禁全部通过，核心新增逻辑覆盖率 >90%，既有权限推导、可选工具、样式和 reload 契约保持。

失败标准：只列举组合、不安装运行；仅链接本地源码；仅测生成文件存在；筛选结果冒充全矩阵；失败退出码被吞掉；以单一 Vite 版本代表所有支持版本。
