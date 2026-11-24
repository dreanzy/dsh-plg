# 诊断回灌用三个发现来源、一个去重键

## 背景与决定

`dsh-lsp-actions` 注册了 8 个 `lsp_*` 工具，语言服务器也配好了，但近两周 264 个会话、27911 次工具调用中一次没被调用。缺的不是能力，是触发：模型不会主动想起来调。因此本包不做提醒，做**回灌**——改完代码后自动把诊断送进模型上下文。

发现「哪些文件变了」没有单一可靠来源。原生 `write`/`edit` 走 `ctx.fs.writeText`，紧跟 emit `fs/observed`；`dsh-ops` 的 `ops_write_file`/`ops_edit_file` 在独立 worker 进程里写盘，只 best-effort emit `fs/observed`；`bash`/`pwsh` 改文件完全不经文件 seam。

决定：并行使用三个发现来源，以「绝对路径 + 内容版本」作为唯一去重键——写入类工具的返回、`fs/observed` 观测、`git status` 差分。

## 考虑过的替代方案

**文件 watcher 覆盖全部写入。** 否掉：能覆盖 bash 与 MCP，但每个会话一份 watcher、大仓库 IO 与 `node_modules` 噪音，外部编辑器保存还会误触发。为剩余的一成场景付全仓库的账。

**解析 bash 命令文本。** 否掉：重定向、`sed -i`、脚本内部写、`python -c` 全都会漏，只覆盖最简单的一类。

**只挂 `write`/`edit` 两个工具。** 否掉：本机 `ops_write_file` 4619 次、`ops_edit_file` 976 次与 `write` 2822 次、`edit` 3228 次并存；只挂两个，在 ops-ptc 模式下漏掉一半以上写入。

## 后果

- 后台 shell 由工具返回里的 `jobId`/`cwd` 登记，下一步用 `jobs.read` 查结算状态，非阻塞；daemon 类长跑 job 不会挂住回灌。
- 非 git 仓库里的 bash 写入、`.gitignore` 内的文件、工作区外的绝对路径写入覆盖不到，列为已知限制。
- 每次 shell 调用后多一次 `git status`（本机实测 0.077–0.107s），且只在有 shell 调用后的下一步执行一次。
- 诊断结果只存在于会话日志，不落盘；同一文件同一版本只回灌一次。
- 每次诊断会等满 `dsh-lsp-actions` 的 `diagnosticsSettleMs`（默认 2000ms）：tsls 是 push-only，未变更文档不会重新发布，窗口到点才返回缓存或空。异步化因此是必须的而非优化；同一事实也让「空结果」无法区分干净与没等到，上游请求见 [issue #37](https://github.com/PerryLink/dsh-lsp-actions/issues/37)。
