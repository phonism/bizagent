# 变更日志

本文件记录 BizAgent 规范的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。
本规范遵循 `Draft v0.x` → `v1.0` 生命周期；草案阶段预期会有破坏性改动。

**语言**：[English](./CHANGELOG.md) · [**中文**](./CHANGELOG.zh-CN.md)

## [Draft v0.1] — 2026-05-26

首个公开草案。**给 Code Agent 的 BizAgent build 规范**——schema、API、算法、接口，足以让 Code Agent（Claude Code、Cursor、Devin…）端到端搭出一个 BizAgent 平台。

- §1 项目布局——要生成的目录树
- §2 记忆子系统——SQL DDL、4 层模型、清单同步 API、Worklog、Knowledge、Recap 引擎、Consolidation 引擎
- §3 监控子系统（Pulse）——DDL、指标 YAML schema、5 种规则、调度 tick、原子认领 CAS、调查流程、insight 输出规则、失败与重试
- §4 运行时原语——Wakeup 引擎、Monitor 引擎
- §5 适配器——AgentRunnerAdapter、AsyncQueryAdapter、StorageAdapter（TypeScript 接口）
- §6 符合性测试——M1–M7、P1–P7、W1–W5
- §7 特化指南——common/domain 知识、workspaces、指标、技能、UI
- 附录 A——设计原理（可选）
