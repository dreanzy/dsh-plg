# dsh-lsp-lens

把语言服务器的诊断在改完代码后**回灌**给模型。不依赖模型主动调用 `lsp_*` 工具。

写入类工具返回后，本插件调用已注册的 `lsp_diagnostics`，把诊断追加到该次工具返回里。模型下一步就看见问题，不需要想起来去查。

## 是 / 不是

- **是**：回灌。覆盖 `write`、`edit`、`ops_write_file`、`ops_edit_file`、`ops_replace`，原生与 ops-ptc 两种执行模式都经过同一条工具流水线。
- **不是**：提醒（不改措辞）、格式化、重命名执行。
- 诊断来源是 `dsh-lsp-actions` 注册的 `lsp_diagnostics`；工具缺席时本插件静默不动作，不会伪造"干净"。

## 配置

```yaml
- insert:
    - id: lsp-lens
      name: '@dreanzy/dsh-lsp-lens'
      inject: [tools]
      config:
        enabled: true
        maxFilesPerStep: 3
        maxCharsPerFile: 800
        diagnosticTimeoutMs: 2000
        extensions: ['.ts', '.py', '.lua', '.ps1', '.bat']
```

## 三个发现来源

| 来源 | 触发 | 回灌位置 |
|---|---|---|
| 写入类工具返回 | `write`/`edit`/`ops_write_file`/`ops_edit_file`/`ops_replace` | 下一步开头汇总（只登记，不等诊断） |
| `fs/observed` | 文件系统观测到新版本 | 下一步开头汇总 |
| git 差分 | `bash`/`pwsh`/`ops_bash` 执行后；后台作业结算后 | 下一步开头汇总 |

后台作业：工具返回里的 `jobId` 与 `cwd` 先登记，下一步用 `jobs.read` 看是否结算，结算后才差分，不阻塞。

## 已知限制

- `pre-step` 汇总要宿主提供 `createUserMessage`（`@deepseek-ai/dsh-llm`）；取不到时该通道跳过并只 warn 一次。
- 非 git 仓库里的 shell 写入、`.gitignore` 内文件、工作区外的绝对路径写入覆盖不到，见 [ADR 0013](../../docs/adr/0013-lsp-feedback-three-sources.md)。
- 诊断超时按"未确认"回灌，不等于干净；`dsh-lsp-actions` 的 `#10`（未变更文件二次调用返回空）在此表现为空结果，不回灌。
- 只回灌受支持扩展名；`.md`、`.json` 等不触发诊断，也不消耗调用。

## 术语

见 [GLOSSARY.md](./GLOSSARY.md)：回灌、脏文件、发现来源、待处理、未确认。
