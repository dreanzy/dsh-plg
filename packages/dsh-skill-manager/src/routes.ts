import { createResolver } from './policy.js'
import { isOfficialSkill, type SkillSummaryLike, type SkillsFace } from './inventory.js'
import { applyCommands, workspacePath } from './store.js'
import type { ScopeSnapshot, SnapshotValue } from './snapshot.js'
import type { Command, GlobalPolicy, GroupRegistry, LayerPolicy } from './types.js'

/** 路由层需要的最小 ctx 面。 */
export interface RouteContext {
  get(name: string): unknown
  logger: { warn(message: string): void }
}

export type ErrorCode = 'bad-request' | 'unknown-session' | 'internal'

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

export type Envelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }

/** 面板用的一行 skill。求值结果由服务端算好，前端只负责渲染。 */
export interface SkillRow {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly provider: string
  /** 官方 `@deepseek-ai` 技能：默认不在面板出现。 */
  readonly official: boolean
  readonly groupId: string | null
  /** 按工作区（两层）求值的最终状态。全局面板用不到。 */
  readonly open: boolean
  /** 只按全局层求值的状态。全局面板用它渲染开关。 */
  readonly openGlobal: boolean
  /** 行内是否带项级覆盖（该层有键）。 */
  readonly itemGlobal: boolean | null
  readonly itemWorkspace: boolean | null
  /** 来源短标签，给人看：`.agents`、`.dsh`、`官方`、`插件名`、`运行时`。 */
  readonly origin: string
}

export interface GlobalView {
  readonly policy: GlobalPolicy
  readonly skills: readonly SkillRow[]
  readonly groups: GroupRegistry
  readonly complete: boolean
  readonly warnings: readonly string[]
}

export interface WorkspaceView extends GlobalView {
  readonly cwd: string
  readonly policyPath: string
  readonly workspace: LayerPolicy | null
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
      const cwd = readString(asRecord(asRecord(record?.['session'])?.['header']), 'cwd')
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
      observation = await (observe as (id: string, options: { projectionMode: 'none' }) => Promise<unknown>).call(
        query,
        sessionId,
        { projectionMode: 'none' },
      )
      const cwd = readString(asRecord(asRecord(observation)?.['header']), 'cwd')
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
    ctx.logger.warn(`dsh-skill-manager: 释放会话观察失败（sessionId=${sessionId}）：${String(error)}`)
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
    if (pkg !== undefined && pkg !== '' && pkg !== 'skills') return pkg
  }
  return segments[segments.length - 1] ?? ''
}

function buildRows(
  rows: readonly SkillSummaryLike[],
  global: GlobalPolicy,
  workspace: LayerPolicy | null,
  groups: GroupRegistry,
  showOfficial: boolean,
): SkillRow[] {
  const workspaceResolver = createResolver({ workspace, global, assignments: groups.assignments })
  const globalResolver = createResolver({ workspace: null, global, assignments: groups.assignments })
  const out: SkillRow[] = []
  for (const row of rows) {
    const official = isOfficialSkill(row)
    // 官方技能只在面板层面过滤；求值始终用全量清单，
    // 否则把「显示官方技能」关回去之后，之前对它们做的决定会失效。
    if (official && !showOfficial) continue
    out.push({
      name: row.name,
      description: row.description,
      source: row.source,
      provider: row.provider,
      official,
      groupId: workspaceResolver.groupOf(row.name) ?? null,
      open: workspaceResolver.isOpen(row.name),
      openGlobal: globalResolver.isOpen(row.name),
      itemGlobal: global.items[row.name] ?? null,
      itemWorkspace: workspace?.items[row.name] ?? null,
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
 * 关闭决定仍然写全局层，所以用会话清单当「看得见的全集」不改变语义。
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
    const session = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session
    const cwd = session?.header?.cwd
    if (agent !== undefined && typeof cwd === 'string' && cwd !== '') {
      return await deps.snapshot.refresh(cwd, agent)
    }
  } catch {
    // 取不到 Agent 就退回全局清单，不让面板整体失败。
  }
  return await deps.snapshot.refresh(null)
}

/** `POST api/skill-manager/global`：全局层策略 + 全量清单。 */
export async function handleGlobal(
  ctx: RouteContext,
  deps: RouteDeps,
  sessionId?: string,
): Promise<Envelope<GlobalView>> {
  try {
    const skills = rootSkills(ctx)
    if (skills === null) return { ok: false, error: { code: 'internal', message: 'skills 服务不可用' } }
    const view = await readAnyView(ctx, deps, sessionId)
    return {
      ok: true,
      value: {
        policy: view.policy.global,
        skills: buildRows(
          view.rows,
          view.policy.global,
          null,
          view.policy.groups,
          view.policy.global.showOfficialSkills,
        ),
        groups: view.policy.groups,
        complete: view.complete,
        warnings: view.warnings,
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
): Promise<Envelope<WorkspaceView>> {
  const skills = rootSkills(ctx)
  if (skills === null) return { ok: false, error: { code: 'internal', message: 'skills 服务不可用' } }
  // 带 scope 的一次读取已经包含 global 层（`[global, ...chainLayers(scope)]`），
  // 而且与 hooks 共用同一份快照：面板看到的隐藏集就是会话里生效的那一份。
  const view = await deps.snapshot.refresh(agent === undefined ? null : cwd, agent)
  return {
    ok: true,
    value: {
      policy: view.policy.global,
      workspace: view.policy.workspace,
      skills: buildRows(
        view.rows,
        view.policy.global,
        view.policy.workspace,
        view.policy.groups,
        view.policy.global.showOfficialSkills,
      ),
      groups: view.policy.groups,
      complete: view.complete,
      warnings: view.warnings,
      cwd,
      policyPath: workspacePath(cwd),
      live,
      hidden: view.hidden,
      stuck,
    },
  }
}

/** `POST api/skill-manager/workspace`：`{ sessionId }`。 */
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
  'item',
  'group',
  'assign',
  'createGroup',
  'renameGroup',
  'deleteGroup',
  'showOfficialSkills',
  'showSidebarEntry',
])

/** 校验入站意图。宁可拒绝整批，也不要半懂地写一半。 */
export function parseCommands(raw: unknown): { ok: true; commands: Command[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }
  const commands: Command[] = []
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    if (record === null) return { ok: false, message: `commands[${index}] 不是对象` }
    const op = record['op']
    if (typeof op !== 'string' || !OPS.has(op)) {
      return { ok: false, message: `commands[${index}].op 不是已知操作` }
    }
    if (op === 'showOfficialSkills' || op === 'showSidebarEntry') {
      const value = record['value']
      if (typeof value !== 'boolean') return { ok: false, message: `commands[${index}].value 必须是布尔` }
      commands.push(op === 'showSidebarEntry' ? { op: 'showSidebarEntry', value } : { op: 'showOfficialSkills', value })
      continue
    }
    if (op === 'assign') {
      const name = record['name']
      const groupId = record['groupId']
      if (typeof name !== 'string' || name === '') return { ok: false, message: `commands[${index}].name 必须是非空字符串` }
      if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) {
        return { ok: false, message: `commands[${index}].groupId 必须是分组 id 或 null` }
      }
      commands.push({ op: 'assign', name, groupId })
      continue
    }
    if (op === 'createGroup' || op === 'renameGroup') {
      const name = record['name']
      if (typeof name !== 'string' || name.trim() === '') {
        return { ok: false, message: `commands[${index}].name 必须是非空字符串` }
      }
      if (op === 'createGroup') {
        commands.push({ op: 'createGroup', name })
        continue
      }
      const groupId = record['groupId']
      if (typeof groupId !== 'string' || groupId === '') {
        return { ok: false, message: `commands[${index}].groupId 必须是非空字符串` }
      }
      commands.push({ op: 'renameGroup', groupId, name })
      continue
    }
    if (op === 'deleteGroup') {
      const groupId = record['groupId']
      if (typeof groupId !== 'string' || groupId === '') {
        return { ok: false, message: `commands[${index}].groupId 必须是非空字符串` }
      }
      commands.push({ op: 'deleteGroup', groupId })
      continue
    }
    const layer = record['layer']
    if (layer !== 'global' && layer !== 'workspace') {
      return { ok: false, message: `commands[${index}].layer 必须是 global 或 workspace` }
    }
    const value = record['value']
    if (value !== null && typeof value !== 'boolean') {
      return { ok: false, message: `commands[${index}].value 必须是布尔或 null` }
    }
    if (op === 'item') {
      const name = record['name']
      if (typeof name !== 'string' || name === '') return { ok: false, message: `commands[${index}].name 必须是非空字符串` }
      commands.push({ op: 'item', layer, name, value })
    } else {
      const groupId = record['groupId']
      if (typeof groupId !== 'string' || groupId === '') {
        return { ok: false, message: `commands[${index}].groupId 必须是非空字符串` }
      }
      commands.push({ op: 'group', layer, groupId, value })
    }
  }
  return { ok: true, commands }
}

/** `POST api/skill-manager/apply`：`{ sessionId?, commands }`。 */
export async function handleApply(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  deps: RouteDeps,
): Promise<Envelope<WorkspaceView | GlobalView>> {
  let cwd: string | null = null
  let live = false
  let agent: unknown
  try {
    const parsed = parseCommands(body?.['commands'])
    if (!parsed.ok) return { ok: false, error: { code: 'bad-request', message: parsed.message } }

    const needsWorkspace = parsed.commands.some(
      (command) => (command.op === 'item' || command.op === 'group') && command.layer === 'workspace',
    )
    if (needsWorkspace) {
      const sessionId = readString(body, 'sessionId')
      if (sessionId === null) {
        return { ok: false, error: { code: 'unknown-session', message: '工作区写入需要 sessionId' } }
      }
      const resolved = await resolveSession(ctx, sessionId)
      if (resolved === null) {
        return { ok: false, error: { code: 'unknown-session', message: `未找到会话：${sessionId}` } }
      }
      cwd = resolved.cwd
      live = resolved.live
      agent = resolved.agent
    }

    await applyCommands(cwd, parsed.commands)
    // 保存不触碰 skill 注册表，因此不会发出 skills/change；这条显式调用是
    // 「同一会话内改策略立刻生效」的唯一来源。失败只降级，不能让写成功的保存报错。
    try {
      await deps.reapply()
    } catch (error) {
      ctx.logger.warn(`dsh-skill-manager: 保存后重新落地失败（策略已写入）：${String(error)}`)
    }

    if (cwd === null) {
      const view = await handleGlobal(ctx, deps)
      return view
    }
    return await buildWorkspaceView(ctx, cwd, agent, live, deps.stuck(), deps)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `写入策略失败：${String(error)}` } }
  }
}
