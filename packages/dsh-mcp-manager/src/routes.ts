import { scanRows } from './inventory.js'
import { parseServerDef, readOwned, removeServer, updateOwned, upsertServer, type OwnedServers } from './servers.js'
import { mergeOwnedRows } from './state.js'
import { hasLayerEntry, resolveRow } from './policy.js'
import { applyCommands, globalPath, loadLayers, workspacePath, type Layers, type LoadOptions } from './store.js'
import type { Command, LayerPolicy, LayerSettings, McpRow, ResolvedRow, RowPolicy } from './types.js'

/** 路由层需要的最小 ctx 面。 */
export interface RouteContext {
  get(name: string): unknown
  logger: { warn(message: string): void }
}

export type ErrorCode = 'bad-request' | 'unknown-session' | 'internal'

export type Envelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }

/** 面板用的一行：发现结果 + 求值结果 + 两层原始条目。 */
export interface RowView extends McpRow {
  readonly resolved: ResolvedRow
  readonly globalEntry: RowPolicy | null
  readonly workspaceEntry: RowPolicy | null
}

export interface RowsView {
  readonly rows: readonly RowView[]
  /** 行扫描是否完整；false 时面板不得据此隐藏任何东西。 */
  readonly complete: boolean
  readonly warnings: readonly string[]
  /** 当前会话的工作目录；未解析出来时为 null（只读全局视图）。 */
  readonly cwd: string | null
  readonly live: boolean
  readonly paths: { readonly global: string; readonly workspace: string | null }
  /** 插件托管文件的路径；工单 09 落地前恒为 null。 */
  readonly ownedFile: string | null
  /** 全局层的界面开关。 */
  readonly settings: LayerSettings
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
    ctx.logger.warn(`dsh-mcp-manager: 释放会话观察失败（sessionId=${sessionId}）：${String(error)}`)
  }
}

function entryOf(layer: LayerPolicy | null, rowKey: string): RowPolicy | null {
  if (layer === null || !hasLayerEntry(layer, rowKey)) return null
  return layer.rows[rowKey] ?? null
}

async function buildView(ctx: RouteContext, layers: Layers, cwd: string | null, live: boolean): Promise<Envelope<RowsView>> {
  const loader = ctx.get('loader')
  if (loader === undefined) {
    return { ok: false, error: { code: 'internal', message: '宿主没有 loader 服务' } }
  }
  const scan = scanRows(loader)
  // 托管定义要一起进视图，否则「新增的 server 在面板里看不见」。
  const owned = await readOwned()
  const merged = mergeOwnedRows(scan.rows, owned.value, [...scan.warnings, ...owned.warnings])
  const rows: RowView[] = merged.rows.map((row) => ({
    ...row,
    resolved: resolveRow(row.rowKey, layers.workspace, layers.global),
    globalEntry: entryOf(layers.global, row.rowKey),
    workspaceEntry: entryOf(layers.workspace, row.rowKey),
  }))
  return {
    ok: true,
    value: {
      rows,
      complete: scan.complete,
      warnings: [...merged.warnings, ...layers.warnings],
      cwd,
      live,
      paths: { global: globalPath(), workspace: cwd === null ? null : workspacePath(cwd) },
      ownedFile: null,
      settings: layers.global.settings,
    },
  }
}

function emptyWorkspace(layers: Layers): Layers {
  return { global: layers.global, workspace: null, warnings: layers.warnings }
}

/** 全局视图：只按全局层求值，不需要会话。 */
export async function handleGlobal(ctx: RouteContext): Promise<Envelope<RowsView>> {
  try {
    const layers = await loadLayers({ cwd: null })
    return await buildView(ctx, emptyWorkspace(layers), null, false)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取全局策略失败：${String(error)}` } }
  }
}

/** 工作区视图：按 `{ sessionId }` 解析 cwd 后两层求值。 */
export async function handleWorkspace(ctx: RouteContext, body: Record<string, unknown> | null): Promise<Envelope<RowsView>> {
  const sessionId = body === null ? null : readString(body, 'sessionId')
  if (sessionId === null) {
    return { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } }
  }
  const session = await resolveSession(ctx, sessionId)
  if (session === null) {
    return { ok: false, error: { code: 'unknown-session', message: `无法解析会话：${sessionId}` } }
  }
  try {
    const layers = await loadLayers({ cwd: session.cwd })
    return await buildView(ctx, layers, session.cwd, session.live)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `读取策略失败：${String(error)}` } }
  }
}

/** 把未知形状的数组读成命令列表；坏条目跳过并记 warning。 */
export function parseCommands(raw: unknown, warnings: string[]): readonly Command[] {
  if (!Array.isArray(raw)) {
    warnings.push('commands 不是数组')
    return []
  }
  const commands: Command[] = []
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item)
    if (record === null) {
      warnings.push(`commands[${index}] 不是对象`)
      continue
    }
    const op = readString(record, 'op')
    // 层开关命令没有 rowKey，必须在 rowKey 校验之前分流。
    if (op === 'showSidebarEntry') {
      const value = record['value']
      if (typeof value !== 'boolean') {
        warnings.push(`commands[${index}] 的 value 必须是布尔`)
        continue
      }
      commands.push({ op: 'showSidebarEntry', layer: 'global', value })
      continue
    }
    const layer = readString(record, 'layer')
    const rowKey = readString(record, 'rowKey')
    if (rowKey === null) {
      warnings.push(`commands[${index}] 缺少 rowKey`)
      continue
    }
    if (layer !== 'global' && layer !== 'workspace') {
      warnings.push(`commands[${index}] 的 layer 非法`)
      continue
    }
    if (op === 'enabled') {
      const value = record['value']
      if (value !== null && typeof value !== 'boolean') {
        warnings.push(`commands[${index}] 的 value 必须是布尔或 null`)
        continue
      }
      commands.push({ op: 'enabled', layer, rowKey, value })
      continue
    }
    if (op === 'mode') {
      const value = record['value']
      if (value !== null && value !== 'eager' && value !== 'dynamic' && value !== 'lazy') {
        warnings.push(`commands[${index}] 的 value 必须是合法模式或 null`)
        continue
      }
      commands.push({ op: 'mode', layer, rowKey, value })
      continue
    }
    if (op === 'description') {
      const value = record['value']
      if (value !== null && typeof value !== 'string') {
        warnings.push(`commands[${index}] 的 value 必须是字符串或 null`)
        continue
      }
      commands.push({ op: 'description', layer, rowKey, value })
      continue
    }
    if (op === 'tools') {
      const value = record['value']
      if (value !== null && !(Array.isArray(value) && value.every((item): item is string => typeof item === 'string'))) {
        warnings.push(`commands[${index}] 的 value 必须是字符串数组或 null`)
        continue
      }
      commands.push({ op: 'tools', layer, rowKey, value })
      continue
    }
    warnings.push(`commands[${index}] 的 op 不认识`)
  }
  return commands
}

/** 最近一次 `/apply` 实际收到的命令。诊断用：`/diag` 会读它。 */
let lastApplied: readonly unknown[] = []

export function lastAppliedCommands(): readonly unknown[] {
  return lastApplied
}

/** 写入后要做的补偿动作（刷新名册缓存）。失败不影响写入结果。 */
export interface ApplyHooks {
  readonly afterWrite?: () => Promise<void>
}

/** 应用命令并返回写入后的工作区视图。 */
export async function handleApply(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  hooks: ApplyHooks = {},
): Promise<Envelope<RowsView>> {
  const warnings: string[] = []
  const sessionId = body === null ? null : readString(body, 'sessionId')
  let cwd: string | null = null
  let live = false
  if (sessionId !== null) {
    const session = await resolveSession(ctx, sessionId)
    if (session === null) {
      return { ok: false, error: { code: 'unknown-session', message: `无法解析会话：${sessionId}` } }
    }
    cwd = session.cwd
    live = session.live
  }
  const commands = parseCommands(body?.['commands'], warnings)
  lastApplied = commands
  if (commands.some((command) => command.layer === 'workspace') && cwd === null) {
    return { ok: false, error: { code: 'bad-request', message: '工作区命令缺少 sessionId' } }
  }
  try {
    const options: LoadOptions = { cwd }
    const layers = await applyCommands(options, commands)
    if (hooks.afterWrite !== undefined) {
      try {
        await hooks.afterWrite()
      } catch (error) {
        ctx.logger.warn(`dsh-mcp-manager: 写入后刷新名册失败：${String(error)}`)
      }
    }
    const view = await buildView(ctx, layers, cwd, live)
    if (!view.ok) return view
    return { ok: true, value: { ...view.value, warnings: [...warnings, ...view.value.warnings] } }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `写入策略失败：${String(error)}` } }
  }
}
/** 托管 server 的读写视图。 */
export interface ServersView {
  readonly servers: OwnedServers['servers']
  readonly warnings: readonly string[]
  /** 与用户配置里已有行重名的托管定义：宿主按 serverName 互斥，这些挂不上。 */
  readonly conflicts: readonly string[]
}

function conflictsWithRows(ctx: RouteContext, name: string): boolean {
  const loader = ctx.get('loader')
  if (loader === undefined) return false
  try {
    return scanRows(loader).rows.some((row) => row.serverName === name && !row.owned)
  } catch {
    return false
  }
}

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
  try {
    if (op === 'remove') {
      if (name === null) return { ok: false, error: { code: 'bad-request', message: '缺少 name' } }
      const existed = (await readOwned()).value.servers[name] !== undefined
      await updateOwned(undefined, (current) => removeServer(current, name))
      if (existed) {
        // 定义删掉后把全局层的四个字段也清掉：否则会留下永远求值不到的孤儿键，
        // 用户重建成同名 server 时又会莫名继承旧设置。
        const rowKey = `own:${name}`
        const clear = ['enabled', 'mode', 'tools', 'description'] as const
        await applyCommands({ cwd: null }, clear.map((field) => ({ op: field, layer: 'global', rowKey, value: null })))
      }
    } else if (op === 'upsert') {
      if (name === null) return { ok: false, error: { code: 'bad-request', message: '缺少 name' } }
      const def = parseServerDef(body?.['def'])
      if (def === null) {
        return { ok: false, error: { code: 'bad-request', message: '定义不完整：stdio 需要 command，http 需要合法 url' } }
      }
      if (conflictsWithRows(ctx, name)) {
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
        ctx.logger.warn(`dsh-mcp-manager: 托管定义写入后刷新失败：${String(error)}`)
      }
    }
    const owned = await readOwned()
    warnings.push(...owned.warnings)
    const conflicts = Object.keys(owned.value.servers).filter((candidate) => conflictsWithRows(ctx, candidate))
    return { ok: true, value: { servers: owned.value.servers, warnings, conflicts } }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: `托管定义写入失败：${String(error)}` } }
  }
}