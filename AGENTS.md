# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

## 上游 API 观察清单

`docs/dsh-api-watch.md` 记本项目对 `@deepseek-ai/*` 的脆弱依赖：官方没提供、本地手工复刻的规则，以及担心会变的接口。写代码时出现下面任一情况，当场加一条：

- 手工复刻宿主的规则或对象形状，因为对应的包不是依赖
- 用到某个接口，但觉得下游版本可能改名或改签名
- 绕过了某个限制，期待官方以后提供正规做法
- 想做某个能力，但上游还没提供接口或服务

每条必填一个可执行判据和一个退役条件：`check` + `retireWhen`（已落地的），或 `probe` + `unblocksWhen`（还没法做的）。缺一不收。条件达成就删，不留着。检查 DSH 更新时先过这份清单，见 `my-dsh-upstream-check`。

## 客户端插件红线

浏览器侧的 `client.js` 在 web boot 阶段加载。**它的任何异常都会把该 entry 判成 failed，进而让整个桌面端启动失败**——不是"面板不出来"，是 DSH 起不来。所以：

1. `apply` 必须整体包 `try/catch`，失败只 `console.error`，绝不外抛。
2. **服务是否在 `ctx` 上，由 `inject` 决定，不由环境决定**。没在 `inject` 里声明的服务，`ctx.remote` 这类属性访问得到 `undefined`；而 `ctx.get(name)` 对取不到的**已声明**服务会**抛错**，不是返回 `undefined`。两条一起看：想用某个服务就必须 `inject` 声明它，并且探测处包 `try/catch`。把 "避免硬依赖" 做成"从 inject 去掉"，只会让功能静默失效（模型目录读不到 → 所有下拉为空 → 看着像"不能编辑"）。
3. 这一步不能只靠 `node --check` 或假 ctx 冒烟——假 ctx 返回 undefined 会掩盖真实行为。冒烟时把 `get` 写成抛错版，才测得到降级路径。
4. 组件必须以稳定标识符注册（`const Card = (props) => ...`），不要传内联箭头函数：每次渲染都是新类型，React 会整棵卸载重挂，输入框逐字失焦。

## 宿主插件红线

`agent/created` 是 serial 派发，监听器抛错会让**会话创建失败**。所有 `applyOne` 路径包 `try/catch`，失败只 `logger.warn`；该回调里只做**有界**读盘（1–3 个小配置文件，结果按 cwd 缓存），不扫目录、不做无界遍历。

## 验收

改动插件后，**跑测试脚本不算验收完成**。测试只覆盖函数级行为，路由层、信封形状、跨包不一致都测不到——`mcp-pack` 的原型链 op 报 `internal` 就是这么漏掉的：其余三包已修，只有它没修，而单包测试全绿。

验收分两步，缺一不可：

1. **测试脚本**：`pnpm test`，或逐包 `node --test --test-isolation=none packages/<pkg>/test/`。
2. **隔离 profile 端到端**：建独立 profile（`dsh <name> --from-default-profile web`），用 `link:` 装本仓库的包，启动 web 服务，走真实 HTTP 路由把面板的操作序列跑一遍。

端到端判据：

- 每包至少覆盖：读初始状态、新建、改名、绑定、试算不落盘、删除、名册回到初始。
- 试算（`dryRun: true`）必须验证「响应变了但磁盘没变」，两条都要断言。
- **四包对比同一操作的信封 `code`**：不一致就是缺陷。`bad-request` 与 `internal` 混用会让客户端把输入错误当成服务端故障。
- 隔离 profile 用完即删，不留在 `~/.dsh/profiles/` 下。

web 服务有浏览器认证栅栏：无 cookie 的 `/api/*` 请求一律 401。端到端脚本要先完成认证——用 `~/.dsh/.credentials.yaml` 里的签名 secret 自签 cookie，或从启动 URL 的 `?token=` 换。凭据只在本机用，不进提交、不进文档。

### 沙箱限制与绕开

本机 DSH 文件沙箱是 `workspace-write`，且**强制不完整**（`File sandbox enforcement is partial`）。下面几条是实测踩到的，不是猜测。

**写不出去的位置**：

- `~/.dsh/profiles/` —— `dsh <name> --from-default-profile web` 默认写这里，报 `EPERM: mkdtemp` 或 `EPERM: open ... cordis.yml`。**绕开**：先 `$env:DSH_HOME = (Resolve-Path .tmp/e2e/home).Path`，再跑 `dsh`。profile 落在工作区内，用完连 `.tmp/e2e` 一起删。
- `~/AppData/Local/pnpm-store-operation-locks/` —— `pnpm --filter <pkg> test` 报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`。**绕开**：不进 pnpm，直接 `node --test --test-isolation=none test/`（在包目录下），或 `node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.json`（在仓库根下）。

**管道被拦**：

- `<program> | <cmdlet>` 会报 `Access to the path '\\.\pipe\LOCAL\dotnet_...' is denied`。这是沙箱禁止程序打开命名管道，不是命令写错。**绕开**：不用管道，改用程序自己的输出参数（`git show <ref>:<path> --output=<file>`）或先落盘再读。注意 `--output=` 在部分 git 版本上同样静默失败（文件 0 字节），落盘后要 `Test-Path` + 查大小。
- `npx <tool>` 会先跑 `npx.ps1` 里的 `$NPM_PREFIX=(& $NODE_EXE ...)`，同样撞管道限制，报错但 `exit code` 仍是 0 —— **看起来成功，实际没跑**。**绕开**：直接 `node <path-to-bin>`。

**恢复被误改的文件**：

- `git checkout -- <path>` 可用。`git show <ref>:<path> > file` 与 `| Out-File` 都不可用（管道/重定向）。批量裁剪脚本改坏文件时，先 `git checkout` 恢复再重做，不要试图从管道拼回原文。

**判据**：报错文本里出现 `\\.\pipe\LOCAL\dotnet_` 或 `EPERM` 且路径在 `~` 下，就是沙箱，不是代码问题。不要重试同一条命令，换上面任一条绕开路径。

