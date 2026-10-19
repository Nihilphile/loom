# Unit 执行准备与侧边对话

状态：2026-10-08 架构决策。用户已确认独立只读侧聊及复用侧聊的自动访谈，并授权实施。访谈不进入源 Agent 的 context。本文件记录执行契约；输入接收、独立会话及访谈收集已实现，真实运行验收单独记录。

## 使用方式

用户在自由会话中显式调用 `$loom-matt` 或 `$loom-pstack`，与主控讨论任务。安装工作流包、选择它或设为项目默认，都不自动注入工作流指令。调用规划 Skill 本身也不授权运行 Graph。主控生成具体 TaskType、Unit Config 和 Context 后，Loom 按这些配置执行。

Graph 只显示 Task 和依赖。打开 Task 后显示 Unit。每个 Unit 有 Config、Context、运行记录和收发件箱。Task 的调度规则由 TaskType 提供，放在 Task 配置中。Scheduler 与 Preparation 是内部能力，不成为图节点或额外 Agent。

```text
Task 调度规则选中 Unit
    → 会话执行入口
        → Preparation 解析配置并准备输入
        → Runtime 启动或继续会话
        → 保存输入接收记录
    → 执行正常结束且交卷有效后，由 Task 调度规则决定下一步
```

例如 worker 首次执行时收到角色、Skills、任务说明和指定材料。reviewer 交回新报告后，worker 的原 session 收到返修指令及尚未接收的报告，不重新注入整套角色说明。上游发给下游的 Letter 在下游获准启动时进入其输入。

## 职责与所有权

| 部分                 | 职责                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| Workflow pack        | 提供工作方法、Skills、成员模板、TaskTypes、上下文选择和报告约定                 |
| Scheduler            | 根据依赖、暂停、并发限制、显式结果和规则决定运行谁                              |
| Preparation          | 解析 Unit 配置、加载明确指定的资源、组装本次输入，区分初始化与增量              |
| 会话执行模块         | 管理准备记录、已接受配置、会话输入记录及投递确认，统一启动与 steer 的准备逻辑   |
| Runtime              | 应用执行参数和权限，调用底层运行协议，返回接收、拒绝、未知及结束事实            |
| Mailbox              | 保存发送者、收件人、文件内容快照和逐收件人的投递视图                            |
| Engine／ProjectStore | 独占权威状态写入，事务保存会话接收记录及相关投递事实，控制 Task 状态与 Git 操作 |

会话执行模块拥有会话准备规则，不拥有另一份数据库或独立写事务。它通过 Engine 的一个事务入口提交状态变更。Mailbox 的“已投递”由接收记录推导，不能另有一个可以独立更新的已投递标志。

Preparation 不决定应该采用 Matt 或 pstack，不选择信件收件人，不代写交接报告，也不根据自然语言判定任务完成。工作流给出明确配置与材料选择，Loom 校验和执行。最小 CLI 使用说明属于平台帮助，不等于启用某个工作流。

Task 的 Git 工作区准备由 Engine／Git 执行。所有前置 Task 已成功集成后，程序固定 Graph 当前集成 HEAD 并创建独立工作区，可能包含已集成的独立 Task。它不在启动时另合并依赖列表，与每次 Unit 输入准备是两个职责。工作区状态展示在 Task 信息中。

TaskType 的 finish 只将验收后的不可变候选交给每 Graph 串行集成队列。程序在隔离工作区合并并验证实际结果，通过后才推进 Graph 分支、完成 Task 并放行下游。Command Unit 的工作流检查不能代替合并后验证。交付记录区分输入接收、报告、候选快照和实际集成提交，完整契约见 [实施规格 R10、R11](SPEC.md)。Agentic 子会话仍需先完成或处置其写入成果，不能绕过外部审查或直接交付到 Graph。

## Unit Config 与 Context

Config 声明模型、reasoning、Skills、权限及会话复用策略。Context 声明初始 prompt、任务说明、指定文件、报告来源和本轮输入。配置和上下文来源来自 Task 保存的版本快照，不能在运行中悄悄读取更新后的模板或默认工作流。

Context 选择器是数据，例如任务说明、指定依赖的交付报告、上一次调度结果、指定文件。工作流选择哪些来源对该 Unit 可见。Core 不因角色叫 worker 或 reviewer 而硬编码材料选择。待收 Letter 根据明确地址和投递方式进入输入。

每个来源保存身份、版本或内容摘要、引用路径和实际传入的内容。报告和 Letter 使用绑定时的固定内容。Skill 记录引用路径、使用的内容版本及加载方式；源文件后来改变，不得覆盖旧输入记录。相同报告通过多个引用进入同一次输入时可合并正文，但保留各 Letter 的发送者、用途和独立回执。

| 场景             | 配置与输入                                                       |
| ---------------- | ---------------------------------------------------------------- |
| 新 session       | 解析模型等配置；加载角色、Skills、目标、选定材料、待收信件       |
| 原 session 续跑  | 沿用已接受配置；加入本轮指令、新报告、新信件和显式变更           |
| 返修／再审       | 默认原 session；传入新的审查或实现结果                           |
| 正常结束但漏报   | 原 session 只补充交卷提醒及需要的新材料                          |
| 暂停后修改任务   | 把新版本目标或配置的实际内容作为变更输入，不能只更新 UI 提示     |
| 显式新建 session | 重新完整初始化；历史 Letter 不自动全部重投，需要的旧材料显式引用 |
| 活动会话 steer   | 针对确定的当前 turn 准备增量输入；不在 steer 中改变模型或权限    |
| 已交付任务答疑   | 沿用原 session 的上下文，但本次执行降为只读且无交卷权            |

“配置通常只在首次运行时决定”不代表后续进程可以省略配置。Runtime 每次仍须应用有效 model、reasoning、工作目录、权限及新执行凭据。临时只读答疑不覆盖原工作 session 的长期配置。

首次初始化以“初始化输入得到运行时确认”为准。仅创建 Loom session、拿到 threadId、返回进程 handle 都不足以证明初始化完成。显式删掉一个 Skill 不能擦除模型历史中已读的内容；需要干净上下文时，应显式新建 session。

Command Unit 仍是非 LLM 执行单元。它准备命令、工作目录和输入，不加载模型、角色或 Agent Skills。命令输出进入独立执行记录。

## 会话执行接口草案

领域类型已定义在 `src/shared/types.ts`。当前 SessionInputs 集中纯输入构建、增量来源选择、接收确认与信件占用；Engine 的 launch 负责预留执行权、启动 Runtime 和原子持久化。以下伪代码说明确认顺序。

调用方只提交执行意图及当前配置，不手动串联多个 preparation 步骤。

```ts
const handle = sessions.start({
  executionId,
  target,
  intent,
  definition,
  sources,
});
const [acceptance, completion] = await Promise.allSettled([
  handle.accepted,
  handle.done,
]);
engine.finishExecution(executionId, { acceptance, completion });

await sessions.inject({ executionId, turnId, instruction, letters });
```

`start` 在 Engine 已预留该 session 的执行权后调用。准备过程中能被暂停取消，运行器 handle 可在接收输入前返回，以支持启动期中断。`accepted` 与 `done` 是独立事实；调用方必须同时处理失败，不能因前者失败而遗留未回收的进程。`inject` 校验当前执行身份和暂停状态，复用相同输入组装规则。

```ts
type SessionBinding =
  | { kind: "uninitialized"; provisionalThreadId?: string }
  | { kind: "initialized"; threadId: string; config: ResolvedConfig };

type Preparation = {
  id: string;
  executionId: string;
  sessionId: string;
  mode: "initialize" | "continue" | "steer";
  config: ResolvedConfig;
  inputs: ResolvedContextItem[];
  instruction: string;
  receipt:
    | { status: "prepared" | "dispatching" }
    | { status: "accepted"; threadId: string; turnId: string }
    | { status: "rejected"; reason: string }
    | { status: "uncertain"; reason: string };
};
```

`ResolvedConfig` 包含有效设置与显式配置版本。`ResolvedContextItem` 包含来源身份、版本、正文或原生资源引用。每次 Preparation 的配置和输入在派发后不可修改；其 receipt 由状态所有者推进。继续 session 的已接收来源集合从成功回执得出，准备过程中的候选来源不算已消费。

Runtime 返回领域内的传输事实，例如接受的 thread／turn、明确拒绝或结果未知，不返回 Task 的完成动作。会话执行模块据此产生输入回执，再由 Engine 原子保存。执行凭据单独传给 Runtime，不写入 Context 预览或可公开的准备快照。

## 确认、暂停与恢复

- 解析失败时记录具体配置或资源错误，阻止该次派发，保留待收输入。Task 是否阻塞由 Engine 处理。
- 保存待派发记录后才能产生外部效果。收信、初始化状态和配置接受状态在真实 `turn/start` 或 `turn/steer` 确认后统一推进。
- 输入得到确认后，即使模型随后失败或被中断，也不把该输入改回未投递。
- 接收回执表示运行时接受，不代表模型已经阅读、理解或遵从内容。
- 同一 session 的启动、排队消息和信件不能形成两个并发 turn。派发期间已占用的 Letter 不能又通过 steer 重投。
- 软暂停阻止新的派发和信件注入；已经接受的执行可正常结束。硬暂停还要等待实际中断。晚到的回执更新对应旧执行，不能误更新新执行。
- 发送后确认丢失，或进程崩溃导致接收状态不明，保留 uncertain 并停止自动重发。只有可靠运行历史能消除不确定性，否则通过显式恢复处理。不承诺跨 Runtime 与 SQLite 的 exactly-once。
- 交卷回执、输入接收、执行结束和 Task 完成各自独立。普通信件不会隐式触发交付、解除阻塞或恢复写权限。

## 界面呈现

Unit 的 Config 显示声明配置、已接受配置和待生效的显式修改。Context 显示初始输入来源及每次增量，区分“待发送”“已组装”“运行时已接收”“拒绝”和“结果未知”。可以展开查看实际内容，不能把配置预览标为已注入。

准备失败就显示在该 Unit 上。内部 preparation 不占一张成员卡，不显示在 DAG 中。调度规则仍可在 Task 的配置中检查。运行记录保留每个 Unit 的独立时间、tool calls 和 input／cached input／output tokens。

## 只读侧边对话

已确认自由会话及 Task Agent 都能打开独立只读侧聊。入口位于 Sessions 和 Task Unit 详情。

侧聊持有独立 session，记录来源 session、来源 Task／Unit、分叉 turn 和时间。源 Agent 正常运行。侧聊的 turn、上下文接受记录和 token 单独统计，不计为源 Unit 的交付执行，也不消费原 Agent 的待收信件。

优先使用运行时原生会话分叉以继承对话和工具历史。当前本地生成的 Codex 0.160.0 协议支持 `thread/fork` 的 `lastTurnId`，且明确该 turn 不能处于运行中。默认取最近已完成 turn，并在 UI 显示边界；尚无可分叉轮次时明确显示不可用，不静默把文本拼接冒充完整分叉。是否另提供“只带选定材料的新对话”，作为独立功能再决定。

对话分叉只固定会话历史，不冻结正在变化的项目文件。侧聊读取实时文件时应标明这一点，不能宣称读取的是分叉时的代码快照。源 Agent 后续输出也不自动追加到已有侧聊。

只读约束必须覆盖文件和控制接口。侧聊可以读允许的代码和报告，不能写项目文件、写报告文件、交卷、发信、启动或修改 Graph，也不能调用外部写操作工具。Loom 自己保存侧聊历史属于平台持久化，不给侧聊 Agent 文件写入权。既有 Skill 指令和继承的任务目标不能提升权限或自动继续源任务。

仅设置文件系统只读或删除 HARNESS_TOKEN 不够。目前本地 HTTP 有其他写接口。侧聊进程禁用 shell、网络、Apps、插件、hooks 和原生子代理，枚举并禁用继承的 MCP，只启用 Loom 受限只读 MCP。它没有可以直接访问 HTTP／CLI 的执行工具。MCP 服务校验读取目录和文件；Runtime 检查实际沙箱与启用的 MCP 列表，不满足限制就拒绝启动。源任务凭据不得继承；恢复侧聊也维持限制。

侧聊不自动发结果给主控或源 Agent。用户可以自行复制结论。若后续增加“发送到原会话”，这是用户显式操作，需要独立权限和目标选择，不能成为侧聊 Agent 的写能力。

## 开发者自动访谈

自动访谈复用独立只读侧聊，不是 Task 的新 Unit。由程序提出配置中的访谈问题，可针对工程摩擦、工具摩擦、工作流或其他关注点。分类、追问方式与报告约定属于访谈配置或 Skill，不硬编码进调度器。

开发者选项默认关闭。首版提供可编辑访谈 prompt、可选模型／reasoning／Skills、Task 完成或阻塞触发、手动访谈入口。每次触发固定来源执行及上下文边界，同一事件不重复访谈。只访谈已具有可分叉上下文的源 Agent，不能因访谈失败阻塞或恢复原 Task。访谈不触发新的自动访谈。

访谈问题、回答及追问只进入访谈 session。源 session 的输入、信件投递和调度状态均不变化。Loom 保存访谈结果到项目意见箱，并关联来源 Graph／Task／Unit／session、访谈会话、触发原因及状态。访谈 Agent 没有写报告、发信或提交反馈文件的权限，收集由程序完成。

开发开销单独标识。侧聊和访谈 tokens 计入真实项目消耗，但不重复计为源 Unit 的执行消耗。意见箱保留原始回答，不要求模型一定输出固定分类；失败和取消应有可见状态，不伪装为成功反馈。

## 设计选择与当前差距

按 Model the Domain 原则，显式区分会话初始化、准备记录、运行时接收和执行结束。选用候选 B 的统一会话执行入口与不可变输入记录，内部采用候选 A 的确定性 preparation builder。所有持久化变更仍经 Engine／ProjectStore 的单一事务入口。不引入独立 session 数据库、泛用插件管线或新调度 agent。

候选 A 直接由 Engine 协调纯 builder，改动较小，但调用方仍需同时理解初始化、配置确认和信件占用。候选 B 由会话执行模块集中处理这些知识，接口较深，但初稿的 permits、独立 Mailbox 模块和领域 Admission 暴露给 Runtime 都过重。本方案保留其会话边界，移除这些额外接口。独立评审五项评分为 A 21/25、B 22/25，比较项为生命周期、工作流分离、接口深度、上下文可观察性和原型复杂度。

当前 SessionInputs 根据已接受记录去重来源，Engine 只在真实输入接受后确认初始化与信件投递。Unit 页面显示 Config／Context 及准备快照，不再显示 Preparation 成员卡。运行时使用原生分叉；侧聊和访谈有自己的 session 与执行统计。只读侧聊不开放运行中 steer，用户可以排队或在本轮结束后追问。

内置 TaskTypes 明确选择目标、依赖报告和上一份结果。Task 创建时固定模板配置与 Skills；后续模板变更不影响已有 Task。已接受的 Skill 内容在原配置版本内复用。配置预览和真实接收快照分别呈现。

本项目处于原型阶段。本次目标契约直接替换旧形状，不设计旧字段别名、双执行入口或旧准备状态的迁移适配。无需兼容旧原型，不等于删除用户项目源文件或把未知执行标为成功。

## 实现与验收顺序

1. 增加真实输入接受契约，验证返回 handle／threadId 不消费上下文，拒绝和未知可区分。
2. 集中首次、续跑和 steer 的 preparation；把 accepted config、来源记录和 Mailbox 投递纳入同一持久化事务。
3. 替换旧组装路径和 Unit 数据契约，验证返修只注入新报告、目标变更真正传到模型、漏报提醒不重跑初始化。
4. 更新 Unit Config／Context 界面，验证暂停、重启、准备失败和投递未知的可见状态，移除独立 Preparation 卡。
5. 实现原生分叉和能力隔离，验证源 Agent 持续运行、历史边界清楚、所有写入口被拒绝、统计不重复计入原 Unit。
6. 实现开发者访谈配置、事件去重和意见箱，验证默认关闭、访谈不回注、不递归触发、失败不影响原任务。

验证还须覆盖新 session 完整初始化、模板更新不影响旧 Task、显式 Skill 调用、准备期间到信、接受后失败不重投、未知接收不自动重放，以及 Command Unit 无 LLM 初始化。
