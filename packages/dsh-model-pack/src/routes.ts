/**
 * 面板数据路由：`POST /api/model-pack/{read,apply,support,reset}`。
 *
 * 四个处理函数只依赖注入进来的 `RouteDeps`，不读宿主 ctx、不 import policy：
 * 这样它们能在 `node --test` 下用真的 policy 函数加一个临时 home 完整跑通。
 * 注册动作（取 `connection.fetch.register`、生命周期 disposer）留在编排层。
 *
 * 一条硬约束：**HTTP 状态恒为 200**，错误只走信封里的 `code`。
 * 前端只认信封；非 2xx 会让它丢掉 body，面板就只剩一句「请求失败」。
 */

/** 错误码。都短、都稳定，前端按它分支，不解析 message。 */
export type ErrorCode = 'bad-request' | 'internal'

/** 会话路由的引用：面板只比对这两项。 */
export interface RouteRef {
  readonly provider: string
  readonly model: string
}

/** 统一信封：成功带 `data`，失败带 `error: { code, message }`。 */
export type Envelope<T = unknown> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }

/**
 * 能力探测结果（spec §6.4）。
 *
 * `subagents` 为假时面板整块置灰；`restrict` 为假时仍注册工具但保留官方
 * `subagent`，面板标红提示「官方工具未被屏蔽，模型可能绕过档位」。
 * `reason` 是给人看的原始原因，没有缺失时不存在。
 */
export interface SupportView {
  readonly subagents: boolean
  readonly restrict: boolean
  readonly reason?: string
}

/**
 * 路由需要的全部副作用。
 *
 * 全部注入，且形状刻意比 policy 的签名宽（`unknown`）：路由只搬数据，不解释它。
 * `resolve` 与 `support` 是同步的——它们只读内存里的状态与探测结果。
 */
export interface RouteDeps {
  loadState(cwd: string | null): Promise<unknown>
  applyCommands(cwd: string | null, commands: readonly unknown[]): Promise<unknown>
  resolve(state: unknown, cwd: string | null): unknown
  /**
   * 逐键合并提示词覆盖与内置，返回生效值。
   *
   * 读文件由 loadState 一并完成；这里只做合并，路由不必知道文件在哪。
   */
  resolvePrompt(overrides: unknown): unknown
  /** 内置提示词。面板拿它与生效值比对，标出哪些键是用户覆盖。 */
  builtinPrompt(): unknown
  support(): SupportView
  lastError(): string | undefined
  /**
   * 把某个在线会话的模型路由恢复成它所在 pack 的值。
   *
   * 只作用于那一条会话（写一条 `model/selection`），不动 pack 配置，也不影响其他会话。
   * 会话必须在线：空白会话同样有 agent，冷会话需要先打开。
   */
  resetSession(sessionId: string): Promise<RouteRef>
  /**
   * 某条在线会话当前实际用的路由。
   *
   * 面板拿它和 pack 里配的会话路由比对：只有不一致时才需要「恢复」这个动作，
   * 常驻一个按钮会让人以为每次都要点一下。
   */
  sessionModel(sessionId: string): Promise<(RouteRef & { readonly reasoningEffort?: string }) | null>
  logger: { warn(message: string): void }
}

/** 路径。宿主按完整 pathname 匹配，`/api` 前缀不能省。 */
export const ROUTES: { read: string; apply: string; support: string; reset: string } = {
  read: '/api/model-pack/read',
  apply: '/api/model-pack/apply',
  support: '/api/model-pack/support',
  reset: '/api/model-pack/reset',
}

/**
 * 一条写命令。
 *
 * 与 policy.ts 的 `PackCommand` 逐字段一致，但这里自己声明而不 import：
 * 路由层不应把 policy 的类型拖进它的公开签名，否则编排层换实现就要改路由。
 * 形状对不上时编译期看不出来，由 `parseCommands` 与 policy 的解析共同兜底。
 *
 * 一半与其余三个 pack 包同形（`createPack` / `renamePack` / `deletePack` /
 * `bind` / `addExtra` / `removeExtra` / `showChip` / `defaultTab`）；另一半是本包
 * 特有的内容编辑命令：pack 本身就是内容，没有 item 与 group 那种逐项开关。
 */
type ValidCommand =
  | { readonly op: 'putPack'; readonly packId: string; readonly pack: Record<string, unknown> }
  | { readonly op: 'packSession'; readonly packId: string; readonly session: Record<string, unknown> | null }
  | {
      readonly op: 'packTier'
      readonly packId: string
      readonly tierId: string
      readonly tier: Record<string, unknown> | null
    }
  | { readonly op: 'createPack'; readonly name: string }
  | { readonly op: 'renamePack'; readonly packId: string; readonly name: string }
  | { readonly op: 'deletePack'; readonly packId: string }
  | { readonly op: 'bind'; readonly cwd: string; readonly packId: string | null }
  | { readonly op: 'addExtra'; readonly cwd: string }
  | { readonly op: 'removeExtra'; readonly cwd: string }
  | { readonly op: 'showChip'; readonly value: boolean }
  | { readonly op: 'defaultTab'; readonly value: 'packs' | 'workspace' | 'prompts' }
  | {
      readonly op: 'putPrompts'
      readonly delegation?: string | null
      readonly tiers?: Record<string, Record<string, string | null> | null>
    }
  | { readonly op: 'resetPrompts'; readonly keys?: readonly string[] }

const OPS: ReadonlySet<string> = new Set([
  'putPack',
  'packSession',
  'packTier',
  'createPack',
  'renamePack',
  'deletePack',
  'bind',
  'addExtra',
  'removeExtra',
  'showChip',
  'defaultTab',
  'putPrompts',
  'resetPrompts',
])

/** 与 pack.ts 的 `TIER_IDS` / `PROMPT_KEYS` 逐字一致；本层刻意不 import 那份类型。 */
const TIER_IDS: readonly string[] = ['tier1', 'tier2', 'tier3', 'tier4']
const PROMPT_TIER_IDS: readonly string[] = [...TIER_IDS]
const PROMPT_KEYS: readonly string[] = ['delegation', ...PROMPT_TIER_IDS]
const PROMPT_TIER_FIELDS: readonly string[] = ['label', 'text']

/** 内置 pack 的 id。与 pack.ts 的 `DEFAULT_PACK_ID` 逐字一致。 */
const DEFAULT_PACK_ID = 'default'

/** 覆盖段的一个字段：`null` 删键（= 恢复内置），空串与纯空白一律拒绝。 */
function readPromptField(
  value: unknown,
  at: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: at + ' 必须是非空字符串或 null' }
  if (value.trim() === '') {
    return { ok: false, message: at + ' 不能为空串：恢复内置请用 null 或 resetPrompts' }
  }
  return { ok: true, value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 日志失败不该拖垮一次响应：宿主 logger 在卸载中途可能已经不可用。 */
function warn(deps: RouteDeps, message: string): void {
  try {
    deps.logger.warn(message)
  } catch {
    // 吞掉：调用方已经在返回一个错误信封，没有第二条通道可走。
  }
}

function internal(deps: RouteDeps, action: string, error: unknown): Envelope {
  warn(deps, 'model-pack: ' + action + '失败：' + String(error))
  return { ok: false, error: { code: 'internal', message: action + '失败：' + String(error) } }
}

function badRequest(message: string): Envelope {
  return { ok: false, error: { code: 'bad-request', message } }
}

/**
 * 取入参里的 cwd。
 *
 * 缺省、`null`、空白都表示「不回读任何工作区的绑定」——工作区粒度需要目录，
 * 没有目录就没有那一条绑定。非字符串是坏请求：静默当 null 会让 UI 以为已经绑定，
 * 实际回读的是全局视图。
 *
 * 写入本身不依赖它：`bind` / `addExtra` / `removeExtra` 自带 cwd。
 */
function readCwd(body: Record<string, unknown> | null): { ok: true; cwd: string | null } | { ok: false; message: string } {
  const raw = body?.['cwd']
  if (raw === undefined || raw === null) return { ok: true, cwd: null }
  if (typeof raw !== 'string') return { ok: false, message: 'cwd 必须是字符串' }
  // 空白串按缺省处理，但路径本身原样保留：目录名尾部的空白不归我们修剪。
  if (raw.trim() === '') return { ok: true, cwd: null }
  return { ok: true, cwd: raw }
}

/**
 * 校验命令数组。
 *
 * 只校验**形状**：op 是否已知、必填键的类型与取值域。pack 内容是否说得通交给
 * `parsePack` / `parseTier` 降级并留 warning——那里是宽容的，这里是严格的，
 * 因为这里拒绝的是「看不懂的指令」，那里降级的是「看得懂但不合理的配置」。
 *
 * 一条不合格就整批拒绝：部分写入会让 UI 显示半套配置，回滚又无从谈起。
 */
function parseCommands(raw: unknown): { ok: true; commands: ValidCommand[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  // 空批与其余三个 pack 包口径一致：拒绝。空批只会让前端误以为保存过一次。
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }

  const commands: ValidCommand[] = []
  /** 整条命令不合格：`commands[0] 不是对象`。 */
  const bad = (index: number, message: string) => ({ ok: false as const, message: `commands[${index}] ${message}` })
  /** 某个字段不合格：`commands[0].packId 必须是非空字符串`。 */
  const badField = (index: number, field: string, message: string) => ({
    ok: false as const,
    message: `commands[${index}].${field} ${message}`,
  })

  const readId = (record: Record<string, unknown>, key: string): string | null => {
    const value = record[key]
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }

  for (const [index, entry] of raw.entries()) {
    const record = isRecord(entry) ? entry : null
    if (record === null) return bad(index, '不是对象')

    const op = record['op']
    if (typeof op !== 'string' || !OPS.has(op)) return bad(index, 'op 不是已知操作')

    switch (op) {
      case 'createPack': {
        const name = record['name']
        if (typeof name !== 'string' || name.trim() === '') return badField(index, 'name', '必须是非空字符串')
        commands.push({ op: 'createPack', name })
        break
      }
      case 'renamePack': {
        const packId = readId(record, 'packId')
        if (packId === null) return badField(index, 'packId', '必须是非空字符串')
        const name = record['name']
        if (typeof name !== 'string' || name.trim() === '') return badField(index, 'name', '必须是非空字符串')
        commands.push({ op: 'renamePack', packId, name })
        break
      }
      case 'deletePack': {
        const packId = readId(record, 'packId')
        if (packId === null) return badField(index, 'packId', '必须是非空字符串')
        commands.push({ op: 'deletePack', packId })
        break
      }
      case 'putPack': {
        const packId = readId(record, 'packId')
        if (packId === null) return badField(index, 'packId', '必须是非空字符串')
        const pack = record['pack']
        if (!isRecord(pack)) return badField(index, 'pack', '必须是对象')
        commands.push({ op: 'putPack', packId, pack })
        break
      }
      case 'packSession': {
        const packId = readId(record, 'packId')
        if (packId === null) return badField(index, 'packId', '必须是非空字符串')
        const session = record['session']
        if (session !== null && !isRecord(session)) return badField(index, 'session', '必须是对象或 null')
        commands.push({ op: 'packSession', packId, session })
        break
      }
      case 'packTier': {
        const packId = readId(record, 'packId')
        if (packId === null) return badField(index, 'packId', '必须是非空字符串')
        const tierId = record['tierId']
        if (typeof tierId !== 'string' || !TIER_IDS.includes(tierId)) {
          return badField(index, 'tierId', '必须是 ' + TIER_IDS.join(' / ') + ' 之一')
        }
        const tier = record['tier']
        if (tier !== null && !isRecord(tier)) return badField(index, 'tier', '必须是对象或 null')
        commands.push({ op: 'packTier', packId, tierId, tier })
        break
      }
      case 'bind': {
        const cwd = record['cwd']
        if (typeof cwd !== 'string' || cwd.trim() === '') return badField(index, 'cwd', '必须是非空字符串')
        const packId = record['packId']
        if (packId !== null && (typeof packId !== 'string' || packId === '')) {
          return badField(index, 'packId', '必须是 pack id 或 null')
        }
        commands.push({ op: 'bind', cwd, packId })
        break
      }
      case 'addExtra':
      case 'removeExtra': {
        const cwd = record['cwd']
        if (typeof cwd !== 'string' || cwd.trim() === '') return badField(index, 'cwd', '必须是非空字符串')
        commands.push({ op, cwd })
        break
      }
      case 'showChip': {
        const value = record['value']
        if (typeof value !== 'boolean') return badField(index, 'value', '必须是布尔')
        commands.push({ op: 'showChip', value })
        break
      }
      case 'defaultTab': {
        const value = record['value']
        if (value !== 'packs' && value !== 'workspace' && value !== 'prompts') {
          return badField(index, 'value', '必须是 packs、workspace 或 prompts')
        }
        commands.push({ op: 'defaultTab', value })
        break
      }
      case 'putPrompts': {
        const hasDelegation = Object.hasOwn(record, 'delegation')
        const hasTiers = Object.hasOwn(record, 'tiers')
        if (!hasDelegation && !hasTiers) {
          return bad(index, '至少需要 delegation 或 tiers 之一')
        }
        const command: {
          op: 'putPrompts'
          delegation?: string | null
          tiers?: Record<string, Record<string, string | null> | null>
        } = { op: 'putPrompts' }
        if (hasDelegation) {
          const field = readPromptField(record['delegation'], `commands[${index}].delegation`)
          if (!field.ok) return field
          command.delegation = field.value
        }
        if (hasTiers) {
          const tiersRaw = record['tiers']
          if (!isRecord(tiersRaw)) return badField(index, 'tiers', '必须是对象')
          const tiers: Record<string, Record<string, string | null> | null> = {}
          for (const [key, value] of Object.entries(tiersRaw)) {
            if (!PROMPT_TIER_IDS.includes(key)) {
              return badField(index, 'tiers', '有不存在的档 id「' + key + '」')
            }
            if (value === null) {
              tiers[key] = null
              continue
            }
            if (!isRecord(value)) return badField(index, 'tiers.' + key, '必须是对象或 null')
            const patch: Record<string, string | null> = {}
            for (const field of PROMPT_TIER_FIELDS) {
              if (!Object.hasOwn(value, field)) continue
              const parsedField = readPromptField(value[field], `commands[${index}].tiers.${key}.${field}`)
              if (!parsedField.ok) return parsedField
              patch[field] = parsedField.value
            }
            tiers[key] = patch
          }
          command.tiers = tiers
        }
        commands.push(command)
        break
      }
      case 'resetPrompts': {
        const keysRaw = record['keys']
        if (keysRaw === undefined || keysRaw === null) {
          commands.push({ op: 'resetPrompts' })
          break
        }
        if (!Array.isArray(keysRaw)) return badField(index, 'keys', '必须是字符串数组')
        if (keysRaw.length === 0) return badField(index, 'keys', '不能为空数组：省略即全部恢复内置')
        const keys: string[] = []
        for (const [position, value] of keysRaw.entries()) {
          if (typeof value !== 'string') return badField(index, 'keys[' + String(position) + ']', '必须是字符串')
          const key = value.trim()
          if (!PROMPT_KEYS.includes(key)) {
            return badField(index, 'keys[' + String(position) + ']', '不是已知的键「' + value + '」')
          }
          keys.push(key)
        }
        commands.push({ op: 'resetPrompts', keys })
        break
      }
      default:
        return bad(index, 'op 不是已知操作')
    }
  }

  return { ok: true, commands }
}

/**
 * 兼容投影：旧面板（`client/client.js`）按「全局层 + 工作区层」读取
 * `data.state.global.schemes`、`data.state.workspace.schemeId` 与 `data.resolved.scheme`。
 *
 * 数据实际落在 `packs.json` 与 `workspaces.json`；这里只把生效值投影成旧形状，
 * 让面板重写期间不整页空白。旧的写命令（`putScheme` / `setDefaultScheme` /
 * `bindWorkspace`）已不再接受，投影只用于渲染。
 */
function compatState(state: unknown): unknown {
  const record = isRecord(state) ? state : {}
  const book = isRecord(record['packs']) ? record['packs'] : {}
  const packs = isRecord(book['packs']) ? book['packs'] : {}
  const binding = typeof record['binding'] === 'string' ? record['binding'] : null
  return {
    ...record,
    global: { defaultSchemeId: DEFAULT_PACK_ID, schemes: packs },
    workspace: binding === null ? {} : { schemeId: binding },
  }
}

/**
 * 兼容投影：`resolved.pack` 同时以 `scheme` 暴露。
 *
 * 旧面板按 `resolved.scheme.name` 取显示名。新词是 `pack`，两个名字指向同一份数据。
 * `source` 不做映射：`default` 与旧的 `global` 不是同一件事（前者是 pack 名册里的
 * 内置项，后者是已删除的一层），混用会让「绑定失效」与「未绑定」看起来一样。
 */
function compatResolved(resolved: unknown): unknown {
  const record = isRecord(resolved) ? resolved : {}
  return { ...record, scheme: record['pack'] }
}

/**
 * 面板要的提示词视图：生效值、内置值、用户覆盖原样。
 *
 * 三份都给：生效值用来渲染，内置值用来标「与内置相同」，覆盖原样用来判断
 * 「这个键到底有没有被覆盖过」——只比前两份在用户恰好抄了一份内置时分不出来。
 */
interface PromptsView {
  readonly effective: unknown
  readonly builtin: unknown
  readonly overrides: unknown
}

/** 面板要的一份视图。apply 成功后也返回它，前端一次写入一次刷新。 */
interface PanelData {
  readonly state: unknown
  readonly resolved: unknown
  readonly prompts: PromptsView
  readonly support: SupportView
  readonly lastError: string | null
}

function buildData(deps: RouteDeps, cwd: string | null, state: unknown): PanelData {
  const record = isRecord(state) ? state : {}
  const overrides = isRecord(record['prompts']) ? record['prompts'] : { tiers: {} }
  return {
    state: compatState(state),
    resolved: compatResolved(deps.resolve(state, cwd)),
    prompts: {
      effective: deps.resolvePrompt(overrides),
      builtin: deps.builtinPrompt(),
      overrides,
    },
    support: deps.support(),
    // JSON 里 undefined 会让键直接消失；统一成 null，前端只需判真假。
    lastError: deps.lastError() ?? null,
  }
}

/** POST /api/model-pack/read：{ cwd? } → 状态 + 求值结果 + 探测 + 上一次失败原因。 */
export async function handleRead(deps: RouteDeps, body: Record<string, unknown> | null): Promise<Envelope> {
  try {
    const cwdResult = readCwd(body)
    if (!cwdResult.ok) return badRequest(cwdResult.message)
    const cwd = cwdResult.cwd
    const state = await deps.loadState(cwd)
    const data = buildData(deps, cwd, state)

    const rawSessionId = body === null ? undefined : body['sessionId']
    if (typeof rawSessionId !== 'string' || rawSessionId.trim() === '') return { ok: true, data }

    // 会话不在线属于正常情况（冷会话、别的进程），不该让整次读取失败。
    try {
      const sessionModel = await deps.sessionModel(rawSessionId.trim())
      return { ok: true, data: { ...(data as unknown as Record<string, unknown>), sessionModel } }
    } catch {
      return { ok: true, data }
    }
  } catch (error) {
    return internal(deps, '读取模型配置', error)
  }
}

/**
 * POST /api/model-pack/apply：{ cwd?, commands } → 落盘后的同一份视图。
 *
 * 不依赖 sessionId：`bind` 自带 cwd，写入不需要先把会话解析成目录。
 * body 里的 cwd 只决定回读哪一条绑定，缺省就是全局视图。
 */
export async function handleApply(deps: RouteDeps, body: Record<string, unknown> | null): Promise<Envelope> {
  try {
    const parsed = parseCommands(body?.['commands'])
    if (!parsed.ok) return badRequest(parsed.message)

    const cwdResult = readCwd(body)
    if (!cwdResult.ok) return badRequest(cwdResult.message)
    const cwd = cwdResult.cwd

    // applyCommands 的返回值是落盘后重读的完整状态（含本次写入产生的 warning），
    // 不再单独 loadState：那样会丢掉「default pack 不可删除，已忽略」这类说明。
    const state = await deps.applyCommands(cwd, parsed.commands)
    return { ok: true, data: buildData(deps, cwd, state) }
  } catch (error) {
    return internal(deps, '写入模型配置', error)
  }
}

/** POST /api/model-pack/support：无入参 → 探测结果 + 上一次失败原因。 */
export async function handleSupport(deps: RouteDeps, body: Record<string, unknown> | null): Promise<Envelope> {
  // body 不使用：探测结果与目录无关。参数保留只为四条路由同形，注册处可以一视同仁。
  void body
  try {
    return { ok: true, data: { support: deps.support(), lastError: deps.lastError() ?? null } }
  } catch (error) {
    return internal(deps, '探测能力', error)
  }
}

/**
 * 把某个会话的模型恢复成 pack 里的会话路由。
 *
 * 存在的理由：手动切模型写的是会话级选择，切走再切回会保留——这是对的，
 * 但用户没有任何「回到 pack」的出口。这条路由就是那个出口。
 */
export async function handleReset(deps: RouteDeps, body: Record<string, unknown> | null): Promise<Envelope> {
  const sessionId = body === null ? undefined : body['sessionId']
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return badRequest('reset 需要 sessionId')
  }
  try {
    const route = await deps.resetSession(sessionId.trim())
    return { ok: true, data: { provider: route.provider, model: route.model } }
  } catch (error) {
    return internal(deps, '恢复 pack 路由', error)
  }
}

/** 把信封变成 Response。HTTP 恒 200 是这里的唯一职责。 */
export function toResponse(envelope: Envelope): Response {
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 把 `(body) => Promise<Envelope>` 包成 `fetch` 处理器。
 *
 * 取 body 失败（空体、非 JSON、顶层不是对象）一律当 `null`：四条路由里
 * `read` 与 `support` 都不需要入参，空体必须合法。处理器自身的异常也在这里兜住，
 * 保证连接层永远只看到一个 200。
 */
export function wrapHandler(
  handler: (body: Record<string, unknown> | null) => Promise<Envelope>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await request.json()
      body = isRecord(parsed) ? parsed : null
    } catch {
      // 空体合法，见上。
    }
    try {
      return toResponse(await handler(body))
    } catch (error) {
      return toResponse({
        ok: false,
        error: { code: 'internal', message: '路由处理失败：' + String(error) },
      })
    }
  }
}
