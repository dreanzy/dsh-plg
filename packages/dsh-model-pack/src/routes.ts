/**
 * 面板数据路由：`POST /api/model-pack/{read,apply}`。
 *
 * 两个处理函数只依赖注入进来的 `RouteDeps`，不读宿主 ctx、不 import policy 的运行时：
 * 这样它们能在 `node --test` 下用真的 policy 函数加一个临时 home 完整跑通。
 * 注册动作（取 `connection.fetch.register`、生命周期 disposer）留在编排层。
 *
 * 一条硬约束：**HTTP 状态恒为 200**，错误只走信封里的 `code`。
 * 前端只认信封；非 2xx 会让它丢掉 body，面板就只剩一句「请求失败」。
 */

import type { PackCommand, PromptTierPatch } from './policy.js'

/** 错误码与信封同其余三个包，定义在 `@dreanzy/dsh-pack-core`（见 ADR-0007）。 */
export type { Envelope, ErrorCode }
import type { Envelope, ErrorCode } from '@dreanzy/dsh-pack-core'

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
  applyCommands(cwd: string | null, commands: readonly PackCommand[]): Promise<unknown>
  /**
   * 试算：把命令应用在内存里，返回同一份视图但不落盘、也不触发重新落地。
   * 面板的待保存改动每一步都用它渲染「改了之后会是什么样」。
   */
  previewCommands(cwd: string | null, commands: readonly PackCommand[]): Promise<unknown>
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
  logger: { warn(message: string): void }
}

/** 路径。宿主按完整 pathname 匹配，`/api` 前缀不能省。 */
export const ROUTES: { read: string; apply: string } = {
  read: '/api/model-pack/read',
  apply: '/api/model-pack/apply',
}

/**
 * 一条写命令。
 *
 * 与 policy.ts 的 `PackCommand` 逐字段一致，但这里自己声明而不 import：
 * 路由层不应把 policy 的类型拖进它的公开签名，否则编排层换实现就要改路由。
 * 形状对不上时编译期看不出来，由 `parseCommands` 与 policy 的解析共同兜底。
 *
 * 一半与其余三个 pack 包同形（`createPack` / `renamePack` / `deletePack` /
 * `bind` / `showChip` / `defaultTab`）；另一半是本包
 * 特有的内容编辑命令：pack 本身就是内容，没有 item 与 group 那种逐项开关。
 */
/** 与 `policy.ts` 的 `PackCommand` 是同一份定义：校验形状与落盘共用一种类型，
 * 新增 op 时编译器会同时提醒两边。 */
type ValidCommand = PackCommand

const OPS: ReadonlySet<string> = new Set([
  'putPack',
  'packSession',
  'packTier',
  'createPack',
  'renamePack',
  'deletePack',
  'bind',
  'showChip',
  'defaultTab',
  'putPrompts',
  'resetPrompts',
])

/** 与 pack.ts 的 `TIER_IDS` / `PROMPT_KEYS` 逐字一致；本层刻意不 import 那份类型。 */
const TIER_IDS: readonly string[] = ['tier1', 'tier2', 'tier3', 'tier4']
const PROMPT_TIER_IDS: readonly string[] = [...TIER_IDS]
const PROMPT_KEYS: readonly string[] = ['delegation', ...PROMPT_TIER_IDS]
const PROMPT_TIER_FIELDS: readonly ('label' | 'text')[] = ['label', 'text']

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
 * 写入本身不依赖它：`bind` 自带 cwd。
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
          tiers?: Record<string, PromptTierPatch | null>
        } = { op: 'putPrompts' }
        if (hasDelegation) {
          const field = readPromptField(record['delegation'], `commands[${index}].delegation`)
          if (!field.ok) return field
          command.delegation = field.value
        }
        if (hasTiers) {
          const tiersRaw = record['tiers']
          if (!isRecord(tiersRaw)) return badField(index, 'tiers', '必须是对象')
          const tiers: Record<string, PromptTierPatch | null> = {}
          for (const [key, value] of Object.entries(tiersRaw)) {
            if (!PROMPT_TIER_IDS.includes(key)) {
              return badField(index, 'tiers', '有不存在的档 id「' + key + '」')
            }
            if (value === null) {
              tiers[key] = null
              continue
            }
            if (!isRecord(value)) return badField(index, 'tiers.' + key, '必须是对象或 null')
            const patch: { label?: string | null; text?: string | null } = {}
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
    state,
    resolved: deps.resolve(state, cwd),
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

/**
 * 视图构造函数：`policy` 给出来时按它渲染（试算视图），否则现读一份。
 *
 * 探测结果与上一次失败始终取真实运行时——试算不改变它们，也不该让人以为变了。
 */
async function buildView(deps: RouteDeps, cwd: string | null, policy?: unknown): Promise<Envelope> {
  const state = policy === undefined ? await deps.loadState(cwd) : policy
  return { ok: true, value: buildData(deps, cwd, state) }
}

/** POST /api/model-pack/read：{ cwd? } → 状态 + 求值结果 + 探测 + 上一次失败原因。 */
export async function handleRead(deps: RouteDeps, body: Record<string, unknown> | null): Promise<Envelope> {
  try {
    const cwdResult = readCwd(body)
    if (!cwdResult.ok) return badRequest(cwdResult.message)
    return await buildView(deps, cwdResult.cwd)
  } catch (error) {
    return internal(deps, '读取模型配置', error)
  }
}

/**
 * POST /api/model-pack/apply：{ cwd?, commands, dryRun? } → 同一份视图。
 *
 * 不依赖 sessionId：`bind` 自带 cwd，写入不需要先把会话解析成目录。
 * body 里的 cwd 只决定回读哪一条绑定，缺省就是全局视图。
 *
 * `dryRun: true` 只把命令应用在内存里并返回同样的视图，不写盘、不重新落地。
 * 面板的待保存改动每一步都用它渲染「改了之后会是什么样」。
 */
export async function handleApply(deps: RouteDeps, body: Record<string, unknown> | null): Promise<Envelope> {
  try {
    const parsed = parseCommands(body?.['commands'])
    if (!parsed.ok) return badRequest(parsed.message)
    const dryRun = body?.['dryRun'] === true

    const cwdResult = readCwd(body)
    if (!cwdResult.ok) return badRequest(cwdResult.message)
    const cwd = cwdResult.cwd

    // 两条路径的返回值都是完整状态（含本次命令产生的 warning），不再单独 loadState：
    // 那样会丢掉「默认 pack 不可删除，已忽略」这类说明。
    const state = dryRun
      ? await deps.previewCommands(cwd, parsed.commands)
      : await deps.applyCommands(cwd, parsed.commands)
    return await buildView(deps, cwd, state)
  } catch (error) {
    return internal(deps, '写入模型配置', error)
  }
}

/** 把信封变成 Response。HTTP 恒 200 是这里的唯一职责。 */
export function toResponse(envelope: Envelope): Response {
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 把 `(body) => Promise<Envelope>` 包成 `fetch` 处理器。
 *
 * 取 body 失败（空体、非 JSON、顶层不是对象）一律当 `null`：`read` 不需要入参，
 * 空体必须合法。处理器自身的异常也在这里兜住，保证连接层永远只看到一个 200。
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
