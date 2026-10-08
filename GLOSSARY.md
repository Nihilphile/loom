# Loom

供用户个人在本地使用的 Codex agent 工作台。用户可直接与 agent 对话，也可创建任务图并启动按依赖执行的任务。

## Language

**项目（Project）**：
用户通过 harness 开展工作的本地项目，包含项目文件，以及属于该项目的 agent 会话和任务图。

**会话（Agent session）**：
通过 harness 在某个项目中运行的 agent 会话。会话是需要保留记录的工作过程。

**任务图（Task graph）**：
由任务节点及其依赖关系组成的有向无环图，可由 agent 创建。用户启动任务图后，harness 根据依赖关系自动派发 agent 执行任务。

**任务（Task）**：
任务图中的一个工作节点，其执行需要遵循图中声明的依赖关系。

**任务类型（TaskType）**：
跨项目复用的可执行工作流配置，定义 Task 的 Unit 组成、成员模板、调度规则、完成条件与运行限制。具体 Task 提供目标、依赖及必要覆盖，运行时使用配置快照。

**成员模板（Agent Template）**：
单个 Agent Unit 的默认模型、reasoning、skills、权限和基础指令配置，与描述成员之间如何协作的 TaskType 分开。

**执行单元（Unit）**：
Task 内可独立配置的工作成员或执行单元。Agent Unit 有自己的角色配置与会话，Unit 也可以不调用模型。

**执行成员（Worker）**：
Task 中负责实现目标并提交工作成果的 agent 成员。
_Avoid_: Coder

**审查成员（Reviewer）**：
Task 中负责审查候选成果的 agent 成员。Task 配置 reviewer 后，提交必须经过其审查通过。

**调查成员（Explorer）**：
Task 中负责调查项目、回答问题并提供调查报告的 agent 成员。
