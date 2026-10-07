# task-graph 前代设计审查

2026-10-08。本文是迁移建议，不是已确认的新 harness 规格。

审查对象是本地 `D:/文档/ChatGPT/画板/task-graph` 的 skill、操作手册和源码。只读检查，没有运行真实审查、通知、Git 合并或性能测试，也未修改前代项目及当前 HTML 原型。

## 总体判断

前代以任务要求、依赖、责任登记和交付记录为中心，由主控或外部环境组织普通执行，并为 review 增加专门的自动执行器。它不是纯静态看板，但也不是新项目要求的统一执行运行时。

新 harness 必须持续管理 Graph run、Task、并列 Unit、session、工具调用、消息投递、工作区和恢复。应保留前代已经发现的可靠性约束，重新确定模型与运行机制，不能把旧流程作为新核心的默认规范。

本次采用 Redesign from First Principles 原则：从可执行图与并列 Unit 的需求出发，评估旧能力是否合适，而不是在旧 Task 状态机上继续增加分支。

## 三层边界

| 层 | 负责什么 | 新项目中的例子 |
| --- | --- | --- |
| 基础能力 | 不论选择什么工作流，都必须正确执行和记录的机制 | 身份与运行实例、依赖校验、执行与取消、并发占用、权限执行、session 续用、状态与事件持久化、文件引用与版本、逐收件人投递、产物绑定、拒绝过期结果、工作区操作 |
| 可执行工作流配置 | 这次工作采用哪些条件、顺序和处理规则；由程序落实 | 提交后启动哪个 Unit、哪些审查是完成条件、返修回到谁、是否续用 session、何时要求人工输入、最大轮数、哪些通知唤醒主控、选取哪些上下文 |
| Skill 与模板指令 | Agent 如何理解任务、采取方法和表达成果 | 如何探索、编码与审查，报告写法，public / to-audit / handoff 约定，何时建议请求主控裁决 |

同一能力可以跨三层组成。例如，skill 指导 reviewer 进行检查；工作流要求指定 reviewer 的通过结果；底层校验提交者、运行身份和交付版本，并保证条件未满足时不能完成 Task。不能用“已在 prompt 中要求审查”代替程序门禁。

权限也是如此：模板保存默认配置，运行时执行边界，skill 提醒写入纪律。角色名称本身不应授予权限。

## 主要迁移风险

### 1. 具体工作流已经进入公共 Task 生命周期

前代将 `pending_review`、`reviewing`、`pending_human`、`pending_merge`、`reject` 纳入统一 Task 状态；`completeTask` 直接处理 HITL、review 和 worktree merge；公共修改函数也判断这些阶段并产生特定通知。

证据：[Task 状态](D:/文档/ChatGPT/画板/task-graph/src/core/task.ts:8)、[完成入口](D:/文档/ChatGPT/画板/task-graph/src/core/lifecycle.ts:196)、[公共修改逻辑](D:/文档/ChatGPT/画板/task-graph/src/core/mutate.ts:49)。

这方便旧工具维护固定的交付流程。但新 Task 中可能同时存在探索、实现、验证和通信，不宜用某个成员的阶段代表整个 Task。reviewer 本轮要求修改也不必使整个 Task 成为失败或外部阻塞状态。

建议：区分 Task 的整体生命周期、各 Unit 的运行情况、审查结论和未满足的完成条件。UI 可以显示“等待审查”这一可读摘要，但不必为每种工作流向核心状态枚举追加一个状态。程序按明确配置执行门禁，不根据成员恰好名为 reviewer 就硬编码整个流程。

### 2. 单个 Task 的领取身份无法代替运行实例和并发控制

前代每个 Task 保存一个 claim，绑定 session，executionId 是补充；claim 不自动过期。review 则有专门执行器，每次启动新的 `codex exec`，没有项目级 review 并发限制。

证据：[领取](D:/文档/ChatGPT/画板/task-graph/src/core/claims.ts:55)、[审查调度](D:/文档/ChatGPT/画板/task-graph/src/core/review-runner.ts:29)、[进程启动](D:/文档/ChatGPT/画板/task-graph/src/core/review-runner.ts:112)。

这些机制适用于主控登记普通执行者、工具另行派出 reviewer。新系统的一个 Task 有多个 Unit，Command Unit 没有 agent session，同一个 session 还可能承载返修和来信处理。

建议：分别标识成员、运行实例或 attempt、turn、可选 session。运行时统一控制启动、占用、停止与预算，reviewer 使用同一执行能力。归属责任可另行记录，不能拿责任登记直接当进程锁，也不能用 session ID 判断一个迟到结果是否仍然有效。

前代已有 review_id 和 worktree attempt，不应说它完全没有执行身份；需要补足的是新系统中一致的 Graph/Task/Unit 运行模型。

### 3. 文件索引值得保留，固定报告体系不宜继承

前代有材料路径、实际读取路径、摘要、读者范围、快照和 SHA；上下文可以先给索引，正文按需读取。这与 Letter 正文引用文件的方向兼容。

证据：[上下文材料](D:/文档/ChatGPT/画板/task-graph/src/core/task-context.ts:49)、[文件与快照](D:/文档/ChatGPT/画板/task-graph/src/core/documents.ts:127)。

但旧系统固定了 content、review-requirement、report、log、handoff 等输出类型，reject 强制附非空 Markdown error-report。材料选取还包含特定依赖和报告分发规则。

证据：[输出类型](D:/文档/ChatGPT/画板/task-graph/src/core/task.ts:63)、[审查拒绝所需报告](D:/文档/ChatGPT/画板/task-graph/src/core/review.ts:187)。

建议：底层提供文件引用、来源、读取范围和可选版本快照；报告名称、章节和复盘方法交给 skill。哪些结果必须附哪些证据，由工作流配置表达并由程序校验。记录进程崩溃或工具错误不能先等待 agent 写完一份复盘。

另外，旧文件路径规则以统一项目根为边界。跨 worktree 交付需要明确正文文件属于哪个工作区、接收方如何读取以及引用哪个版本，不能只复制一段相对路径。

### 4. 旧引用节点是聚合视图，新引用节点是执行调用

旧 `graphRefs` 根据被引用图当前任务是否完成，计算引用节点的状态；不会创建新的子图执行。被引用图重新打开时，聚合完成状态可以改变。

证据：[引用状态计算](D:/文档/ChatGPT/画板/task-graph/src/core/graph-model.ts:22)、[聚合历史](D:/文档/ChatGPT/画板/task-graph/src/core/graph-events.ts:26)。

建议：保留依赖、环检测及完成条件的概念。新引用节点绑定目标图定义，并记录自己实际启动的子 Graph run、输入和返回成果。重复执行同一引用不能共享上次完成状态。父子取消和阻塞传播需要新规则，不能默认沿用旧图聚合。

### 5. 旧 worktree 机制与当前约定的合并路线不同

旧 Task worktree 从图当前分支建立；`markMerged` 检查固定交付已经被外部合入图分支，再登记完成，它不是自动执行依赖合并的函数。

证据：[Task 工作区起点](D:/文档/ChatGPT/画板/task-graph/src/core/worktrees.ts:157)、[固定交付校验](D:/文档/ChatGPT/画板/task-graph/src/core/worktrees.ts:188)、[登记已合并](D:/文档/ChatGPT/画板/task-graph/src/core/merge.ts:13)。

建议：保留固定提交 SHA、工作区身份、HEAD 漂移检查等机制。按新约定重新实现“下游按依赖结果准备输入工作区”，记录实际依赖版本、合并顺序及冲突。旧“回图集成分支后才算 done”是一种交付流程，不能暗中取代用户已选的路线。

### 6. 通知可靠性有价值，订阅语义和 Desktop 传输不能混成核心

前代在任务结果事务中记录待发通知，按订阅去重，区分 pending、accepted、uncertain 等投递状态，也明确 accepted 不代表模型消费。这些约束值得借鉴。

证据：[通知登记](D:/文档/ChatGPT/画板/task-graph/src/core/watch.ts:92)、[投递与恢复](D:/文档/ChatGPT/画板/task-graph/src/core/watch.ts:147)。

但订阅数据直接绑定 Desktop 程序和配置，事件类型固定为 pass、reject、blocked、warning、merge_ready、human_ready。通知内容还嵌入具体 CLI 恢复和主控推进指令。

证据：[订阅模型](D:/文档/ChatGPT/画板/task-graph/src/core/watch.ts:15)、[通知生成](D:/文档/ChatGPT/画板/task-graph/src/core/watch.ts:105)。

建议：运行时记录真实发生的变化；订阅规则决定谁收到、哪些变化值得唤醒、如何合并重复提醒；session 或 Desktop 适配器负责交付。主控如何判断返工、重试或继续，是配置与 skill 的职责。

前代“进入 blocked 通知，持续 blocked 不重复”可以作为默认策略参考。基础能力应保留阻塞及其变化的事实，不能因为默认不提醒就丢掉后续信息。订阅时是否返回当前阻塞清单、是否重放历史，都应作为明确选择，而不是前代行为自动成为新规范。

### 7. 接手修复不应等同于外部障碍已经解除

旧 `beginBlockedRepair` 在接手时将 Task 变为 in_progress，把当前手工阻塞原因清空并归档，同时重新检查依赖和细化条件。这适合表示“执行者现在负责尝试解决问题”，并没有证明那些障碍已经消失。

证据：[接手修复](D:/文档/ChatGPT/画板/task-graph/src/core/repair.ts:12)。

建议：新运行时区分开始诊断、尝试修复、解除某项阻塞和恢复正常执行。主控已接手、收到回复、session 被唤醒都不能单独证明 merge 冲突已经消失或依赖输入已经可用。是否需要单独的修复状态可以继续讨论，但这些动作的效果不能混淆。

### 8. 旧存储与视图更新路线不宜直接承担逐次工具调用

前代普通修改会在项目锁内重新读取任务仓库、重写 Task Markdown，成功后再生成全量 JSON 和离线 HTML；Task history 也随文档序列化。

证据：[修改路径](D:/文档/ChatGPT/画板/task-graph/src/core/mutate.ts:38)、[提交后构建](D:/文档/ChatGPT/画板/task-graph/src/core/mutate.ts:67)、[构建流程](D:/文档/ChatGPT/画板/task-graph/src/core/build.ts:36)。

建议：保留“权威记录和可重建视图分开”的思想；将任务配置、运行事件、工具输入输出和报告内容按用途组织。Web UI 的刷新不应要求每个 tool call 都走离线 HTML 全量构建。具体存储选型应由记录量、恢复目标与实际验证决定。

本次没有测性能，不能声称旧存储已经慢，也不能据此断言必须使用某种数据库。事务实现可以回滚普通异常，但不能把它等同于跨文件的崩溃原子性。

## 保留、改造和不默认引入

| 处理 | 能力 |
| --- | --- |
| 保留原则 | readiness 与执行 blocked 分开、文件索引与可选快照、固定交付、旧轮次防回写、结果与待发记录的一致性、逐次投递记录、通知接收不等于已处理 |
| 重新实现 | 统一 Unit 运行器、定义与运行分离、子图执行、依赖版本合并、session 生命周期、记录和统计、进程恢复、调度与订阅 |
| 变成工作流配置 | review 门禁、返修路由、是否需要 HITL/refine、上下文选取、通知筛选、预算与轮数、结果汇合流程 |
| 交给 skill | 规划方法、实现与审查方法、报告结构、复盘内容、主控的分析判断 |
| 第一版不默认引入 | GitHub 发布、离线 HTML 构建链路、前代专属 CLI 地址语法、强制 error-book、单独的 reviewer 执行器、多图 AND 聚合作为子图调用语义 |

## 对当前 0.2 原型的同一标准

原型目前按 `templateId === worker/reviewer` 调度完成和返修，这是为了展示用户选定的默认场景。它不能直接成为正式调度器架构。

证据：[原型模拟执行](F:/AI_project/new-harness/prototype/harness-prototype-v0.2.html:68)。

正式实现应将这些行为表达为可执行工作流配置，底层校验身份、版本、权限及完成条件。用户已认可的“有 reviewer 必须通过、默认原 session 返修”保留为所选默认工作流，不因分层而取消。

此前参考前代得出的状态变化通知建议，仅是可借鉴的一项机制，不意味着应移植其完整状态枚举、报告类别、主控流程或 Desktop 实现。
