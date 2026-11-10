import { cwdFromAgent, cwdFromObserved } from './cwd.js'
import { scanRows } from './inventory.js'
import { effective } from './effective.js'
import { defaultPackOf, rowEntryOf } from './policy.js'
import { parseServerDef, readOwned, removeServer, serversPath, updateOwned, upsertServer, type OwnedServers } from './servers.js'
import { type ScopeSnapshot } from './snapshot.js'
import { applyCommands, groupsPath, loadState, packsPath, previewCommands, workspacesPath, type PolicyState } from './store.js'
import {
  DEFAULT_PACK_ID,
  DEFAULT_PACK_NAME,
  type Bindings,
  type Command,
  type GroupRegistry,
  type McpPack,
  type McpRow,
  type PackBook,
  type ResolvedRow,
  type RowPatch,
  type RowPolicy,
  type SettingsTab,
  type UiState,
} from './types.js'

/** 路由层需要的最小 ctx 面。 */
export interface RouteContext {
  get(name: string): unknown
  logger: { warn(message: string): void }
}

export type ErrorCode = 'bad-request' | 'unknown-session' | 'internal'

/**
 * 路由层依赖。
 *
 * `snapshot` 与 hooks 共用同一份：面板看到的行、求值结果与名册必须与模型那边
 * 是同一次求值的产物，否则会出现「面板显示启用、`mcp_load` 却说 unknown」。
 */
export interface RouteDeps {
  readonly snapshot: ScopeSnapshot
}

export type Envelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }

/** 一个 pack 的面板投影。 */
export interface PackView {
  readonly id: string
  readonly name: string
  /** 组级开关：只有开/关，没有第三个字段。 */
  readonly groups: Readonly<Record<string, boolean>>
  readonly rows: Readonly<Record<string, RowPolicy>>
  /** `default` 是内置 pack：不可删除、不可改名。 */
  readonly builtin: boolean
}

/**
 * 面板用的一行：发现结果 + 求值结论 + 两个 pack 里的原始条目。
 *
 * 求值字段（`open` / `itemWorkspace` / `itemGlobal` / `decidedBy` / `decidedVia`）
 * 摊平在行上，与另外两个包同名：浏览器只渲染，不再自己走链。
 */
export interface RowView extends McpRow, ResolvedRow {
  /** 绑定 pack 里的原始条目；没有即跟随。 */
  readonly packEntry: RowPolicy | null
  /** `default` pack 里的原始条目；没有即内置缺省。 */
  readonly defaultEntry: RowPolicy | null
}

export interface RowsView {
  readonly rows: readonly RowView[]
  /** 行扫描是否完整；false 时面板不得据此隐藏任何东西。 */
  readonly complete: boolean
  readonly warnings: readonly string[]
  /** 当前会话的工作目录；未解析出来时为 null（只读全局视图）。 */
  readonly cwd: string | null
  readonly live: boolean
  /** 该 cwd 的原始绑定 id；未绑定为 null。可能悬空。 */
  readonly binding: string | null
  /** 生效的 pack id；未绑定或悬空时为 `default`。 */
  readonly packId: string
  readonly packName: string
  /** 全部 pack，`default` 排第一。 */
  readonly packs: readonly PackView[]
  readonly ui: UiState
  readonly groups: GroupRegistry
  readonly bindings: Bindings
  /** 三份策略文件 + 托管定义的落盘位置，供面板显示「这些设置存在哪」。 */
  readonly paths: {
    readonly packs: string
    readonly groups: string
    readonly workspaces: string
    readonly servers: string
  }
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
 * 作用域链，形状相同的替身查不到 agent 层。它同时是后续按 agent 注册工具的唯一合法入参。
 *
 * 先问 live Agent，再退回 `sessionQuery` 的只读观察。观察体**必须在 finally 里
 * 释放**：宿主为每次观察保留订阅，漏一次就是一条长期泄漏。
 */
export async function resolveSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<{ cwd: string; live: boolean; agent: unknown } | null> {
  const agents = asRecord(ctx.get('agents'))
  const get = agents?.['get']
  if (typeof get === 'function') {
    try {
      const agent = (get as (id: string) => unknown).call(agents, sessionId)
      const cwd = cwdFromAgent(agent)
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
      const cwd = cwdFromObserved(observation)
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
    ctx.logger.warn(`dsh-mcp-pack: 释放会话观察失败（sessionId=${sessionId}）：${String(error)}`)
  }
}

/** 全部 pack，`default` 排第一，其余按 id 排序。 */
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
    out.push({ id, name: id === DEFAULT_PACK_ID ? DEFAULT_PACK_NAME : pack.name, groups: pack.groups, rows: pack.rows, builtin: id === DEFAULT_PACK_ID })
  }
  return out
}

/**
 * 由共享快照渲染面板视图。
 *
 * 求值本身在 `effective.ts`，由 `snapshot.ts` 连同读盘与缓存一起持有：面板与
 * 闸门、名册读的是同一份结论。这里只把它摊平成面板要的形状，不重算任何一刀。
 *
 * `policy` 给出时按它渲染策略那几段（pack 名册、绑定、组、ui），行与 warnings
 * 仍来自真实快照：试算只改策略，不改「这一刻发现了哪些 server」。
 */
async function buildView(
  ctx: RouteContext,
  deps: RouteDeps,
  cwd: string | null,
  live: boolean,
  /** 试算后的策略状态；给出时视图按它渲染，但行清单仍来自真实快照。 */
  policy?: PolicyState,
): Promise<Envelope<RowsView>> {
  if (ctx.get('loader') === undefined) {
    return { ok: false, error: { code: 'internal', message: '宿主没有 loader 服务' } }
  }
  const view = await deps.snapshot.refresh(cwd)
  const state = policy ?? view.policy
  const defaultPack: McpPack = defaultPackOf(state.packs)
  // 试算视图必须重算一遍求值：面板要看到「改了之后每行会变成什么样」。行清单仍是
  // 真实快照的那一份，只有策略换了；没给 policy 时直接用快照里那份，不重复算。
  const evaluated =
    policy === undefined ? view.effective : effective({ policy: state, rows: view.rows, complete: view.complete })
  const rows: RowView[] = []
  for (const [index, row] of view.rows.entries()) {
    const resolved = evaluated.rows[index]
    if (resolved === undefined) continue
    rows.push({
      ...row,
      ...resolved,
      packEntry: rowEntryOf(state.pack, row.rowKey),
      defaultEntry: rowEntryOf(defaultPack, row.rowKey),
    })
  }
  return {
    ok: true,
    value: {
      rows,
      complete: view.complete,
      warnings: view.warnings,
      cwd,
      live,
      binding: state.binding,
      packId: state.packId,
      packName: state.pack?.name ?? defaultPack.name,
      packs: packViews(state.packs),
      ui: state.ui,
      groups: state.groups,
      bindings: state.bindings,
      paths: {
        packs: packsPath(),
        groups: groupsPath(),
        workspaces: workspacesPath(),
        servers: serversPath(),
      },
    },
  }
}

/** 全局视图：只按 default 求值，不需要会话。 */
export async function handleGlobal(
  ctx: RouteContext,
  deps: RouteDeps,
  /** 试算后的策略状态；给出时视图按它渲染，但行清单仍来自真实快照。 */
  policy?: PolicyState,
): Promise<Envelope<RowsView>> {
  try {
    return await buildView(ctx, deps, null, false, policy)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取全局策略失败：${String(error)}` } }
  }
}

/** 工作区视图：按 `{ sessionId }` 解析 cwd 后，用该目录绑定的 pack 求值。 */
export async function handleWorkspace(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  deps: RouteDeps,
): Promise<Envelope<RowsView>> {
  const sessionId = body === null ? null : readString(body, 'sessionId')
  if (sessionId === null) {
    return { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } }
  }
  const session = await resolveSession(ctx, sessionId)
  if (session === null) {
    return { ok: false, error: { code: 'unknown-session', message: `无法解析会话：${sessionId}` } }
  }
  try {
    return await buildView(ctx, deps, session.cwd, session.live)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取策略失败：${String(error)}` } }
  }
}

const OPS: ReadonlySet<string> = new Set([
  'packRow',
  'packGroup',
  'createPack',
  'renamePack',
  'deletePack',
  'bind',
  'assign',
  'createGroup',
  'renameGroup',
  'deleteGroup',
  'showChip',
  'defaultTab',
])

function readNonEmpty(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function readNullableBool(record: Record<string, unknown>): boolean | null | undefined {
  const value = record['value']
  if (value === null) return null
  return typeof value === 'boolean' ? value : undefined
}

/** 读行级补丁：缺省的键不动，`null` 删键；出现未知类型就拒绝整批。 */
function readPatch(
  raw: unknown,
  bad: (index: number, text: string) => { readonly ok: false; readonly message: string },
  index: number,
): { readonly ok: true; readonly patch: RowPatch } | { readonly ok: false; readonly message: string } {
  const record = asRecord(raw)
  if (record === null) return bad(index, 'patch 必须是对象')
  const patch: {
    enabled?: boolean | null
    mode?: RowPatch['mode']
    tools?: readonly string[] | null
    description?: string | null
  } = {}
  if ('enabled' in record) {
    const value = record['enabled']
    if (value !== null && typeof value !== 'boolean') return bad(index, 'patch.enabled 必须是布尔或 null')
    patch.enabled = value
  }
  if ('mode' in record) {
    const value = record['mode']
    if (value !== null && value !== 'eager' && value !== 'dynamic' && value !== 'lazy') {
      return bad(index, 'patch.mode 必须是合法模式或 null')
    }
    patch.mode = value
  }
  if ('tools' in record) {
    const value = record['tools']
    if (value !== null && !(Array.isArray(value) && value.every((item): item is string => typeof item === 'string'))) {
      return bad(index, 'patch.tools 必须是字符串数组或 null')
    }
    patch.tools = value
  }
  if ('description' in record) {
    const value = record['description']
    if (value !== null && typeof value !== 'string') return bad(index, 'patch.description 必须是字符串或 null')
    patch.description = value
  }
  return { ok: true, patch }
}

/** 校验入站意图。宁可拒绝整批，也不要半懂地写一半。 */
export function parseCommands(
  raw: unknown,
): { readonly ok: true; readonly commands: readonly Command[] } | { readonly ok: false; readonly message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }
  const bad = (index: number, text: string) => ({ ok: false as const, message: `commands[${index}] ${text}` })
  const commands: Command[] = []

  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    if (record === null) return bad(index, '不是对象')
    const op = record['op']
    if (typeof op !== 'string' || !OPS.has(op)) return bad(index, 'op 不是已知操作')

    switch (op) {
      case 'showChip': {
        const value = record['value']
        if (typeof value !== 'boolean') return bad(index, 'value 必须是布尔')
        commands.push({ op: 'showChip', value })
        break
      }
      case 'defaultTab': {
        const value = record['value']
        if (value !== 'servers' && value !== 'groups' && value !== 'packs' && value !== 'workspace') {
          return bad(index, 'value 必须是 servers、groups、packs 或 workspace')
        }
        commands.push({ op: 'defaultTab', value: value as SettingsTab })
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
      case 'packRow': {
        const packId = readNonEmpty(record, 'packId')
        if (packId === null) return bad(index, 'packId 必须是非空字符串')
        const rowKey = readNonEmpty(record, 'rowKey')
        if (rowKey === null) return bad(index, 'rowKey 必须是非空字符串')
        const patch = readPatch(record['patch'], bad, index)
        if (!patch.ok) return patch
        commands.push({ op: 'packRow', packId, rowKey, patch: patch.patch })
        break
      }
      case 'packGroup': {
        const packId = readNonEmpty(record, 'packId')
        if (packId === null) return bad(index, 'packId 必须是非空字符串')
        const groupId = readNonEmpty(record, 'groupId')
        if (groupId === null) return bad(index, 'groupId 必须是非空字符串')
        const value = readNullableBool(record)
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
        const rowKey = readNonEmpty(record, 'rowKey')
        if (rowKey === null) return bad(index, 'rowKey 必须是非空字符串')
        const groupId = record['groupId']
        if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) {
          return bad(index, 'groupId 必须是分组 id 或 null')
        }
        commands.push({ op: 'assign', rowKey, groupId })
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

/** 最近一次 `/apply` 实际收到的命令。诊断用：`/diag` 会读它。 */
let lastApplied: readonly unknown[] = []

export function lastAppliedCommands(): readonly unknown[] {
  return lastApplied
}

/** 写入后要做的补偿动作（刷新名册缓存）。失败不影响写入结果。 */
export interface ApplyHooks {
  /** 与 hooks、面板共用的那份快照：写入后必须由它来失效。 */
  readonly snapshot: ScopeSnapshot
  readonly afterWrite?: () => Promise<void>
}

/**
 * `POST api/mcp-pack/apply`：`{ sessionId?, commands, dryRun? }`。
 *
 * `dryRun: true` 只把命令应用在内存里并返回同样的视图，不写盘、不失效快照、也不
 * 触发写入后的重算。面板的待保存改动每一步都用它渲染「改了之后会是什么样」。
 */
export async function handleApply(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  hooks: ApplyHooks,
): Promise<Envelope<RowsView>> {
  const parsed = parseCommands(body?.['commands'])
  if (!parsed.ok) return { ok: false, error: { code: 'bad-request', message: parsed.message } }
  const dryRun = body?.['dryRun'] === true
  // 自检里的「最近一次写入」只记真的写下去的命令：试算没有写盘，记进去会让诊断说谎。
  if (!dryRun) lastApplied = parsed.commands

  // `bind` 自带 cwd，所以写入本身不依赖会话；sessionId 只决定回哪种视图。
  const sessionId = body === null ? null : readString(body, 'sessionId')
  let session: { cwd: string; live: boolean; agent: unknown } | null = null
  if (sessionId !== null) {
    session = await resolveSession(ctx, sessionId)
    if (session === null) {
      return { ok: false, error: { code: 'unknown-session', message: `无法解析会话：${sessionId}` } }
    }
  }

  // 写失败不在这里报错：applyCommands 把它写进 warnings，随视图一起回给面板。
  const applied = dryRun
    ? await previewCommands(session?.cwd ?? null, parsed.commands)
    : await applyCommands(session?.cwd ?? null, parsed.commands)
  if (!dryRun) {
    // 写入后立刻失效：不依赖 mtime 精度（同毫秒的两次写在 Windows 上会撞车），
    // 也不等任何 TTL。afterWrite 里的重算因此一定读到新值。
    hooks.snapshot.invalidate()
    if (hooks.afterWrite !== undefined) {
      try {
        await hooks.afterWrite()
      } catch (error) {
        ctx.logger.warn(`dsh-mcp-pack: 写入后刷新名册失败：${String(error)}`)
      }
    }
  }
  try {
    const view = await buildView(
      ctx,
      { snapshot: hooks.snapshot },
      session?.cwd ?? null,
      session?.live ?? false,
      // 试算视图按试算后的策略渲染；真写时给 undefined，走快照里那份。
      dryRun ? applied : undefined,
    )
    if (!view.ok) return view
    // 写入（或试算）失败的说明排在读警告之前：它是用户刚才那一下的直接结果。
    return { ok: true, value: { ...view.value, warnings: [...new Set([...applied.warnings, ...view.value.warnings])] } }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取策略失败：${String(error)}` } }
  }
}

/** 托管 server 的读写视图。 */
export interface ServersView {
  readonly servers: OwnedServers['servers']
  readonly warnings: readonly string[]
  /** 与用户配置里已有行重名的托管定义：宿主按 serverName 互斥，这些挂不上。 */
  readonly conflicts: readonly string[]
}

/** 用户配置里已有行的 serverName 集合；一次扫描供整轮使用，loader 不可用时返回 null。 */
function configuredServerNames(ctx: RouteContext): ReadonlySet<string> | null {
  const loader = ctx.get('loader')
  if (loader === undefined) return null
  try {
    return new Set(scanRows(loader).rows.filter((row) => !row.owned).map((row) => row.serverName))
  } catch {
    return null
  }
}

/** 四个字段全清：托管定义删掉后不该留下求值不到的孤儿键。 */
const CLEAR_PATCH: RowPatch = { enabled: null, mode: null, tools: null, description: null }

/**
 * 托管定义的增删。
 *
 * 与 `/apply` 分开：那是「策略」（哪些行可见、怎么加载），这是「定义」（连哪里）。
 * 两套存储、两套校验，混在一起会让命令模型的语义变糊。
 */
export async function handleServers(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  hooks: { readonly afterWrite?: () => Promise<void> } = {},
): Promise<Envelope<ServersView>> {
  const warnings: string[] = []
  const op = body === null ? null : readString(body, 'op')
  const name = body === null ? null : readString(body, 'name')
  const configured = configuredServerNames(ctx)
  try {
    if (op === 'remove') {
      if (name === null) return { ok: false, error: { code: 'bad-request', message: '缺少 name' } }
      const existed = (await readOwned()).value.servers[name] !== undefined
      await updateOwned(undefined, (current) => removeServer(current, name))
      if (existed) {
        // 定义删掉后把各 pack 里这一行的四个字段都清掉：否则会留下永远求值不到的
        // 孤儿键，用户重建成同名 server 时又会莫名继承旧设置。
        const rowKey = `own:${name}`
        const state = await loadState(null)
        const commands: Command[] = []
        for (const [packId, pack] of Object.entries(state.packs.packs)) {
          if (pack.rows[rowKey] === undefined) continue
          commands.push({ op: 'packRow', packId, rowKey, patch: CLEAR_PATCH })
        }
        if (commands.length > 0) await applyCommands(null, commands)
      }
    } else if (op === 'upsert') {
      if (name === null) return { ok: false, error: { code: 'bad-request', message: '缺少 name' } }
      const def = parseServerDef(body?.['def'])
      if (def === null) {
        return { ok: false, error: { code: 'bad-request', message: '定义不完整：stdio 需要 command，http 需要合法 url' } }
      }
      if (configured?.has(name) === true) {
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: `"${name}" 已在你的 cordis 配置里声明；宿主按 serverName 互斥，换个名字`,
          },
        }
      }
      await updateOwned(undefined, (current) => upsertServer(current, name, def))
    } else if (op !== null) {
      return { ok: false, error: { code: 'bad-request', message: `不认识的 op：${op}` } }
    }

    if (op !== null && hooks.afterWrite !== undefined) {
      // 新增的定义要立刻进视图与挂载表，否则用户得重启才能看见。
      try {
        await hooks.afterWrite()
      } catch (error) {
        ctx.logger.warn(`dsh-mcp-pack: 托管定义写入后刷新失败：${String(error)}`)
      }
    }
    const owned = await readOwned()
    warnings.push(...owned.warnings)
    const conflicts = configured === null
      ? []
      : Object.keys(owned.value.servers).filter((candidate) => configured.has(candidate))
    return { ok: true, value: { servers: owned.value.servers, warnings, conflicts } }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `托管定义写入失败：${String(error)}` } }
  }
}
