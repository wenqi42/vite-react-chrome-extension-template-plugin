# Extension Doctor

验证路径：A。独立 Verifier 先依据公开 CLI 与报告契约编写失败用例，再实现；真实 Chrome 与开发服务器诊断另做 E2E。

## 范围与所有权

Implementer 负责插件包的 `doctor.ts`、所需独立诊断模块、权限来源报告，以及 package bin/exports/files/build 配置。可对 index.ts 的 AST 权限信息收集与输出做最小扩展，保持现有 API 和推导规则。

Verifier 负责测试、测试 fixture、诊断场景和覆盖率配置。公开文档由 Orchestrator 维护。不得修改用户的 spec 或既有验收标准。

## 公开入口

- 插件包提供 `chrome-extension-doctor` 可执行文件。
- 根目录提供 `doctor` script。
- 支持 `--root <project>`、`--dist <directory>`、`--json`。
- 支持可选 `--dev-url <origin>` 检查开发服务，和 `--cdp <endpoint> --extension-id <id>` 检查已加载的 Chrome 扩展。
- JSON 至少包含 `ok`、`issues`、`permissions`、`checks`；issue 包含稳定 `code`、`level`、`message` 和可操作 `hint`。不以日志文本作为机器接口。

## 验收条件

1. 合法产物成功退出；缺失/损坏 Manifest、本地引用缺失和明确不合法 MV3 CSP 返回非零；无 background 的合法扩展不因该项报错。sandbox CSP 与 extension_pages CSP 分开判断。
2. 检查 Manifest、HTML、worker/content 及资源引用，给出字段/文件位置和修复提示；路径、URL 和带空格目录正确处理。不把常用诊断描述为完整 Chrome schema 验证。
3. 报告产物 permissions、显式配置与 AST 推导来源（文件、API）；构建活跃模块的推导证据与未使用源码区分。保留显式权限合并、host 权限手动管理和 `autoPermissions: false`。
4. 开发服务可达时诊断 revision/building/error、连接信息与输出目录；不可达、构建失败或目录不一致有明确错误和提示，网络请求有超时。
5. 可连接 Chrome 时识别指定扩展及实际 worker/page 上下文，报告加载/注册/运行错误和 CSP 问题；扩展未加载、worker 注册失败、CDP 不可达不能报告通过。未请求运行时诊断时清楚标记未执行。
6. 诊断不修改项目、Manifest、权限、Chrome 配置或已有标签页；只清理自己创建的临时诊断资源。
7. npm pack 后在外部项目实际执行该 bin，类型声明、exports、files 与依赖完整；文本/JSON 两种输出与退出码一致。
8. 全仓门禁通过，新增核心逻辑覆盖率 >90%；Verifier 逐项报告真实静态、开发服务、Chrome 和打包入口证据。

失败标准：仅转发旧 verifier 却声称具备开发/运行诊断；把候选源码扫描当活跃构建来源；无背景 worker 一律报错；诊断失败仍 `ok: true`；缺少真实 Chrome/外部打包入口验证。
