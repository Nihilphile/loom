# 首版验收记录

2026-10-08，Windows / Node 24.18.0 / Codex Desktop CLI 0.160.0。正式服务 http://127.0.0.1:4317。原型 http://127.0.0.1:4173 保留。

## 真实端到端

浏览器在 output/acceptance-project 创建自由会话，收到 HARNESS_READY。随后通过正式 UI 创建并运行 Graph 31ba343b-9264-44a4-b4f8-350670eff679。

| 执行 | 结果 | 工具调用 | 运行秒数 |
| --- | --- | ---: | ---: |
| A / worker | 生成 greeting.txt、CLI ready | 5 | 55.494 |
| A / reviewer | 独立验证、CLI approved | 4 | 55.961 |
| B / worker | 读取 A 成果、生成 verified.txt、CLI ready | 6 | 81.332 |

A 通过后 B 才启动，Graph 最终状态 done。Graph 基线中的 greeting.txt 为 Hello Harness 换行，verified.txt 为 VERIFIED 换行。汇总提交 96928a44f4a69385463f7fd42f901c870a9d1dc1。原项目 main 仍为 dea80a461d2ec45ebeb8e902234e3aaaf87685b1，未合并或推送。

这些秒数来自实际执行起止时间，包含 Codex 启动和退出；并发图的成员时间之和不等于图墙钟时间。Token 来自 App Server usage；费用未知，不推算美元价格。

服务停止并重新打开同一项目后，已完成 Graph、四个会话、报告和指标均可读取。浏览器验证了 Unit 详情、Debug、统计、自由/任务会话分区、创建草稿图、发送 Letter、发件筛选及 390px 窄屏无文档横向溢出。

浏览器首次发现 HTML pattern 连字符与 Unicode v 模式不兼容，修正转义后重新创建图通过。重启时的一条 SSE connection reset 是预期断线，重新连接成功；修正后没有新增页面脚本错误。Debug 检查脚本增加等待异步对话框，不改产品行为。

证据截图在 output/playwright/real-graph-complete.png、real-stats.png、real-mailbox.png、real-mobile.png；驱动脚本为 drive-real-session.js、drive-real-graph.js、drive-real-acceptance.js。output 为本机验证产物，不进入源码提交。

## 自动化及独立审查

最终检查通过：npm run typecheck；npm test（24 项通过，3 项真实模型测试默认跳过）；npm run build；git diff --check。三个 opt-in 模型测试本轮已另外启用并通过，不计入默认 24 项。

测试通过公开 API/CLI 观察报告与结束的区别、原会话返修、依赖门槛、软硬暂停、漏报上限、真实 CLI 回执、不可变报告、活动 steer、followup、完成后只读答疑、追加屏障、重启答疑恢复、控制器订阅和 Command Unit。Git 使用实际临时仓库验证合并冲突、重试及主分支不变。

默认测试不使用模型。三个显式开启的真实 runtime smoke 已分别通过，覆盖 thread 恢复、steer/中断和 Reviewer 报告目录权限；详见 runtime.md。整图真实执行在本报告单独验证，不能把协议假进程测试当成模型调用。

独立生命周期审查发现并修复七个问题：完成图来信重复启动、答疑中断导致任务重开、Command 来信重跑、暂停信件未续送、启动阶段 steer 滞留、解除阻塞越过暂停、待快照恢复卡住。对应关键回归加入 scheduler.test.ts。Git 无变更快照复用原提交，使只读审查可以核对候选版本。

Standards 审查统一格式、检查 shell 参数边界、清除两个多余或过度承诺的注释。Spec 审查按 docs/SPEC.md 核对，首版限制见下。

## 明确限制

共享 Task 工作区、Reviewer 新增测试权限、Graph 引用、已交付任务重开/下游失效及取消流程未开放。Task 内单入口、单活动成员；跨 Task 并行。规则编辑暂用 JSON。费用未配置价格表。Windows 已实测；其他平台权限行为未做真实验收。命令成员是用户配置的本地脚本，没有 Agent 沙箱的只读保证。

实现采用 Model the Domain，将 Execution、Submission 和 Delivery 分开；采用 Boundary Discipline，将 Codex 协议隔离在 Runtime 适配器。SQLite 保留状态与事件的一致提交，Git 使用稳定操作标识支持重试。
