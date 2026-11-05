# 按插件裁剪 system prompt：可行性与成本

- 调研对象：DSH `0.2.2-rc.1`（asar：`%USERPROFILE%\scoop\apps\deepseek-harness-pre\0.2.2-rc.1\resources\app.asar`）
- 本机 profile：`%USERPROFILE%\.dsh\profiles\desktop`（`dsh.profile.bundles` 24 个 bundle，`dependencies` 19 个直接依赖）
- 所有 asar 内路径均相对 asar 根，记作 `dsh/node_modules/...`
- 复现用镜像：asar 中 `@deepseek-ai/*/lib/**` 与 `*.yml` 已抽取到 `.tmp/prompt-inv/src/`，行号即在镜像内行号

---

## 0. 先答

1. **装配钩子可删段**：`system-prompt/assemble` waterfall 拿到的是 `{sections, contexts, variables}` 的可变对象，返回值的 `sections` 就是最终 system prompt。外部插件完全可以按段名过滤。**代价低**（一个 ~100 行插件），但有 3 个约束（complete 段覆盖、tools 不能经此改、滚动缓存）。
2. **"按插件"识别不行**：注册项里没有注册者身份，公共 API 没有枚举方法；段名是唯一稳定判据。桥接只能靠**命名约定 + 静态清单**（或读 waterfall 的 `assembly.sections[].name` 做运行时枚举）。
3. **段文本的真实占用**：本机装配下段文本合计约 **1.63 万字符 ≈ 4.1K token**（不含 `tools:sdk` 与动态上下文）。最大头是第三方插件：`@wenaixi/dsh-ponytail`（1.3K token）、`@dickpy/dsh-imagegen`（~0.8K token）。真正的成本大头不是段，而是 PTC 的 `tools:sdk` 与工具 schema（见 §3.5）。
4. **启停语义**：`setBundleEnabled` 真写 profile `package.json` 的 `dsh.profile.bundles`，并在有 HMR 时热重组（真卸载 fiber）、无 HMR 时返回 `restart-required`。见 §5。
5. **没有任何"按工作区不同插件集"**：最近的层级是 **agent preset（会话级）**，其次是 scope（agent 级）。工作区只决定 `cwd`（AGENTS.md 链、沙箱根），不决定插件集。见 §6。

---

## 1. 装配钩子形状

### 1.1 payload 定义（官方类型）

`dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:5186-5191`：

```ts
name: 'system-prompt/assemble',
mode: 'waterfall',
signature: '\'system-prompt/assemble\'(this: Scoped<SystemPrompt>, assembly: PromptPresentation, context: AssembleContext, next: () => Promise<PromptPresentation>): Promise<PromptPresentation>',
summary: 'Presentation waterfall over assembled sections, contexts, and variables.',
description: '... Scope-filtered dispatch (@deepseek-ai/dsh-scope): scoped listeners receive only that scope\'s assemblies. The returned text is authoritative; tool declarations remain provider-owned. ...',
parameters: [{ name: 'assembly', description: 'the mutable assembly built from registered providers.' }, ...]
```

payload 类型（同文件 `:7604-7607`、`:5560-5567`）：

```ts
export interface PromptPresentation {
    sections: AssembledSection[];
    contexts: AssembledContext[];
    variables: Record<string, string | undefined>;
}
export interface AssembledSection { name: string; text: string; interpolate?: boolean; }
export interface AssembledContext { name: string; text: string; interpolate?: boolean; }
```

注意：`AssembleContext` 的**公开声明**只有 `{ scope?: ScopeKey; signal?: AbortSignal }`（`:5557-5559`），但运行时实际传进来更多字段 —— `dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:679-683`：

```js
const assembly = await this.loopCtx.systemPrompt.assemble({
    ...assembleContextFor(this, signal),   // { agent, scope: agent, signal }  —— dsh-agent/lib/index.js:407-412
    modelSelection: selection,
    toolSet
});
```

即 handler 里 `context.agent`、`context.modelSelection`、`context.toolSet` 都能读；**这是"按 cwd / 按 agent 条件裁剪"的入口**（`context.agent.session.header.cwd`）。

### 1.2 发射点与去向

`dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:396-412`：

```js
const assembly = {
    sections,
    contexts: [...].map((entry) => resolveContext(entry, context)),
    variables
};
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
if (completeSection === void 0 && !runtimeContextSuppressed) return {
    ...transformed,
    tools
};
const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
return {
    ...transformed,
    tools,
    sections: completeSection === void 0 ? transformed.sections : [completeSection],
    contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
};
```

消费端 `dsh-agent-loop/lib/index.js:839`：`const renderedPrompt = renderPrompt(assembly);`，
`dsh-system-prompt/lib/index.js:119`：`return assembly.sections.map(...).filter((text) => text.length > 0).join("\n\n");`

**结论：waterfall 返回的 `sections` 数组逐字决定 system prompt 内容。**删元素 = 删段。

### 1.3 三种既有写法（都能证明"可变"）

| 写法 | 证据 | 语义 |
|---|---|---|
| 返回新对象 / 返回 `next()` 的结果 | `dsh/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js:52-69` | `const assembly = await next(); assembly.contexts.unshift(...)` —— **原地改** waterfall 产物并返回 |
| 校验后放行 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-ops\lib\official-tool-hiding.js:175-212` | `(assembly, context, next)`，读 `context.scope`，校验 `result.tools`，不合法就 `throw` |
| 重新装配 | `dsh-ops/lib/ptc/index.js:352-378` | `return prompt.assemble(context)` —— 直接重跑注册表装配 |

`dsh-working-directory` 的写法是"外部插件可以改 assembly"的最硬证据：

```js
ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    ...
    const assembly = await next();
    const contribution = assembly.contexts.find((entry) => entry.name === "working-directory:current");
    if (contribution === void 0) assembly.contexts.unshift({ name: "working-directory:current", text, interpolate: false });
    else { contribution.text = text; contribution.interpolate = false; }
    return assembly;
}, { prepend: true });
```

### 1.4 边界（必须知道的三条）

1. **`complete` 段会覆盖你的过滤**：`index.js:383-384, 402-410`。若某段注册了 `complete: true`（`dsh-persona` 的 `config.complete`，见 `dsh-persona/lib/index.js:36-41`），waterfall 返回的 `sections` 会被丢弃，只保留那一段。
2. **工具声明不归 waterfall 管**：`{...transformed, tools}`（`index.js:402-405`）用注册表算出的 `tools` 覆盖返回值；注释也写明 "tool declarations stay provider-owned"（`:352-354`）。工具裁剪必须用 `ctx.tools.restrict({allow, deny})`（`api-catalog.js:4004-4007`）或 executor 层的隐藏，不能靠删段。
3. **`runtimeContextSuppressed` 分支**会把 `sections` 收缩到仅 `[completeSection]`（`:410`）；此时你的过滤无意义。

### 1.5 缓存影响

system prompt 进入请求前还有一次投影：`dsh-agent-loop/lib/index.js:850-858`：

```js
const commits = this.systemPrompt.project(renderedPrompt, {
    inHistory: preparedCall?.systemPromptUpdate === "in-history",
    startsSeries: startsRequestSeries || ... || this.toolsChanged(assembly.tools)
});
for (const { message, intent } of commits) this.session.append("system/message", { turn, step, message }, intent);
```

删段会让 `renderedPrompt` 变化 → 触发 system message 投影更新（或 in-history 提交）。**对缓存是否友好取决于裁剪是否稳定**：同一工作区内稳定 → 只在首轮付一次；随工作区变化 → 每次切工作区都重建前缀缓存。

---

## 2. 段的来源能否识别

### 2.1 注册 API 全貌（公共方法只有这些）

`dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js`：

| 行 | 方法 | 存什么 |
|---|---|---|
| 255-257 | `section(section)` | `layer.sections.insert(section.name, section)` —— 只存 section 对象 |
| 281-283 | `context(context)` | `layer.contexts.insert(context.name, context)` |
| 291-292 | `suppressRuntimeContext()` | 布尔抑制器 |
| 301-302 | `tools(provider)` | provider 函数 |
| 312-314 | `variable(name, provider)` | 名字 → provider |
| 264-273 | `getSectionOrder/getContextOrder` | 只查内置 order 表 |
| 358-413 | `assemble` / 326-348 `refreshContext` | — |

**没有任何 `list*`/`sections()` 之类的方法**，也没有返回"当前全部段"的公共读取接口。

### 2.2 注册项里没有注册者身份

插入语句就是 `insert(section.name, section)`（`:257`），`NamedEntries` 的存储是 `Map<name, value>`（`dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js:66-75`，`entries()/values()`）。存进去的 value 就是调用方自建的对象（`name/order/text/interpolate/complete`），**没有 fiber、没有包名、没有 `PromptOrigin`**。

注意 `PromptOrigin = { kind: 'composer' } | { kind: 'plugin'; name: string }`（`api-catalog.js:7600-7603`）是**用户消息提交**的来源标识，与段注册无关。

effect 的 label 也是硬编码常量：`{ label: "systemPrompt.section()" }`（`:257`），四个 API 各一个常量标签 —— 无法据此区分插件。

### 2.3 运行时枚举：只有两条路，且都没有身份

1. **水fall 内**：`assembly.sections` 是 `{name, text}` 数组 —— 能拿到**全部段名**（这就是过滤插件需要的全部信息）。
2. **内部字段**（非文档 API，可用但脆）：`SystemPrompt` 的 `layers = new ScopedLayers(...)` 是公开类字段（`index.js:223`），可 `ctx.systemPrompt.layers.global.sections.entries()`、`layers.peek(scope)`、`chainLayers(scope)`（`dsh-scope/lib/index.js:132-180`）。

### 2.4 结论

- **"列出全部段名"可以**（waterfall 里枚举 `assembly.sections`）。
- **"这段是谁注册的"不行**：注册表不存 owner，scope 只区分"全局 vs 某 agent"，不区分包。
- 所以「按插件裁剪」= **段名 → 插件** 的映射表，由我们维护。好在段名**事实上已经带命名空间**（见 §3）：`tool:*`、`plugin:<pkg>:*`、`mcp:*`、`<pkg>:*`。

---

## 3. 现状清单与 token 成本

### 3.1 扫描方法（可复现）

```powershell
# 官方包（asar）：解析 asar 头，逐文件正则扫注册点，按"字面量字符数"计量
node .tmp/prompt-inv/scan2.cjs asar "%USERPROFILE%\scoop\apps\deepseek-harness-pre\0.2.2-rc.1\resources\app.asar"
# 第三方插件（profile 直接依赖的 node_modules）
node .tmp/prompt-inv/scan2.cjs fs   "%USERPROFILE%\.dsh\profiles\desktop\node_modules"
# 单点复核（模板字面量 / 常量函数）
node .tmp/prompt-inv/measure.cjs <file> <IDENT>
```

- 覆盖面：asar 内 `@deepseek-ai/*/lib/**/*.js` 共 **327 个包**（已排除 `lib/types/` 的重复副本）；profile `node_modules` 下 **19 个直接依赖**。
- 命中：官方 **27 个包**有 `systemPrompt.section/context` 注册；第三方 **6 个包**。
- 计量口径：`text:` 表达式的字符串/模板字面量字符数之和（`${...}` 插值按 0 计），token ≈ 字符数 / 4。函数型 text 取同文件产生函数的字面量（`measure.cjs`），标注 `≈`/`≤`。

### 3.2 官方包：段清单

| 包 | 段名（注册处） | order | 内容一句 | 字符 | token |
|---|---|---|---|---|---|
| dsh-tool-executor-ptc | `tools:ptc-only`（lib/index.js:1722-1726） | 800 | "run_code 是唯一可直接调用的工具" | 149 | 37 |
| dsh-tool-executor-ptc | `tools:sdk`（:1727-1731） | 5000 | 由工具 schema 生成的 SDK 声明 | **动态**（见 §3.5） | — |
| dsh-deliverable-file-references | `ui:deliverable-file-references`（:13） | 9000 | 产物展示与文件链接规范 | 1305 | 326 |
| dsh-tool-fs | `tool:read`（:248） | 1100 | read 用法 | 130 | 33 |
| dsh-tool-fs | `tool:write`（:543） | 1200 | write 用法 | 101 | 25 |
| dsh-tool-fs | `tool:apply_patch`（:1377） | 1350 | apply_patch 用法 | 454 | 114 |
| dsh-tool-fs | `tool:edit`（:1453） | 1300 | edit 用法 | 87 | 22 |
| dsh-tool-fs-search | `tool:glob`（:786） | 1400 | glob 用法 | 75 | 19 |
| dsh-tool-fs-search | `tool:grep`（:1097） | 1500 | grep 用法 | 137 | 34 |
| dsh-tool-pwsh | `tool:pwsh`（:350） | 1010 | pwsh 语义 | 259 | 65 |
| dsh-tool-bash | `tool:bash`（:376） | 1000 | bash 语义 | 92 | 23 |
| dsh-tool-jobs | `tool:jobs`（:295） | 1600 | 后台作业规则 | 382 | 96 |
| dsh-tool-goal | `tool:goal`（:258，guidance():193） | 2400 | goal 三件套策略 | 527 | 132 |
| dsh-tool-schedule | `tool:schedule`（:511） | 2500 | 定时任务 | 28 | 7 |
| dsh-tool-session-query | `tool:session-query`（:949，PROMPT_TEXT:944） | 2300 | 会话检索 | 315 | 79 |
| dsh-tool-subagent | `tool:${toolName}`（:500） | 2800 | 子代理委派 | 389 | 97 |
| dsh-tool-subagent | `tool:${toolName}:depth`（:510，context） | 120 | 委派深度 | 123 | 31 |
| dsh-tool-terminal | `tool:pty`（:259） | 1700 | 终端会话 | 308 | 77 |
| dsh-tool-web | `tool:web_search`（:283） | 2000 | 搜索语义 | 420 | 105 |
| dsh-tool-web | `tool:web_fetch`（:761） | 2100 | 抓取语义 | 159 | 40 |
| dsh-tool-workflow | `tool:${toolName}`（:265） | 2600 | workflow 工具 | 317 | 79 |
| dsh-tool-ralph | `tool:ralph`（:295） | 2700 | ralph 循环 | 434 | 109 |
| dsh-mcp-resources | `mcp-resource-servers`（:119） | 3100 | MCP 资源清单 | 148 | 37 |
| dsh-mcp-client | `mcp:${server}`（:737） | 3100 | 每台 MCP 的 instructions | 动态 | — |
| dsh-persona | `deployment:persona-prefix`（:36） | 0 | 身份前缀 | 54（preset 值） | 14 |
| dsh-persona | `deployment:persona-suffix`（:42） | 10200 | 身份后缀 | 0 | 0 |
| dsh-plan-mode | `plan:policy`（:158） | 500 | 计划模式规则 | 0 / 2900（激活时） | 0 / 725 |
| dsh-experimental-tool-agent-team | `team:policy`（:234） | 600 | 团队策略 | 1831 | 458 |
| dsh-experimental-tool-agent-team | `team:identity`（:239，context） | 125 | 团队身份 | 154 | 39 |
| dsh-harness-dev-context | `harness:source`/`web:surface`（:99/:111） | 10000/10100 | 仅 dev 会话 | 0（admitted） | 0 |
| dsh-file-reference-local | `context:file-reference`（:343） | 900 | @ 引用提示 | 4 + 动态 | ~0 |
| dsh-tools | `section.name`（:603） | 由 executor 给 | 工具执行器自带的段（PTC 走这条路） | 动态 | — |

补充事实：
- `tool:bash`/`tool:pwsh` 互斥（`dsh-web-app/presets/ptc.patch.yml:21-26`），Windows 上只有 pwsh。
- `tool:apply_patch` 在本机被 `applyPatch: false` 关掉（`ptc.patch.yml:29-31`）→ 实际 318 字符而非 772。
- `tool:workflow`、`tool-plugin-manager`、`tool-plugin-market` 在 preset 里 `disabled: true`（`ptc.patch.yml:108,113,131,134`）。
- `tool:ralph`、`team:*` 所属 bundle 不在本 profile 的 bundles 列表中 → 未装配。

### 3.3 第三方插件：段清单（本机直接依赖）

| 包 | 段名（注册处） | order | 内容 | 字符 | token |
|---|---|---|---|---|---|
| @wenaixi/dsh-ponytail | `ponytail`（lib/ponytail.js:329） | 50 | "PONYTAIL active - level: full" + SKILL.md 正文裁剪 | **5224**（实测 `render(skillDir,'full')`） | 1306 |
| @dickpy/dsh-imagegen | `plugin:dsh-imagegen`（lib/index.js:16368） | 150 | 生图插件能力 + 渠道×模型表 | **≈3259**（IMAGEGEN_GUIDANCE 3091@15785 + 168 动态） | 815 |
| @dickpy/dsh-imagegen | `plugin:dsh-imagegen:canvas-skill`（:15589） | 150 | 画布技能子代理的提示词 | 仅画布子代理路径 | — |
| @stardustlc/dsh-dream | `dsh-dream-reviewed-memory`（automatic.js:83，context） | 4100 | 命中的人审经验（≤3 条） | **≤3000**（:413 limit:3/maxChars:2400，:418 硬顶 3000） | ≤750 |
| dsh-free-search | `free-search:engines`（lib/index.js:5923） | 500 | 引擎目录 + 9 个工具说明 | **≈1600**（composeInjectedPrompt:3695；en 文案字面量 1391 + 引擎清单） | ≈400 |
| dsh-language-guard | `language-guard:head`（lib/index.js:197） | -2000 | 语言锁定·最高优先级 | 883（实测 `headText`） | 221 |
| dsh-language-guard | `language-guard:mid`（:214） | 5100 | 中段重申 | 146 | 37 |
| dsh-language-guard | `language-guard:tail`（:225） | 11200 | 收尾复述 | 139 | 35 |
| dsh-ops | `${TOOLING_SECTION}:${component}`（lib/index.js:121） | 1000/1350 | 替换工具后的套件策略 | 动态（`config.promptPolicy` 才注册） | — |

其余 13 个直接依赖（dshmarket、dsh-better-sidebar、dsh-context、ds-harness-remote、dsh-lsp-actions、dsh-notify-me、dsh-session-recycle-bin、dsh-tool-antigravity、@guowenzhang/dsh-mcp-manager、@mars-sea/dsh-commandcode-provider、dsh-dream-skin、@dreanzy/*）**零注册**。

### 3.4 按包汇总（降序，token = 字符/4）

| # | 包 | 字符 | token | 是否本机装配 |
|---|---|---|---|---|
| 1 | @wenaixi/dsh-ponytail | 5224 | **1306** | 是 |
| 2 | @dickpy/dsh-imagegen | 3259 | **815** | 是 |
| 3 | @stardustlc/dsh-dream（context，上界） | ≤3000 | **≤750** | 是（按需） |
| 4 | dsh-experimental-tool-agent-team | 1985 | 496 | 否 |
| 5 | dsh-free-search | ≈1600 | **≈400** | 是 |
| 6 | dsh-deliverable-file-references | 1305 | **326** | 是 |
| 7 | dsh-language-guard | 1168 | **292** | 是 |
| 8 | dsh-tool-fs | 772 | 193 | 是（apply_patch 关 → 80） |
| 9 | dsh-tool-web | 579 | 145 | 是 |
| 10 | dsh-tool-goal | 527 | 132 | 是 |
| 11 | dsh-tool-subagent | 512 | 128 | 是 |
| 12 | dsh-tool-ralph | 434 | 109 | 否 |
| 13 | dsh-tool-jobs | 382 | 96 | 是 |
| 14 | dsh-tool-workflow | 317 | 79 | 否（disabled） |
| 15 | dsh-tool-session-query | 315 | 79 | 是 |
| 16 | dsh-tool-terminal | 308 | 77 | 是 |
| 17 | dsh-tool-pwsh | 259 | 65 | 是 |
| 18 | dsh-tool-fs-search | 212 | 53 | 是 |
| 19 | dsh-tool-executor-ptc（仅 ptc-only 段） | 149 | 37 | 是（另有 sdk，见 §3.5） |
| 20 | dsh-mcp-resources | 148 | 37 | 是如果启用 MCP |
| 21 | dsh-tool-bash | 92 | 23 | 否（win32） |
| 22 | dsh-tool-schedule | 28 | 7 | 是 |
| 23 | dsh-persona | 54 | 14 | 是 |
| 24 | dsh-plan-mode | 0 / 2900 | 0 / 725 | 否（未进计划模式） |

**本机装配的段文本合计 ≈ 16,350 字符 ≈ 4.1K token**（不含 dream 的动态上界、不含 MCP、不含 `tools:sdk`）。

### 3.5 最大的那块不在"段"里

`tools:sdk`（`dsh-tool-executor-ptc/lib/index.js:1727-1731`）的 `text: (tools) => this.renderSdk(tools)` 由**当步工具集**渲染，长度 ∝ 工具数与参数 schema。PT C 模式下这是 system prompt 里最大的一块（本会话工具 ~90 个，量级 2–3 万字符）。同理还有个隐性的：工具 schema 本身走 `assembly.tools` → `buildRequest`（`dsh-agent-loop/lib/index.js:868`），与段无关但也按插件增长。

→ **按插件裁剪的收益排序应是：先砍工具（含 SDK 声明），再砍段。** 段全砍掉也只有 ~4K token。

---

## 4. 其它注入路径（除 section 外）

| # | 路径 | API / 位置 | 内容 | 能否按工作区裁剪 | 证据 |
|---|---|---|---|---|---|
| 1 | 动态 context | `systemPrompt.context({name,order,text})` → `assembly.contexts` → 每步渲染成 **user 消息**（"Current runtime context…"） | 工作目录、沙箱策略、审批策略、委派深度、团队身份、dream 记忆、harness source | **能**：同属 `assembly.contexts`，可在 waterfall 过滤（但 `required: true` 的会在 `assemble` 分支被重算，见 `:406-411`） | `index.js:281-283`；`joinContextSections` `:143-147`；`dsh-agent-loop:847` |
| 2 | persona 前后缀 | `deployment:persona-prefix/suffix` 两个固定段名；部署级由 `dsh-system-prompt` 的 config 注册（空串），会话级由 `dsh-persona` 在 agent scope 内**同名覆盖** | 身份前缀 | **能**：就是普通段，按名删 | `dsh-base/cordis.patch.yml:508-513`；`dsh-persona/lib/index.js:4-16,36-47`；同名 shadow 机制 `index.js:351-352` |
| 3 | 工具 schema | `systemPrompt.tools(provider)` + `ctx.tools.register` → `assembly.tools` | 每个工具的名字/描述/参数 | **不能靠 waterfall**（返回值被覆盖，`:402-405`）；用 `ctx.tools.restrict({allow,deny})`（scope 级、可叠加、返回 disposer） | `api-catalog.js:4004-4007,9565-9566` |
| 4 | 工具执行器自带段 | executor 的 `sections` → `dsh-tools` 逐个 `systemPrompt.section` | PTC 的 `tools:ptc-only`/`tools:sdk` | 能（按段名） | `dsh-tools/lib/index.js:603` |
| 5 | AGENTS.md / 项目指令 | `agent/pre-step` 插 user 消息（`source.kind = 'agent-instructions'`），预算 `maxBytes` | 用户全局 + 项目链 instructions | **天然按 cwd**（不同工作目录不同文件），但不能按插件 | `dsh-agent-instructions/lib/index.js:1480-1498`，渲染 `:366+`，preset `maxBytes: 65536`（`ptc.patch.yml:18`） |
| 6 | 技能目录 | `agent/pre-step` 插 user 消息（`source.kind='skill-catalog'`） | 可用技能清单 | 否（按会话内发现结果），可换 catalog 但非按工作区 | `dsh-tool-skill/lib/index.js:931-991` |
| 7 | 时间上下文 | `agent/pre-step`（`prepend: true`）插 user 消息 | 当前时间/时区 | 否 | `dsh-time-context/lib/index.js:249-282` |
| 8 | 周期提醒 / 模式提示 | 各插件在 `agent/pre-step` 追加消息（language-guard 的 D 档、ponytail 切档、plan-mode narration） | 短提醒 | 否（能按 agent 判断） | `dsh-language-guard/lib/cycle.js`、`ponytail-instructions.js:118-134`、`dsh-plan-mode/lib/index.js:168-183` |
| 9 | 变量插值 | `systemPrompt.variable(name, provider)` | 只影响文本，不产生段 | 不能（只能改值） | `index.js:312-314` |
| 10 | 关闭运行时上下文 | `suppressRuntimeContext()` | 抑制可选 context | 能（scope 级开关） | `index.js:291-292` |
| 11 | system message 投影 | `systemPrompt.project(renderedPrompt, …)` 决定 system 放 header 还是 in-history | — | 否 | `dsh-agent-loop/lib/index.js:850-858` |

**一句话**：能按"段/上下文"精确裁剪的只有 1、2、4；3 要用 restrict；5 到 8 是消息层，得另做拦截（`agent/pre-step` waterfall 可以过滤 `decision.messages`，但那是另一套机制）。

---

## 5. 插件级启停：`setBundleEnabled(name, enabled)`

### 5.1 源码

`dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:2683-2697`：

```js
/** Select or remove a bundle layer while retaining installed dependencies.
* @param name Bundle package name.
* @param enabled Whether the bundle contributes its patch layer.
* @returns Persisted and runtime outcomes. */
setBundleEnabled(name, enabled) {
    return this.change((result) => this.configure(async () => {
        await this.selectBundle(name, enabled);
        Object.assign(result, enabled ? await this.publishAndReload(this.bundleRows(name).map((row) => row.id)) : await this.reload());
    }), { stage: "enable", target: name, enabled }, "bundle");
}
```

### 5.2 写不写 profile 文件 —— 写

`selectBundle`（`:3048-3075`）直接改 `package.json` 的 `dsh.profile.bundles`：

```js
const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter((item) => item !== name);
if (JSON.stringify(previous) === JSON.stringify(bundles)) return;
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
await saveManifest(this.profile.dir, manifest);
```

本机证据：`%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 就是这份清单。

### 5.3 真卸载还是只标记 —— 有 HMR 就真卸载

`reload`（`:3129-3141`）：

```js
async reload(requiredIds = []) {
    const hmr = this.ownerContext.get("hmr");
    if (hmr === void 0) { composeEntries([readProfilePatches("dsh", this.profile)]); return { warnings: [] }; }
    const { warnings, pending, restartReason } = await hmr.reconcileProfile(requiredIds);
    const restart = restartReason ?? pending[0]?.reason;
    return restart === void 0 ? { warnings } : { warnings, restartReason: restart };
}
```

`dsh-hmr` 的 `reconcileProfile`（`dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js:1312-1325` 注释 + `:1325-`）：

> "Recompose the profile from its manifest and patch files, replacing running plugins whose loaded files … changed on disk … Changed modules are evicted and the Loader entries running them stop; app-boot's `recomposeProfile` then publishes the resolution, applies the generation, starts the stopped entries …"

`change()` 在无 HMR 时把结果标成 `application: "restart-required", restartReason: "no-hmr"`（`:3167-3170`）。

**本机 `dsh-hmr` 在装配里**：`dsh-base/cordis.patch.yml:28-29` → 热生效，无需重启。

### 5.4 有没有"不许关"的

有。`selectBundle` 里：

```js
if (!enabled && previous.includes(name)) {
    if (this.protectsManager(name)) throw new ManagementFailure("management-required");
}
```

`protectsManager`（`:3081-3092`）用 `PROTECTED_PLUGINS` 判定：含插件管理器自身或其 include 行的 bundle 不可关。

旁证：`dshmarket` 自己维护了一份更宽的保护名单，`^@deepseek-ai/dsh-system-prompt$` 也在其中（`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dshmarket\lib\patch.js:58`）—— 提示词注册表被当成宿主基础设施，任何「关掉它」的路线都被两层挡。

### 5.5 对 system prompt 的效果链

卸载 → cordis fiber dispose → `layers.effect` 的 undo 执行（`dsh-scope/lib/index.js:211-216`）→ `NamedEntries` 条目删除 → 下次 `assemble` 不再有该段。**真删，不是隐藏**。

但注意粒度：`setBundleEnabled` 是 **bundle 级**（一个 bundle 内可能含十几个插件）；单插件用 `setPluginEnabled(id, enabled)`（`:2669-2682`，写 patch 层的 `disabled`）。

---

## 6. 按工作区的既有机制

### 6.1 最近的层级 = agent preset（会话级）

- preset 定义：`dsh/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`（`dsh-agent-preset` 行 `config.plugins` 是一份完整插件装配）与 `standard.patch.yml`、`minimal.patch.yml`。
- 注册表：`dsh-agent-preset-registry`，`selectedDefault` 只是"后续新会话的默认"（`lib/index.js:470-472`），per-session 记录在 `agent-preset/selected` 事件里（`:759-776`）。
- 选择被**锁定在会话首轮前**：`if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) throw new RemoteError("agent-preset/locked", ...)`（`:768-770`）。

### 6.2 scope 是 agent，不是 cwd

`dsh-persona` 的头注释把机制讲得最清楚（`dsh-persona/lib/index.js:4-16`）：

> "A per-agent persona as a composable row. `dsh-system-prompt` owns the global persona as its own config … so this row is **scope-only**. Mounted inside an agent preset it shadows the deployment persona for that one session, exactly like the per-child persona `dsh-subagent` installs; mounted globally it collides with the registry's own registration and fails loud."

scope 的键是 agent（`dsh-agent/lib/index.js:407-412`：`scope: agent`），层沿父链继承（`dsh-scope/lib/index.js:155-180`），子代理可再覆盖（`dsh-subagent/lib/index.js:386-393`）。

### 6.3 workspaceRegistry 只是 UI 分组

`workspaceRegistry` 出现在 `dsh-api-workspace-controller`、`dsh-api-session-controller`（会话列表/归档按工作区分组），**不出现在任何 prompt 或插件装配代码里**。

### 6.4 工作区能影响的只有

| 维度 | 机制 | 位置 |
|---|---|---|
| 指令文件 | AGENTS.md 链按 cwd 发现，`maxBytes` 预算 | `dsh-agent-instructions/lib/index.js:1473-1498` |
| 沙箱根 | session cwd = workspace-write 边界 | `dsh-sandbox-policy/lib/index.js:166-174` |
| 工作目录上下文 | `working-directory:current` | `dsh-working-directory/lib/index.js:45-51` |
| 技能发现 | 按 cwd 扫描 skills 目录 | `dsh-tool-skill/lib/index.js:935-942` |

**没有**：同一 profile 下"不同 cwd 挂不同插件集"的能力。

---

## 7. 可行性判断与落地建议

### 7.1 判断

| 问题 | 结论 | 成本 |
|---|---|---|
| 能否在 waterfall 按段名剔除段 | **能**，官方语义允许，已有插件这么做 | 一个 ~100 行插件，无宿主改动 |
| 能否按"插件"识别段 | **不能**，只能靠段名→插件映射表 | 维护一张静态表；新插件需补 |
| 能否顺带砍工具 schema | 不能经 waterfall；要 `ctx.tools.restrict` | 需另做，scope 级 |
| 能否按工作区切换 | 需要自建"cwd → 段白名单"策略；宿主没有现成层级 | 策略在我们这边 |

### 7.2 建议形态

1. 一个 `scope: global` 的插件，监听 `system-prompt/assemble`，`{ prepend: true }` 但不抢先返回：拿到 `result = await next()`，再按 `context.agent?.session.header.cwd` 选策略，返回 `{ ...result, sections: result.sections.filter(...) }`。
2. 策略文件（放 profile 目录，随工作区读）形如 `{ "<cwd>": { denySections: ["ponytail", "plugin:dsh-imagegen", ...], denyContexts: [...] } }`。
3. 段名映射表用现有事实命名：`tool:*`（官方工具）、`plugin:<pkg>*`（第三方）、`mcp:*`、`<pkg>:*`。未知前缀一律保留（fail-open），并记日志。
4. 想同时省 token，必须并行做工具裁剪：`ctx.tools.restrict({ deny: [...] })`，这条收益远大于删段（§3.5）。
5. 注意 `complete` 段与 `runtimeContextSuppressed` 两个分支（§1.4），实现时先断言 `Array.isArray(result.sections)`。

### 7.3 未决点（写代码前要验）

1. `assembly` 在 waterfall 入口**没有** `tools` 字段（`index.js:396-400` 只构造三者），但 `dsh-ops` 在 `:206-210` 断言 `Array.isArray(result.tools)` 否则抛错 —— 二者不一致，实施前需在本机实测一次 waterfall 里的实际对象形状。
2. `refreshContext` 每步会重算 context 文本（`:326-348`），被删掉的 context 不会被补回，但 `required: true` 的在新一次 `assemble` 中必然重现 —— 删 `required` 上下文等于每步删一次，成本可忽略但要确认不会触发 `system-prompt/change` 风暴。
3. 段文本频繁变化会打掉前缀缓存（§1.5），策略应按工作区稳定、而不是按轮次变化。

---

## 8. 附录：证据文件索引

| 主题 | 文件（asar 内 / 本机） | 关键行 |
|---|---|---|
| 段注册表实现 | `@deepseek-ai/dsh-system-prompt/lib/index.js` | 119, 255-257, 281-283, 291-292, 301-302, 312-314, 358-413 |
| 事件类型与 waterfall 签名 | `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` | 5186-5191, 5557-5567, 7600-7607 |
| scope 层 | `@deepseek-ai/dsh-scope/lib/index.js` | 66-75, 132-180, 189-218 |
| 装配调用点 | `@deepseek-ai/dsh-agent-loop/lib/index.js` | 679-683, 839, 843-847, 850-858 |
| 装配上下文 | `@deepseek-ai/dsh-agent/lib/index.js` | 407-412 |
| 外部改 assembly 先例 | `@deepseek-ai/dsh-working-directory/lib/index.js` | 45-69 |
| 插件管理器 | `@deepseek-ai/dsh-plugin-manager/lib/index.js` | 2669-2682, 2688-2697, 3048-3075, 3120-3141 |
| HMR 重组 | `@deepseek-ai/dsh-hmr/lib/index.js` | 1312-1325, 1364-1373 |
| preset 定义 | `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml` | 全文件 |
| persona scope 语义 | `@deepseek-ai/dsh-persona/lib/index.js` | 4-16, 36-47 |
| 指令文件注入 | `@deepseek-ai/dsh-agent-instructions/lib/index.js` | 1409-1419, 1480-1498 |
| 技能目录注入 | `@deepseek-ai/dsh-tool-skill/lib/index.js` | 931-991 |
| 工具裁剪 API | `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` | 4004-4007, 9565-9566 |
| 本机 profile | `%USERPROFILE%\.dsh\profiles\desktop\package.json`、`cordis.patch.yml` | — |
