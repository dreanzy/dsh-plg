import {
  applyPolicyCommands,
  defaultCatalogFeed,
  loadPolicyState,
  workspacePolicyPath,
  type CatalogFeed,
  type PolicyState,
  type Support,
  type ToolSchemaLike,
  type ToolsFace,
} from './hooks.js'
import { createResolver } from './policy.js'
import type { Catalog, Command, GlobalPolicy, GroupRegistry, LayerPolicy } from './types.js'

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

/** 面板用的一行插件。求值结果由服务端算好，前端只负责渲染。 */
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
  /** 按工作区（两层）求值的最终状态。 */
  readonly open: boolean
  /** 只按全局层求值的状态。全局面板用它渲染开关。 */
  readonly openGlobal: boolean
  readonly itemGlobal: boolean | null
  readonly itemWorkspace: boolean | null
  /** 关闭前需要二次确认：关掉它，模型基本失去工作能力，或本插件自己失效。 */
  readonly protected: boolean
}

export interface PluginView {
  readonly policy: GlobalPolicy
  readonly plugins: readonly PluginRow[]
  readonly groups: GroupRegistry
  readonly warnings: readonly string[]
  readonly support: Support
  /** 策略里有、目录里没有的包名。保留不删（卸载再装回来决定还在）。 */
  readonly outOfScope: readonly string[]
  /** 目录还没扫完。前端据此把空的归属显示成「识别中」而不是「未知」。 */
  readonly pending: boolean
}

export interface WorkspaceView extends PluginView {
  readonly cwd: string
  readonly policyPath: string
  readonly workspace: LayerPolicy | null
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
  '@dreanzy/dsh-plugin-manager',
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
  lastFailureAt: number
}

const scanStates = new WeakMap<CatalogFeed, ScanState>()

function scanStateOf(feed: CatalogFeed): ScanState {
  let state = scanStates.get(feed)
  if (state === undefined) {
    state = { scanning: null, lastFailureAt: 0 }
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
    ctx.logger.warn('dsh-plugin-manager: 读取插件目录缓存失败：' + String(error))
  }

  if (catalog === null && state.scanning === null && Date.now() - state.lastFailureAt >= RETRY_AFTER_MS) {
    const scanning = feed
      .load()
      .then(() => undefined)
      .catch((error: unknown) => {
        state.lastFailureAt = Date.now()
        ctx.logger.warn('dsh-plugin-manager: 扫描插件目录失败：' + String(error))
      })
      .finally(() => {
        state.scanning = null
      })
    state.scanning = scanning
  }

  return { catalog, pending: catalog === null && state.scanning !== null }
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

interface BuildInput {
  readonly loaded: PolicyState
  readonly catalog: Catalog | null
  readonly pending: boolean
  readonly tools: ToolsFace | null
  readonly scope: unknown
  readonly deps: RouteDeps
}

/**
 * 造面板视图。
 *
 * 工具数与体积取实测（definitions/schemas 带 scope），不是目录里的静态记录：
 * 目录是扫描那一刻的快照，而已卸载的插件的工具不该继续算在面板上。
 * 实测读不到时退回目录记录，并在 warnings 里说明——比显示 0 诚实。
 */
function buildPluginView(input: BuildInput): PluginView {
  const { loaded, catalog, pending, tools, scope, deps } = input
  const workspaceResolver = createResolver({
    workspace: loaded.workspace,
    global: loaded.global,
    assignments: loaded.groups.assignments,
  })
  const globalResolver = createResolver({
    workspace: null,
    global: loaded.global,
    assignments: loaded.groups.assignments,
  })

  const names = tryNames(tools, scope)
  const volumes = tryVolumes(tools, scope)

  const warnings = [...loaded.warnings]
  if (names === null && tools !== null) {
    warnings.push('当前工具清单不可用，插件行的工具数按扫描记录显示')
  }

  const plugins = [...(catalog?.plugins ?? [])].sort((left, right) =>
    left.pkg < right.pkg ? -1 : left.pkg > right.pkg ? 1 : 0,
  )

  const rows: PluginRow[] = []
  for (const plugin of plugins) {
    const present = names === null ? plugin.tools : plugin.tools.filter((name) => names.has(name))
    let toolVolume = plugin.toolVolume
    if (volumes !== null) {
      toolVolume = 0
      for (const name of present) toolVolume += volumes.get(name) ?? 0
    }
    rows.push({
      pkg: plugin.pkg,
      origin: plugin.pkg.startsWith(OFFICIAL_SCOPE) ? 'official' : 'profile',
      tools: present.length,
      sections: plugin.sections.length,
      toolVolume,
      sectionChars: plugin.sectionChars,
      sectionKnown: plugin.sectionsKnown,
      open: workspaceResolver.isOpen(plugin.pkg),
      openGlobal: globalResolver.isOpen(plugin.pkg),
      itemGlobal: loaded.global.items[plugin.pkg] ?? null,
      itemWorkspace: loaded.workspace?.items[plugin.pkg] ?? null,
      protected: PROTECTED_PACKAGES.has(plugin.pkg),
    })
  }

  // 范围外名字：策略里有、目录里没有。保留不删——卸载再装回来时决定还在。
  const known = new Set(plugins.map((plugin) => plugin.pkg))
  const extras = new Set<string>()
  const collect = (namesInLayer: Iterable<string>): void => {
    for (const name of namesInLayer) if (!known.has(name)) extras.add(name)
  }
  collect(Object.keys(loaded.global.items))
  if (loaded.workspace !== null) collect(Object.keys(loaded.workspace.items))
  collect(Object.keys(loaded.groups.assignments))

  return {
    policy: loaded.global,
    plugins: rows,
    groups: loaded.groups,
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
    ctx.logger.warn('dsh-plugin-manager: 释放会话观察失败（sessionId=' + sessionId + '）：' + String(error))
  }
}

/** POST api/plugin-manager/global：全局层策略 + 全量插件行。 */
export async function handleGlobal(ctx: RouteContext, deps: RouteDeps): Promise<Envelope<PluginView>> {
  try {
    const loaded = await loadPolicyState(null)
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
  const loaded = await loadPolicyState(cwd)
  const found = await currentCatalog(ctx, deps)
  const base = buildPluginView({
    loaded,
    catalog: found.catalog,
    pending: found.pending,
    tools: rootTools(ctx),
    scope: agent,
    deps,
  })
  return {
    ok: true,
    value: {
      ...base,
      cwd,
      policyPath: workspacePolicyPath(cwd),
      workspace: loaded.workspace,
      live,
      stuck: deps.stuck(),
    },
  }
}

/** POST api/plugin-manager/workspace：{ sessionId }。 */
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
  'item',
  'group',
  'assign',
  'createGroup',
  'renameGroup',
  'deleteGroup',
  'showSidebarEntry',
])

/** 校验入站意图。宁可拒绝整批，也不要半懂地写一半。 */
export function parseCommands(raw: unknown): { ok: true; commands: Command[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }
  const commands: Command[] = []
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    if (record === null) return { ok: false, message: 'commands[' + String(index) + '] 不是对象' }
    const op = record['op']
    if (typeof op !== 'string' || !OPS.has(op)) {
      return { ok: false, message: 'commands[' + String(index) + '].op 不是已知操作' }
    }
    if (op === 'showSidebarEntry') {
      const value = record['value']
      if (typeof value !== 'boolean') return { ok: false, message: 'commands[' + String(index) + '].value 必须是布尔' }
      commands.push({ op: 'showSidebarEntry', value })
      continue
    }
    if (op === 'assign') {
      const name = record['name']
      const groupId = record['groupId']
      if (typeof name !== 'string' || name === '') {
        return { ok: false, message: 'commands[' + String(index) + '].name 必须是非空字符串' }
      }
      if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) {
        return { ok: false, message: 'commands[' + String(index) + '].groupId 必须是分组 id 或 null' }
      }
      commands.push({ op: 'assign', name, groupId })
      continue
    }
    if (op === 'createGroup' || op === 'renameGroup') {
      const name = record['name']
      if (typeof name !== 'string' || name.trim() === '') {
        return { ok: false, message: 'commands[' + String(index) + '].name 必须是非空字符串' }
      }
      if (op === 'createGroup') {
        commands.push({ op: 'createGroup', name })
        continue
      }
      const groupId = record['groupId']
      if (typeof groupId !== 'string' || groupId === '') {
        return { ok: false, message: 'commands[' + String(index) + '].groupId 必须是非空字符串' }
      }
      commands.push({ op: 'renameGroup', groupId, name })
      continue
    }
    if (op === 'deleteGroup') {
      const groupId = record['groupId']
      if (typeof groupId !== 'string' || groupId === '') {
        return { ok: false, message: 'commands[' + String(index) + '].groupId 必须是非空字符串' }
      }
      commands.push({ op: 'deleteGroup', groupId })
      continue
    }
    const layer = record['layer']
    if (layer !== 'global' && layer !== 'workspace') {
      return { ok: false, message: 'commands[' + String(index) + '].layer 必须是 global 或 workspace' }
    }
    const value = record['value']
    if (value !== null && typeof value !== 'boolean') {
      return { ok: false, message: 'commands[' + String(index) + '].value 必须是布尔或 null' }
    }
    if (op === 'item') {
      const name = record['name']
      if (typeof name !== 'string' || name === '') {
        return { ok: false, message: 'commands[' + String(index) + '].name 必须是非空字符串' }
      }
      commands.push({ op: 'item', layer, name, value })
    } else {
      const groupId = record['groupId']
      if (typeof groupId !== 'string' || groupId === '') {
        return { ok: false, message: 'commands[' + String(index) + '].groupId 必须是非空字符串' }
      }
      commands.push({ op: 'group', layer, groupId, value })
    }
  }
  return { ok: true, commands }
}

/** POST api/plugin-manager/apply：{ sessionId?, commands }。 */
export async function handleApply(
  ctx: RouteContext,
  body: Record<string, unknown> | null,
  deps: RouteDeps,
): Promise<Envelope<WorkspaceView | PluginView>> {
  try {
    const parsed = parseCommands(body?.['commands'])
    if (!parsed.ok) return { ok: false, error: { code: 'bad-request', message: parsed.message } }

    const needsWorkspace = parsed.commands.some(
      (command) => (command.op === 'item' || command.op === 'group') && command.layer === 'workspace',
    )

    let cwd: string | null = null
    let live = false
    let agent: unknown
    if (needsWorkspace) {
      const sessionId = readString(body, 'sessionId')
      if (sessionId === null) {
        return { ok: false, error: { code: 'unknown-session', message: '工作区写入需要 sessionId' } }
      }
      const resolved = await resolveSession(ctx, sessionId)
      if (resolved === null) {
        return { ok: false, error: { code: 'unknown-session', message: '未找到会话：' + sessionId } }
      }
      cwd = resolved.cwd
      live = resolved.live
      agent = resolved.agent
    }

    await applyPolicyCommands(cwd, parsed.commands)
    // 策略写入不产生宿主事件，这条显式调用是「同一会话内改策略立刻生效」的唯一来源。
    // 失败只降级，不能让写成功的保存报错。
    try {
      await deps.reapply()
    } catch (error) {
      ctx.logger.warn('dsh-plugin-manager: 保存后重新施加失败（策略已写入）：' + String(error))
    }

    if (cwd === null) return await handleGlobal(ctx, deps)
    return await buildWorkspaceView(ctx, cwd, agent, live, deps)
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: '写入插件策略失败：' + String(error) } }
  }
}
