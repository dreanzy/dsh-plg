/**
 * 编排层：把三个纯模块接到宿主上（spec §6.1）。
 *
 * 这一层只做四件事：读会话身份、按 cwd 求值方案、按固定顺序落三条副作用、
 * 登记释放器。所有判定都不在这里——档位、描述、段文本、路由由纯模块给。
 *
 * 顺序是硬约束（spec §6.1）：**先注册工具，注册成功才 deny 官方 subagent，再注入段**。
 * 反过来一旦注册失败，模型会两个工具都没有，彻底失去委派能力。
 *
 * 失败一律只 `logger.warn` 并留一条 `lastError`：`agent/created` 是 serial 派发，
 * 监听器抛错会让会话创建失败。
 */

import { loadState, resolve, type ResolvedScheme, type SchemePathOptions } from './policy.js'
import { selectionOf } from './scheme.js'
import { delegationSection, resolvePrompt, type PromptText } from './prompt.js'
import type { SupportView } from './routes.js'
import { describeTiers, probeSupport, registerTierTool, type TierToolDeps } from './tools.js'

/**
 * 被屏蔽的官方工具名。
 *
 * 只有 `subagent_tier` 注册成功才 deny 它：留着官方工具，模型至少还能委派。
 */
const SUBAGENT_TOOL = 'subagent'

/**
 * 委派段的顺序值。
 *
 * 官方 `TOOL_SUBAGENT` 是 2800（那段「Start independent delegations using subagent_fork」），
 * 取 2850 让本段紧跟在它之后：既不与内置值冲突，又能在模型读到官方推荐后立刻被纠正。
 */
const DELEGATION_SECTION_ORDER = 2850

/* ------------------------------------------------------------------ *
 * 宿主面：只声明用到的形状
 * ------------------------------------------------------------------ */

/** 宿主 ctx 的最小面：订阅、纳管、取服务、记日志。 */
export interface PluginContext {
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(callback: () => unknown): unknown
  get(name: string): unknown
  logger: { info(message: string): void; warn(message: string): void }
}

/** `agent/session` 上本模块用到的面。 */
interface SessionLike {
  readonly seq?: number
  readonly header?: { readonly cwd?: string; readonly origin?: string }
  /** 物化全部事件。0.2.2 仍导出；新建会话时前置只有几条，成本可忽略。 */
  snapshotEvents?(): unknown
  /** 老宿主没有 snapshotEvents 时的回退。 */
  eventAt?(seq: number): unknown
}

/** `agent/model` 上本模块用到的面。入参交给 `selectionOf` 组装，这里只要求能调用。 */
interface ModelLike {
  select?(selection: unknown): void
}

/** `agent/created` 负载里的 Agent，只取本模块用到的字段。 */
interface AgentLike {
  readonly id: string
  readonly ctx: { get(name: string): unknown } | undefined
  readonly session: SessionLike
  readonly model: ModelLike | undefined
  /** 宿主给出的对象本体。`registerTierTool` 要原始对象去取 `agent.ctx.get('tools')`。 */
  readonly raw: unknown
}

/** 一个 agent 上由本插件登记的释放器。 */
interface AgentState {
  /**
   * 工具注销、restrict 释放、段释放，按登记顺序。
   *
   * 只在 `agent/disposed` 与插件卸载时统一调用。**不做重算撤销**：
   * 撤销工具之后再 deny 会撞车，模型会完全没有委派能力（spec §6.1）。
   */
  readonly disposers: Array<() => void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asAgentLike(value: unknown): AgentLike | null {
  const record = asRecord(value)
  if (record === null) return null
  const session = asRecord(record['session'])
  if (session === null) return null
  const id = record['id']
  if (typeof id !== 'string' || id === '') return null

  const ctx = record['ctx']
  const model = asRecord(record['model'])
  return {
    id,
    ctx:
      typeof ctx === 'object' && ctx !== null && typeof (ctx as { get?: unknown }).get === 'function'
        ? (ctx as { get(name: string): unknown })
        : undefined,
    session: session as unknown as SessionLike,
    model: model === null ? undefined : (model as unknown as ModelLike),
    raw: value,
  }
}

/** 会话的创建目录。空串按缺失处理：没有目录就没有工作区层。 */
function cwdOf(agent: AgentLike): string | null {
  const cwd = agent.session.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
}


/* ------------------------------------------------------------------ *
 * 句柄
 * ------------------------------------------------------------------ */

export interface HooksHandle {
  /** 插件重载后补施加：已有会话不会再收到 `agent/created`。 */
  bootstrap(): Promise<void>
  /** 退订全部事件并释放全部登记项。幂等。 */
  stopAll(): void
  /** 面板用的两格探测结果。 */
  support(): SupportView
  /** 最近一次失败原因（含原始错误文本）；成功后不清空，供面板显示。 */
  lastError(): string | undefined
}

export interface HooksOptions {
  /** 全局层根目录；只给测试用，生产路径走 `dshHomePath`。 */
  readonly home?: string
}

/* ------------------------------------------------------------------ *
 * 安装
 * ------------------------------------------------------------------ */

/**
 * 装好两个监听器。
 *
 * 只订阅 `agent/created` 与 `agent/disposed`：`agent/created` 是 serial 派发，
 * 必然早于该 agent 的首次装配，不需要 `agent/pre-step` 每步重算。
 */
export function installHooks(ctx: PluginContext, options: HooksOptions = {}): HooksHandle {
  const pathOptions: SchemePathOptions = options.home === undefined ? {} : { home: options.home }
  const states = new Map<string, AgentState>()
  /** 降级提示只打一次：这些分支每次建会话都会走到，逐次刷日志没有信息量。 */
  const warned = new Set<string>()

  /** 宿主是否支持过 `tools.restrict`。一旦确认支持就不再回退。 */
  let restrictFound = false
  /** 最近一次按 agent 作用域做的能力探测：`support()` 在根作用域拿不到 subagents，只能沿用它的结论。 */
  let lastProbe: ReturnType<typeof probeSupport> | undefined
  let lastErrorText: string | undefined

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn('model-scheme: ' + message)
  }

  const recordFailure = (agentId: string, error: unknown): void => {
    lastErrorText = 'agent=' + agentId + ' 施加失败：' + String(error)
    ctx.logger.warn('model-scheme: ' + lastErrorText)
  }

  /** 根 ctx 上的服务。取不到或取值抛错都按「没有」处理。 */
  const serviceOf = (name: string): Record<string, unknown> | undefined => {
    try {
      return asRecord(ctx.get(name)) ?? undefined
    } catch {
      return undefined
    }
  }

  /** agent 作用域的服务。`restrict()` 与 `section()` 都必须用作用域实例。 */
  const scopedService = (agent: AgentLike, name: string): Record<string, unknown> | undefined => {
    if (agent.ctx === undefined) return undefined
    try {
      return asRecord(agent.ctx.get(name)) ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 三种依赖在这里现组，每次重新取、不缓存——宿主 HMR 换服务后旧引用会指向死对象。
   *
   * `subagents` **必须从 agent 作用域取**：它由 delegation 组挂载，属于 preset/agent
   * 作用域，根 ctx 上根本没有。用根 ctx 取只会永远拿到 undefined，表现为
   * 「子代理插件明明装了，档位工具却从不注册、编排段从不注入」。
   */
  const tierDeps = (agent: AgentLike): TierToolDeps => ({
    resolveFor: async (cwd) => resolve(await loadState(cwd, pathOptions), cwd),
    llm: (scopedService(agent, 'llm') ?? serviceOf('llm')) as unknown as TierToolDeps['llm'],
    subagents: scopedService(agent, 'subagents') as unknown as TierToolDeps['subagents'],
    logger: { warn: (message: string) => ctx.logger.warn('model-scheme: ' + message) },
  })

  /* ---------------------------------------------------------------- *
   * 会话路由（spec §6.1 第 1 步）
   * ---------------------------------------------------------------- */

  /**
   * 会话是否已经真正跑过请求。
   *
   * 不能用 `model/selection` 当判据：宿主在**创建会话时**就写了一条初始选择
   * （实测事件序列 `session → permission/preset → sandbox/mode → approval/policy →
   * model/selection → subagent/model-selection-policy`）。把它当成「用户已经选过」，
   * 会让方案对每一个新建会话都不生效，而老会话因为已有 selection 或手动切换，
   * 看起来反而是好的——这是最难从表面现象反推的一类 bug。
   *
   * `request/header` 只在真正发出请求时出现，才是可靠判据。读不到事件接口时返回
   * false：新建会话本来就没有请求，放行才能让方案生效；兜底交给 select 自身的
   * 幂等短路（同一路由不会被重复记录）。
   */
  const hasRecordedRequest = (agent: AgentLike): boolean => {
    const session = agent.session
    const isHeader = (event: unknown): boolean => asRecord(event)?.['type'] === 'request/header'

    if (typeof session.snapshotEvents === 'function') {
      let events: unknown
      try {
        events = session.snapshotEvents()
      } catch (error) {
        warnOnce('session-read', '读取会话事件失败，本轮不改模型：' + String(error))
        return true
      }
      if (Array.isArray(events)) return events.some(isHeader)
    }

    const at = session.eventAt
    const length = session.seq
    if (typeof at === 'function' && typeof length === 'number') {
      for (let seq = 0; seq < length; seq += 1) {
        try {
          if (isHeader(at.call(session, seq))) return true
        } catch {
          return false
        }
      }
      return false
    }

    return false
  }

  const applySessionRoute = (agent: AgentLike, resolved: ResolvedScheme): void => {
    const route = resolved.scheme.session
    if (route === undefined) return
    if (hasRecordedRequest(agent)) return
    const select = agent.model?.select
    if (typeof select !== 'function') {
      warnOnce('no-select', '宿主的 agent.model.select 不可用，会话路由未注入')
      return
    }
    select.call(agent.model, selectionOf(route))
  }

  /* ---------------------------------------------------------------- *
   * 档位与段（spec §6.1 第 2、3 步）
   * ---------------------------------------------------------------- */

  /**
   * 注册 `subagent_tier`、deny 官方 `subagent`、注入委派段。
   *
   * 三者的依赖方向是单向的：没有可用档位就什么都不做；注册返回 null（能力不足、
   * 重名、取不到 tools）就既不 deny 也不注入——段里提到的工具必须真的存在。
   */
  const applyTierAndSection = (
    agent: AgentLike,
    resolved: ResolvedScheme,
    prompt: PromptText,
    state: AgentState,
  ): void => {
    // 这几条失败路径都把原因写进 lastErrorText：面板上能直接看到「为什么没注入」，
    // 而不是只看到工具凭空消失。排障时最贵的一步永远是「不知道哪一步没走通」。
    if (describeTiers(resolved) === null) {
      lastErrorText = '档位工具未注册：方案「' + resolved.id + '」没有配置任何档位'
      return
    }
    const deps = tierDeps(agent)
    const support = probeSupport(deps)
    // 面板的 support() 在根作用域上取不到 subagents，只能沿用它。
    lastProbe = support
    if (!support.subagents || !support.agentOptions) {
      lastErrorText = '档位工具未注册：' + (support.reason ?? '宿主不支持按档位指定模型')
      return
    }

    const disposeTool = registerTierTool(agent.raw, deps, support)
    if (disposeTool === null) {
      lastErrorText = '档位工具未注册：能力探测通过，但注册被宿主拒绝（详见日志）'
      return
    }
    state.disposers.push(disposeTool)

    const tools = scopedService(agent, 'tools')
    const restrict = tools?.['restrict']
    if (typeof restrict === 'function') {
      restrictFound = true
      try {
        const disposeRestrict = (restrict as (filter: { deny: readonly string[] }) => unknown).call(tools, {
          deny: [SUBAGENT_TOOL],
        })
        if (typeof disposeRestrict === 'function') state.disposers.push(disposeRestrict as () => void)
      } catch (error) {
        // 官方工具名可能不在该 agent 的清单里（宿主对整批校验，一个未知名会让全部失败）。
        // 这里不重试也不回滚已注册的工具：功能少了屏蔽，比少了委派好。
        warnOnce('restrict', '屏蔽官方 subagent 失败，模型可能绕过档位：' + String(error))
      }
    } else {
      warnOnce('no-restrict', '宿主没有 tools.restrict()，subagent_tier 已注册但官方 subagent 未被屏蔽')
    }

    const section = delegationSection(resolved, prompt)
    if (section === null) return
    const promptService = scopedService(agent, 'systemPrompt')
    const addSection = promptService?.['section']
    if (typeof addSection !== 'function') {
      warnOnce('no-prompt', '宿主没有 systemPrompt.section()，委派段未注入')
      return
    }
    try {
      const disposeSection = (addSection as (value: unknown) => unknown).call(promptService, {
        name: section.name,
        order: DELEGATION_SECTION_ORDER,
        text: section.text,
      })
      if (typeof disposeSection === 'function') state.disposers.push(disposeSection as () => void)
    } catch (error) {
      warnOnce('section', '注入委派段失败：' + String(error))
    }
  }

  /* ---------------------------------------------------------------- *
   * 施加
   * ---------------------------------------------------------------- */

  /** 一个 agent 的完整施加。`select` 为假时只做工具与段（补施加不走会话路由）。 */
  const applyOne = async (agent: AgentLike, state: AgentState, select: boolean): Promise<void> => {
    const cwd = cwdOf(agent)
    if (cwd === null) {
      warnOnce('no-cwd', 'agent 缺少 cwd，按空方案运行')
      return
    }
    const loaded = await loadState(cwd, pathOptions)
    // 读盘期间该 agent 可能已被销毁（onDisposed 先删了 states 项）。此时再注册工具或
    // 注入段，disposer 会挂到一个已删除的 state 上，永不释放。校验身份，不等就放弃。
    if (states.get(agent.id) !== state) return
    const resolved = resolve(loaded, cwd)
    // 提示词覆盖随 loadState 一起读上来；合并是纯函数，不额外碰盘。
    const prompt = resolvePrompt(loaded.prompts)
    if (select) applySessionRoute(agent, resolved)
    applyTierAndSection(agent, resolved, prompt, state)
  }

  const onCreated = async (payload: unknown): Promise<void> => {
    let agent: AgentLike | null = null
    try {
      const record = asRecord(payload)
      if (record === null) {
        warnOnce('payload', 'agent/created 负载形状不符，跳过')
        return
      }
      agent = asAgentLike(record['agent'])
      if (agent === null) {
        warnOnce('payload', 'agent/created 负载缺少 agent，跳过')
        return
      }
      // 子智能体的路由由父级在创建前捕获，这里插手会与 dsh-subagent 打架。
      if (agent.session.header?.origin === 'subagent') return

      // 新会话：模型、工具、段三样都做。
      // 恢复的会话：只做工具与段——模型选择已经写在它自己的日志里，不该被工作区方案改写，
      // 但工具和段挂在 agent 作用域上，agent 重建后旧注册随旧 agent 一起消失，
      // 不重新挂的话，恢复出来的会话只有模型、没有 subagent_tier，模型只能去调官方 subagent。
      const isStartup = record['source'] === 'startup'

      const state: AgentState = { disposers: [] }
      states.set(agent.id, state)
      await applyOne(agent, state, isStartup)
    } catch (error) {
      // 这个监听器抛错会让会话创建失败，所以一律吞掉降级。
      recordFailure(agent?.id ?? '?', error)
    }
  }

  const onDisposed = (payload: unknown): void => {
    const record = asRecord(payload)
    const agent = asAgentLike(record?.['agent'])
    if (agent === null) return
    const state = states.get(agent.id)
    if (state === undefined) return
    states.delete(agent.id)
    for (const dispose of state.disposers) {
      try {
        dispose()
      } catch {
        // 释放失败无副作用：agent 已经消失。
      }
    }
    state.disposers.length = 0
  }

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  const offs: Array<() => void> = []
  // 事件名必须带斜杠，与宿主 emit 的字符串逐字一致；写成点号不会报错，也永远不会被调用。
  try {
    offs.push(ctx.on('agent/created', onCreated))
    offs.push(ctx.on('agent/disposed', onDisposed))
  } catch (error) {
    ctx.logger.warn('model-scheme: 订阅会话事件失败，方案不会在新建会话时生效：' + String(error))
  }

  const stopAll = (): void => {
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {
        // 退订失败不影响后续释放。
      }
    }
    for (const state of states.values()) {
      for (const dispose of state.disposers) {
        try {
          dispose()
        } catch {
          // 同上。
        }
      }
      state.disposers.length = 0
    }
    states.clear()
  }

  /**
   * 插件重载后补一次施加。
   *
   * `states` 是进程内表，插件一重载就清空；而那些已经存在的会话不会再收到
   * `agent/created`，于是一直没有 `subagent_tier` 与委派段。补施加**不碰会话路由**：
   * 老会话的模型是用户的选择，插件无权改写。
   */
  const bootstrap = async (): Promise<void> => {
    let list: unknown[] = []
    try {
      const agents = serviceOf('agents')
      const raw = typeof agents?.['list'] === 'function' ? (agents['list'] as () => unknown).call(agents) : []
      list = Array.isArray(raw) ? raw : []
    } catch {
      return
    }

    for (const entry of list) {
      let agent: AgentLike | null = null
      try {
        agent = asAgentLike(entry)
        if (agent === null || states.has(agent.id)) continue
        if (agent.session.header?.origin === 'subagent') continue
        if (cwdOf(agent) === null) continue
        const state: AgentState = { disposers: [] }
        states.set(agent.id, state)
        await applyOne(agent, state, false)
      } catch (error) {
        ctx.logger.warn('model-scheme: 补施加失败（agent=' + (agent?.id ?? '?') + '）：' + String(error))
      }
    }
  }

  const support = (): SupportView => {
    let restrict = restrictFound
    if (!restrict) {
      const root = serviceOf('tools')
      restrict = typeof root?.['restrict'] === 'function'
    }
    // support() 在根作用域上，拿不到 subagents；沿用最近一次按 agent 作用域做的探测。
    //
    // 没有历史探测时按「可用」放行，而不是「不可用」：面板拿这一格决定是否禁用
    // 档位编辑，判成 false 会让用户「没开会话就配不了方案」。真正的可用性在
    // agent/created 时按会话判断，那时才是唯一有意义的时点。
    const probe = lastProbe ?? { subagents: true, agentOptions: true }
    return {
      // 第一格是「档位委派能不能工作」：服务在但 provider 不支持 agentOptions 时同样不可用。
      subagents: probe.subagents && probe.agentOptions,
      restrict,
      ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    }
  }

  return {
    bootstrap,
    stopAll,
    support,
    lastError: () => lastErrorText,
  }
}
