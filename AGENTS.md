# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

## 客户端插件红线

浏览器侧的 `client.js` 在 web boot 阶段加载。**它的任何异常都会把该 entry 判成 failed，进而让整个桌面端启动失败**——不是"面板不出来"，是 DSH 起不来。所以：

1. `apply` 必须整体包 `try/catch`，失败只 `console.error`，绝不外抛。
2. **服务是否在 `ctx` 上，由 `inject` 决定，不由环境决定**。没在 `inject` 里声明的服务，`ctx.remote` 这类属性访问得到 `undefined`；而 `ctx.get(name)` 对取不到的**已声明**服务会**抛错**，不是返回 `undefined`。两条一起看：想用某个服务就必须 `inject` 声明它，并且探测处包 `try/catch`。把 "避免硬依赖" 做成"从 inject 去掉"，只会让功能静默失效（模型目录读不到 → 所有下拉为空 → 看着像"不能编辑"）。
3. 这一步不能只靠 `node --check` 或假 ctx 冒烟——假 ctx 返回 undefined 会掩盖真实行为。冒烟时把 `get` 写成抛错版，才测得到降级路径。
4. 组件必须以稳定标识符注册（`const Card = (props) => ...`），不要传内联箭头函数：每次渲染都是新类型，React 会整棵卸载重挂，输入框逐字失焦。

## 宿主插件红线

`agent/created` 是 serial 派发，监听器抛错会让**会话创建失败**。所有 `applyOne` 路径包 `try/catch`，失败只 `logger.warn`；该回调里只做**有界**读盘（1–3 个小配置文件，结果按 cwd 缓存），不扫目录、不做无界遍历。
