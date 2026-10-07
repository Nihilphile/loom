# 可操作的真实本地 Web 工作台

承接 SPEC R01–R04、R05–R09 的查看和操作，以及 R12–R16 的交互入口。依据 0.3 原型建立正式 UI，读取共享领域类型和 HTTP 契约，不内置模拟计时、假费用或假运行结果。项目选择、自由会话创建/发送、Task 会话分区、图创建/运行/暂停、成员记录、报告、Mailbox、模板与统计应有可用入口。未实现服务能力明确标记，不生成假成功。

验收：生产构建通过，在真实服务器与浏览器操作核心闭环；错误可见，窄屏可用，Git 内部元数据仅 Debug。只修改 web/ 与相关构建配置，API 变化先联系主控。输入：docs/architecture.md、src/shared/types.ts、prototype/harness-prototype-v0.3.html。
