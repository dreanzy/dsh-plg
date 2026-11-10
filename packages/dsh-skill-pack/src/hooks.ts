import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Inventory, type SkillSummaryLike, type SkillsFace } from './inventory.js'
import { createReconciler, type Dispose } from '@dreanzy/dsh-pack-core'
import { projectedCwd } from '@dreanzy/dsh-pack-core'
import { createScopeSnapshot, fingerprintOf, type ScopeSnapshot } from './snapshot.js'
import { loadState } from './store.js'

/**
 * 落地失败的落盘诊断。
 *
 * 宿主日志的位置随 profile 走，用户未必拿得到；面板又只能显示「关不掉」这一种结论。
 * 「落地在哪个分支提前返回」是这个包最难复现的现场，所以把原因直接追加到
 * `$DSH_HOME/logs/skill-pack-diagnose.log`：复现一次就有证据，不用再靠猜。
 *
 * 只在失败分支写，正常落地一行不写。写盘失败只吞掉——诊断不能影响主流程。
 */
function diagnose(message: string): void {
  try {
    const home =
      typeof process.env['DSH_HOME'] === 'string' && process.env['DSH_HOME'] !== ''
        ? process.env['DSH_HOME']
        : join(homedir(), '.dsh')
    const dir = join(home, 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'skill-pack-diagnose.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 写不进去就算了。
  }
}

/** 宿主 ctx 的最小面：订阅、纳管、取服务、记日志。 */
export interface PluginContext {
  /** waterfall 事件的监听器会收到下游 `next`；普通事件只有 payload。 */
  on(event: string, listener: (payload: unknown, next?: () => Promise<unknown>) => unknown): () => void
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 投影的读取实现在 `@dreanzy/dsh-pack-core`：顺序与理由见那边的注释。 */
export { projectedCwd }

/**
 * 工作目录的权威值在投影里。
 *
 * `cd` 与切换工作区只改 `workingDirectory` 投影，`header.cwd` 是会话创建时的快照。
 * 读 header 会让「切到另一个工作区后仍按上一个目录求值」——清单、绑定与开关全部停在
 * 旧目录。投影还没写过（新会话）时退回 header.cwd。
 */
function cwdOf(agent: AgentLike): string | null {
  const session = asRecord(agent.raw)?.['session']
  const projected = projectedCwd(session)
  if (projected !== null) return projected
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
  /** 上一次落地时用的工作目录；变了就要重新求值。 */
  cwd: string | null
  /** 隐藏集的规范串，用来跳过没有变化的重新落地。 */
  key: string
  /** 注册遮蔽副本后复验，模型侧仍然看得见的名字。 */
  stuck: readonly string[]
}

/**
 * 把求值得到的名字映射回清单行。
 *
 * **不读正文。** 遮蔽副本把 `modelInvocable` 与 `userInvocable` 都置为 `false`，
 * 模型目录、`skill` 工具、`/name` 注入三条路径都在取正文之前按标记拒绝，正文
 * 没有消费者。`skills.get()` 又会命中 revision 缓存——跳过它，`agent/created`
 * 就少了整段全量枚举。
 */
function shadowRows(rows: readonly SkillSummaryLike[], hidden: readonly string[]): SkillSummaryLike[] {
  const byName = new Map(rows.map((row) => [row.name, row]))
  const out: SkillSummaryLike[] = []
  for (const name of hidden) {
    const row = byName.get(name)
    if (row !== undefined) out.push(row)
  }
  return out
}

/**
 * 同步注册一份遮蔽。
 *
 * 放进 reconcile 的 `build` 里调用：那一刻上一轮已经释放；这一半失败也退回无资源，
 * 不会留下半份。
 */
function registerShadows(
  ctx: PluginContext,
  skills: SkillsFace,
  rows: readonly SkillSummaryLike[],
): Dispose | null {
  const disposers: Dispose[] = []
  for (const row of rows) {
    try {
      disposers.push(
        skills.register({
          name: row.name,
          description: row.description,
          // 正文没有消费者：两条调用路径都在取正文之前按标记拒绝。
          content: '',
          source: row.source,
          ...(row.path === undefined ? {} : { path: row.path }),
          invocation: { modelInvocable: false, userInvocable: false },
        }),
      )
    } catch (error) {
      ctx.logger.warn(`dsh-skill-pack: 注册遮蔽副本失败（${row.name}）：${String(error)}`)
    }
  }
  if (disposers.length === 0) return null
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 释放失败只影响内存，下一次落地会重建。
      }
    }
  }
}

/**
 * 复验：判据是「两条标记都落了」，不是「名字还在不在」。
 * 遮蔽只改 invocation 标记，名字永远在清单里；任一条没落都算关不掉。
 */
async function verifyShadows(
  ctx: PluginContext,
  skills: SkillsFace,
  hidden: readonly string[],
  cwd: string,
  scope: unknown,
): Promise<string[]> {
  let stuck: string[] = []
  try {
    const after = await skills.snapshot({ cwd, scope })
    if (after.complete) {
      const visible = new Set<string>()
      for (const row of after.skills) {
        if (row.invocation?.modelInvocable !== false || row.invocation?.userInvocable !== false) visible.add(row.name)
      }
      stuck = hidden.filter((name) => visible.has(name))
      if (stuck.length > 0) {
        ctx.logger.warn(
          `dsh-skill-pack: 以下 skill 关不掉（同层已被别的插件注册）：${stuck.join(', ')}`,
        )
      }
    }
  } catch {
    // 复验失败不影响已落地的遮蔽，只是这条会话的「关不掉」名单未知。
  }
  return stuck
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
  // 每次 `apply`（含禁用后重新启用）都会走到这里：这是判断「插件这次到底装上没有」
  // 的唯一无条件证据。
  diagnose('install: hooks 已挂载')
  const states = new Map<string, AgentState>()
  /**
   * 每个 agent 一份装配记账：先释放上一轮、串行、失败退回无资源，三件事都在这里。
   * key 用 agent id，一个 agent 只有一份遮蔽。
   */
  const shadows = createReconciler((message) => {
    ctx.logger.warn(`dsh-skill-pack: ${message}`)
  })
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
  /** 落地期间到达的清单变化。直接丢掉会让遮蔽停在上一个版本，所以记下来补跑。 */
  let dirty = false

  async function guarded(operation: () => Promise<void>): Promise<void> {
    applying += 1
    try {
      await operation()
    } finally {
      applying -= 1
      if (applying === 0 && dirty) {
        dirty = false
        void onChange().catch((error: unknown) => {
          ctx.logger.warn(`dsh-skill-pack: 补跑清单变化失败：${String(error)}`)
        })
      }
    }
  }

  const applyOne = async (state: AgentState): Promise<void> => {
    const cwd = cwdOf(state.agent)
    if (cwd === null) {
      diagnose(`applyOne: 解析不到 cwd（agent=${state.agent.id}）`)
      return
    }
    // 目录变了，旧目录那一格缓存就没有消费者了；顺手打掉，避免按会话数单调增长。
    if (state.cwd !== null && state.cwd !== cwd) snapshot.invalidate(state.cwd)
    state.cwd = cwd

    const skills = scopedSkills(state.agent)
    if (skills === null) {
      ctx.logger.warn(`dsh-skill-pack: 取不到 agent 作用域的 skills 服务（agent=${state.agent.id}）`)
      diagnose(`applyOne: 取不到 agent 作用域的 skills 服务（agent=${state.agent.id}）`)
      return
    }

    // 求值按 cwd + scope 共享：同一会话的多次落地（created、清单变更、保存、
    // 插件重载）只在策略或清单真的变了之后才重新读盘。
    // 清单始终是全量的（含官方技能）：官方技能只是面板默认不展示，一旦用户把它们
    // 放出来并关掉，「显示官方技能」开关再关回去，那条决定仍然有效。
    //
    // 绑定表的键是规范化后的 cwd；归一在 `loadState` 内部完成，用的是
    // `policy.ts` 的 `normalizeCwd` 唯一实现。这里刻意保留原始 cwd 给清单读取：
    // 宿主按原写法解析工程根，改写大小写会让工程 skill 找不到。
    const view = await snapshot.refresh(cwd, state.agent.raw)
    for (const warning of view.warnings) ctx.logger.warn(`dsh-skill-pack: ${warning}`)
    if (!view.complete) {
      ctx.logger.warn(`dsh-skill-pack: skill 清单不完整，本轮不改变遮蔽（agent=${state.agent.id}）`)
      diagnose(`applyOne: 清单不完整，本轮不动（agent=${state.agent.id}, cwd=${cwd}, warnings=${view.warnings.join(' | ')}）`)
      return
    }

    const hidden = view.hidden
    // 计划没变就跳过：这条判断留在调用方，reconcile 只管落地。
    const key = hidden.join(',')
    if (key === state.key) return

    // 只做名字 → 行的映射，不碰注册表；注册必须排进 reconcile 的队列，
    // 这样「先释放上一轮、再施加这一轮」才成立。
    const rows = shadowRows(view.rows, hidden)
    const landed = await shadows.apply(state.agent.id, () => registerShadows(ctx, skills, rows))
    if (!landed) {
      // 上一轮已被释放、这一轮没有资源：不推进 key，下一个事件会重试。
      state.stuck = []
      diagnose(`applyOne: 没有可注册的遮蔽副本（agent=${state.agent.id}, hidden=${hidden.join(',')}）`)
      return
    }
    state.key = key
    state.stuck =
      rows.length === 0 ? [] : await verifyShadows(ctx, skills, hidden, cwd, state.agent.raw)
  }

  const onCreated = async (payload: unknown): Promise<void> => {
    // 这个事件的监听器抛错会让会话创建失败（仓库红线），所以整条路径吞掉降级。
    try {
      const agent = asAgentLike((payload as { agent?: unknown } | null)?.agent)
      if (agent === null) {
        ctx.logger.warn('dsh-skill-pack: agent/created 负载形状不符，跳过')
        return
      }
      if (cwdOf(agent) === null) {
        ctx.logger.warn(`dsh-skill-pack: agent/created 缺少 cwd，跳过（agent=${agent.id}）`)
        return
      }
      // 宿主可能对同一个 agent id 再发一次 created（会话恢复、重连）。
      // 覆盖前必须释放旧遮蔽，否则注册表里留下没人能释放的第二份副本。
      shadows.release(agent.id)
      const state: AgentState = { agent, cwd: null, key: '', stuck: [] }
      states.set(agent.id, state)
      if (typeof agent.raw === 'object' && agent.raw !== null) agentByScope.set(agent.raw, agent)
      await guarded(async () => {
        await applyOne(state)
      })
    } catch (error) {
      ctx.logger.warn(`dsh-skill-pack: agent/created 落地失败，本会话按空策略运行：${String(error)}`)
    }
  }

  const onDisposed = (payload: unknown): void => {
    const agent = asAgentLike((payload as { agent?: unknown } | null)?.agent)
    if (agent === null) return
    const state = states.get(agent.id)
    if (state === undefined) return
    // 释放并忘记这个主体的资源；还排在队列里的那一轮会自己作废。
    shadows.release(agent.id)
    states.delete(agent.id)
    // 这一格已经没有消费者；不清理会让缓存按开过的会话数单调增长。
    // 同目录还有活会话时会被一并打掉，代价是它们下一轮重读一次。
    const cwd = cwdOf(agent)
    if (cwd !== null) snapshot.invalidate(cwd)
  }

  /**
   * 切换工作区不重建 Agent，也不发 `skills/change`：清单与绑定会一起停在旧目录。
   * 每步比一次工作目录，变了就重新落地（一次切换只跑一次）。
   *
   * `agent/pre-step` 是 waterfall：必须 `await next()` 并把下游结论原样返回，
   * 否则整步连同目录、工具、提示词装配一起被吞掉。
   */
  const onPreStep = async (payload: unknown, next?: () => Promise<unknown>): Promise<unknown> => {
    if (typeof next !== 'function') return undefined
    const decision = await next()
    try {
      const agent = asAgentLike((payload as { agent?: unknown } | null)?.agent)
      if (agent !== null) {
        const state = states.get(agent.id)
        const cwd = cwdOf(agent)
        if (state !== undefined && cwd !== null && state.cwd !== cwd) {
          await guarded(async () => {
            await applyOne(state)
          })
        }
      }
    } catch (error) {
      ctx.logger.warn(`dsh-skill-pack: 工作目录变化后重新落地失败：${String(error)}`)
    }
    return decision
  }

  async function onChange(): Promise<void> {
    if (applying > 0) {
      // 自己注册遮蔽触发的 skills/change 会走这里；外部变化也走这里，不能丢。
      dirty = true
      return
    }
    // 清单变化不改三份策略文件，指纹挡不住；不主动打掉就会一直读到旧清单。
    snapshot.invalidate()
    await guarded(async () => {
      // 并发而不是串行：不同 agent 落在各自的 scope 上，互不依赖；同键的刷新由
      // `ScopeSnapshot` 单飞合并，所以并发不会把一次变更放大成 N 次读盘。
      await Promise.all(
        [...states.values()].map(async (state) => {
          try {
            await applyOne(state)
          } catch (error) {
            ctx.logger.warn(
              `dsh-skill-pack: 清单变化后重新落地失败（agent=${state.agent.id}）：${String(error)}`,
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
  // 切换工作区只改投影，不重建 Agent、也不发 `skills/change`：只能按步比较目录。
  const offStep = ctx.on('agent/pre-step', onPreStep as never)

  /**
   * 策略保存不触碰 skill 注册表，因此不会发出 `skills/change`。
   * 保存成功后由路由显式调用这里，否则同一会话里改策略要等新会话才生效。
   */
  const reapply = async (): Promise<void> => {
    // 策略刚被写盘：onChange 里的显式失效不靠 mtime 精度。同毫秒内的两次写在
    // Windows 上可能得到同一个时间戳，靠指纹会漏掉第二次。
    await onChange()
  }

  const stopAll = (): void => {
    for (const off of [offCreated, offSkills, offDisposed, offStep]) {
      try {
        off()
      } catch {
        // 退订失败不影响后续释放。
      }
    }
    for (const id of states.keys()) shadows.release(id)
    states.clear()
    snapshot.invalidate()
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
      if (agents === undefined || typeof agents.list !== 'function') {
        // 未在 inject 声明时 ctx.get 返回 undefined：以前这里静默返回，表现就是
        // 「重载插件后遮蔽再也不生效」，而且没有任何线索。
        ctx.logger.warn('dsh-skill-pack: agents 服务不可用，已有会话不会被补落地')
        diagnose('bootstrap: agents 服务不可用')
        return
      }
      const raw = agents.list.call(agents)
      list = Array.isArray(raw) ? raw : []
    } catch (error) {
      ctx.logger.warn(`dsh-skill-pack: bootstrap 枚举 live Agent 失败：${String(error)}`)
      diagnose(`bootstrap: 枚举失败 ${String(error)}`)
      return
    }
    diagnose(`bootstrap: 枚举到 ${list.length} 个 agent`)
    for (const raw of list) {
      // 传 agent 本体：`asAgentLike` 读的是 `value.id` / `value.session`，
      // 多包一层 `{ agent }` 会让每个元素都判成形状不符。
      const agent = asAgentLike(raw)
      if (agent === null) {
        diagnose('bootstrap: agents.list() 返回的形状不符')
        continue
      }
      if (states.has(agent.id)) continue
      if (cwdOf(agent) === null) {
        diagnose(`bootstrap: 解析不到 cwd（agent=${agent.id}）`)
        continue
      }
      const state: AgentState = { agent, cwd: null, key: '', stuck: [] }
      states.set(agent.id, state)
      if (typeof agent.raw === 'object' && agent.raw !== null) agentByScope.set(agent.raw, agent)
      try {
        await guarded(async () => {
          await applyOne(state)
        })
      } catch (error) {
        ctx.logger.warn(`dsh-skill-pack: 补落地失败（agent=${agent.id}）：${String(error)}`)
        diagnose(`bootstrap: 补落地失败（agent=${agent.id}）${String(error)}`)
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
