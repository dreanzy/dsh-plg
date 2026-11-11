# 模型方案（model-scheme）

> Status: ready-for-human
> 目标版本：DSH 0.2.2-rc.1（本机 asar 内代码）
> 相关：调研证据见 `.tmp/research/dsh-feasibility.md`、`preset-workspace.md`、`community.md`

## 1. 目标

按**工作区**为新建会话决定两件事，且不自动改写已有会话（会话浮层里可手动把当前会话拉回方案路由）：

1. 会话使用的 provider / model / reasoningEffort；
2. 子智能体（`subagent_tier` 工具）四档难度各自的路由，含首选与备选。

用户把这两件事组合成一个可命名的**方案（scheme）**，可在设置页增删，可把某个方案绑定到某个工作区。

## 2. 非目标

- 不替代官方 `设置 → 模型`；只为空白会话把全局方案的会话路由同步成进程级默认显示，官方设置页继续存在。
- 不接管官方 composer 模型选择器的交互（只在其上挂展示）。
- 不管智能体团队（`spawn_teammate`）的成员路由——它直接调 `subagents.startActivation`，插件无介入点。
- 不给 `subagent_fork` 分档：fork 的价值是前缀复用，换模型即浪费。
- 不改官方 agent preset 的 `plugins` 组合。

## 3. 术语

**模型方案（Scheme）**:
一套命名的路由配置，含一个可选的会话路由与最多四个档位。本插件拥有的对象，与官方 `agent preset`、profile 无关。
_Avoid_: preset、profile、配置、模板

**档（Tier）**:
子智能体的难度等级，固定四个：`tier1`（只读，答案在文件里）…`tier4`（因或目标还未知）。难度指所需判断力，不指文件数或阅读量。id 稳定，显示名可改。
_Avoid_: 级别、等级、模型组

**路由（Route）**:
`{ provider, model, reasoningEffort? }`。省略 `reasoningEffort` 表示交给适配器默认值。

**首选 / 备选（Primary / Fallback）**:
一个档位内的有序路由列表。首选不可用或确定失败时按序换下一个；**不重试已失败的子任务**。

**思考等级跟随（Effort follows the model）**:
路由省略 `reasoningEffort` 时，取该模型自己的默认强度，**不继承会话路由的强度**。这是官方 `agentOptions` 的既有语义（换路由而未显式给强度时会清掉继承来的强度）。

**绑定（Binding）**:
工作区到方案的映射。只作用于该目录下**之后新建**的会话。

**跟随（Follow）**:
某层对该键没有记录，取值来自上一层。落盘表现为键不存在。
_Avoid_: 继承、默认

## 4. 求值链

```
工作区层  <cwd>/.dsh/model-scheme.json  { schemeId }
   │ 有 schemeId 且该方案存在 → 用它
   ▼
全局层    $DSH_HOME/model-scheme/schemes.json  { defaultSchemeId, schemes }
   │ 有 defaultSchemeId → 用它
   ▼
出厂方案  BUILTIN（会话跟随、四档全空）
```

工作区层记录的方案已被删除 → 回落全局层，并在面板标「绑定失效」。

## 5. 数据结构

```jsonc
// $DSH_HOME/model-scheme/schemes.json
{
  "version": 1,
  "defaultSchemeId": "standard",          // 可缺省 = 用出厂
  "schemes": {
    "standard": {
      "name": "标准",
      "session": {                         // 可缺省 = 跟随官方默认
        "provider": "deepseek",
        "model": "deepseek-chat",
        "reasoningEffort": "high"
      },
      "tiers": {
        "tier1": {
          "name": "侦察",
          "primary": {
            "provider": "deepseek",
            "model": "deepseek-chat",
            "reasoningEffort": "low"        // 可缺省 = 该模型自己的默认强度
          },
          "fallbacks": [
            { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "low" }
          ]
        }
        // tier2..tier4 同理；缺省的档不暴露给模型
      }
    }
  }
}
```

```jsonc
// <cwd>/.dsh/model-scheme.json
{ "version": 1, "schemeId": "standard" }
```

另有一份 `$DSH_HOME/model-scheme/prompts.json` 承载提示词覆盖，结构见 §6.3.1。它与方案正交：所有方案共用同一份提示词覆盖。

写盘沿用现有三包的 `withFileLock` + `writeFileAtomic`，模式 `0600`，目录 `0700`。

## 6. 行为

### 6.1 新会话（Host，`agent/created`）

```
on agent/created({ agent, source }):
  agent.session.header.origin === 'subagent' → return // 不与父级捕获打架
  cwd === undefined                       → return
  scheme = resolve(cwd)
  isStartup = source === 'startup'
  // 1) 会话路由：只在新建会话做
  if isStartup && scheme.session && 会话日志里没有 request/header:
      try agent.model.select(scheme.session) catch warn

  // 判据说明：宿主在**创建会话时**就写一条初始 model/selection
  //（实测：session → permission/preset → sandbox/mode → approval/policy →
  //  model/selection → subagent/model-selection-policy）。
  // 用 model/selection 判「用户已选过」会让方案对每个新会话都不生效。
  // request/header 只在真正发出请求后出现，才是可靠判据。
  // 2) 子代理档位
  if 任一档有 primary && subagents 可用 && startActivation 是函数:
      注册 subagent_tier → 成功后 tools.restrict({ deny: ['subagent'] })
      注册失败 → 不 deny（宁可让官方工具留着）
  // 3) 提示词段
  仅当 subagent_tier 注册成功才注入（段名 model-scheme.delegation）

第 2、3 步对恢复的会话同样执行：工具与段挂在 agent 作用域上，agent 重建后旧注册随
旧 agent 一起消失。不重挂的话，恢复出来的会话只有模型、没有 subagent_tier。
```

顺序是硬要求：**先注册成功再 deny**。反过来一旦注册失败，模型会完全失去委派能力。

整个回调包 try/catch，失败只 `logger.warn` 并把原因存进 `lastError` 供面板显示（`agent/created` 抛错会让会话创建失败）。

### 6.2 `subagent_tier` 工具

单一工具，`tier` 枚举参数：

```
subagent_tier(tier, prompt, label?, cwd?)
```

execute：
1. 用调用方 `agent.ctx` 取 `subagents`；
2. 按 cwd（缺省调用方 cwd）解析方案，取该档路由链；
3. 依次尝试每条路由：`llm.resolveCallConfig({ provider, model, reasoningEffort })` 通过才用；
4. `startActivation({ provider:'spawn', delivery:'parent', request:{ prompt, agentOptions: route } })`；
5. 返回 `{ kind:'activation', subagentId }`。

只在**确定性失败**（路由不存在、模型不存在、适配器未注册、额度耗尽）时前进到下一条路由；子任务自身执行失败不换模型重跑。这里的「前进」与 §6.4 的「降级」（能力缺失）是两件事，不要混用同一个词。

### 6.3 提示词

两处，合计预算 ≤ 650 token（实测：工具描述 145、段 424）：

- **工具描述**（≤200）：四档表——`tier1` 侦察 / `tier2` 速办 / `tier3` 攻坚 / `tier4` 深算；参数说明；「独立任务一律用它」。上限取 200 是因为档名可被用户改长、需要护栏；原写的 400 永远触发不到，等于没有约束。
- **系统提示词段** `model-pack.delegation`（≤450）：判据（派不派）+ 按难度切轨道 + 四档判定线索 + 检查点 + 单次委派步数护栏 + 自足交付 + 收尾验收 + `subagent_tier` 与 `subagent_fork` 的分工。

### 6.3.1 内置提示词与用户覆盖

编排段与各档提示词**内置在插件里**，用户可通过 `$DSH_HOME/model-scheme/prompts.json` 覆盖：

```jsonc
{
  "version": 1,
  "delegation": "……",
  "tiers": { "tier1": { "label": "侦察", "text": "只读定位，产出是带引用的上下文" } }
}
```

- 逐键合并：用户有则用用户，无则用内置。**空串等于缺省**，写入时直接拒绝，不静默忽略。
- 面板为每段提供文本框与「恢复内置」（= 删键）。
- 内置文本更新后不自动合并用户覆盖；面板不主动提示变化，恢复内置由清空文本框（= 删键）完成。

两条硬约束：

1. 段内容只能来自配置与内置常量，**不得拼入方案名、模型名、cwd 等随会话变化的值**——那会破坏 KV cache 前缀复用。
2. 段内不得出现任何 provider / model 名。内置文本由测试保证；用户覆盖**不做硬校验**——插件内没有权威的 provider 名单，硬校验只会误杀。面板保存时若检测到形如 `a/b` 的串，给一条不阻止保存的提示。

### 6.4 降级矩阵

| 缺失 | 表现 | 面板 |
|---|---|---|
| `subagents` 服务 | 不注册工具、不注入段、不 deny | 置灰 +「子智能体插件未启用」 |
| `startActivation` 不存在 | 同上 | 置灰 + 原始错误 |
| `tools.restrict` 不存在 | 注册工具但保留官方 `subagent` | 标红「官方工具未被屏蔽，模型可能绕过档位」 |
| `llm.resolveModelInfo` 失败 | 跳过该路由试备选；全失败则不注册该档 | 列表内逐条标「当前不可用」 |
| 配置文件坏 JSON | 回落出厂方案 | 标红 + 文件路径 + 解析错误原文 |

`support()` 在没有探测历史时按可用放行：面板用这一格决定是否禁用档位编辑，判成不可用
会让「没开过会话就配不了方案」。真实可用性在 `agent/created` 时按会话判断。

### 6.5 插件重载后的补施加（`bootstrap`）

插件重载或热更新后，已存在的会话不会再收到 `agent/created`，于是没有 `subagent_tier`
与委派段。`bootstrap()` 对 `agents.list()` 里的每个在线会话补做第 2、3 步
（工具、deny、段），**不改会话路由**：老会话的模型是用户的选择，插件无权改写。

`states` 是进程内表，重载即清空；补施加按 agent id 幂等，已在表里的跳过。
读取 `agents` 失败时静默返回：补施加是尽力而为，不能反过来让插件加载失败。

## 7. UI

**设置页**（`settings.section`，与另外三个 manager 同级的设置项）：

- 方案列表：名称、会话路由、四档摘要、当前被哪些会话的工作区绑定（最近 8 个，不是全盘扫描）；
- 增删改方案；出厂方案不可删；删除仍被绑定的方案需先解绑或确认回落；
- 每档：首选 + 备选的有序列表，**每条各自带模型与思考等级**，从 `modelCatalog` 选，无效路由标灰；强度下拉只列该模型公布的 `reasoning.efforts`，另有「跟随模型默认」一项（= 该键不存在）；
- 工作区绑定在会话浮层里改，设置页只定义方案与全局默认：浮层显示当前 cwd、其绑定、
  以及「跟随全局默认」按钮（跟随 = 删除 `schemeId` 键，不是写 null）。

**会话界面**：`conversation.input.right` 的 chip 打开方案浮层（`shell.overlay`），用于会话内切方案与把当前会话拉回方案路由；`conversation.input.model.label` 在官方模型位触发按钮上显示 `方案名 · 模型名`（纯展示）。

## 8. 模块边界

```
packages/dsh-model-scheme/
  package.json          dsh.bundle.patch + dsh.client
  cordis.patch.yml      一条 insert，id = model-scheme
  src/index.ts          apply / inject / 路由注册 / bootstrap
  src/scheme.ts         数据结构、解析、校验（纯函数）
  src/policy.ts         两层读写 + 求值链（纯函数）
  src/hooks.ts          agent/created、restrict 生命周期、按 agent 登记
  src/tools.ts          subagent_tier 定义与 execute
  src/prompt.ts         段文本生成
  src/routes.ts         /api/model-scheme/read|apply|support|reset
  client/client.js      设置页 + 模型位展示
  locale/{zh,en}.json
  test/*.test.js        node --test，测编译产物
```

host 侧 `inject` 只声明 `tools`；`subagents` / `agentPresets` / `connection` 全部走运行期 `ctx.get` 探测，缺了降级（照 `dsh-plugin-manager` 的做法）。

## 9. 测试切面

1. **求值链**：工作区有绑定 / 绑定指向已删方案 / 全局有默认 / 都没有 / 坏 JSON / 文件不存在。
2. **注册顺序**：注册成功 → 有 deny；注册抛错 → 无 deny、无段。
3. **事件过滤**：`source === 'resume'` 不调 `select`（但重挂工具与段）；`origin === 'subagent'` 不动；无 cwd 不动。
4. **select 条件**：已有 pending/lastUsed 时不 select。
5. **备选前进**：`resolveCallConfig` 抛错 → 换下一条；全失败 → 工具返回错误而不是崩。
6. **降级矩阵**逐格。
7. **提示词预算**：段 + 工具描述字符数断言，超限即失败。

## 10. 风险

| 风险 | 处置 |
|---|---|
| 官方改 `startActivation` / `capabilities` | 能力探测 + 工具不注册，降级为「只有会话路由」 |
| 与 dsh-model-dispatch 等社区插件抢同一批事件 | 不注册同名工具；不写 `subagent-model-selection` 命名空间；文档给出并存说明 |
| 模型仍偏爱官方 `subagent`（若 restrict 不可用） | 面板标红，明确告知降级 |
| 提示词成本 | 预算断言（见测试 7） |
