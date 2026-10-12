# Home 文件归档与恢复

`bizagent archive` 为 DSH Home **文件层**生成可校验目录归档。它保存 Organization、Home、Identity、
Memory、Insight、Knowledge、Method，以及已保留的 Worklog、Work、Project 结果和学习批次前后文件快照的原始字节，并在 `home-archive.json` 中记录每个相对路径的
长度、SHA-256 和整体清单摘要。导出目标必须是新目录；工具先写同级 staging，校验后再改名。

```sh
cd packages/dsh
npm run build
node lib/cli.js --root /path/to/organization-home-root archive export /path/to/home-archive-v1
node lib/cli.js archive verify /path/to/home-archive-v1
node lib/cli.js --root /path/to/new-empty-home-root archive import /path/to/home-archive-v1
node lib/cli.js --root /path/to/new-empty-home-root doctor
```

导入只接受**尚不存在**的目标目录；先核对完整文件清单和 SHA-256，再复制到同级 staging，用
`HomeStore` 加载并运行 doctor，全部通过后才提升为目标目录。导出和验证拒绝符号链接、非普通文件、
路径穿越、额外文件及内容变化。重试时另选版本化目标目录，不覆盖已经完成的归档或恢复目录。
`.bizagent-writer.lock` 与短暂的 `.bizagent-writer-claim.lock` 是运行时守卫，导出时排除，归档清单也不接受它们；恢复目录不会继承旧进程的锁。

此归档**不包含** DSH `storageDomain` 中的 Session binding、Worklog、Inbox、proposal、receipt、
Work、Project、审阅与检查点，也不包含 DSH Session 正文、Workspace 文件、模型配置或凭据。复制 Home
文件本身不能恢复这些运行状态；Worklog、Work、Project 与学习快照也需要对应的账本才能建立来源关系。此归档不能当作
完整 DSH profile 备份或跨运行时迁移成功证明。完整恢复还需由
DSH 宿主保存相应 profile 存储和 Session 数据，并核对其版本、来源、所有权与可读性；恢复后将目标
Home root 显式配置给新的 DSH profile，再逐项验证账本和来源。不要在运行中的 profile 下直接换根目录。

`home-archive.json` 的 `kind` 固定为 `bizagent-dsh-home-files`、`schemaVersion` 为 1。该格式只承诺
DSH Home 文件层的字节和完整性，不把 Claude 包的产品线/业务目录自动映射为 DSH Home，也不把没有
原始 Session 的外部记录冒充已验证的 DSH 学习。
