# 诊断回灌改为会话作用域与跨步异步

## 背景与决定

[ADR 0013](./0013-lsp-feedback-three-sources.md) 定的同步回灌在实测里失效：`hooks.test.js` 的同一版本被回灌 20 次，另一次会话收到 16 条不在自己会话根内的文件。两个原因叠在一起——`take()` 取走即删条目，连「已诊断」的记忆一起删；脏表是 `apply()` 闭包里的单例，整个 profile 共用一个。

决定三条：

1. **脏表按会话作用域。** `Map<会话键, DirtySet>`，键取 `agent.session.header.id`，缺失时退回 `header.cwd`。
2. **诊断跨步异步。** pre-step 发起后不等待，下一步取已完成的结果；`AbortController` 自持，不绑 pre-step 的 `signal`。
3. **`seen` 记忆 `path + version`**，上限 2000 条、按插入序淘汰；`take()` 取走即锁定（含飞行中），失败与超时不解除——否认知情比反复重试更便宜。迟到结果超过 2 步或 30s 丢弃。

同时把「会话目录」的基准固定为 `agent.session.header.cwd`（见[根术语表](../../GLOSSARY.md#会话目录session-cwd)与[包术语表](../../packages/dsh-lsp-lens/GLOSSARY.md)）。

## 考虑过的替代方案

**保持进程级共享，条目记来源会话。** 否掉：诊断不是纯函数——`dsh-lsp-actions` 用**当前会话**的 cwd 做 containment（`lib/session-cwd.js` 只读 `exec.agent.session.header.cwd`），共享条目必然用错根去解析，结果只能是 `unconfirmed`。共享在这条链上不成立。

**只加大 `stepBudgetMs`。** 否掉：pre-step 里的 `await` 直接延迟模型请求，把 4s 加到 12s 等于拿延迟换并行度；且 `Promise.race` 放弃结果时不取消底层请求，超时的诊断仍占着服务器队列。

**保留同步、把 `maxFilesPerStep` 降到 1。** 否掉：3 个脏文件要拖 3 步，而 `.js` 文件在包 `tsconfig` 的 `include` 之外，tsserver 不推诊断，只能等满 `diagnosticsSettleMs`——降到 1 只是把每次等待挪到不同步骤。

**用 `workingDirectory` 投影做基准。** 否掉：上游判定只认 `header.cwd` 快照，插件若用投影过滤，会出现「过滤放行、执行被拒」的裂缝，正是这轮要修的病。

## 后果

- `stepBudgetMs` 与 `MIN_DIAGNOSIS_MS` 退役；`diagnosticTimeoutMs` 保留，语义变为「单次飞行的放弃上限」。
- `maxFilesPerStep` 语义从「每步诊断几个」变成「同时飞行几个」，默认 3；同一台语言服务器同时只飞 1 个，因为服务器本身串行。
- `fs/observed` 的回调签名是 `(target, observation)`，拿不到会话（宿主自身的 `WorkspaceChangeFeed` 也只用这两个参数）。观测因此先进一个进程级候选池，pre-step 用当前会话根分流；根外条目直接丢弃，不保留给别的会话。
- 未确认分两档措辞：真超时，与调用失败（containment、服务器未就绪、工具抛错）。
- git 差分的路径基准是**仓库根**，由 `git rev-parse --show-toplevel` 取得。`git status` 输出的路径相对仓库根，而 shell 的 `workdir` 常是子目录；直接拼 `cwd` 会得到 `<子目录>/<仓库根相对路径>` 这种不存在的路径，诊断必然失败。代价是每次 shell 后多一次 git 调用。
- 结果未回时静默，不发「诊断进行中」。
