import type { Envelope, ErrorCode } from '@dreanzy/dsh-pack-core'
import { defaultPackOf } from './policy.js'
import { effective } from './effective.js'
import { projectedCwd } from './hooks.js'
import { isOfficialSkill, type SkillSummaryLike, type SkillsFace } from './inventory.js'
import { applyCommands, previewCommands, type PolicyState } from './store.js'
import type { ScopeSnapshot, SnapshotValue } from './snapshot.js'
import {
  DEFAULT_PACK_ID,
  DEFAULT_PACK_NAME,
  type Bindings,
  type Command,
  type GroupRegistry,
  type PackBook,
  type UiState,
} from './types.js'

/** 路由层需要的最小 ctx 面。 */
export interface RouteContext {
  get(name: string): unknown
  logger: { warn(message: string): void }
}

export type { Envelope, ErrorCode }

/**
 * 路由层依赖。
 *
 * `snapshot` 与 hooks 共用同一份：面板看到的清单与模型看到的遮蔽必须由同一次求值
 * 产生，否则会出现「面板显示关了、会话里还开着」这种无法复现的偏差。
 */
export interface RouteDeps {
  readonly snapshot: ScopeSnapshot
  readonly reapply: () => Promise<void>
  readonly stuck: () => readonly string[]
}


/** 面板用的一行 skill。求值结果由服务端算好，前端只负责渲染。 */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly provider: string
  /** 官方 `@deepseek-ai` 技能：默认不在面板出现。 */
  readonly official: boolean
  readonly groupId: string | null
  /** 该工作区绑定的 pack 求值出的最终状态；清单不完整时为 `null`（未生效）。 */
  readonly open: boolean | null
  /** 只按 default pack 求值的状态。全局面板用它渲染开关。 */
  readonly openGlobal: boolean
  /** 行内是否带项级覆盖（该 pack 有键）。 */
  readonly itemGlobal: boolean | null
  readonly itemWorkspace: boolean | null
  /** 生效值来自哪个 pack；取内置缺省时是 `default`。 */
  readonly decidedBy: string
  /** 生效值来自 pack 的哪一级；两层都没记录时是 `builtin`。 */
  readonly decidedVia: 'item' | 'group' | 'builtin'
  /** 来源短标签，给人看：`.agents`、`.dsh`、`官方`、`插件名`、`运行时`。 */
  readonly origin: string
}

/** 一个 pack 的面板投影。 */
export interface PackView {
  readonly id: string
  readonly name: string
  readonly items: Readonly<Record<string, boolean>>
  readonly groups: Readonly<Record<string, boolean>>
  /** `default` 是内置 pack：不可删除、不可改名。 */
  readonly builtin: boolean
}

export interface GlobalView {
  /** 全部 pack，`default` 排第一。 */
  readonly packs: readonly PackView[]
  readonly ui: UiState
  readonly groups: GroupRegistry
  /** 绑定表：键是规范化后的 cwd。 */
  readonly bindings: Bindings
  readonly skills: readonly SkillRow[]
  readonly complete: boolean
  readonly warnings: readonly string[]
  /** 已注册遮蔽但复验仍可见的名字。全局面板也要能提示「关不掉」。 */
  readonly stuck: readonly string[]
}

export interface WorkspaceView extends GlobalView {
  readonly cwd: string
  /** 该 cwd 的原始绑定 id；未绑定为 `null`。可能悬空。 */
  readonly binding: string | null
  /** 生效的 pack id；未绑定或悬空时为 `default`。 */
  readonly packId: string
  readonly packName: string
  readonly live: boolean
  readonly hidden: readonly string[]
  /** 已注册遮蔽副本但复验仍可见的名字。 */
  readonly stuck: readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 把 `sessionId` 解析成工作目录与它的 live Agent。
 *
 * `agent` 必须是 `agents.get()` 返回的**对象本体**：`dsh-scope` 按对象身份查
 * 作用域链，形状相同的替身查不到 agent 层，清单会静默退化成 global 层。
 * 它同时是 `snapshot({ scope })` 的唯一合法入参。
 *
 * 先问 live Agent，再退回 `sessionQuery` 的只读观察（后者没有 scope，只能给出 cwd）。
 *
 * `observeSession` 的观察体**必须在 finally 里释放**：宿主为每次观察保留订阅，
 * 漏一次就是一条长期泄漏；它只暴露 `Symbol.dispose`，没有 `.dispose()`。
 */
async function resolveSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<{ cwd: string; live: boolean; agent: unknown } | null> {
  const agents = asRecord(ctx.get('agents'))
  const get = agents?.['get']
  if (typeof get === 'function') {
    try {
      const agent = get.call(agents, sessionId)
      const record = asRecord(agent)
      const session = asRecord(record?.['session'])
      // 工作目录的权威值在投影里：`cd` 与切换工作区只改投影，`header.cwd` 是会话
      // 创建时的快照。投影还没写过（新会话）时退回 header.cwd——顺序与宿主
      // `skill-catalog` 一致。
      const cwd = projectedCwd(session) ?? readString(asRecord(session?.['header']), 'cwd')
      if (cwd !== null) return { cwd, live: true, agent }
    } catch {
      // Agent 侧失败不致命，继续问 sessionQuery。
    }
  }

  const query = asRecord(ctx.get('sessionQuery'))
  const observe = query?.['observeSession']
  if (typeof observe === 'function') {
    let observation: unknown
    try {
      // 不带 `projectionMode: 'none'`：历史会话的当前目录同样只在投影里。
      observation = await (observe as (id: string) => Promise<unknown>).call(query, sessionId)
      const observed = asRecord(observation)
      const projections = asRecord(observed?.['projections'])
      const values = asRecord(projections?.['values'])
      const cwd = readString(values, 'workingDirectory') ?? readString(asRecord(observed?.['header']), 'cwd')
      if (cwd !== null) return { cwd, live: false, agent: undefined }
    } catch {
      // 未知会话在这里 reject；交给调用方报错。
    } finally {
      releaseObservation(ctx, observation, sessionId)
    }
  }

  return null
}

function releaseObservation(ctx: RouteContext, observation: unknown, sessionId: string): void {
  const record = asRecord(observation)
  if (record === null) return
  try {
    const dispose = (record as Record<symbol, unknown>)[Symbol.dispose]
    if (typeof dispose === 'function') (dispose as () => void).call(observation)
  } catch (error) {
    ctx.logger.warn(`dsh-skill-pack: 释放会话观察失败（sessionId=${sessionId}）：${String(error)}`)
  }
}

/**
 * 来源短标签，给人看。
 *
 * 宿主只给 `provider` 与 `path`：`source` 由 provider 自己填（磁盘 provider 一律填
 * `custom`），对用户没有信息量。按顺序判定：
 * 1. `runtime`：注册表直接注入，没有磁盘出处；
 * 2. 非 `filesystem` / `unknown` 的 provider：那就是某个插件的名字；
 * 3. 路径含 `@deepseek-ai`：官方技能；
 * 4. 其余把路径上卷到 `skills/` 一级，取注册根目录名——
 *    `~/.agents`、`<cwd>/.dsh`，或 `node_modules/<包名>` 里的包名。
 */
function originOf(row: SkillSummaryLike): string {
  if (row.provider === 'runtime') return '运行时'
  if (row.provider !== 'filesystem' && row.provider !== 'unknown') return row.provider
  if (row.path === undefined) return ''
  const posix = row.path.replace(/\\/g, '/')
  if (posix.includes('@deepseek-ai')) return '官方'
  const at = posix.lastIndexOf('/skills/')
  const root = at >= 0 ? posix.slice(0, at) : posix.slice(0, posix.lastIndexOf('/'))
  const segments = root.split('/').filter((segment) => segment !== '')
  const nodeModules = segments.lastIndexOf('node_modules')
  if (nodeModules >= 0 && nodeModules + 1 < segments.length) {
    const pkg = segments[nodeModules + 1]
    if (pkg !== undefined && pkg !== '' && pkg !== 'skills') {
      // scoped 包占两段：`node_modules/@scope/pkg/skills/x` 的包名是 `@scope/pkg`。
      const inner = segments[nodeModules + 2]
      if (pkg.startsWith('@') && inner !== undefined && inner !== '') return `${pkg}/${inner}`
      return pkg
    }
  }
  return segments[segments.length - 1] ?? ''
}


function packViews(book: PackBook): PackView[] {
  const ids = Object.keys(book.packs).sort((a, b) => {
    if (a === b) return 0
    if (a === DEFAULT_PACK_ID) return -1
    if (b === DEFAULT_PACK_ID) return 1
    return a < b ? -1 : 1
  })
  const out: PackView[] = []
  for (const id of ids) {
    const pack = book.packs[id]
    if (pack === undefined) continue
    out.push({
      id,
      name: id === DEFAULT_PACK_ID ? DEFAULT_PACK_NAME : pack.name,
      items: pack.items,
      groups: pack.groups,
      builtin: id === DEFAULT_PACK_ID,
    })
  }
  return out
}

/**
 * 造面板行。
 *
 * 求值本身归 `effective`：面板与装配读同一份结论，这里只把清单上的展示字段拼上去。
 * `scope` 决定用哪条链：`workspace` 走「绑定 pack → default → 内置缺省」，
 * `global` 直接按 default 求值。
 */
function buildRows(
  rows: readonly SkillSummaryLike[],
  state: PolicyState,
  scope: 'global' | 'workspace',
  complete: boolean,
): SkillRow[] {
  const answer = effective({ policy: state, names: rows.map((row) => row.name), scope, complete })
  const answers = new Map(answer.rows.map((row) => [row.name, row]))
  const showOfficial = state.ui.showOfficialSkills
  const out: SkillRow[] = []
  for (const row of rows) {
    const official = isOfficialSkill(row)
    // 官方技能只在面板层面过滤；求值始终用全量清单，
    // 否则把「显示官方技能」关回去之后，之前对它们做的决定会失效。
    if (official && !showOfficial) continue
    const item = answers.get(row.name)
    if (item === undefined) continue
    out.push({
      ...item,
      description: row.description,
      source: row.source,
      provider: row.provider,
      official,
      origin: originOf(row),
    })
  }
  return out
}

function rootSkills(ctx: RouteContext): SkillsFace | null {
  const skills = ctx.get('skills')
  if (typeof skills !== 'object' || skills === null) return null
  return skills as SkillsFace
}

/**
 * 挑一个活 Agent，拿它的 scope 读清单。
 *
 * **全局面板也必须带 scope**。`dsh-skill-filesystem` 由 agent preset 挂载，
 * 注册在 preset 层；`snapshot({})` 不传 scope 时只查 global 层，于是只能看到
 * 那些直接注册在根 ctx 的插件 provider（实测 4 个 provider、15 条），
 * 用户级目录（`.agents/skills`）与工程 skill 全部缺失。
 * 关闭决定仍然写在 default pack，所以用会话清单当「看得见的全集」不改变语义。
 *
 * 没有任何活跃会话时退回 global 层：此时只能看到根 provider，面板会偏少，
 * 但那是暂时状态，新建会话即恢复。
 */
async function readAnyView(ctx: RouteContext, deps: RouteDeps, sessionId?: string): Promise<SnapshotValue> {
  // 优先用调用方给的会话：以前只取 `agents.list()` 的第一个，用户在会话 B 打开面板时
  // 看到的行集合可能来自会话 A 的 preset——状态是全局层的，行却是别人的。
  if (sessionId !== undefined) {
    try {
      const session = await resolveSession(ctx, sessionId)
      // 非 live 的观察没有 scope，只能用它的 cwd；那种情况交给下面的启发式。
      if (session !== null && session.agent !== undefined) {
        return await deps.snapshot.refresh(session.cwd, session.agent)
      }
    } catch {
      // 解析失败不让面板整体失败，退回下面的路径。
    }
  }
  try {
    const agentsService = ctx.get('agents') as { list?: () => unknown } | undefined
    const list = typeof agentsService?.list === 'function' ? (agentsService.list.call(agentsService) as unknown[]) : []
    const agent = Array.isArray(list) ? list[0] : undefined
    const session = (agent as { session?: unknown } | undefined)?.session
    // 投影优先：这条回退路径以前直接读会话头，切目录后会按旧目录刷新。
    const cwd = projectedCwd(session) ?? readString(asRecord(asRecord(session)?.['header']), 'cwd')
    if (agent !== undefined && typeof cwd === 'string' && cwd !== '') {
      return await deps.snapshot.refresh(cwd, agent)
    }
  } catch {
    // 取不到 Agent 就退回全局清单，不让面板整体失败。
  }
  return await deps.snapshot.refresh(null)
}

/** `POST api/skill-pack/global`：全部 pack + 组注册表 + ui + 清单。 */
export async function handleGlobal(
  ctx: RouteContext,
  deps: RouteDeps,
  sessionId?: string,
  /** 试算后的策略状态；给出时视图按它渲染，但清单仍来自真实快照。 */
  policy?: PolicyState,
): Promise<Envelope<GlobalView>> {
  try {
    const skills = rootSkills(ctx)
    if (skills === null) return { ok: false, error: { code: 'internal', message: 'skills 服务不可用' } }
    const view = await readAnyView(ctx, deps, sessionId)
    const state = policy ?? view.policy
    return {
      ok: true,
      value: {
        packs: packViews(state.packs),
        ui: state.ui,
        groups: state.groups,
        bindings: state.bindings,
        skills: buildRows(view.rows, state, 'global', view.complete),
        complete: view.complete,
        warnings: view.warnings,
        stuck: deps.stuck(),
      },
    }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取全局策略失败：${String(error)}` } }
  }
}

async function buildWorkspaceView(
  ctx: RouteContext,
  cwd: string,
  agent: unknown,
  live: boolean,
  stuck: readonly string[],
  deps: RouteDeps,
  /** 试算后的策略状态；给出时视图按它渲染，但清单仍来自真实快照。 */
  policy?: PolicyState,
): Promise<Envelope<WorkspaceView>> {
  const skills = rootSkills(ctx)
  if (skills === null) return { ok: false, error: { code: 'internal', message: 'skills 服务不可用' } }
  // 带 scope 的一次读取已经包含 default 层（`[global, ...chainLayers(scope)]`），
  // 而且与 hooks 共用同一份快照：面板看到的隐藏集就是会话里生效的那一份。
  // 非 live 的会话没有 scope，但 cwd 仍要传：绑定表按 cwd 解析，丢掉它会让
  // 已关闭会话的工作区视图退回 default，显示成「没绑定」。
  const view = await deps.snapshot.refresh(cwd, agent)
  const state = policy ?? view.policy
  const defaultPack = defaultPackOf(state.packs)
  return {
    ok: true,
    value: {
      packs: packViews(state.packs),
      ui: state.ui,
      groups: state.groups,
      bindings: state.bindings,
      skills: buildRows(view.rows, state, 'workspace', view.complete),
      complete: view.complete,
      warnings: view.warnings,
      cwd,
      binding: state.binding,
      packId: state.packId,
      packName: state.pack?.name ?? defaultPack.name,
      live,
      hidden: view.hidden,
      stuck,
    },
  }
}

/** `POST api/skill-pack/workspace`：`{ sessionId }`。 */
export async function handleWorkspace(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  deps: RouteDeps,
): Promise<Envelope<WorkspaceView>> {
  try {
    const sessionId = readString(body, 'sessionId')
    if (sessionId === null) {
      return { ok: false, error: { code: 'unknown-session', message: '工作区请求需要 sessionId' } }
    }
    const resolved = await resolveSession(ctx, sessionId)
    if (resolved === null) {
      return { ok: false, error: { code: 'unknown-session', message: `未找到会话：${sessionId}` } }
    }
    return await buildWorkspaceView(ctx, resolved.cwd, resolved.agent, resolved.live, deps.stuck(), deps)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取工作区策略失败：${String(error)}` } }
  }
}

const OPS = new Set([
  'packItem',
  'packGroup',
  'createPack',
  'renamePack',
  'deletePack',
  'bind',
  'assign',
  'createGroup',
  'renameGroup',
  'deleteGroup',
  'showOfficialSkills',
  'showChip',
  'defaultTab',
])

function readNonEmpty(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function readValue(record: Record<string, unknown>): boolean | null | undefined {
  const value = record['value']
  if (value === null) return null
  return typeof value === 'boolean' ? value : undefined
}

/** 校验入站意图。宁可拒绝整批，也不要半懂地写一半。 */
export function parseCommands(raw: unknown): { ok: true; commands: Command[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }
  const commands: Command[] = []
  const bad = (index: number, message: string) => ({ ok: false as const, message: `commands[${index}] ${message}` })

  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    if (record === null) return bad(index, '不是对象')
    const op = record['op']
    if (typeof op !== 'string' || !OPS.has(op)) return bad(index, 'op 不是已知操作')

    switch (op) {
      case 'showOfficialSkills':
      case 'showChip': {
        const value = record['value']
        if (typeof value !== 'boolean') return bad(index, 'value 必须是布尔')
        commands.push({ op, value })
        break
      }
      case 'defaultTab': {
        const value = record['value']
        if (value !== 'groups' && value !== 'packs' && value !== 'workspace') {
          return bad(index, 'value 必须是 groups、packs 或 workspace')
        }
        commands.push({ op: 'defaultTab', value })
        break
      }
      case 'createPack': {
        const name = record['name']
        if (typeof name !== 'string' || name.trim() === '') return bad(index, 'name 必须是非空字符串')
        commands.push({ op: 'createPack', name })
        break
      }
      case 'renamePack': {
        const packId = readNonEmpty(record, 'packId')
        if (packId === null) return bad(index, 'packId 必须是非空字符串')
        const name = record['name']
        if (typeof name !== 'string' || name.trim() === '') return bad(index, 'name 必须是非空字符串')
        commands.push({ op: 'renamePack', packId, name })
        break
      }
      case 'deletePack': {
        const packId = readNonEmpty(record, 'packId')
        if (packId === null) return bad(index, 'packId 必须是非空字符串')
        commands.push({ op: 'deletePack', packId })
        break
      }
      case 'packItem': {
        const packId = readNonEmpty(record, 'packId')
        if (packId === null) return bad(index, 'packId 必须是非空字符串')
        const name = readNonEmpty(record, 'name')
        if (name === null) return bad(index, 'name 必须是非空字符串')
        const value = readValue(record)
        if (value === undefined) return bad(index, 'value 必须是布尔或 null')
        commands.push({ op: 'packItem', packId, name, value })
        break
      }
      case 'packGroup': {
        const packId = readNonEmpty(record, 'packId')
        if (packId === null) return bad(index, 'packId 必须是非空字符串')
        const groupId = readNonEmpty(record, 'groupId')
        if (groupId === null) return bad(index, 'groupId 必须是非空字符串')
        const value = readValue(record)
        if (value === undefined) return bad(index, 'value 必须是布尔或 null')
        commands.push({ op: 'packGroup', packId, groupId, value })
        break
      }
      case 'bind': {
        const cwd = readNonEmpty(record, 'cwd')
        if (cwd === null || cwd.trim() === '') return bad(index, 'cwd 必须是非空字符串')
        const packId = record['packId']
        if (packId !== null && (typeof packId !== 'string' || packId === '')) {
          return bad(index, 'packId 必须是 pack id 或 null')
        }
        commands.push({ op: 'bind', cwd, packId })
        break
      }
      case 'assign': {
        const name = readNonEmpty(record, 'name')
        if (name === null) return bad(index, 'name 必须是非空字符串')
        const groupId = record['groupId']
        if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) {
          return bad(index, 'groupId 必须是分组 id 或 null')
        }
        commands.push({ op: 'assign', name, groupId })
        break
      }
      case 'createGroup':
      case 'renameGroup': {
        const name = record['name']
        if (typeof name !== 'string' || name.trim() === '') return bad(index, 'name 必须是非空字符串')
        if (op === 'createGroup') {
          commands.push({ op: 'createGroup', name })
          break
        }
        const groupId = readNonEmpty(record, 'groupId')
        if (groupId === null) return bad(index, 'groupId 必须是非空字符串')
        commands.push({ op: 'renameGroup', groupId, name })
        break
      }
      case 'deleteGroup': {
        const groupId = readNonEmpty(record, 'groupId')
        if (groupId === null) return bad(index, 'groupId 必须是非空字符串')
        commands.push({ op: 'deleteGroup', groupId })
        break
      }
      default:
        return bad(index, 'op 不是已知操作')
    }
  }
  return { ok: true, commands }
}

/**
 * 把这次写入产生的告警并进视图。
 *
 * 写失败不改信封：`ok: false` 留给命令解析失败与未知会话，写盘失败是「这次没写成」
 * 而不是「请求无效」，它必须和读警告一起出现在同一个 `warnings` 里。
 */
function withWriteWarnings(
  view: Envelope<WorkspaceView | GlobalView>,
  warnings: readonly string[],
): Envelope<WorkspaceView | GlobalView> {
  if (!view.ok) return view
  const merged = [...warnings]
  for (const warning of view.value.warnings) {
    if (merged.indexOf(warning) < 0) merged.push(warning)
  }
  const value: WorkspaceView | GlobalView = { ...view.value, warnings: merged }
  return { ok: true, value }
}

/**
 * `POST api/skill-pack/apply`：`{ sessionId?, commands, dryRun? }`。
 *
 * `dryRun: true` 只把命令应用在内存里并返回同样的视图，不写盘、不重新落地。
 * 面板的待保存改动每一步都用它渲染「改了之后会是什么样」。
 */
export async function handleApply(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  deps: RouteDeps,
): Promise<Envelope<WorkspaceView | GlobalView>> {
  try {
    const parsed = parseCommands(body?.['commands'])
    if (!parsed.ok) return { ok: false, error: { code: 'bad-request', message: parsed.message } }
    const dryRun = body?.['dryRun'] === true

    // `bind` 自带 cwd，所以写入本身不再依赖会话；sessionId 只决定回哪种视图。
    const sessionId = readString(body, 'sessionId')
    let target: { cwd: string; live: boolean; agent: unknown } | null = null
    if (sessionId !== null) {
      try {
        target = await resolveSession(ctx, sessionId)
      } catch {
        // 会话解析失败不影响写入：绑定命令带自己的 cwd。
      }
    }

    // 写入失败不抛，只把说明塞进 state.warnings；下面把它并进返回的视图。
    const state = dryRun
      ? await previewCommands(target?.cwd ?? null, parsed.commands)
      : await applyCommands(target?.cwd ?? null, parsed.commands)
    if (!dryRun) {
      // 保存不触碰 skill 注册表，因此不会发出 skills/change；这条显式调用是
      // 「同一会话内改策略立刻生效」的唯一来源。失败只降级，不能让写成功的保存报错。
      try {
        await deps.reapply()
      } catch (error) {
        ctx.logger.warn(`dsh-skill-pack: 保存后重新落地失败（策略已写入）：${String(error)}`)
      }
    }

    if (target === null) return withWriteWarnings(await handleGlobal(ctx, deps, undefined, state), state.warnings)
    const view = await buildWorkspaceView(ctx, target.cwd, target.agent, target.live, deps.stuck(), deps, state)
    return withWriteWarnings(view, state.warnings)
  } catch (error) {
    // 写入失败已经在 warnings 里，走不到这里；命令解析失败走上面的 bad-request。
    // 这条只剩渲染最新视图时抛错，属于意外，保留一个兜底信封。
    return { ok: false, error: { code: 'internal', message: `读取最新状态失败：${String(error)}` } }
  }
}
