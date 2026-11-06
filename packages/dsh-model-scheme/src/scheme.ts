/**
 * 数据结构的解析、校验与序列化（纯函数）：方案两层，外加提示词覆盖一份。
 *
 * 这一层只管「一份文件长什么样」：形状不对就降级成缺省值并留一条 warning，
 * 从不抛异常。引用是否成立（方案 id 指向谁）不在这里判定，那是 policy.ts 的求值链；
 * 提示词覆盖与内置的合并也不在这里，那是 prompt.ts 的 resolvePrompt。
 *
 * 术语见 GLOSSARY.md：方案 / 档 / 路由 / 首选与备选 / 思考等级跟随。
 */

/** 档 id 固定四个，顺序即难度顺序，落盘与序列化都用这个顺序。 */
export const TIER_IDS = ['tier1', 'tier2', 'tier3', 'tier4'] as const

export type TierId = (typeof TIER_IDS)[number]

/** 档的出厂显示名。文件里没写 `name` 时用它，不写进方案本身。 */
export const TIER_DEFAULT_NAMES: Readonly<Record<TierId, string>> = {
  tier1: '侦察',
  tier2: '速办',
  tier3: '攻坚',
  tier4: '深算',
}

/** 出厂方案 id。不落盘、不可覆盖、不可删除。 */
export const BUILTIN_SCHEME_ID = 'builtin'

/** 出厂方案：会话跟随官方默认，四档全空。 */
export const BUILTIN_SCHEME: Scheme = { name: '出厂方案', tiers: {} }

/** 方案文件条数上限，只为防止文件被写成无界清单。 */
const MAX_SCHEMES = 200

/** 单档备选条数上限，同上。 */
const MAX_FALLBACKS = 16

export function isTierId(value: unknown): value is TierId {
  return typeof value === 'string' && (TIER_IDS as readonly string[]).includes(value)
}

/**
 * 路由：`{ provider, model, reasoningEffort? }`。
 *
 * 省略 `reasoningEffort` 表示「跟随模型默认」，与写成空串不是一回事：
 * 前者让键不存在，后者是坏输入，解析时降级成前者。
 */
export interface Route {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 档：显示名 + 首选 + 有序备选。 */
export interface TierConfig {
  readonly name: string
  readonly primary: Route
  readonly fallbacks: readonly Route[]
}

/** 方案：可选的会话路由 + 至多四档。缺省的档不暴露给模型。 */
export interface Scheme {
  readonly name: string
  readonly session?: Route
  readonly tiers: Readonly<Partial<Record<TierId, TierConfig>>>
}

/** 全局层文件内容。`defaultSchemeId` 缺省即「跟随出厂方案」。 */
export interface SchemeStore {
  readonly defaultSchemeId?: string
  readonly schemes: Readonly<Record<string, Scheme>>
}

/** 工作区层文件内容。`schemeId` 缺省即「跟随全局默认」。 */
export interface WorkspaceBinding {
  readonly schemeId?: string
}

/**
 * 一档的提示词覆盖。
 *
 * 与方案正交：所有方案共用同一份覆盖（spec §6.3.1）。字段缺省即跟随内置，
 * 解析时`''` 与纯空白都当没写——这条在写入侧另有更严的拒绝，见 routes.ts。
 */
export interface PromptTierOverride {
  readonly label?: string
  readonly text?: string
}

/** 提示词覆盖文件内容。`delegation` 缺省即用内置编排段。 */
export interface PromptOverrides {
  readonly delegation?: string
  readonly tiers: Readonly<Partial<Record<TierId, PromptTierOverride>>>
}

/** `resetPrompts` 认的键：编排段一个，档四个。 */
export const PROMPT_KEYS = ['delegation', ...TIER_IDS] as const

export type PromptKey = (typeof PROMPT_KEYS)[number]

export function isPromptKey(value: unknown): value is PromptKey {
  return typeof value === 'string' && (PROMPT_KEYS as readonly string[]).includes(value)
}

/** 解析结果：坏输入降级后的值，加上说明降级原因的可读文本。 */
export interface ParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
}

export const EMPTY_STORE: SchemeStore = { schemes: {} }
export const EMPTY_BINDING: WorkspaceBinding = {}
export const EMPTY_PROMPTS: PromptOverrides = { tiers: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串才算「写了」，其余（含纯空白）一律当没写。 */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 读一份 JSON 对象。
 *
 * 空文件与不存在等价：调用方传进来的是 `undefined`。坏 JSON 是 warning 不是异常，
 * 理由与 spec §6.4 一致——配置文件坏了只该回落出厂方案，不该让会话建不出来。
 */
/** 报错里的位置：有路径就带上，面板才能直接定位到文件（spec §6.4）。 */
function where(label: string, path: string | undefined): string {
  return path === undefined || path === '' ? label : label + '（' + path + '）'
}

function readJsonObject(
  text: string | undefined,
  label: string,
  warnings: string[],
  path?: string,
): Record<string, unknown> | null {
  if (text === undefined || text.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    warnings.push(`${where(label, path)} 不是合法 JSON，已按空配置处理：${String(error)}`)
    return null
  }
  if (!isRecord(raw)) {
    warnings.push(`${label} 顶层不是对象，已按空配置处理`)
    return null
  }
  return raw
}

function checkVersion(raw: Record<string, unknown>, label: string, warnings: string[]): void {
  const version = raw['version']
  if (version === undefined) return
  if (version !== 1) warnings.push(`${label} 的 version 不是 1（${String(version)}），已按 1 解析`)
}

function parseRoute(raw: unknown, label: string, warnings: string[]): Route | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${label} 不是对象，已忽略`)
    return undefined
  }
  const provider = readString(raw['provider'])
  const model = readString(raw['model'])
  if (provider === undefined || model === undefined) {
    warnings.push(`${label} 缺少 provider 或 model，已忽略`)
    return undefined
  }
  const effortRaw = raw['reasoningEffort']
  if (effortRaw === undefined || effortRaw === null) return { provider, model }
  const effort = readString(effortRaw)
  if (effort === undefined) {
    warnings.push(`${label}.reasoningEffort 不是非空字符串，已按「跟随模型默认」处理`)
    return { provider, model }
  }
  return { provider, model, reasoningEffort: effort }
}

function parseFallbacks(raw: unknown, label: string, warnings: string[]): Route[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push(`${label}.fallbacks 不是数组，已忽略`)
    return []
  }
  const fallbacks: Route[] = []
  for (const [index, entry] of raw.entries()) {
    const route = parseRoute(entry, `${label}.fallbacks[${String(index)}]`, warnings)
    if (route !== undefined) fallbacks.push(route)
  }
  if (fallbacks.length > MAX_FALLBACKS) {
    warnings.push(`${label}.fallbacks 超过 ${String(MAX_FALLBACKS)} 条，已只保留前 ${String(MAX_FALLBACKS)} 条`)
    fallbacks.length = MAX_FALLBACKS
  }
  return fallbacks
}

function parseTier(raw: unknown, tierId: TierId, schemeId: string, warnings: string[]): TierConfig | undefined {
  const label = `方案「${schemeId}」的 tiers.${tierId}`
  if (!isRecord(raw)) {
    warnings.push(`${label} 不是对象，已忽略该档`)
    return undefined
  }
  const primary = parseRoute(raw['primary'], `${label}.primary`, warnings)
  if (primary === undefined) {
    warnings.push(`${label} 没有可用的首选路由，已忽略该档`)
    return undefined
  }
  return {
    name: readString(raw['name']) ?? TIER_DEFAULT_NAMES[tierId],
    primary,
    fallbacks: parseFallbacks(raw['fallbacks'], label, warnings),
  }
}

/**
 * 解析一个方案对象。
 *
 * 供两处使用：读文件时按 id 解析，以及写入命令校验调用方给的方案。
 * 返回 `null` 表示「这一份整体不可用」（不是对象），局部坏只降级不整体丢弃。
 */
export function parseScheme(raw: unknown, id: string): ParseResult<Scheme | null> {
  const warnings: string[] = []
  if (!isRecord(raw)) {
    warnings.push(`方案「${id}」不是对象，已忽略`)
    return { value: null, warnings }
  }
  const name = readString(raw['name']) ?? id
  if (readString(raw['name']) === undefined) warnings.push(`方案「${id}」缺少 name，已用 id 当显示名`)

  const sessionRaw = raw['session']
  let session: Route | undefined
  if (sessionRaw !== undefined && sessionRaw !== null) {
    session = parseRoute(sessionRaw, `方案「${id}」的 session`, warnings)
  }

  const tiers: Partial<Record<TierId, TierConfig>> = {}
  const tiersRaw = raw['tiers']
  if (tiersRaw !== undefined && tiersRaw !== null) {
    if (!isRecord(tiersRaw)) {
      warnings.push(`方案「${id}」的 tiers 不是对象，已忽略`)
    } else {
      for (const [key, value] of Object.entries(tiersRaw)) {
        if (!isTierId(key)) {
          warnings.push(`方案「${id}」有不存在的档 id「${key}」，已忽略`)
          continue
        }
        const tier = parseTier(value, key, `${id}`, warnings)
        if (tier !== undefined) tiers[key] = tier
      }
    }
  }

  const scheme: Scheme = session === undefined ? { name, tiers } : { name, session, tiers }
  return { value: scheme, warnings }
}

/** 解析全局层文件。 */
export function parseSchemeStore(text: string | undefined, path?: string): ParseResult<SchemeStore> {
  const warnings: string[] = []
  const raw = readJsonObject(text, '方案文件', warnings, path)
  if (raw === null) return { value: EMPTY_STORE, warnings }
  checkVersion(raw, '方案文件', warnings)

  const schemes: Record<string, Scheme> = {}
  const schemesRaw = raw['schemes']
  if (schemesRaw !== undefined && schemesRaw !== null) {
    if (!isRecord(schemesRaw)) {
      warnings.push('方案文件的 schemes 不是对象，已忽略')
    } else {
      const ids = Object.keys(schemesRaw).sort()
      if (ids.length > MAX_SCHEMES) {
        warnings.push(`方案文件的 schemes 超过 ${String(MAX_SCHEMES)} 项，已只保留前 ${String(MAX_SCHEMES)} 项`)
        ids.length = MAX_SCHEMES
      }
      for (const id of ids) {
        if (id === BUILTIN_SCHEME_ID) {
          warnings.push(`方案文件里不能定义出厂方案「${BUILTIN_SCHEME_ID}」，已忽略`)
          continue
        }
        const parsed = parseScheme(schemesRaw[id], id)
        warnings.push(...parsed.warnings)
        if (parsed.value !== null) schemes[id] = parsed.value
      }
    }
  }

  const defaultSchemeId = readString(raw['defaultSchemeId'])
  if (raw['defaultSchemeId'] !== undefined && raw['defaultSchemeId'] !== null && defaultSchemeId === undefined) {
    warnings.push('方案文件的 defaultSchemeId 不是非空字符串，已按跟随出厂方案处理')
  }

  return {
    value: defaultSchemeId === undefined ? { schemes } : { defaultSchemeId, schemes },
    warnings,
  }
}

/** 解析工作区层文件。 */
export function parseWorkspaceBinding(text: string | undefined, path?: string): ParseResult<WorkspaceBinding> {
  const warnings: string[] = []
  const raw = readJsonObject(text, '工作区方案绑定', warnings, path)
  if (raw === null) return { value: EMPTY_BINDING, warnings }
  checkVersion(raw, '工作区方案绑定', warnings)

  const schemeId = readString(raw['schemeId'])
  if (raw['schemeId'] !== undefined && raw['schemeId'] !== null && schemeId === undefined) {
    warnings.push('工作区方案绑定的 schemeId 不是非空字符串，已按跟随全局默认处理')
  }
  // 跟随 = 键不存在。写成 null 是坏输入，降级成同一个语义。
  return { value: schemeId === undefined ? EMPTY_BINDING : { schemeId }, warnings }
}

/**
 * 读一个提示词覆盖字段。
 *
 * 非字符串是 warning 级降级；空串按 spec §6.3.1 视为「没有覆盖」。读时宽容
 * 是为了不让一份手写的坏文件把整段提示词变空，写入侧另有严格拒绝。
 */
function readOverrideText(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  warnings: string[],
): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  const text = readString(value)
  if (text === undefined) warnings.push(`${label}.${key} 不是非空字符串，已按缺省处理`)
  return text
}

/** 解析提示词覆盖文件。全部字段可选，缺省即跟随内置。 */
export function parsePromptOverrides(text: string | undefined, path?: string): ParseResult<PromptOverrides> {
  const warnings: string[] = []
  const raw = readJsonObject(text, '提示词覆盖文件', warnings, path)
  if (raw === null) return { value: EMPTY_PROMPTS, warnings }
  checkVersion(raw, '提示词覆盖文件', warnings)

  const delegation = readOverrideText(raw, 'delegation', '提示词覆盖文件', warnings)

  const tiers: Partial<Record<TierId, PromptTierOverride>> = {}
  const tiersRaw = raw['tiers']
  if (tiersRaw !== undefined && tiersRaw !== null) {
    if (!isRecord(tiersRaw)) {
      warnings.push('提示词覆盖文件的 tiers 不是对象，已忽略')
    } else {
      for (const [key, value] of Object.entries(tiersRaw)) {
        if (!isTierId(key)) {
          warnings.push(`提示词覆盖文件有不存在的档 id「${key}」，已忽略`)
          continue
        }
        const label = `提示词覆盖文件的 tiers.${key}`
        if (!isRecord(value)) {
          warnings.push(`${label} 不是对象，已忽略`)
          continue
        }
        const tierLabel = readOverrideText(value, 'label', label, warnings)
        const tierText = readOverrideText(value, 'text', label, warnings)
        if (tierLabel === undefined && tierText === undefined) continue
        tiers[key] = {
          ...(tierLabel === undefined ? {} : { label: tierLabel }),
          ...(tierText === undefined ? {} : { text: tierText }),
        }
      }
    }
  }

  return {
    value: { ...(delegation === undefined ? {} : { delegation }), tiers },
    warnings,
  }
}

function routeToJson(route: Route): Record<string, unknown> {
  const out: Record<string, unknown> = { provider: route.provider, model: route.model }
  const effort = route.reasoningEffort
  if (effort !== undefined && effort !== '') out['reasoningEffort'] = effort
  return out
}

function schemeToJson(scheme: Scheme): Record<string, unknown> {
  const out: Record<string, unknown> = { name: scheme.name }
  if (scheme.session !== undefined) out['session'] = routeToJson(scheme.session)
  const tiers: Record<string, unknown> = {}
  for (const tierId of TIER_IDS) {
    const tier = scheme.tiers[tierId]
    if (tier === undefined) continue
    tiers[tierId] = {
      name: tier.name,
      primary: routeToJson(tier.primary),
      fallbacks: tier.fallbacks.map((route) => routeToJson(route)),
    }
  }
  out['tiers'] = tiers
  return out
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * 序列化全局层文件。
 *
 * 方案按 id 排序、档按 TIER_IDS 排序、两空格缩进、结尾换行：同一份配置必须序列化成
 * 同一串字节，否则每次保存都产生一次无意义的差异。出厂方案永不落盘。
 */
export function serializeSchemeStore(store: SchemeStore): string {
  const out: Record<string, unknown> = { version: 1 }
  if (store.defaultSchemeId !== undefined && store.defaultSchemeId !== '') {
    out['defaultSchemeId'] = store.defaultSchemeId
  }
  const schemes: Record<string, unknown> = {}
  for (const id of Object.keys(store.schemes).sort()) {
    if (id === BUILTIN_SCHEME_ID) continue
    const scheme = store.schemes[id]
    if (scheme === undefined) continue
    schemes[id] = schemeToJson(scheme)
  }
  out['schemes'] = schemes
  return serialize(out)
}

/** 序列化工作区层文件。解绑即删键，从不写 `null`。 */
export function serializeWorkspaceBinding(binding: WorkspaceBinding): string {
  const out: Record<string, unknown> = { version: 1 }
  if (binding.schemeId !== undefined && binding.schemeId !== '') out['schemeId'] = binding.schemeId
  return serialize(out)
}

/**
 * 序列化提示词覆盖文件。
 *
 * 与方案文件同一口径：固定键序、两空格缩进、结尾换行，空覆盖不落无意义的空对象。
 * 「恢复内置」的落盘表现是删键，因此这里跳过空串与空档。
 */
export function serializePromptOverrides(overrides: PromptOverrides): string {
  const out: Record<string, unknown> = { version: 1 }
  const delegation = overrides.delegation
  if (delegation !== undefined && delegation.trim() !== '') out['delegation'] = delegation

  const tiers: Record<string, unknown> = {}
  for (const tierId of TIER_IDS) {
    const tier = overrides.tiers[tierId]
    if (tier === undefined) continue
    const entry: Record<string, unknown> = {}
    if (tier.label !== undefined && tier.label.trim() !== '') entry['label'] = tier.label
    if (tier.text !== undefined && tier.text.trim() !== '') entry['text'] = tier.text
    if (Object.keys(entry).length === 0) continue
    tiers[tierId] = entry
  }
  out['tiers'] = tiers
  return serialize(out)
}

/**
 * 按 id 取方案，出厂方案当内置常量返回。
 *
 * 出厂方案不落盘，所以不能用 `schemes[id]` 直接查——那样它在求值链里永远「不存在」。
 */
export function findScheme(store: SchemeStore, id: string | undefined): Scheme | undefined {
  if (id === undefined || id === '') return undefined
  if (id === BUILTIN_SCHEME_ID) return BUILTIN_SCHEME
  return store.schemes[id]
}
