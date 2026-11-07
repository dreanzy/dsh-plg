import {
  defaultCatalogFeed,
  type CatalogFeed,
  type Support,
  type ToolSchemaLike,
  type ToolsFace,
} from './hooks.js'
import { createResolver, defaultPackOf } from './policy.js'
import { applyCommands, loadState, type PolicyState } from './store.js'
import {
  DEFAULT_PACK_ID,
  type Bindings,
  type Catalog,
  type Command,
  type GroupRegistry,
  type PackBook,
  type UiState,
} from './types.js'

/**
 * 面板路由的三条入口。
 *
 * 信封与同类面板一致（HTTP 恒 200，body 是 { ok, value } 或
 * { ok, error: { code, message } }），前端只认 code，非 2xx 会让它丢掉 body。
 *
 * 一条硬约束：**请求路径里不许同步扫描**。目录扫描要读整个 profile 的 node_modules，
 * 几百毫秒起；请求只读缓存，未就绪就挂后台扫描并置 pending，面板先显示一轮「识别中」。
 */

/** 路由层需要的最小 ctx 面。 */
export interface RouteContext {
  get(name: string): unknown
  logger: { warn(message: string): void }
}

export type ErrorCode = 'bad-request' | 'unknown-session' | 'internal'

export type Envelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }

/**
 * 面板用的一行插件。求值结果由服务端算好，前端只负责渲染。
 *
 * 键是插件包名：一个 npm 包要么整体可用，要么整体不可用。
 */
export interface PluginRow {
  readonly pkg: string
  /** 官方包还是 profile 里的第三方包。 */
  readonly origin: 'profile' | 'official'
  /** 该插件在当前清单里实际存在的工具数。 */
  readonly tools: number
  /** 识别到的段数。 */
  readonly sections: number
  /** 工具 schema 的估算 token（schemas(scope) 投影长度 / 4）。 */
  readonly toolVolume: number
  /** 段字符数。 */
  readonly sectionChars: number
  /** 段归属是否完整。不完整的部分留在孤儿里，面板标注「提示词占用未知」。 */
  readonly sectionKnown: boolean
  /** 该工作区绑定 pack 求值出的最终状态。全局面板只看 default。 */
  readonly open: boolean
  /** 只按 default pack 求值的状态。全局面板用它渲染开关。 */
  readonly openGlobal: boolean
  /** 行内是否带 default pack 的项级覆盖。 */
  readonly itemGlobal: boolean | null
  /** 行内是否带绑定 pack 的项级覆盖。 */
  readonly itemWorkspace: boolean | null
  /** 生效值来自哪个 pack；取内置缺省时是 `default`。 */
  readonly decidedBy: string
  /** 生效值来自 pack 的哪一级；两层都没记录时是 `builtin`。 */
  readonly decidedVia: 'item' | 'group' | 'builtin'
  /** 关闭前需要二次确认：关掉它，模型基本失去工作能力，或本插件自己失效。 */
  readonly protected: boolean
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

export interface PluginView {
  /** 全部 pack，`default` 排第一。 */
  readonly packs: readonly PackView[]
  readonly ui: UiState
  readonly groups: GroupRegistry
  /** 绑定表：键是规范化后的 cwd。 */
  readonly bindings: Bindings
  readonly plugins: readonly PluginRow[]
  /**
   * 过滤前识别到的官方插件数。
   *
   * 面板用它判断「归属扫描有没有定位到 app.asar」——拿过滤后的 `plugins` 数判断，
   * 关掉「显示官方插件」时会把正常情况误报成扫描失败。
   */
  readonly officialTotal: number
  readonly warnings: readonly string[]
  readonly support: Support
  /** 策略里有、目录里没有的包名。保留不删（卸载再装回来决定还在）。 */
  readonly outOfScope: readonly string[]
  /** 目录还没扫完。前端据此把空的归属显示成「识别中」而不是「未知」。 */
  readonly pending: boolean
}

export interface WorkspaceView extends PluginView {
  readonly cwd: string
  /** 该 cwd 的原始绑定 id；未绑定为 `null`。可能悬空。 */
  readonly binding: string | null
  /** 生效的 pack id；未绑定或悬空时为 `default`。 */
  readonly packId: string
  readonly packName: string
  /** 该工作区是否有活的 Agent（没有时清单只有全局视图）。 */
  readonly live: boolean
  /** 已施加限制但复验仍可见的名字。 */
  readonly stuck: readonly string[]
}

/** 路由需要从 hooks 拿到的东西。 */
export interface RouteDeps {
  readonly reapply: () => Promise<void>
  readonly stuck: () => readonly string[]
  readonly support: () => Support
  /** 目录来源。缺省走 catalog.ts；测试注入替身以观测「请求不扫描」。 */
  readonly catalog?: CatalogFeed
}

/** 官方包的判别口径：发布在 @deepseek-ai 作用域下的那些。 */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/**
 * 受保护插件：关掉之后模型基本没法干活，或者本插件自己失效。
 *
 * 只做二次确认，不做禁止：纯聊天的工作区确实想把读写与执行都关掉。
 * 判定用包名精确匹配——这份名单是「删了就没法自救」的那几个，不该由配置改写。
 */
const PROTECTED_PACKAGES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-executor-ptc',
  '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@dreanzy/dsh-plugin-pack',
])

/** 扫描失败后的退避：失败后立刻重试没有意义，空转会把 CPU 打满。 */
const RETRY_AFTER_MS = 60_000

/**
 * 每个 feed 一份扫描状态，而不是一个模块级全局。
 *
 * 这样注入的 feed（测试）与默认 feed（生产）互不串味；scanning 同时充当并发去重锁，
 * 两个请求同时进来只扫一次。
 */
interface ScanState {
  scanning: Promise<void> | null
  /** 上一次**发起**扫描的时间。成功但结果残缺时也要靠它限流。 */
  lastScanAt: number
}

const scanStates = new WeakMap<CatalogFeed, ScanState>()

function scanStateOf(feed: CatalogFeed): ScanState {
  let state = scanStates.get(feed)
  if (state === undefined) {
    state = { scanning: null, lastScanAt: 0 }
    scanStates.set(feed, state)
  }
  return state
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
 * 取这一轮可用的目录。
 *
 * 只有读缓存是同步的；扫描用 void 挂到后台，请求立刻返回（面板最多先显示一轮「识别中」）。
 * 拿不到目录也不报错：归属只是展示信息，工具掩码那条路径在 hooks 里单独判断。
 */
async function currentCatalog(
  ctx: RouteContext,
  deps: RouteDeps,
): Promise<{ catalog: Catalog | null; pending: boolean }> {
  const feed = deps.catalog ?? defaultCatalogFeed
  const state = scanStateOf(feed)

  let catalog: Catalog | null = null
  try {
    catalog = feed.read()
  } catch (error) {
    ctx.logger.warn('dsh-plugin-pack: 读取插件目录缓存失败：' + String(error))
  }

  // 残缺缓存也要重扫：有东西可用，但结果不可信。限流用「上次发起扫描的时间」，
  // 否则「扫描成功但结果残缺」会让每个面板请求都再扫一轮。
  // 只有明确的 `complete: false` 才算残缺；字段缺席（旧缓存、测试替身）按完整处理，
  // 与 `parseCatalog` 的缺省一致。
  if (
    (catalog === null || catalog.complete === false) &&
    state.scanning === null &&
    Date.now() - state.lastScanAt >= RETRY_AFTER_MS
  ) {
    state.lastScanAt = Date.now()
    const scanning = feed
      .load()
      .then(() => undefined)
      .catch((error: unknown) => {
        ctx.logger.warn('dsh-plugin-pack: 扫描插件目录失败：' + String(error))
      })
      .finally(() => {
        state.scanning = null
      })
    state.scanning = scanning
  }

  return { catalog, pending: (catalog === null || catalog.complete === false) && state.scanning !== null }
}

/** 工具 schema 的体积口径：投影的 JSON 字符数除以 4 向上取整。 */
function volumeOf(schema: ToolSchemaLike): number {
  try {
    return Math.ceil(JSON.stringify(schema).length / 4)
  } catch {
    // 定义里有循环引用或 BigInt 时 stringify 会抛。体积记 0 不影响正确性。
    return 0
  }
}

function tryNames(tools: ToolsFace | null, scope: unknown): Set<string> | null {
  if (tools === null) return null
  try {
    const names = new Set<string>()
    for (const definition of tools.definitions(scope)) {
      if (typeof definition?.name === 'string') names.add(definition.name)
    }
    return names
  } catch {
    return null
  }
}

function tryVolumes(tools: ToolsFace | null, scope: unknown): Map<string, number> | null {
  if (tools === null) return null
  try {
    const volumes = new Map<string, number>()
    for (const schema of tools.schemas(scope)) {
      if (typeof schema?.name !== 'string') continue
      volumes.set(schema.name, volumeOf(schema))
    }
    return volumes
  } catch {
    return null
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
    out.push({
      id,
      name: pack.name,
      items: pack.items,
      groups: pack.groups,
      builtin: id === DEFAULT_PACK_ID,
    })
  }
  return out
}


interface BuildInput {
  readonly loaded: PolicyState
  readonly catalog: Catalog | null
  readonly pending: boolean
  readonly tools: ToolsFace | null
  readonly scope: unknown
  readonly deps: RouteDeps
  /** `true` 走「绑定 pack → default」，`false` 只按 default 求值。 */
  readonly workspaceScoped: boolean
}

/**
 * 造面板视图。
 *
 * 工具数与体积取实测（definitions/schemas 带 scope），不是目录里的静态记录：
 * 目录是扫描那一刻的快照，而已卸载的插件的工具不该继续算在面板上。
 * 实测读不到时退回目录记录，并在 warnings 里说明——比显示 0 诚实。
 */
function buildPluginView(input: BuildInput): PluginView {
  const { loaded, catalog, pending, tools, scope, deps, workspaceScoped } = input
  const defaultPack = defaultPackOf(loaded.packs)
  const assignments = loaded.groups.assignments
  const resolver = workspaceScoped
    ? createResolver({ pack: loaded.pack, packId: loaded.packId, defaultPack, assignments })
    : createResolver({ pack: null, defaultPack, assignments })
  const defaultResolver = createResolver({ pack: null, defaultPack, assignments })

  const names = tryNames(tools, scope)
  const volumes = tryVolumes(tools, scope)

  const warnings = [...loaded.warnings]
  if (names === null && tools !== null) {
    warnings.push('当前工具清单不可用，插件行的工具数按扫描记录显示')
  }

  const plugins = [...(catalog?.plugins ?? [])].sort((left, right) =>
    left.pkg < right.pkg ? -1 : left.pkg > right.pkg ? 1 : 0,
  )

  const showOfficial = loaded.ui.showOfficialPlugins === true
  const officialTotal = plugins.filter((plugin) => plugin.pkg.startsWith(OFFICIAL_SCOPE)).length
  const rows: PluginRow[] = []
  for (const plugin of plugins) {
    // 官方插件只在面板层面过滤；求值始终用全量清单——否则拨一下「显示官方插件」
    // 就会连带改变它们的生效状态，而那个开关只该影响列表。
    if (!showOfficial && plugin.pkg.startsWith(OFFICIAL_SCOPE)) continue
    const present = names === null ? plugin.tools : plugin.tools.filter((name) => names.has(name))
    let toolVolume = plugin.toolVolume
    if (volumes !== null) {
      toolVolume = 0
      for (const name of present) toolVolume += volumes.get(name) ?? 0
    }
    const decision = resolver.decide(plugin.pkg)
    rows.push({
      pkg: plugin.pkg,
      origin: plugin.pkg.startsWith(OFFICIAL_SCOPE) ? 'official' : 'profile',
      tools: present.length,
      sections: plugin.sections.length,
      toolVolume,
      sectionChars: plugin.sectionChars,
      sectionKnown: plugin.sectionsKnown,
      open: decision.value,
      openGlobal: defaultResolver.isOpen(plugin.pkg),
      itemGlobal: defaultPack.items[plugin.pkg] ?? null,
      itemWorkspace: loaded.pack === null ? null : (loaded.pack.items[plugin.pkg] ?? null),
      decidedBy: decision.packId,
      decidedVia: decision.via,
      protected: PROTECTED_PACKAGES.has(plugin.pkg),
    })
  }

  // 范围外名字：策略里有、目录里没有。保留不删——卸载再装回来时决定还在。
  const known = new Set(plugins.map((plugin) => plugin.pkg))
  const extras = new Set<string>()
  const collect = (namesInPack: Iterable<string>): void => {
    for (const name of namesInPack) if (!known.has(name)) extras.add(name)
  }
  collect(Object.keys(defaultPack.items))
  if (loaded.pack !== null) collect(Object.keys(loaded.pack.items))
  collect(Object.keys(assignments))

  return {
    packs: packViews(loaded.packs),
    ui: loaded.ui,
    groups: loaded.groups,
    bindings: loaded.bindings,
    plugins: rows,
    // 过滤前的官方插件数。面板用「扫描到几个官方包」判断归属扫描是否失败，
    // 不能拿过滤后的行数判断——关掉「显示官方插件」时会把自己骗成扫描失败。
    officialTotal,
    warnings,
    support: deps.support(),
    outOfScope: [...extras].sort(),
    pending,
  }
}

function rootTools(ctx: RouteContext): ToolsFace | null {
  const tools = ctx.get('tools')
  if (typeof tools !== 'object' || tools === null) return null
  return tools as ToolsFace
}

/**
 * 挑一个活跃会话，拿它的 scope 读清单。
 *
 * 全局面板也必须带 scope：agent preset 挂载的工具注册在 preset 层，
 * definitions() 不传 scope 时只看得见根 ctx 的那几个，面板会缺掉一大截。
 * 没有任何活跃会话时退回全局层：清单偏少，但那是暂时状态，新建会话即恢复。
 */
function pickAgent(ctx: RouteContext): unknown {
  try {
    const agents = asRecord(ctx.get('agents'))
    const list = agents?.['list']
    if (typeof list !== 'function') return undefined
    const raw = (list as () => unknown).call(agents)
    if (!Array.isArray(raw)) return undefined
    return raw[0]
  } catch {
    return undefined
  }
}

/**
 * 把一个 sessionId 解析成工作目录与它的 live Agent。
 *
 * agent 必须是 agents.get() 返回的对象本体：工具作用域按对象身份查链路，
 * 形状相同的替身查不到 agent 层，清单会静默退化成全局层。
 *
 * observeSession 的观察体必须在 finally 里释放：宿主为每次观察保留订阅，
 * 漏一次就是一条长期泄漏；它只暴露 Symbol.dispose，没有 dispose()。
 */
async function resolveSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<{ cwd: string; live: boolean; agent: unknown } | null> {
  const agents = asRecord(ctx.get('agents'))
  const get = agents?.['get']
  if (typeof get === 'function') {
    try {
      const agent = (get as (id: string) => unknown).call(agents, sessionId)
      const cwd = readString(asRecord(asRecord(asRecord(agent)?.['session'])?.['header']), 'cwd')
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
    ctx.logger.warn('dsh-plugin-pack: 释放会话观察失败（sessionId=' + sessionId + '）：' + String(error))
  }
}

/** POST api/plugin-pack/global：全部 pack + 组注册表 + 绑定表 + 全量插件行。 */
export async function handleGlobal(ctx: RouteContext, deps: RouteDeps): Promise<Envelope<PluginView>> {
  try {
    const loaded = await loadState(null)
    const found = await currentCatalog(ctx, deps)
    return {
      ok: true,
      value: buildPluginView({
        loaded,
        catalog: found.catalog,
        pending: found.pending,
        tools: rootTools(ctx),
        scope: pickAgent(ctx),
        deps,
        workspaceScoped: false,
      }),
    }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: '读取全局插件策略失败：' + String(error) } }
  }
}

async function buildWorkspaceView(
  ctx: RouteContext,
  cwd: string,
  agent: unknown,
  live: boolean,
  deps: RouteDeps,
): Promise<Envelope<WorkspaceView>> {
  const loaded = await loadState(cwd)
  const found = await currentCatalog(ctx, deps)
  const base = buildPluginView({
    loaded,
    catalog: found.catalog,
    pending: found.pending,
    tools: rootTools(ctx),
    scope: agent,
    deps,
    workspaceScoped: true,
  })
  const defaultPack = defaultPackOf(loaded.packs)
  return {
    ok: true,
    value: {
      ...base,
      cwd,
      binding: loaded.binding,
      packId: loaded.packId,
      packName: loaded.pack?.name ?? defaultPack.name,
      live,
      stuck: deps.stuck(),
    },
  }
}

/** POST api/plugin-pack/workspace：{ sessionId }。 */
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
      return { ok: false, error: { code: 'unknown-session', message: '未找到会话：' + sessionId } }
    }
    return await buildWorkspaceView(ctx, resolved.cwd, resolved.agent, resolved.live, deps)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: '读取工作区插件策略失败：' + String(error) } }
  }
}

const OPS = new Set([
  'packItem',
  'packGroup',
  'createPack',
  'renamePack',
  'deletePack',
  'bind',
  'addExtra',
  'removeExtra',
  'assign',
  'createGroup',
  'renameGroup',
  'deleteGroup',
  'showOfficialPlugins',
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
      case 'showOfficialPlugins':
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
      case 'addExtra':
      case 'removeExtra': {
        const cwd = readNonEmpty(record, 'cwd')
        if (cwd === null || cwd.trim() === '') return bad(index, 'cwd 必须是非空字符串')
        commands.push({ op, cwd })
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

/** POST api/plugin-pack/apply：{ sessionId?, commands }。 */
export async function handleApply(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  deps: RouteDeps,
): Promise<Envelope<WorkspaceView | PluginView>> {
  try {
    const parsed = parseCommands(body?.['commands'])
    if (!parsed.ok) return { ok: false, error: { code: 'bad-request', message: parsed.message } }

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

    await applyCommands(target?.cwd ?? null, parsed.commands)
    // 策略写入不产生宿主事件，这条显式调用是「同一会话内改策略立刻生效」的唯一来源。
    // 失败只降级，不能让写成功的保存报错。
    try {
      await deps.reapply()
    } catch (error) {
      ctx.logger.warn('dsh-plugin-pack: 保存后重新施加失败（策略已写入）：' + String(error))
    }

    if (target === null) return await handleGlobal(ctx, deps)
    return await buildWorkspaceView(ctx, target.cwd, target.agent, target.live, deps)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: '写入策略失败：' + String(error) } }
  }
}
