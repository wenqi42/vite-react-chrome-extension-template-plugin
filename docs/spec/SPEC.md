## 能力矩阵

能力状态以 `docs/acceptance-matrix + docs/features` 为来源。能力状态沿用矩阵枚举；任务验收结论使用 PASS、FAIL、BLOCKED。仅在独立验收通过后更新对应能力状态，BLOCKED 必须说明阻塞原因。

## 作业模式

遵循 TDD 的 spec coding模式。验收标准先于实现：
**路径A(纯函数，UI核心交互)**：Orchestrator 确定标准 → Verifier 编写用例并确认预期失败 → Implementer 实现 → Verifier 独立执行 → 失败反馈与修复 → 验收通过。UI／浏览器场景至少先确定操作步骤和可观察结果。
**路径B(UI非核心交互)**：Orchestrator 确定标准 → Implementer 实现 UI → Verifier 编写覆盖核心交互的单测 + E2E 功能验证 → 失败反馈与修复 → 验收通过。

- Orchestrator 写验收标准、范围和约束。
- Implementer 写具体实现，并提交验证方式和结果。
- Verifier 独立执行或复核检查，实现预期功能的测试代码，不修改业务实现，验证Implementer的具体实现。E2E 默认探索式执行；模块稳定后固化为 Playwright 脚本纳入回归

**以能力矩阵内容作为核心事实来源**
1. docs/acceptance-matrix.md：能力索引、支持状态、验收链接。
2. docs/features/：公开行为、用法和稳定限制。
3. docs/spec/acceptance/：具体任务可判定的验收条件。
4. 测试门禁以 [测试基准（硬约束）](#测试基准硬约束) 为基准。

### Orchestrator（main agent）


输入：用户输入本次需求、PRD、设计稿、`docs/acceptance-matrix + docs/features`核心来源。

输出：

1. 更新后的 `acceptance-matrix.md`。
2. 模块任务书，只含本模块的范围、允许修改的目录、失败标准。
3. 模块验收标准，写入 `docs/spec/acceptance/<module>.md`,未拆分前，功能验证以 `docs/acceptance-matrix + docs/features` 为准。
4. 判断当前改动需要走TDD模式还是e2e验证模式，并给出验证范围。

禁止：

- 自己实现功能的细节代码。
- 改写 [测试基准（硬约束）](#测试基准硬约束) 或模块验收标准。
- 替 Verifier 宣布验收通过。
- 在模块任务书中不标注验证路径，导致 Implementer 自行判断
- 纯功能函数，核心UI等内容禁止在 Verifier 未先确认预期失败的情况下，让 Implementer 先行实现。
- 在用户未要求时提交代码。

### Implementer（子 agent）

输入：模块任务书，只包含本模块所需上下文，必要时可做简单的自测验证。

输出：根据需求和标准实现代码，并根据反馈的检测结果，循环迭代直至完成目标，提交实现说明及运行既定用例的自测结果，要留下可被 Verifier 执行的交互结果；block 功能需标注原因。

禁止：

- 改写 能力矩阵 或模块验收标准。
- 读取其他模块中与本任务无关的实现来扩大改动。
- 不得修改、删除、跳过或弱化 Verifier 编写的验证用例、断言和测试配置
- 无缘由的标注 BLOCKED，除非有充分事实基础。

### Verifier（独立子 agent）

输入：[测试基准（硬约束）](#测试基准硬约束),能力矩阵、对应模块验收标准和运行测试效果，测试验证路径

权限：
- 路径 A：不读取实现代码
- 路径 B：可读取实现代码以确认接口和调用方式

输出：逐条返回全部验收条件的结论和证据（通过、失败或无法判断，并附截图、日志或断言结果），由 Implementer 修复后重新验收

禁止：
- 书写无效用例
- 不满足 [测试基准（硬约束）](#测试基准硬约束) 要求就通过
- 不得将代码细节作为验收结论的依据。


## 注意事项
1. 功能开发和行为修复执行完整流程；纯讨论、只读审查、拼写和格式调整使用简化流程。无法使用独立子代理时，应明确披露验证限制
2. 参与实现的代理不能担任该模块的独立 Verifier
3. 认为用例有误时，提交理由，由 Verifier 复核；涉及标准变化时由 Orchestrator 确认


## 测试基准硬约束

### Typecheck、Eslint与 Vitest
```bash
pnpm run lint
pnpm run test
pnpm run typecheck
```

### 覆盖率规则
- 核心逻辑（纯函数、状态转换、业务规则）：> 90%
- UI 组件 必须包含核心UI检测逻辑，不做强制覆盖率要求
- 生成代码、类型声明、配置文件：不计入

覆盖率为硬门禁，但 Review 阶段需抽查测试质量：是否存在只断言“函数被调用”而不检查返回值的测试用例，或者虚假的、 obviously wrong 的测试实现

### E2E功能测试 触发规则

Orchestrator 给出本轮验收标准后，Verifier 用 Playwright 在 `apps/wise-demo` 上按标准操作。输出应包含通过或失败、操作路径和证据。探索式验证连续稳定后，再把成功路径收成可重复的 Playwright 用例

- 模块完成/变更时必跑
- 采用 **探索式执行**：Verifier 按验收标准中的流程图操作，不依赖固定脚本

### 准出定义

一个模块“完成”当且仅当：
1. 以下命令全部通过：
   - `pnpm run lint` 无报错
   - `pnpm run typecheck` 无报错
   - `pnpm run test` 通过；仓库原有失败不计入本次验收，但不得新增失败
2. Verifier 报告无“无法判断”条目
3. Orchestrator 更新 能力矩阵 目标功能状态为“已完成”
