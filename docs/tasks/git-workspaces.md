# 隔离代码成果与自动 Git 快照

承接 SPEC R10、R11。实现冻结的 Git workspace 接口：固定起点创建 graph worktree、从 graph 起点创建 task worktree并合并依赖提交、自动快照、汇总已验收成果到 graph 基线。参数使用 spawn argv，不拼 shell。报告路径与运行元数据不进入代码快照。

验收：临时真实仓库并行分支合并、冲突保留、快照重试、最终成果文件正确，项目主分支和用户原工作目录不变。只在托管目录操作，不自动清除冲突或丢弃用户改动。输入：docs/architecture.md、src/shared/types.ts。
