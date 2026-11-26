import type { Envelope, ErrorCode } from '@dreanzy/dsh-pack-core'
import {
  cwdFromAgent,
  packViews as corePackViews,
  resolveSession,
  staleKeysOf,
  type Rank,
  type RouteContext,
  type SessionResolution,
} from '@dreanzy/dsh-pack-core'
import { defaultPackOf } from './policy.js'
import { effective, type EffectiveDiff } from './effective.js'
import { isOfficialSkill, type SkillSummaryLike, type SkillsFace } from './inventory.js'
import { applyCommands, previewCommands, type PolicyState } from './store.js'
import type { ScopeSnapshot, SnapshotValue } from './snapshot.js'
import {
  DEFAULT_PACK_ID,
  DEFAULT_PACK_NAME,
  type Bindings,
  type Command,
  type GroupRegistry,
  type Pack,
  type PackBook,
  type UiState,
} from './types.js'

export type { Envelope, ErrorCode, RouteContext }

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

/**
 * 一个残留键。
 *
 * 与 plugin-pack 同形：`kind` 决定清理时发哪种命令，`packs` 说明它出现在哪些 pack 里。
 * 键空间不同（skill 名 vs 组 id），合并显示会让用户分不清。
 */
export interface StaleKey {
  readonly key: string
  readonly kind: 'item' | 'group' | 'assignment'
  readonly packs: readonly string[]
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
  /** 选中 pack 相对 default 的差异。浏览器只渲染，不再自己算。 */
  readonly diff: readonly EffectiveDiff[]
  /** 每个分组的排序档位。 */
  readonly groupRanks: Readonly<Record<string, Rank>>
  readonly warnings: readonly string[]
  /** 已注册遮蔽但复验仍可见的名字。全局面板也要能提示「关不掉」。 */
  readonly stuck: readonly string[]
  /** 策略里有、当前名册里没有的键。保留不删（重新装回来决定还在）。 */
  readonly stale: readonly StaleKey[]
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

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value !== '' ? value : null
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
  // 无斜杠时 lastIndexOf 返回 -1，slice(0, -1) 会去掉最后一个字符。
  const slash = posix.lastIndexOf('/')
  const root = at >= 0 ? posix.slice(0, at) : slash >= 0 ? posix.slice(0, slash) : ''
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


/**
 * 全部 pack，`default` 排第一，其余按名字（`localeCompare(…, 'zh')`）排序。
 *
 * `default` 不参与名字序：它是求值链终点，不是一张普通 pack，混进名字序里用户
 * 找「基线」得先扫一遍列表。重名按 id 兜底——`parsePack` 在 name 缺失时用 id
 * 代替，手改文件可能造出重名，没有兜底就不是全序。
 */
/** 排序与 `default` 的显示名在 core，这里只把值域映射成面板要的 `items` / `groups`。 */
function packViews(book: PackBook): PackView[] {
  const rows = corePackViews<Pack>(
    book.packs,
    { defaultPackId: DEFAULT_PACK_ID, defaultPackName: DEFAULT_PACK_NAME },
    (row) => row.name,
  )
  return rows.map((view) => ({
    id: view.id,
    name: view.name,
    items: view.row.items,
    groups: view.row.groups,
    builtin: view.builtin,
  }))
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
): {
  rows: SkillRow[]
  diff: readonly EffectiveDiff[]
  groupRanks: Readonly<Record<string, Rank>>
  stale: readonly StaleKey[]
} {
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
  // 残留键：策略里有、当前名册里没有。名册是宿主快照给出的那一份，随工作区与
  // preset 变化——同一个 skill 名在不同工作区可能一个是残留、一个不是。
  //
  // 两类名册分开算：项级键与分组归属的键是 skill 名，组级键的键是组 id。
  const known = new Set(rows.map((row) => row.name))
  const itemPacks = new Map<string, string[]>()
  const groupPacks = new Map<string, string[]>()
  for (const [packId, pack] of Object.entries(state.packs.packs)) {
    for (const name of Object.keys(pack.items)) {
      const list = itemPacks.get(name)
      if (list === undefined) itemPacks.set(name, [packId])
      else list.push(packId)
    }
    for (const groupId of Object.keys(pack.groups)) {
      const list = groupPacks.get(groupId)
      if (list === undefined) groupPacks.set(groupId, [packId])
      else list.push(packId)
    }
  }

  const stale: StaleKey[] = []
  for (const name of staleKeysOf(itemPacks.keys(), known)) {
    stale.push({ key: name, kind: 'item', packs: itemPacks.get(name) ?? [] })
  }
  for (const name of staleKeysOf(Object.keys(state.groups.assignments), known)) {
    stale.push({ key: name, kind: 'assignment', packs: [] })
  }
  const groupIds = new Set(state.groups.groups.map((group) => group.id))
  for (const groupId of staleKeysOf(groupPacks.keys(), groupIds)) {
    stale.push({ key: groupId, kind: 'group', packs: groupPacks.get(groupId) ?? [] })
  }
  stale.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))

  return { rows: out, diff: answer.diff, groupRanks: answer.groupRanks, stale }
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
      if (session !== null && session.live) {
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
    // 按会话所属工作区取：这条回退路径没有 sessionId，只能拿第一个 live Agent。
    const cwd = cwdFromAgent(agent)
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
    const built = buildRows(view.rows, state, 'global', view.complete)
    return {
      ok: true,
      value: {
        packs: packViews(state.packs),
        ui: state.ui,
        groups: state.groups,
        bindings: state.bindings,
        skills: built.rows,
        complete: view.complete,
        diff: built.diff,
        groupRanks: built.groupRanks,
        warnings: view.warnings,
        stuck: deps.stuck(),
        stale: built.stale,
      },
    }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取全局策略失败：${String(error)}` } }
  }
}

async function buildWorkspaceView(
  ctx: RouteContext,
  session: SessionResolution,
  stuck: readonly string[],
  deps: RouteDeps,
  /** 试算后的策略状态；给出时视图按它渲染，但清单仍来自真实快照。 */
  policy?: PolicyState,
): Promise<Envelope<WorkspaceView>> {
  const { cwd } = session
  const agent = session.live ? session.agent : undefined
  const { live } = session
  const skills = rootSkills(ctx)
  if (skills === null) return { ok: false, error: { code: 'internal', message: 'skills 服务不可用' } }
  // 带 scope 的一次读取已经包含 default 层（`[global, ...chainLayers(scope)]`），
  // 而且与 hooks 共用同一份快照：面板看到的隐藏集就是会话里生效的那一份。
  // 非 live 的会话没有 scope，但 cwd 仍要传：绑定表按 cwd 解析，丢掉它会让
  // 已关闭会话的工作区视图退回 default，显示成「没绑定」。
  const view = await deps.snapshot.refresh(cwd, agent)
  const state = policy ?? view.policy
  const defaultPack = defaultPackOf(state.packs)
  const built = buildRows(view.rows, state, 'workspace', view.complete)
  return {
    ok: true,
    value: {
      packs: packViews(state.packs),
      ui: state.ui,
      groups: state.groups,
      bindings: state.bindings,
      skills: built.rows,
      complete: view.complete,
      diff: built.diff,
      groupRanks: built.groupRanks,
      warnings: view.warnings,
      cwd,
      binding: state.binding,
      packId: state.packId,
      packName: state.pack?.name ?? defaultPack.name,
      live,
      hidden: view.hidden,
      stuck,
      stale: built.stale,
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
    return await buildWorkspaceView(ctx, resolved, deps.stuck(), deps)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取工作区策略失败：${String(error)}` } }
  }
}

import { parseCommands } from './ops.js'
export { parseCommands }

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
    let target: SessionResolution | null = null
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
    const view = await buildWorkspaceView(ctx, target, deps.stuck(), deps, state)
    return withWriteWarnings(view, state.warnings)
  } catch (error) {
    // 写入失败已经在 warnings 里，走不到这里；命令解析失败走上面的 bad-request。
    // 这条只剩渲染最新视图时抛错，属于意外，保留一个兜底信封。
    return { ok: false, error: { code: 'internal', message: `读取最新状态失败：${String(error)}` } }
  }
}
