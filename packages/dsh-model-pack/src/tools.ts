/**
 * 档位委派工具 `subagent_tier`（spec §6.2 的五步执行、§6.4 的降级矩阵）。
 *
 * 这一层只做「按档位把独立任务派出去」：解析 pack → 取该档路由链 → 逐条探测
 * `llm.resolveCallConfig` → 通过则 `subagents.startActivation`。探测失败是
 * **确定性失败**，可以前进到备选；子任务自己跑挂了不是确定性失败，不换模型重跑。
 *
 * 与编排层的边界：本文件不 `restrict`、不订阅事件、不注入提示词段。注册成功之后
 * 由编排层决定是否 deny 官方 `subagent`（顺序反过来会让模型完全失去委派能力）。
 *
 * 工具定义不走 `@deepseek-ai/dsh-tools` 的 `defineTool`：那个包不是本包的依赖，
 * 而 package.json 不在本 ticket 的改动范围内。这里直接构造 `defineTool` 产出的
 * 同形状对象（`parameters` 与 `output.schema` 都是原始 JSON Schema），
 * 宿主 `tools.register()` 只读 `name` / `output` / `parameters`，形状一致即可。
 */

import { cwdFromAgent } from '@dreanzy/dsh-pack-core'
import { TIER_DEFAULT_NAMES, TIER_IDS, isTierId, selectionOf, type Route, type TierId } from './pack.js'
import type { ResolvedPack } from './policy.js'

/**
 * 委派标签的前缀：`t1`…`t4`。
 *
 * 子智能体在会话列表里只显示 label，委派一多就分不出哪条是深算、哪条是侦察。
 * 前缀比档名短，四个并排也不挤。
 */
const TIER_SHORT: Readonly<Record<TierId, string>> = {
  tier1: 't1',
  tier2: 't2',
  tier3: 't3',
  tier4: 't4',
}

/** 工具名。编排层与提示词段都按这个名字引用。 */
export const TIER_TOOL_NAME = 'subagent_tier'

/** 工具描述的 token 预算（spec §6.3）。与段的预算分开断言：两处各有上限。 */
export const TIER_DESCRIPTION_MAX_TOKENS = 400

/**
 * 使用的子智能体 provider。
 *
 * 只有 in-process 的 spawn 后端公布 `capabilities.agentOptions = true`；
 * 跨进程后端一律不支持按档位指定模型（spec §6.4 的降级前提）。
 */
const PROVIDER_NAME = 'spawn'

/** 编排层注入的依赖。签名由编排层按此调用，不得改名。 */
export interface TierToolDeps {
  /** 解析 cwd 当前生效的 pack；由编排层注入，测试用替身 */
  resolveFor(cwd: string | null): Promise<ResolvedPack>
  /** 宿主 llm 服务，只用 resolveCallConfig */
  llm: { resolveCallConfig(sel: unknown): { provider: string; model: string } } | undefined
  /** 宿主 subagents 服务，只用 startActivation 与 providerOf/能力探测 */
  subagents: Record<string, unknown> | undefined
  logger: { warn(message: string): void }
}

/** 能力探测结果。面板按 `subagents` / `agentOptions` 两格置灰或标红。 */
export interface TierSupport {
  readonly subagents: boolean
  readonly agentOptions: boolean
  readonly reason?: string
}

/** provider 上本文件用到的那个字段。 */
interface ProviderLike {
  readonly capabilities?: Record<string, unknown>
}

/** `tools.register()` 的最小面。 */
interface ToolsLike {
  register(definition: unknown): unknown
}

/** `execute(args, exec)` 的 exec 上本文件用到的字段。 */
interface ToolExecLike {
  readonly agent?: unknown
  readonly signal?: unknown
}

/** 工具返回值。成功只有 activation；失败是普通结果，不是抛异常。 */
interface TierToolResult {
  readonly kind: 'activation' | 'error'
  readonly subagentId?: string
  readonly tier?: string
  readonly message?: string
}

/** 一档在描述里的那一行。 */
interface TierEntry {
  readonly id: TierId
  readonly name: string
}

/** 注册后会被异步刷新的一次性状态：`description` 与 `tier` 枚举都从这里读。 */
interface ToolState {
  description: string
  parameters: Record<string, unknown>
}

function warn(deps: TierToolDeps, message: string): void {
  try {
    deps.logger.warn(message)
  } catch {
    // 日志本身坏了也不能让工具注册或执行失败。
  }
}

/* ------------------------------------------------------------------ *
 * 档位目录与描述文本
 * ------------------------------------------------------------------ */

/** 有首选路由的档才进目录。缺省的档不暴露给模型（spec §5）。 */
function catalogOf(resolved: ResolvedPack | undefined): TierEntry[] {
  const tiers = resolved?.pack?.tiers
  const entries: TierEntry[] = []
  for (const id of TIER_IDS) {
    const tier = tiers?.[id]
    if (tier === undefined || tier.primary === undefined) continue
    entries.push({ id, name: tier.name })
  }
  return entries
}

/** 注册那一刻还不知道 pack，先用出厂显示名的四档表顶着，随后由 refreshCatalog 覆盖。 */
function defaultCatalog(): TierEntry[] {
  return TIER_IDS.map((id) => ({ id, name: TIER_DEFAULT_NAMES[id] }))
}

/**
 * 工具描述。
 *
 * 用英文：这段文本会进模型的工具清单，与系统提示词同属「给模型读的正文」，
 * 不随界面语言变。档名来自 pack（出厂是英文），所以整段不会中英混排。
 */
function renderDescription(catalog: readonly TierEntry[]): string {
  const table = catalog.map((entry) => `${entry.id} (${entry.name})`).join(', ')
  return `Delegate an independent task to a subagent by difficulty tier. The model and reasoning effort for each tier come from the active pack. tier accepts only: ${table}. Parameters: tier — the tier id; prompt — the complete task description (the subagent cannot see this conversation, so include everything it needs); label — a 3-5 word display name; cwd — the subagent's initial working directory, defaults to the caller's. Always use this for independent tasks; use subagent_fork only when the task needs this conversation's context.`
}

/**
 * 工具描述文本（含四档表，只列当前 pack 里配了首选的档）。
 *
 * 无可用档位时返回 `null`：编排层据此不注册工具、不注入提示词段、也不 deny 官方
 * `subagent`——留着官方工具总比让模型彻底不能委派好。
 */
export function describeTiers(resolved: ResolvedPack): string | null {
  try {
    const catalog = catalogOf(resolved)
    return catalog.length === 0 ? null : renderDescription(catalog)
  } catch {
    return null
  }
}

/** 参数 schema：`tier` 的枚举就是当前可用的档。 */
function parametersFor(ids: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: [...ids], description: 'Difficulty tier id; see the tier table in the description.' },
      prompt: { type: 'string', description: 'The complete task description; the subagent cannot see this conversation.' },
      label: { type: 'string', description: 'A 3-5 word display name.' },
      cwd: { type: 'string', description: "The subagent's initial working directory; defaults to the caller's." },
    },
    required: ['tier', 'prompt'],
  }
}

/* ------------------------------------------------------------------ *
 * 能力探测
 * ------------------------------------------------------------------ */

function providerOf(subagents: Record<string, unknown>): ProviderLike | undefined {
  const lookup = subagents['getProvider'] ?? subagents['providerOf']
  if (typeof lookup !== 'function') return undefined
  const provider = (lookup as (name: string) => unknown).call(subagents, PROVIDER_NAME)
  return typeof provider === 'object' && provider !== null ? (provider as ProviderLike) : undefined
}

/**
 * 宿主是否支持档位委派（供面板显示）。
 *
 * 三格全过才注册：服务存在、`startActivation` 是函数、provider 公布
 * `capabilities.agentOptions === true`。任何一步失败都只返回原因，不抛。
 */
export function probeSupport(deps: TierToolDeps): TierSupport {
  try {
    const subagents = deps.subagents
    if (subagents === undefined || subagents === null) {
      return { subagents: false, agentOptions: false, reason: '子智能体服务未启用（subagents 不存在）' }
    }
    const start = subagents['startActivation']
    if (typeof start !== 'function') {
      return { subagents: false, agentOptions: false, reason: `子智能体服务的 startActivation 不是函数（实际为 ${typeof start}）` }
    }
    let provider: ProviderLike | undefined
    try {
      provider = providerOf(subagents)
    } catch (error) {
      return { subagents: true, agentOptions: false, reason: `查询子智能体 provider 失败：${String(error)}` }
    }
    if (provider === undefined) {
      return { subagents: true, agentOptions: false, reason: `没有注册名为「${PROVIDER_NAME}」的子智能体 provider` }
    }
    const capabilities = provider.capabilities
    if (capabilities?.['agentOptions'] !== true) {
      return { subagents: true, agentOptions: false, reason: `provider「${PROVIDER_NAME}」不支持 agentOptions，无法按档位指定模型` }
    }
    return { subagents: true, agentOptions: true }
  } catch (error) {
    return { subagents: false, agentOptions: false, reason: `子智能体能力探测失败：${String(error)}` }
  }
}

/* ------------------------------------------------------------------ *
 * cwd
 * ------------------------------------------------------------------ */

const EMPTY = Symbol('empty')

function readCwd(value: unknown): string | typeof EMPTY | undefined {
  if (typeof value !== 'object' || value === null) return EMPTY
  const cwd = (value as { cwd?: unknown }).cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : EMPTY
}

/**
 * 调用方的 cwd。
 *
 * 宿主没有把 `workingDirectory` 服务交给本工具（依赖面只有四个字段），
 * 所以这里按会话头取：`agent.session.header.cwd` 就是该会话的创建目录。
 */
function callerCwd(agent: unknown): string | null {
  try {
    // 投影优先：`cd` 与切换工作区只改投影，`header.cwd` 是创建时的快照。
    const projected = cwdFromAgent(agent)
    if (projected !== null) return projected
    const direct = readCwd(agent)
    if (typeof direct === 'string') return direct
    const session = (agent as { session?: unknown } | null | undefined)?.session
    const fromSession = readCwd(session)
    if (typeof fromSession === 'string') return fromSession
    const header = (session as { header?: unknown } | undefined)?.header
    const fromHeader = readCwd(header)
    if (typeof fromHeader === 'string') return fromHeader
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */


function routeLabel(route: Route): string {
  return `${route.provider}/${route.model}`
}

/**
 * 探测一条路由是否可用。
 *
 * 没有 llm 服务时跳过探测（返回 `undefined` = 当作可用）：探测不了不等于不可用，
 * 而挡住整条链会让插件在退化环境里彻底失效。
 */
async function probeRoute(deps: TierToolDeps, route: Route): Promise<string | undefined> {
  const llm = deps.llm
  if (llm === undefined || llm === null || typeof llm.resolveCallConfig !== 'function') return undefined
  try {
    await llm.resolveCallConfig(selectionOf(route))
    return undefined
  } catch (error) {
    return String(error)
  }
}

/** 启动一个子智能体，返回 childId。宿主契约要求 `request.parent` 是活的父 agent。 */
async function startSubagent(
  deps: TierToolDeps,
  route: Route,
  prompt: string,
  args: Record<string, unknown>,
  parent: unknown,
  signal: unknown,
): Promise<string> {
  const subagents = deps.subagents
  if (subagents === undefined || subagents === null) throw new Error('subagents service unavailable')
  const start = subagents['startActivation']
  if (typeof start !== 'function') throw new Error('subagents.startActivation is not a function')

  const request: Record<string, unknown> = {
    prompt: [{ type: 'text', text: prompt }],
    agentOptions: selectionOf(route),
  }
  if (parent !== undefined && parent !== null) request['parent'] = parent
  const cwd = args['cwd']
  if (typeof cwd === 'string' && cwd.trim() !== '') request['cwd'] = cwd

  // 宿主默认的递归预算（maxDepth，缺省 1）必须由调用方带上：官方 subagent 工具传
  // resolveMaxDepth 的结果，本工具不传就会绕过它——用户把 maxDepth 设成 0 时，
  // 官方工具拒绝委派，这里照样派出深度 1 的子智能体。
  const resolveMaxDepth = subagents['resolveMaxDepth']
  if (typeof resolveMaxDepth === 'function') {
    const maxDepth = (resolveMaxDepth as (configured?: unknown) => unknown).call(subagents, undefined)
    if (typeof maxDepth === 'number') request['maxDepth'] = maxDepth
  }

  const spec: Record<string, unknown> = { provider: PROVIDER_NAME, delivery: 'parent', request }
  // 标签前缀 `t1`…`t4`：委派一多，光看名字分不出哪条是深算、哪条是侦察。
  // 用户给的 label 接在后面，没有 label 就只留前缀。
  const given = typeof args['label'] === 'string' ? args['label'].trim() : ''
  const prefix = TIER_SHORT[args['tier'] as TierId] ?? ''
  if (prefix !== '') spec['label'] = given === '' ? prefix : prefix + ' ' + given
  if (signal !== undefined) spec['signal'] = signal

  const activation = await (start as (value: unknown) => Promise<unknown>).call(subagents, spec)
  const childId = (activation as { childId?: unknown } | null | undefined)?.childId
  if (typeof childId !== 'string' || childId === '') throw new Error('startActivation did not return a childId')
  return childId
}

function errorResult(message: string, tier?: string): TierToolResult {
  return { kind: 'error', message, ...(tier === undefined ? {} : { tier }) }
}

async function runTool(
  rawArgs: unknown,
  exec: ToolExecLike | undefined,
  registeredAgent: unknown,
  deps: TierToolDeps,
): Promise<TierToolResult> {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const tierArg = typeof args['tier'] === 'string' ? args['tier'] : ''

  try {
    if (!isTierId(tierArg)) {
      return errorResult(`tier must be one of ${TIER_IDS.join(' / ')}; got "${tierArg}".`)
    }
    const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : ''
    if (prompt.trim() === '') return errorResult('prompt must not be empty: the subagent cannot see this conversation, so it needs a complete description.', tierArg)

    if (typeof deps.resolveFor !== 'function') return errorResult('pack resolution unavailable (resolveFor not injected).', tierArg)

    const agent = exec?.agent ?? registeredAgent
    let resolved: ResolvedPack
    try {
      // 只按调用方会话的目录求值：cwd 参数是子智能体的工作目录，不参与 pack 选择。
      // 否则模型传一个别的目录就能换一套路由，面板上配的绑定对它不成立。
      resolved = await deps.resolveFor(callerCwd(agent))
    } catch (error) {
      return errorResult(`Failed to resolve pack; subagent not started: ${String(error)}`, tierArg)
    }

    const tier = resolved?.pack?.tiers?.[tierArg]
    if (tier === undefined || tier.primary === undefined) {
      const available = catalogOf(resolved).map((entry) => `${entry.id} (${entry.name})`).join(', ') || '(none)'
      return errorResult(`Pack "${resolved?.id ?? '?'}" has no tier ${tierArg}; available tiers: ${available}.`, tierArg)
    }

    if (deps.llm === undefined || deps.llm === null) {
      warn(deps, 'subagent_tier：llm 服务不可用，跳过路由探测，直接用该档首选启动')
    }

    const chain: Route[] = [tier.primary, ...tier.fallbacks]
    const failures: string[] = []
    for (const route of chain) {
      const probeError = await probeRoute(deps, route)
      if (probeError !== undefined) {
        failures.push(`${routeLabel(route)}（${probeError}）`)
        warn(deps, `subagent_tier：档 ${tierArg} 的路由 ${routeLabel(route)} 探测失败，试下一条：${probeError}`)
        continue
      }
      let subagentId: string
      try {
        subagentId = await startSubagent(deps, route, prompt, args, agent, exec?.signal)
      } catch (error) {
        warn(deps, `subagent_tier：档 ${tierArg} 用 ${routeLabel(route)} 启动失败：${String(error)}`)
        return errorResult(`Tier ${tierArg} route ${routeLabel(route)} passed the probe but failed to start: ${String(error)}. Per policy, no fallback retry.`, tierArg)
      }
      return { kind: 'activation', subagentId, tier: tierArg }
    }

    const tried = failures.length === 0 ? '（无可尝试的路由）' : failures.join('；')
    return errorResult(`All ${String(chain.length)} routes for tier ${tierArg} are unavailable; subagent not started: ${tried}`, tierArg)
  } catch (error) {
    warn(deps, `subagent_tier 执行失败：${String(error)}`)
    return errorResult(`Execution failed: ${String(error)}`, tierArg === '' ? undefined : tierArg)
  }
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['activation', 'error'], description: 'activation = started; error = not started, see message.' },
    subagentId: { type: 'string', description: 'Session id of the started subagent.' },
    tier: { type: 'string', description: 'The tier id used for this dispatch.' },
    message: { type: 'string', description: 'Failure reason, including the routes that were tried.' },
  },
  required: ['kind'],
}

function toolsOf(agent: unknown): ToolsLike | null {
  const ctx = (agent as { ctx?: unknown } | null | undefined)?.ctx
  if (typeof ctx !== 'object' || ctx === null) return null
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return null
  const tools = (get as (name: string) => unknown).call(ctx, 'tools')
  if (typeof tools !== 'object' || tools === null) return null
  if (typeof (tools as { register?: unknown }).register !== 'function') return null
  return tools as ToolsLike
}

/** 注册成功后刷新描述与 tier 枚举；失败只 warn，沿用出厂四档表。 */
async function refreshCatalog(
  state: ToolState,
  deps: TierToolDeps,
  agent: unknown,
  isDisposed: () => boolean,
): Promise<void> {
  try {
    if (typeof deps.resolveFor !== 'function') return
    const resolved = await deps.resolveFor(callerCwd(agent))
    if (isDisposed()) return
    const catalog = catalogOf(resolved)
    if (catalog.length === 0) {
      warn(deps, 'subagent_tier：当前 pack 没有任何档位配置，工具虽已注册但调用都会返回错误')
      return
    }
    state.description = renderDescription(catalog)
    state.parameters = parametersFor(catalog.map((entry) => entry.id))
  } catch (error) {
    warn(deps, `subagent_tier：描述刷新失败，沿用出厂四档表：${String(error)}`)
  }
}

/**
 * 注册到该 agent 作用域。返回 disposer；能力不足返回 `null`（不抛）。
 *
 * 注册是同步的，而 pack 解析是异步的，所以描述与 `tier` 枚举先给出厂四档表，
 * 注册后立刻异步刷新成该 agent 实际 pack 的档位。调用方应当先用 `describeTiers`
 * 判断「有没有可用档」，没有就不调用本函数——注册之后再撤销，会让已经 deny 掉
 * 官方 `subagent` 的模型两个工具都没有。
 */
export function registerTierTool(
  agent: unknown,
  deps: TierToolDeps,
  known?: TierSupport,
): (() => void) | null {
  try {
    // 编排层在调用前已经探测过一次（它还要拿结果做降级判断）。传进来就复用，
    // 免得同一个 agent 上跑两遍 provider 查询；不传时自行探测，保持单独可调用。
    const support = known ?? probeSupport(deps)
    if (!support.subagents || !support.agentOptions) {
      warn(deps, `subagent_tier 未注册：${support.reason ?? '宿主不支持档位委派'}`)
      return null
    }

    const tools = toolsOf(agent)
    if (tools === null) {
      warn(deps, 'subagent_tier 未注册：agent.ctx 里取不到 tools 服务')
      return null
    }

    const state: ToolState = {
      description: renderDescription(defaultCatalog()),
      parameters: parametersFor([...TIER_IDS]),
    }

    let disposed = false
    const definition = {
      name: TIER_TOOL_NAME,
      get description(): string {
        return state.description
      },
      get parameters(): Record<string, unknown> {
        return state.parameters
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (args: unknown, value: TierToolResult) => {
          const tier = (args as { tier?: unknown } | null)?.tier
          const suffix = typeof tier === 'string' ? `（${tier}）` : ''
          return [{
            type: 'text',
            text: value.kind === 'activation' ? `已启动子智能体 ${value.subagentId ?? ''}${suffix}` : (value.message ?? '未启动子智能体'),
          }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(rawArgs: unknown, exec?: ToolExecLike): Promise<TierToolResult> {
        return await runTool(rawArgs, exec, agent, deps)
      },
    }

    let unregister: () => void
    try {
      const result = tools.register(definition)
      unregister = typeof result === 'function' ? (result as () => void) : () => {}
    } catch (error) {
      warn(deps, `subagent_tier 注册失败，未注册任何工具：${String(error)}`)
      return null
    }

    void refreshCatalog(state, deps, agent, () => disposed)

    return () => {
      disposed = true
      try {
        unregister()
      } catch (error) {
        warn(deps, `subagent_tier 注销失败：${String(error)}`)
      }
    }
  } catch (error) {
    warn(deps, `subagent_tier 注册过程异常，未注册任何工具：${String(error)}`)
    return null
  }
}
