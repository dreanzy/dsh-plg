import { candidateTools, defaultCatalogFeed, type CatalogFeed } from './catalog.js'
import { cwdFromAgent } from './cwd.js'
import { effective, type Effective } from './effective.js'
import { createReconciler } from './reconcile.js'
import { loadState, type PolicyState } from './store.js'
import { LOCKED_TOOLS, type Catalog } from './types.js'

/**
 * 生效层：把「停用插件」落到两条通道上。
 *
 * 一个插件对模型的贡献只有两类，通道不同，做法也必须不同：
 * - 工具在装配之后才挂回，agent/pre-step 之类改不了它，只能走 tools.restrict({ deny })；
 * - 段在 system-prompt/assemble waterfall 里成形，那边不能 restrict，只能剔数组。
 *
 * 两条通道共用一份「这个 agent 停用了哪些包」的快照：策略读一次，两边同时用。
 *
 * 降级原则（见 ADR 0001）：任何一条读不到就「本轮不动」。宁可放开，也不误删——
 * 多省几百 token 远不如删错一个 1300 字符的段严重。所有失败路径都只 warn，
 * 因为 agent/created 是 serial 派发，监听器抛错会让会话创建失败。
 */

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

/** restrict() 的掩码。本插件只用 deny：语义是「关」，不是「开」。 */
export interface RestrictFilter {
  readonly deny: readonly string[]
}

export interface ToolDefinitionLike {
  readonly name: string
  readonly description?: string
}

export interface ToolSchemaLike {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

/**
 * 宿主 tools 服务在本插件用到的面。
 *
 * restrict 可选：0.2.1 之前的宿主没有它。调用点必须显式判一次
 * typeof … === 'function'，那个分支正是「旧宿主照常加载、面板标红」的实现。
 */
export interface ToolsFace {
  definitions(scope?: unknown, toolSet?: unknown): readonly ToolDefinitionLike[]
  schemas(scope?: unknown, toolSet?: unknown): readonly ToolSchemaLike[]
  restrict?(filter: RestrictFilter): () => unknown
}

/** 宿主是否提供两条通道的能力，供面板标红。 */
export interface Support {
  readonly restrict: boolean
  readonly promptFilter: boolean
}

/** agent/created 负载里的 Agent，只取本插件用到的字段。 */
interface AgentLike {
  readonly id: string
  readonly ctx: { get(name: string): unknown } | undefined
  readonly session: { readonly id: string; readonly header?: { readonly cwd?: string } }
  /** 宿主给出的对象本体。作用域链按对象身份索引，替身查不到 agent 层。 */
  readonly raw: unknown
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
  const sessionId = session['id']
  if (typeof id !== 'string' || typeof sessionId !== 'string') return null
  const header = asRecord(session['header'])
  const cwd = header?.['cwd']
  const ctx = record['ctx']
  return {
    id,
    ctx: typeof ctx === 'object' && ctx !== null ? (ctx as { get(name: string): unknown }) : undefined,
    session: { id: sessionId, ...(typeof cwd === 'string' ? { header: { cwd } } : {}) },
    raw: value,
  }
}

function cwdOf(agent: AgentLike): string | null {
  return cwdFromAgent(agent.raw)
}

/**
 * 取该 Agent 作用域的 tools 实例。
 *
 * 必须由 agent.ctx.get('tools') 取：restrict() 内部按调用方的 ctx 推导作用域层，
 * 从根 ctx 取到的同一个服务对象调用它会直接抛「requires a scoped context」——
 * 那正是宿主防止一次限制误伤所有 agent 的护栏。
 */
function scopedTools(agent: AgentLike): ToolsFace | null {
  const get = agent.ctx?.get
  if (typeof get !== 'function') return null
  try {
    const service = get.call(agent.ctx, 'tools')
    if (typeof service !== 'object' || service === null) return null
    return service as ToolsFace
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 快照
 * ------------------------------------------------------------------ */

/**
 * 某个 agent 当前生效的停用集合。
 *
 * 只有段名：工具那条通道每次重算都从目录与清单现算（掩码还要并上一轮施加的名单，
 * 没法从快照里读）。段名来自静态扫描，认不出的段不在里面——那正是「宁可放开」的落点。
 */
interface Snapshot {
  readonly sections: ReadonlySet<string>
}

const EMPTY_SNAPSHOT: Snapshot = { sections: new Set<string>() }

function buildSnapshot(catalog: Catalog | null, resolver: Effective): Snapshot {
  if (catalog === null) return EMPTY_SNAPSHOT
  const sections = new Set<string>()
  for (const plugin of catalog.plugins) {
    if (resolver.isOpen(plugin.pkg)) continue
    for (const name of plugin.sections) sections.add(name)
  }
  return { sections }
}

/**
 * 从当前清单里挑出要 deny 的名字。
 *
 * 名字有两个来源，都是「这个插件注册了什么」的证据，只是强度不同：
 * - `plugin.tools`：结构扫描认出的 `defineTool({ name })`；
 * - `candidateTools`：包源码里出现过的 name 字面量，且没有第二个包写过它。
 *
 * 两个过滤都不能省：
 * - 只在当前清单里：restrict() 对未知全局工具名直接抛错，而宿主对整批校验，
 *   一个残留名字会让全部限制失败。目录里记着但已被卸载的插件工具必须挡在外面。
 *   这一条同时也挡住了候选名的过期形态：名字不再真实注册，就不会进掩码。
 * - 锁定工具永不进：run_code 被宿主判为保留名，写进去同样是整批拒绝。
 *
 * deniedBefore 并入清单是必需的：限制一生效 definitions() 就看不见被关掉的工具，
 * 只用可见集合求值会得出「没有要关的」→ 释放 → 下一轮又出现，每次重算都白重建掩码。
 */
function denyFor(
  catalog: Catalog,
  resolver: Effective,
  visible: ReadonlySet<string>,
  deniedBefore: readonly string[],
): string[] {
  const known = new Set<string>(visible)
  for (const name of deniedBefore) known.add(name)
  const extras = candidateTools(catalog)
  const out = new Set<string>()
  for (const plugin of catalog.plugins) {
    if (resolver.isOpen(plugin.pkg)) continue
    const candidates = extras.get(plugin.pkg)
    const names = candidates === undefined ? plugin.tools : [...plugin.tools, ...candidates]
    for (const name of names) {
      if (LOCKED_TOOLS.has(name)) continue
      if (known.has(name)) out.add(name)
    }
  }
  return [...out].sort()
}

interface AgentState {
  readonly agent: AgentLike
  /** 隐藏集的规范串，用来跳过没有变化的重新施加。 */
  key: string
  /** 施加后复验仍然可见的名字。 */
  stuck: readonly string[]
  /** 本轮实际施加的 deny 名单，见 denyFor 的并集说明。 */
  denied: readonly string[]
  /** 段通道读的快照。null 表示这一轮没算成（目录或策略不可用）。 */
  snapshot: Snapshot | null
}

/**
 * 从宿主拒绝信息里取出被判为「未知全局工具」的名字。
 *
 * 错误形如 tools.restrict() names unknown global tool "x", "y"; known global tools: …
 * 只认引号内的片段，调用方还要再和掩码比对，避免把消息里其他引号内容当成名字。
 */
function unknownNamesIn(error: unknown, candidates: readonly string[]): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const present = new Set(candidates)
  const out: string[] = []
  for (const match of message.matchAll(/"([^"]+)"/g)) {
    const name = match[1]
    if (name !== undefined && present.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 装配侧：waterfall 的形状
 * ------------------------------------------------------------------ */

interface PromptSectionLike {
  readonly name?: string
  readonly text?: string
  readonly interpolate?: boolean
}

/** system-prompt/assemble 的 payload。可变，返回即生效。 */
interface PresentationLike {
  sections: PromptSectionLike[]
  contexts?: unknown[]
  variables?: Record<string, string | undefined>
}

function asPresentation(value: unknown): PresentationLike | null {
  const record = asRecord(value)
  if (record === null) return null
  if (!Array.isArray(record['sections'])) return null
  return value as PresentationLike
}

/**
 * 按段名精确剔除。
 *
 * 不做前缀猜测：删错一个 1300 字符的段等于废掉一个插件的能力，而且没有兜底。
 * 认不出的段一律不动（见 ADR 0001）。
 */
function keepSections(sections: readonly PromptSectionLike[], removed: ReadonlySet<string>): PromptSectionLike[] {
  const kept: PromptSectionLike[] = []
  for (const section of sections) {
    const name = typeof section?.name === 'string' ? section.name : null
    if (name !== null && removed.has(name)) continue
    kept.push(section)
  }
  return kept
}

export interface HooksHandle {
  /** 保存策略后重新施加：策略写入不产生宿主事件，只能由路由显式触发。 */
  reapply(): Promise<void>
  /** 插件重载后补施加：已有会话不会再收到 agent/created。 */
  bootstrap(): Promise<void>
  stopAll(): void
  /** 各 agent 复验后仍关不掉的名字（并集、排序）。 */
  stuck(): readonly string[]
  /** 两条通道各自是否可用，供面板标红。 */
  support(): Support
}

export interface HooksOptions {
  /** 目录来源。缺省走 catalog.ts；测试注入替身。 */
  readonly catalog?: CatalogFeed
}

/**
 * 装好监听器并返回重新施加的入口。
 *
 * 只订阅 agent/created、agent/disposed 与 system-prompt/assemble。
 * 不挂 agent/pre-step：agent/created 是 serial 派发，必然早于该 Agent 的首次装配；
 * 而限制是「按 agent 一条掩码」，改一次即对后续每个模型步骤生效，不需要每步重算。
 */
export function installHooks(ctx: PluginContext, options?: HooksOptions): HooksHandle {
  const feed = options?.catalog ?? defaultCatalogFeed
  const states = new Map<string, AgentState>()
  /**
   * 限制的释放记账。按 agent id 串行：同一主体的下一轮不会与上一轮重叠，
   * 落地前先释放上一轮的资源；计划没变时调用方就跳过，这里只管落地。
   */
  const reconcile = createReconciler((message) => ctx.logger.warn('dsh-plugin-pack: ' + message))
  /** 对象身份索引：assemble 的 context.scope 就是 agent 本体。 */
  const byIdentity = new WeakMap<object, Snapshot>()
  /** 身份查不到时按 agent id / session id 回退。 */
  const byId = new Map<string, Snapshot>()

  /** 宿主是否支持过 restrict。一旦确认支持就不再回退。 */
  let restrictFound = false
  /** 是否成功订阅过装配事件。 */
  let promptFilterFound = false
  /** 各类降级只提示一次：这些分支每次重算都会走到，逐次刷日志没有信息量。 */
  const warned = new Set<string>()

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn('dsh-plugin-pack: ' + message)
  }

  const readCatalog = (): Catalog | null => {
    try {
      return feed.read()
    } catch (error) {
      warnOnce('catalog-read', '读取插件目录失败，本轮不改变限制：' + String(error))
      return null
    }
  }

  const publish = (state: AgentState): void => {
    const snapshot = state.snapshot
    if (snapshot === null) return
    if (typeof state.agent.raw === 'object' && state.agent.raw !== null) {
      byIdentity.set(state.agent.raw, snapshot)
    }
    byId.set(state.agent.id, snapshot)
    byId.set(state.agent.session.id, snapshot)
  }

  const lookupSnapshot = (context: unknown): Snapshot | null => {
    const scope = asRecord(context)?.['scope']
    if (typeof scope === 'object' && scope !== null) {
      const hit = byIdentity.get(scope)
      if (hit !== undefined) return hit
    }
    const scopeRecord = asRecord(scope)
    if (scopeRecord !== null) {
      const session = asRecord(scopeRecord['session'])
      const candidates = [session?.['id'], scopeRecord['id']]
      for (const id of candidates) {
        if (typeof id !== 'string' || id === '') continue
        const hit = byId.get(id)
        if (hit !== undefined) return hit
      }
    }
    // 两条都没命中就不动：宁可放开，也不要误删。
    return null
  }

  const applyOne = async (state: AgentState): Promise<void> => {
    const cwd = cwdOf(state.agent)
    if (cwd === null) {
      warnOnce('no-cwd', 'agent/created 缺少 cwd，本轮不改变限制')
      return
    }

    const tools = scopedTools(state.agent)
    if (tools === null) {
      warnOnce('no-tools', '取不到 agent 作用域的 tools 服务，本轮不改变限制')
      return
    }
    if (typeof tools.restrict === 'function') restrictFound = true

    let loaded: PolicyState
    try {
      loaded = await loadState(cwd)
    } catch (error) {
      warnOnce('policy-read', '读取停用策略失败，本轮不改变限制：' + String(error))
      return
    }

    const catalog = readCatalog()
    if (catalog === null) {
      // 目录未就绪时连「哪些工具属于谁」都不知道。保持原状，不动掩码也不动快照。
      warnOnce('catalog-missing', '插件目录尚未就绪，本轮不改变限制')
      return
    }

    // 求值链只在这里组装一次：段通道与工具掩码读的是同一份结论。
    // 绑定悬空或未绑定时 `loaded.pack` 为 `null`，求值自然退回 default；
    // 绑定表的键是规范化后的 cwd，归一在 `loadState` 内部完成。
    const answer = effective({
      policy: loaded,
      names: catalog.plugins.map((plugin) => plugin.pkg),
      scope: 'workspace',
      complete: catalog.complete,
    })

    // 段通道先更新：它不依赖工具清单，即使后面清单读不到也照样能剔段。
    state.snapshot = buildSnapshot(catalog, answer)
    publish(state)

    let visible: Set<string>
    try {
      // 清单必须带 scope 读：agent preset 挂载的那批工具不在全局视图里，
      // 用全局视图算掩码会漏掉它们，表现为「关了却还看得见」。
      visible = new Set<string>()
      for (const definition of tools.definitions(state.agent.raw)) {
        if (typeof definition?.name === 'string') visible.add(definition.name)
      }
    } catch (error) {
      warnOnce('inventory', '工具清单不完整，本轮不改变限制：' + String(error))
      return
    }

    const hidden = denyFor(catalog, answer, visible, state.denied)
    const key = hidden.join(',')
    // 计划没变就跳过：这层判断留在调用方，模块只负责落地。
    if (key === state.key) return

    // 本轮的结论先记在本地，apply 返回 true 之后才落到 state 上：失败时推进 key
    // 会让下一次事件误以为「已经生效」，于是永远不重试。
    let planned: readonly string[] | null = null
    let missing = false
    let stuckNow: readonly string[] = []

    const ok = await reconcile.apply(state.agent.id, () => {
      // 空掩码绝不调用：宿主把空过滤当成「配置物化错了」并抛错。
      // 空集只表示这一轮没有要关的，返回 null 让模块释放上一轮。
      if (hidden.length === 0) {
        planned = []
        return null
      }

      const restrict = tools.restrict
      if (typeof restrict !== 'function') {
        warnOnce('no-restrict', '当前宿主不支持 tools.restrict()，策略已保存但工具不会生效')
        // 刻意不更新 key：宿主若在运行中补上 restrict，下一次重算还能接上。
        missing = true
        return null
      }

      // 掩码可能含「两次重算之间被卸载」的名字，宿主对整批校验，任一未知名都会让
      // 全部限制失败。剔除未知名后重试一次：其余工具照样关闭，被剔的名字进 stuck，
      // 由面板显示为「关不掉」，而不是静默失效。
      let candidate = hidden
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const dispose = restrict.call(tools, { deny: candidate })
          planned = candidate
          return () => {
            try {
              dispose()
            } catch {
              // 释放失败只影响内存，下一次重算会重建。
            }
          }
        } catch (error) {
          const unknown = unknownNamesIn(error, candidate)
          const remaining = candidate.filter((name) => !unknown.includes(name))
          if (unknown.length === 0 || remaining.length === 0) {
            warnOnce(
              'restrict-failed',
              '施加限制失败，本会话保持原状（agent=' + state.agent.id + '）：' + String(error),
            )
            return null
          }
          candidate = remaining
          stuckNow = [...new Set([...stuckNow, ...unknown])]
          ctx.logger.warn('dsh-plugin-pack: 以下名字无法限制，已跳过：' + unknown.join(', '))
        }
      }
      return null
    })

    // 被 release 或更新的一次顶掉：这一轮没有落地，一条记录都不要碰。
    if (!ok) return
    if (missing) return
    if (planned === null) {
      // 宿主整批拒绝：退回「没有限制」，下次事件重试。
      state.key = ''
      state.denied = []
      state.stuck = stuckNow
      return
    }
    state.key = key
    state.denied = planned
    state.stuck = stuckNow

    // 复验：限制只作用于继承来的全局工具，agent 作用域自己注册的同名工具不受影响。
    try {
      const after = new Set<string>()
      for (const definition of tools.definitions(state.agent.raw)) {
        if (typeof definition?.name === 'string') after.add(definition.name)
      }
      const stuck = hidden.filter((name) => after.has(name))
      if (stuck.length > 0) {
        state.stuck = [...new Set([...state.stuck, ...stuck])]
        ctx.logger.warn(
          'dsh-plugin-pack: 以下工具关不掉（同名工具注册在该 agent 自己的作用域里）：' + stuck.join(', '),
        )
      }
    } catch {
      // 复验失败不影响已施加的限制，只是这条路失败时不报「关不掉」名单。
    }
  }

  const onCreated = async (payload: unknown): Promise<void> => {
    // 整个监听器包 try/catch：这个事件的监听器抛错会让会话创建失败，这是仓库红线。
    try {
      const agent = asAgentLike(asRecord(payload)?.['agent'])
      if (agent === null) {
        ctx.logger.warn('dsh-plugin-pack: agent/created 负载形状不符，跳过')
        return
      }
      // 同一 id 再装配一次：先放掉上一轮。新 state 的 key 是空的，若不留这一步，
      // 新计划又恰好为空时「没变就跳过」会直接返回，旧掩码永远留在宿主上。
      if (states.has(agent.id)) reconcile.release(agent.id)
      const state: AgentState = { agent, key: '', stuck: [], denied: [], snapshot: null }
      states.set(agent.id, state)
      await applyOne(state)
    } catch (error) {
      ctx.logger.warn('dsh-plugin-pack: agent/created 施加失败，本会话按空策略运行：' + String(error))
    }
  }

  const onDisposed = (payload: unknown): void => {
    try {
      const agent = asAgentLike(asRecord(payload)?.['agent'])
      if (agent === null) return
      states.delete(agent.id)
      // 释放失败由 reconcile 记 warn，Agent 已经消失，这里没有别的要收尾。
      reconcile.release(agent.id)
      // `byId` 是强引用表：只加不减的话，每开过一个会话就永久留下两条记录
      // （agent id 与 session id），进程活多久就涨多久。删掉即「查不到就不动」，
      // 与装配侧「宁可放开，也不要误删」的兜底是同一套语义。
      byId.delete(agent.id)
      byId.delete(agent.session.id)
    } catch (error) {
      ctx.logger.warn('dsh-plugin-pack: agent/disposed 清理失败：' + String(error))
    }
  }

  /**
   * 装配 waterfall。必须 await next() 并透传它的返回值：吞掉返回等于把后续
   * 监听器与 fallback 一起短路，别的插件的装配改动会整段消失。
   *
   * 过滤做两次：先改 payload 让下游少做点事，再看下游返回的对象——有的监听器会
   * 返回新数组覆盖 sections，只改 payload 那份就被丢掉了。
   */
  const onAssemble = async (
    payload: unknown,
    context: unknown,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    let removed: ReadonlySet<string> | null = null
    try {
      const assembly = asPresentation(payload)
      if (assembly !== null) {
        const snapshot = lookupSnapshot(context)
        if (snapshot !== null && snapshot.sections.size > 0) {
          removed = snapshot.sections
          const kept = keepSections(assembly.sections, removed)
          if (kept.length !== assembly.sections.length) assembly.sections = kept
        }
      }
    } catch (error) {
      // 装配路径上永不抛：抛出去整个请求就没了。
      warnOnce('assemble', '提示词段过滤失败，本轮按原样装配：' + String(error))
      removed = null
    }

    const result = await next()
    if (removed === null) return result
    try {
      const out = asPresentation(result)
      if (out !== null && out !== asPresentation(payload)) {
        const kept = keepSections(out.sections, removed)
        if (kept.length !== out.sections.length) return { ...out, sections: kept }
      }
    } catch {
      // 下游结果的形状不在预期内：原样返回，不冒改坏整个请求的风险。
    }
    return result
  }

  const applyAll = async (): Promise<void> => {
    for (const state of states.values()) {
      try {
        await applyOne(state)
      } catch (error) {
        ctx.logger.warn('dsh-plugin-pack: 重新施加失败（agent=' + state.agent.id + '）：' + String(error))
      }
    }
  }

  const offCreated = ctx.on('agent/created', onCreated)
  // 事件名必须带斜杠，与宿主 emit 的字符串逐字一致；写成点号不会报错，也永远不会被调用。
  const offDisposed = ctx.on('agent/disposed', onDisposed)
  let offAssemble: (() => void) | null = null
  try {
    offAssemble = ctx.on('system-prompt/assemble', onAssemble)
    promptFilterFound = true
  } catch (error) {
    warnOnce('no-waterfall', '宿主不支持 system-prompt/assemble，停用只对工具生效：' + String(error))
  }

  const stopAll = (): void => {
    for (const off of [offCreated, offDisposed, offAssemble]) {
      if (off === null) continue
      try {
        off()
      } catch {
        // 退订失败不影响后续释放。
      }
    }
    // states 是键表，资源在 reconciler 里；逐个释放，失败只 warn。
    for (const id of [...states.keys()]) reconcile.release(id)
    states.clear()
    byId.clear()
  }

  ctx.effect(() => stopAll)

  /**
   * 插件重载后补一次施加。
   *
   * states 是进程内表，插件一重载就清空；而那些已经存在的会话不会再收到
   * agent/created，于是一直没有限制——直到用户重开会话，表现就是
   * 「策略改了，手上这个会话还是能看到被停用的插件」。
   */
  const bootstrap = async (): Promise<void> => {
    let list: unknown[] = []
    try {
      const agents = ctx.get('agents') as { list?: () => unknown } | undefined
      const raw = typeof agents?.list === 'function' ? agents.list.call(agents) : []
      list = Array.isArray(raw) ? raw : []
    } catch {
      return
    }
    for (const entry of list) {
      const agent = asAgentLike(entry)
      if (agent === null || states.has(agent.id) || cwdOf(agent) === null) continue
      const state: AgentState = { agent, key: '', stuck: [], denied: [], snapshot: null }
      states.set(agent.id, state)
      try {
        await applyOne(state)
      } catch (error) {
        ctx.logger.warn('dsh-plugin-pack: 补施加失败（agent=' + agent.id + '）：' + String(error))
      }
    }
  }

  const support = (): Support => {
    let restrict = restrictFound
    if (!restrict) {
      try {
        const root = ctx.get('tools')
        if (typeof root === 'object' && root !== null && typeof (root as ToolsFace).restrict === 'function') {
          restrict = true
        }
      } catch {
        // 取不到就按不支持显示：面板提示「已保存但不生效」，比误报支持安全。
      }
    }
    return { restrict, promptFilter: promptFilterFound }
  }

  return {
    reapply: applyAll,
    bootstrap,
    stopAll,
    stuck: () => {
      const out = new Set<string>()
      for (const state of states.values()) for (const name of state.stuck) out.add(name)
      return [...out].sort()
    },
    support,
  }
}
