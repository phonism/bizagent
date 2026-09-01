# ADR 0002：UI 是 DSH Client 插件，不进入 Learning Kernel

状态：Accepted
日期：2026-08-29

## 决策

BizAgent UI 使用 DSH `dsh.client` 机制发布，通过标准 UI slots 组合进 Web 应用。Host 侧另设
`@bizagent/dsh/ui-host` Cordis row，提供有版本的 Web adapter；核心 `@bizagent/dsh` row 保持与界面技术无关。

## 原因

GrowthOS 的核心是 Agent Home、多级 Memory、单 Agent 自进化和多 Agent 组织协作。React 页面不是领域核心，
不能成为 Home 持久化或学习闭环的依赖。DSH 已经提供 Client 插件发现、模块加载、slot composition、locale 与 theme，
BizAgent 应复用这些机制，而不是注入静态页面、fork Web App 或运行独立前端服务。

## 后果

- Headless 环境仍可使用完整 learning kernel；
- Web UI 可以独立演进，不改变 Home schema；
- Host API 成为明确的兼容边界，需要版本化和输入校验；
- UI 暂时只支持 DSH Web profile；
- 将来拆成独立 npm package 时，可以移动 UI row 与 Client bundle，而无需重写核心。
