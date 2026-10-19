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
任务图中的一个工作节点。所有前置 Task 成功集成后才能启动，从固定的 Graph 当前集成 HEAD 创建独立执行工作区。工作流验收后还需排队集成，成功发布才完成。

**集成分支（Integration branch）**：
Graph 专用的 Git 分支，首次运行固定项目已提交 HEAD 为初始起点，每次 Task 集成验证通过后推进。它可以包含无 DAG 依赖关系的已交付成果，不自动更新项目原分支。

**执行起点（Start commit）**：
Task 创建工作区之前固定的 Graph 集成 HEAD，保存在 `Task.startCommit`。活动工作区不随 Graph 集成分支推进。

**候选（Candidate）**：
程序在安全边界固定的源提交。经过 TaskType 配置验收后才能进入交付队列，队列绑定这一不可变提交。它区别于实际合并后发布到 Graph 的集成提交。

**交付（Delivery）**：
将已验收候选合并、验证并发布到 Graph 集成分支的操作及持久记录。`TaskDelivery` 关联固定源提交、验证证据和发布回执；Task 只有发布成功才完成。`Task.deliverySha` 记录源提交，实际集成提交由发布回执标识。暂停后编辑未交付 Task 会把旧记录标为 `superseded` 并保留历史，新候选产生新交付。

**交付队列（Integration queue）**：
每个 Graph 串行处理候选的持久队列。Task 使用 `merge_queued` 和 `integrating` 表示等待与处理中，追加 Task 的 `queued` 仍表示追加屏障。一次交付失败不阻塞独立队列项。

**集成验证（Integration validation）**：
在隔离工作区的真实合并结果上执行 Graph 创建时配置的命令。通过后才发布，未配置命令也明确记录。TaskType 的 Command Unit 检查属于工作流验收，不代替此验证。

**任务类型（TaskType）**：
跨项目复用的可执行工作流配置，定义 Task 的 Unit 组成、成员模板、调度规则、完成条件与运行限制。具体 Task 提供目标、依赖及必要覆盖，运行时使用配置快照。

**成员模板（Agent Template）**：
单个 Agent Unit 的默认模型、reasoning、skills、权限和基础指令配置，与描述成员之间如何协作的 TaskType 分开。

**执行单元（Unit）**：
Task 内可独立配置的工作成员或执行单元。Agent Unit 有自己的角色配置与会话，Unit 也可以不调用模型。

**工作流包（Workflow pack）**：
组织工作方法的 Skills、Agent 模板、TaskTypes、提示词和报告约定集合，例如 loom-matt、loom-pstack。安装、选择或设为项目默认只影响可用选项；用户显式调用后才向主控会话加载工作方法。生成的 Task 使用明确配置，不在执行时隐式读取当前默认包。

**调度器（Scheduler）**：
根据依赖、运行状态和 TaskType 规则决定何时运行哪个 Unit 的程序。属于 Loom 内部能力，不是 Task 成员或图节点。

**执行准备（Preparation）**：
每次 Unit 执行前解析配置并组装上下文的内部能力。首次会话准备模型、reasoning、权限、Skills、初始 prompt 和输入材料；续跑沿用已接受配置并准备增量输入。运行器每次仍须应用实际权限和运行参数。准备完成不代表输入已经投递。

**成员配置（Unit Config）**：
Unit 的模型、reasoning、Skills、权限和会话策略等声明。区别于运行器实际接受的配置快照；模板修改不自动修改已有 Task 或会话。

**成员上下文（Unit Context）**：
初始 prompt、任务说明、报告、文件、信件和本轮指令的来源配置，以及每次实际发送的内容与接收状态。信件内容按收件地址注入，不因准备阶段而改变收件人。

**侧边对话（Side conversation）**：
与源 Agent 关联的只读讨论会话。独立上下文分支是当前建议方案，分叉边界及是否回传由侧聊契约明确；不能隐式修改源 Task、收取源 Agent 的信件或接管其交付职责。

**执行成员（Worker）**：
Task 中负责实现目标并提交工作成果的 agent 成员。
_Avoid_: Coder

**审查成员（Reviewer）**：
Task 中负责审查候选成果的 agent 成员。Task 配置 reviewer 后，提交必须经过其审查通过。

**调查成员（Explorer）**：
Task 中负责调查项目、回答问题并提供调查报告的 agent 成员。
