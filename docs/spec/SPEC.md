
## 能力矩阵

能力状态以 `docs/acceptance-matrix + docs/features` 为来源。能力状态沿用矩阵枚举；任务验收结论使用 PASS、FAIL、BLOCKED。仅在独立验收通过后更新对应能力状态，BLOCKED 必须说明阻塞原因。

## 作业模式

遵循 TDD 的 spec coding模式。验收标准先于实现：
Orchestrator 确定标准 → Verifier 编写用例并确认预期失败 → Implementer 实现 → Verifier 独立执行 → 失败反馈与修复 → 验收通过。UI／浏览器场景至少先确定操作步骤和可观察结果。

- Orchestrator 写验收标准、范围和约束。
- Implementer 写具体实现，并提交验证方式和结果。
- Verifier 独立执行或复核检查，实现预期功能的测试代码，不修改业务实现，验证Implementer的具体实现。

**以能力矩阵内容作为核心事实来源**
1. docs/acceptance-matrix.md：能力索引、支持状态、验收链接。
2. docs/features/：公开行为、用法和稳定限制。
3. docs/spec/acceptance/：具体任务可判定的验收条件。

### Orchestrator（main agent）


输入：用户输入本次需求、PRD、设计稿、`docs/acceptance-matrix + docs/features`核心来源。

输出：

1. 更新后的 `acceptance-matrix.md`。
2. 模块任务书，只含本模块的范围、允许修改的目录、失败标准。
3. 模块验收标准，写入 `docs/spec/acceptance/<module>.md`,未拆分前，门禁以 `docs/acceptance-matrix + docs/features` 为准。

禁止：

- 自己实现功能的细节代码。
- 替 Verifier 宣布验收通过。
- 纯功能函数，核心UI等内容禁止先 Implementer实现，再由 Verifier 独立验证。
- 在用户未要求时提交代码。

### Implementer（子 agent）

输入：模块任务书，只包含本模块所需上下文，必要时可做简单的自测验证。

输出：根据需求和标准实现代码，并根据反馈的检测结果，循环迭代直至完成目标，提交实现说明及运行既定用例的自测结果，要留下可被 Verifier 执行的交互结果，block功能需要标注原因。

禁止：

- 改写 能力矩阵 或模块验收标准。
- 读取其他模块中与本任务无关的实现来扩大改动。·
- 不得修改、删除、跳过或弱化 Verifier 编写的验证用例、断言和测试配置
- 无缘由的标注 BLOCKED，除非有充分事实基础。

### Verifier（独立子 agent）

输入：能力矩阵、对应模块验收标准和运行测试效果，UI代码等必要验证材料。

输出：逐条返回全部验收条件的结论和证据（通过、失败或无法判断，并附截图、日志或断言结果），由 Implementer 修复后重新验收

禁止：
- 降低或者不参照测试标准
- 书写无效用例
- 参照代码实现细节而不是功能标准来伪造覆盖率


## 注意事项
1. 功能开发和行为修复执行完整流程；纯讨论、只读审查、拼写和格式调整使用简化流程。无法使用独立子代理时，应明确披露验证限制
2. 参与实现的代理不能担任该模块的独立 Verifier
3. 认为用例有误时，提交理由，由 Verifier 复核；涉及标准变化时由 Orchestrator 确认
