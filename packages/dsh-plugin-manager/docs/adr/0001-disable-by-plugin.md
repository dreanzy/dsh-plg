# 0001 按插件停用：工具走 restrict，段走装配 waterfall

## 状态

已采纳。

## 背景

需要按工作区停用插件，目的有两个：省下每次请求的 token；在某工作区不让人模型用某个插件的能力。

一个插件对模型的贡献只有两类：它注册的工具（进 API `tools` 或 PTC 的 SDK 声明），和它往 system prompt 注入的段。更早的做法只处理了工具，用 `agent.ctx.tools.restrict({ deny })`。实测本机全部插件的段合计约 1.63 万字符 ≈ 4.1K token，而工具 schema 与 SDK 声明的体量更大。

## 决定

一次停用做两件事：

1. **工具**：该插件注册的工具名进 `restrict({ deny })` 掩码。
2. **段**：在 `system-prompt/assemble` waterfall 里，从 `assembly.sections` 剔除属于该插件的段。

归属靠静态扫描：各包源码里的 `defineTool({ name: '…' })` 与 `systemPrompt.section({ name: '…' })`。

## 备选与取舍

**只删段**。省得少——段合计 4K token，工具大头还在。

**只 deny 工具**。能力确实没了（fail-closed），但插件注入的说明文字仍占 token，且会描述一个调不到的能力，模型可能照着拼调用。

**真卸载插件**（`setBundleEnabled`）。它写 profile 的 `bundles`，是全局状态；有 HMR 时才真卸载 fiber，否则要求重启；受保护 bundle 直接拒绝。既不是工作区粒度，又把生命周期风险引进来。

**按前缀猜段归属**。删错一个 1300 token 的段等于废掉一个插件的能力，且没有兜底。不采用。

## 后果

- 段注册项不记录 owner，公共 API 也没有枚举方法，所以「段 → 插件」只能靠命名约定加静态扫描。**认不出的段一律不动**，面板标注「提示词占用未知」。降级是安全的：工具 deny 已经硬保证了「不希望模型使用」，段只是省 token。
- 不提供「关插件但保留某个工具」。`restrict` 取交集、只收紧，反开会给出假开关。
- 工具在 waterfall 之后才挂回，所以工具不能靠 waterfall 裁——两条通道必须分开走。
- 停用不影响插件进程、不影响 UI 面板、不影响别的 agent 的作用域。
