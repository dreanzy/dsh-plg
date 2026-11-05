import { type Inventory, type SkillSummaryLike, type SkillsFace } from './inventory.js'
import { createScopeSnapshot, fingerprintOf, type ScopeSnapshot } from './snapshot.js'
import { loadState } from './store.js'

/** 宿主 ctx 的最小面：订阅、纳管、取服务、记日志。 */
export interface PluginContext {
  on(event: string, listener: (payload: unknown) => unknown): () => void
  effect(callback: () => unknown): unknown
  get(name: string): unknown
  logger: { info(message: string): void; warn(message: string): void }
}

/** `agent/created` 负载里的 Agent，只取本插件用到的字段。 */
interface AgentLike {
  readonly id: string
  readonly ctx: { get(name: string): unknown } | undefined
  readonly session: { readonly id: string; readonly header?: { readonly cwd?: string } }
  /** 宿主给出的对象本体。层查找按对象身份索引，替身查不到 agent 层。 */
  readonly raw: unknown
}

function asAgentLike(value: unknown): AgentLike | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const session = record['session']
  if (typeof session !== 'object' || session === null) return null
  const sessionRecord = session as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof sessionRecord['id'] !== 'string') return null
  const header = sessionRecord['header']
  const cwd =
    typeof header === 'object' && header !== null ? (header as Record<string, unknown>)['cwd'] : undefined
  return {
    id: record['id'],
    ctx: record['ctx'] as AgentLike['ctx'],
    session: {
      id: sessionRecord['id'],
      ...(typeof cwd === 'string' ? { header: { cwd } } : {}),
    },
    raw: value,
  }
}

function cwdOf(agent: AgentLike): string | null {
  const cwd = agent.session.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * 取该 Agent 作用域的 skills 实例。
 *
 * **必须由 `agent.ctx.get('skills')` 取**：`register()` 用 `scopeOf(this.ctx)`
 * 决定落到哪一层，只有这个实例代表的才是该 Agent 的层。
 */
function scopedSkills(agent: AgentLike): SkillsFace | null {
  const get = agent.ctx?.get
  if (typeof get !== 'function') return null
  try {
    const service = get.call(agent.ctx, 'skills')
    if (typeof service !== 'object' || service === null) return null
    return service as SkillsFace
  } catch {
    return null
  }
}

interface AgentState {
  readonly agent: AgentLike
  /** 释放全部遮蔽副本。`null` 表示当前这一轮没有任何遮蔽。 */
  dispose: (() => void) | null
  /** 隐藏集的规范串，用来跳过没有变化的重新落地。 */
  key: string
  /** 注册遮蔽副本后复验，模型侧仍然看得见的名字。 */
  stuck: readonly string[]
}

async function buildShadows(
  ctx: PluginContext,
  skills: SkillsFace,
  rows: readonly SkillSummaryLike[],
  hidden: readonly string[],
  cwd: string,
  scope: unknown,
): Promise<{ dispose: () => void; stuck: string[] }> {
  const byName = new Map(rows.map((row) => [row.name, row]))
  const disposers: Array<() => void> = []

  /**
   * **先取全部定义，再统一注册。**
   *
   * `skills.register()` 会无条件让注册表的 revision +1 并清掉收集缓存，而
   * `skills.get()` 的缓存正按 revision 做键。所以「取一个 → 注册一个」会让
   * 每次 `get()` 都必然缓存未命中、触发一次完整枚举：一百来个隐藏项实测要
   * 三秒以上，而这段代码跑在 `agent/created` 里、被宿主串行 await——用户看到的
   * 就是「点新会话要等很久」。
   *
   * 分段之后只有第一次 `get()` 可能全量，其余命中缓存；注册本身是微秒级。
   */
  const prepared: Array<{ row: SkillSummaryLike; content: string }> = []
  for (const name of hidden) {
    const row = byName.get(name)
    if (row === undefined) continue
    let content = ''
    try {
      const definition = await skills.get(name, { cwd, scope })
      if (definition !== undefined && typeof definition.content === 'string') content = definition.content
    } catch {
      // 读不到正文只影响手动调用的内容，不影响遮蔽本身。
    }
    prepared.push({ row, content })
  }

  for (const { row, content } of prepared) {
    try {
      disposers.push(
        skills.register({
          name: row.name,
          description: row.description,
          content,
          source: row.source,
          ...(row.path === undefined ? {} : { path: row.path }),
          invocation: { modelInvocable: false, userInvocable: true },
        }),
      )
    } catch (error) {
      ctx.logger.warn(`dsh-skill-manager: 注册遮蔽副本失败（${row.name}）：${String(error)}`)
    }
  }

  const release = (): void => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 释放失败只影响内存，下一次落地会重建。
      }
    }
  }

  // 复验：判据是 `invocation.modelInvocable !== false`，不是「名字还在不在」。
  // 遮蔽只改 invocation 标记，名字永远在清单里。
  let stuck: string[] = []
  try {
    const after = await skills.snapshot({ cwd, scope })
    if (after.complete) {
      const visible = new Set<string>()
      for (const row of after.skills) {
        if (row.invocation?.modelInvocable !== false) visible.add(row.name)
      }
      stuck = hidden.filter((name) => visible.has(name))
      if (stuck.length > 0) {
        ctx.logger.warn(
          `dsh-skill-manager: 以下 skill 关不掉（同层已被别的插件注册）：${stuck.join(', ')}`,
        )
      }
    }
  } catch {
    // 复验失败不影响已落地的遮蔽，只是这条会话的「关不掉」名单未知。
  }

  return { dispose: release, stuck }
}

/**
 * 装好监听器并返回重新落地的入口。
 *
 * 只订阅三个事件：`agent/created`、`agent/disposed`、`skills/change`。
 * 不挂 `agent/pre-step` 或 `system-prompt/assemble`——`agent/created` 是 serial
 * 派发，必然早于该 Agent 的首次装配，不需要接管装配瀑布。
 *
 * 策略不冻结：每次重新落地都重读两层文件，所以保存的效果落在下一个回合边界。
 */
export interface HooksOptions {
  /** 注入一份共享快照；缺省按本包的真实读取自建。测试用它绕开文件系统。 */
  readonly snapshot?: ScopeSnapshot
}

export function installHooks(
  ctx: PluginContext,
  options?: HooksOptions,
): {
  reapply: () => Promise<void>
  bootstrap: () => Promise<void>
  stopAll: () => void
  stuck: () => readonly string[]
  /** 与落地共用的那份求值缓存。路由要用同一份，否则面板与模型看到的会分叉。 */
  snapshot: ScopeSnapshot
} {
  const states = new Map<string, AgentState>()
  /**
   * scope 对象 → agent 的索引。
   *
   * 快照的键是「cwd + scope 身份」，而读清单必须用该 agent 自己的 skills 实例
   * （`register()` 用 `scopeOf(ctx)` 决定落到哪一层）。刷新时只拿得到 scope 对象，
   * 所以在这里反查回 agent。
   */
  const agentByScope = new WeakMap<object, AgentLike>()

  const rootSkills = (): SkillsFace | null => {
    try {
      const service = ctx.get('skills')
      return typeof service === 'object' && service !== null ? (service as SkillsFace) : null
    } catch {
      return null
    }
  }

  /**
   * 读一份**未缓存**的清单。
   *
   * 刻意不复用 `inventory.ts` 的 `readInventory`：它的缓存键不含 scope 身份，会让
   * 不同 preset 的会话读到彼此的清单。缓存统一由 `ScopeSnapshot` 负责。
   */
  const readFresh = async (cwd: string | null, scope: unknown): Promise<Inventory> => {
    const agent = typeof scope === 'object' && scope !== null ? agentByScope.get(scope) : undefined
    const skills = agent === undefined ? rootSkills() : scopedSkills(agent)
    if (skills === null) throw new Error('取不到 skills 服务，无法读取清单')
    const request: { cwd?: string; scope?: unknown } = {}
    if (cwd !== null && cwd !== '') request.cwd = cwd
    if (scope !== undefined) request.scope = scope
    const result = await skills.snapshot(request)
    return { rows: result.skills, complete: result.complete }
  }

  const snapshot =
    options?.snapshot ??
    createScopeSnapshot({
      loadPolicy: (cwd) => loadState(cwd),
      readInventory: readFresh,
      fingerprint: fingerprintOf,
    })

  /**
   * 本插件正在落地时的计数。
   *
   * 遮蔽是 `skills.register()`，而它会触发 `skills/change`；本监听器又监听
   * `skills/change`。没有这个守卫，一次落地会自我复制成注册风暴，表现为
   * 新建会话卡顿数秒、且首条消息的 skill 目录整体消失（快照 revisions 抖动）。
   * 用计数而非布尔：落地期间可能嵌套一次真正的外部变化。
   */
  let applying = 0

  const guarded = async (operation: () => Promise<void>): Promise<void> => {
    applying += 1
    try {
      await operation()
    } finally {
      applying -= 1
    }
  }

  const applyOne = async (state: AgentState): Promise<void> => {
    const cwd = cwdOf(state.agent)
    if (cwd === null) return

    const skills = scopedSkills(state.agent)
    if (skills === null) {
      ctx.logger.warn(`dsh-skill-manager: 取不到 agent 作用域的 skills 服务（agent=${state.agent.id}）`)
      return
    }

    // 求值按 cwd + scope 共享：同一会话的多次落地（created、清单变更、保存、
    // 插件重载）只在策略或清单真的变了之后才重新读盘。
    // 清单始终是全量的（含官方技能）：官方技能只是面板默认不展示，一旦用户把它们
    // 放出来并关掉，「显示官方技能」开关再关回去，那条决定仍然有效。
    const view = await snapshot.refresh(cwd, state.agent.raw)
    for (const warning of view.warnings) ctx.logger.warn(`dsh-skill-manager: ${warning}`)
    if (!view.complete) {
      ctx.logger.warn(`dsh-skill-manager: skill 清单不完整，本轮不改变遮蔽（agent=${state.agent.id}）`)
      return
    }

    const hidden = view.hidden
    const key = hidden.join(',')
    if (key === state.key) return

    if (state.dispose !== null) {
      state.dispose()
      state.dispose = null
    }
    state.stuck = []

    if (hidden.length === 0) {
      state.key = key
      return
    }

    const built = await buildShadows(ctx, skills, view.rows, hidden, cwd, state.agent.raw)
    state.dispose = built.dispose
    state.stuck = built.stuck
    state.key = key
  }

  const onCreated = async (payload: unknown): Promise<void> => {
    const agent = asAgentLike((payload as { agent?: unknown } | null)?.agent)
    if (agent === null) {
      ctx.logger.warn('dsh-skill-manager: agent/created 负载形状不符，跳过')
      return
    }
    if (cwdOf(agent) === null) {
      ctx.logger.warn(`dsh-skill-manager: agent/created 缺少 cwd，跳过（agent=${agent.id}）`)
      return
    }
    const state: AgentState = { agent, dispose: null, key: '', stuck: [] }
    states.set(agent.id, state)
    if (typeof agent.raw === 'object' && agent.raw !== null) agentByScope.set(agent.raw, agent)
    try {
      // 这个事件的监听器抛错会让会话创建失败，所以一律吞掉降级。
      await guarded(async () => {
        await applyOne(state)
      })
    } catch (error) {
      ctx.logger.warn(`dsh-skill-manager: agent/created 落地失败，本会话按空策略运行：${String(error)}`)
    }
  }

  const onDisposed = (payload: unknown): void => {
    const agent = asAgentLike((payload as { agent?: unknown } | null)?.agent)
    if (agent === null) return
    const state = states.get(agent.id)
    if (state === undefined) return
    if (state.dispose !== null) {
      try {
        state.dispose()
      } catch {
        // 释放失败无副作用：Agent 已经消失。
      }
    }
    states.delete(agent.id)
  }

  const onChange = async (): Promise<void> => {
    if (applying > 0) return
    await guarded(async () => {
      // 并发而不是串行：不同 agent 落在各自的 scope 上，互不依赖；同键的刷新由
      // `ScopeSnapshot` 单飞合并，所以并发不会把一次变更放大成 N 次读盘。
      await Promise.all(
        [...states.values()].map(async (state) => {
          try {
            await applyOne(state)
          } catch (error) {
            ctx.logger.warn(
              `dsh-skill-manager: 清单变化后重新落地失败（agent=${state.agent.id}）：${String(error)}`,
            )
          }
        }),
      )
    })
  }

  const offCreated = ctx.on('agent/created', onCreated as never)
  // 事件名必须带斜杠，与宿主 emit 的字符串逐字一致；写成点号不会报错，也永远不会被调用。
  const offSkills = ctx.on('skills/change', onChange as never)
  const offDisposed = ctx.on('agent/disposed', onDisposed as never)

  /**
   * 策略保存不触碰 skill 注册表，因此不会发出 `skills/change`。
   * 保存成功后由路由显式调用这里，否则同一会话里改策略要等新会话才生效。
   */
  const reapply = async (): Promise<void> => {
    // 策略刚被写盘：显式失效，不靠 mtime 精度。同毫秒内的两次写在 Windows 上
    // 可能得到同一个时间戳，靠指纹会漏掉第二次。
    snapshot.invalidate()
    await onChange()
  }

  const stopAll = (): void => {
    for (const off of [offCreated, offSkills, offDisposed]) {
      try {
        off()
      } catch {
        // 退订失败不影响后续释放。
      }
    }
    for (const state of states.values()) {
      if (state.dispose !== null) {
        try {
          state.dispose()
        } catch {
          // 同上。
        }
      }
    }
    states.clear()
  }

  ctx.effect(() => stopAll)

  /**
   * 插件重载后补一次落地。
   *
   * `states` 是进程内表，插件一重载就清空；而那些**已经存在**的会话不会再收到
   * `agent/created`，于是一直以为自己没有被遮蔽——直到用户重开会话，表现就是
   * 「策略改了，手上这个会话还是能看到被关掉的 skill」。
   * 这里主动枚举一次 live Agent，把表补回来。
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
    for (const raw of list) {
      const agent = asAgentLike({ agent: raw })
      if (agent === null || states.has(agent.id) || cwdOf(agent) === null) continue
      const state: AgentState = { agent, dispose: null, key: '', stuck: [] }
      states.set(agent.id, state)
      if (typeof agent.raw === 'object' && agent.raw !== null) agentByScope.set(agent.raw, agent)
      try {
        await guarded(async () => {
          await applyOne(state)
        })
      } catch (error) {
        ctx.logger.warn(`dsh-skill-manager: 补落地失败（agent=${agent.id}）：${String(error)}`)
      }
    }
  }

  return {
    reapply,
    bootstrap,
    stopAll,
    snapshot,
    stuck: () => {
      const out = new Set<string>()
      for (const state of states.values()) for (const name of state.stuck) out.add(name)
      return [...out].sort()
    },
  }
}
