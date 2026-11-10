/**
 * 数据结构的解析、校验与序列化（纯函数）：pack 名册、工作区绑定，外加提示词覆盖一份。
 *
 * 这一层只管「一份文件长什么样」：形状不对就降级成缺省值并留一条 warning，
 * 从不抛异常。引用是否成立（绑定的 pack 指向谁）不在这里判定，那是 policy.ts 的求值链；
 * 提示词覆盖与内置的合并也不在这里，那是 prompt.ts 的 resolvePrompt。
 *
 * 术语见 GLOSSARY.md：pack / 档 / 路由 / 首选与备选 / 思考等级跟随。
 */

/** 档 id 固定四个，顺序即难度顺序，落盘与序列化都用这个顺序。 */
export const TIER_IDS = ['tier1', 'tier2', 'tier3', 'tier4'] as const

export type TierId = (typeof TIER_IDS)[number]

/** 档的出厂显示名。文件里没写 `name` 时用它，不写进 pack 本身。 */
/**
 * 档的出厂显示名。
 *
 * 用英文，与内置提示词一致：档名会写进系统提示词（`tier1 Scout — …`），
 * 中英混排会让模型看到两套语言。界面语言不影响它——这是数据，不是 UI 文案。
 */
export const TIER_DEFAULT_NAMES: Readonly<Record<TierId, string>> = {
  tier1: 'Scout',
  tier2: 'Quick',
  tier3: 'Deep',
  tier4: 'Heavy',
}

/** 内置 pack 的 id。它同时是求值链的终点，也是未绑定工作区的取值来源。 */
export const DEFAULT_PACK_ID = 'default'

/**
 * 出厂内容，也是 `packs.default` 的缺省值。
 *
 * 它不再是一个不可编辑的旁路：`packs.json` 里的 `default` 可编辑、不可删除、不可改名。
 * 文件里没有 `default` 时补这一份，所以「未配置过」与「default 为空」表现一致。
 */
export const DEFAULT_PACK: Pack = { name: '默认', tiers: {} }

/** pack 条数上限，只为防止文件被写成无界清单。 */
const MAX_PACKS = 200

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

/**
 * 一条路由写成宿主 `select()` / `agentOptions` 的入参。
 *
 * 省略 `reasoningEffort` 与写成空串不是一回事：前者让键不存在 = 跟随模型默认（spec §3），
 * 后者是坏输入，这里按前者处理。编排层与会话路由共用这一份，避免两处各写一遍。
 */
export function selectionOf(route: Route): Route {
  return route.reasoningEffort === undefined || route.reasoningEffort === ''
    ? { provider: route.provider, model: route.model }
    : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
}

/** 档：显示名 + 首选 + 有序备选。 */
export interface TierConfig {
  readonly name: string
  readonly primary: Route
  readonly fallbacks: readonly Route[]
}

/**
 * 一张 pack：可选的会话路由 + 至多四档。缺省的档不暴露给模型。
 *
 * 这就是原来的「方案」。model 领域没有 item 与 group，pack 只含这几项。
 */
export interface Pack {
  readonly name: string
  readonly session?: Route
  readonly tiers: Readonly<Partial<Record<TierId, TierConfig>>>
}

/** `packs.json` 的 pack 名册。`default` 是内置项，永远存在。 */
export interface PackBook {
  readonly packs: Readonly<Record<string, Pack>>
}

/**
 * 工作区绑定表。`bindings` 的键是 `normalizeCwd` 之后的 cwd。
 *
 * 目录清单本身不归这里管：可绑定的目录由宿主提供（开过会话的目录）。
 */
export interface Bindings {
  readonly bindings: Readonly<Record<string, string>>
}

/**
 * 设置页的三页，顺序固定。
 *
 * model 领域没有可分组对象：页签是「分包 | 工作区 | 提示词」。
 */
export type SettingsTab = 'packs' | 'workspace' | 'prompts'

/**
 * 单机 UI 开关，落在 `packs.json` 的 `ui` 段。
 *
 * `defaultTab` 是「打开设置时默认显示」的那一页，与「当前正在看哪一页」是两件事：
 * 临时切页不写盘，只有设置页顶部那组单选才改这个值。
 */
export interface UiState {
  /** chip 是否出现。缺省开：文件里没写这个键时，用户期待入口在。 */
  showChip: boolean
  defaultTab: SettingsTab
}

/**
 * 一档的提示词覆盖。
 *
 * 与 pack 正交：所有 pack 共用同一份覆盖（spec §6.3.1）。字段缺省即跟随内置，
 * 解析时 `''` 与纯空白都当没写——这条在写入侧另有更严的拒绝，见 routes.ts。
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

export const EMPTY_PACKS: PackBook = { packs: { [DEFAULT_PACK_ID]: DEFAULT_PACK } }
export const EMPTY_BINDINGS: Bindings = { bindings: {} }
export const EMPTY_UI: UiState = { showChip: true, defaultTab: 'packs' }
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

/** 报错里的位置：有路径就带上，面板才能直接定位到文件（spec §6.4）。 */
function where(label: string, path: string | undefined): string {
  return path === undefined || path === '' ? label : label + '（' + path + '）'
}

/**
 * 读一份 JSON 对象。
 *
 * 空文件与不存在等价：调用方传进来的是 `undefined`。坏 JSON 是 warning 不是异常，
 * 理由与 spec §6.4 一致——配置文件坏了只该回落出厂内容，不该让会话建不出来。
 */
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

export function parseRoute(raw: unknown, label: string, warnings: string[]): Route | undefined {
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

/**
 * 解析一档。
 *
 * 供两处使用：读文件时按 pack 解析，以及 `packTier` 命令校验调用方给的档。
 * 返回 `undefined` 表示这一档不可用（没有首选路由）。
 */
export function parseTier(
  raw: unknown,
  tierId: TierId,
  packId: string,
  warnings: string[],
): TierConfig | undefined {
  const label = `pack「${packId}」的 tiers.${tierId}`
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
 * 解析一张 pack。
 *
 * 供两处使用：读文件时按 id 解析，以及写入命令校验调用方给的 pack。
 * 返回 `null` 表示「这一份整体不可用」（不是对象），局部坏只降级不整体丢弃。
 */
export function parsePack(raw: unknown, id: string, warnings: string[]): Pack | null {
  if (!isRecord(raw)) {
    warnings.push(`pack「${id}」不是对象，已忽略`)
    return null
  }
  const fallbackName = id === DEFAULT_PACK_ID ? DEFAULT_PACK.name : id
  const rawName = readString(raw['name'])
  if (rawName === undefined) warnings.push(`pack「${id}」缺少 name，已用「${fallbackName}」当显示名`)

  const sessionRaw = raw['session']
  let session: Route | undefined
  if (sessionRaw !== undefined && sessionRaw !== null) {
    session = parseRoute(sessionRaw, `pack「${id}」的 session`, warnings)
  }

  const tiers: Partial<Record<TierId, TierConfig>> = {}
  const tiersRaw = raw['tiers']
  if (tiersRaw !== undefined && tiersRaw !== null) {
    if (!isRecord(tiersRaw)) {
      warnings.push(`pack「${id}」的 tiers 不是对象，已忽略`)
    } else {
      for (const [key, value] of Object.entries(tiersRaw)) {
        if (!isTierId(key)) {
          warnings.push(`pack「${id}」有不存在的档 id「${key}」，已忽略`)
          continue
        }
        const tier = parseTier(value, key, id, warnings)
        if (tier !== undefined) tiers[key] = tier
      }
    }
  }

  const name = rawName ?? fallbackName
  return session === undefined ? { name, tiers } : { name, session, tiers }
}

/** `packs.json` 的解析结果：pack 名册与 `ui` 段同住一个文件。 */
export interface ParsedPacks {
  readonly book: PackBook
  readonly ui: UiState
  /** 文件里确实写了 `packs.default`。假表示 `default` 是补出来的出厂内容。 */
  readonly defaultFromFile: boolean
}

function parseUi(raw: unknown, warnings: string[]): UiState {
  if (raw === undefined) return { ...EMPTY_UI }
  if (!isRecord(raw)) {
    warnings.push('ui 不是对象，已用缺省值')
    return { ...EMPTY_UI }
  }
  // 未知键（旧文件里的 `showSidebarEntry` 之类）原样忽略，不报警告。
  return {
    showChip: typeof raw['showChip'] === 'boolean' ? raw['showChip'] : true,
    defaultTab:
      raw['defaultTab'] === 'prompts' || raw['defaultTab'] === 'workspace' ? raw['defaultTab'] : 'packs',
  }
}

/**
 * 解析 `packs.json`。
 *
 * `default` 缺席时补出厂内容：它是求值链的终点，不能不存在。补的行为留一条 warning，
 * 因为正常写入路径永远会写出 `default`，缺席意味着文件被外部改坏。
 */
export function parsePacks(text: string | undefined, path?: string): ParseResult<ParsedPacks> {
  const warnings: string[] = []
  const raw = readJsonObject(text, 'pack 文件', warnings, path)
  const ui = parseUi(raw?.['ui'], warnings)
  const packs: Record<string, Pack> = {}
  let defaultFromFile = false

  if (raw !== null) {
    const rawPacks = raw['packs']
    if (rawPacks !== undefined) {
      if (!isRecord(rawPacks)) {
        warnings.push('packs 不是对象，已忽略')
      } else {
        const ids = Object.keys(rawPacks).sort()
        if (ids.length > MAX_PACKS) {
          warnings.push(`packs 超过 ${String(MAX_PACKS)} 个，已只保留前 ${String(MAX_PACKS)} 个`)
          ids.length = MAX_PACKS
        }
        for (const id of ids) {
          if (id === '') {
            warnings.push('packs 里有空 id 的条目，已忽略')
            continue
          }
          if (id === DEFAULT_PACK_ID) defaultFromFile = true
          const pack = parsePack(rawPacks[id], id, warnings)
          if (pack !== null) packs[id] = pack
        }
      }
    }
  }

  if (packs[DEFAULT_PACK_ID] === undefined) {
    if (raw !== null) warnings.push('packs 缺少 default，已补出厂内容')
    packs[DEFAULT_PACK_ID] = DEFAULT_PACK
    defaultFromFile = false
  }
  return { value: { book: { packs }, ui, defaultFromFile }, warnings }
}

/**
 * 工作区键归一：同一目录的不同写法必须落到同一个键。
 *
 * 反斜杠转正斜杠、剥除尾部斜杠、Windows 下转小写；盘符根目录保留尾斜杠。
 * 这份实现是**唯一一份**：绑定表的键（policy 的读写）、旧工作区层的兼容读，以及任何按
 * cwd 找绑定的调用点都调它。复制一份必然分叉，表现是「绑定了却不生效」。
 * 四个 pack 包（skill / plugin / mcp / model）必须逐字节一致。
 */
export function normalizeCwd(cwd: string | null): string | null {
  if (cwd === null) return null
  const trimmed = cwd.trim()
  if (trimmed === '') return null
  let unified = trimmed.replace(/\\/gu, '/')
  if (process.platform === 'win32') unified = unified.toLowerCase()
  if (unified.length > 1) {
    const stripped = unified.replace(/\/+$/u, '')
    if (stripped === '') return '/'
    // `C:/` 去掉尾斜杠会变成 `C:`，那不是一个目录。
    return /^[a-z]:$/iu.test(stripped) ? stripped + '/' : stripped
  }
  return unified
}

/**
 * 解析 `workspaces.json`。绑定键在读取时归一，缺失即空表。
 *
 * 早期版本这里还有一个 `extra` 数组（手动添加、不属于任何会话的目录）。那个能力已经
 * 移除：目录由宿主提供，本插件只决定绑定。旧文件里的 `extra` 读取时直接忽略，下次写盘
 * 就自然消失——不做迁移，也不为它保留任何分支。
 */
export function parseBindings(text: string | undefined, path?: string): ParseResult<Bindings> {
  const warnings: string[] = []
  const raw = readJsonObject(text, '工作区绑定文件', warnings, path)
  if (raw === null) return { value: EMPTY_BINDINGS, warnings }

  const bindings: Record<string, string> = {}
  const rawBindings = raw['bindings']
  if (rawBindings !== undefined) {
    if (!isRecord(rawBindings)) {
      warnings.push('bindings 不是对象，已忽略')
    } else {
      for (const key of Object.keys(rawBindings).sort()) {
        const value = rawBindings[key]
        if (typeof value !== 'string' || value === '') {
          warnings.push(`bindings.${key} 不是 pack id，已忽略`)
          continue
        }
        const normalized = normalizeCwd(key)
        if (normalized === null) {
          warnings.push('bindings 里有空路径，已忽略')
          continue
        }
        bindings[normalized] = value
      }
    }
  }

  // 旧版 `extra` 直接忽略：它不影响求值，也不该在面板上常驻一条告警。
  // 下次这份文件被重写时它就自然消失。
  return { value: { bindings }, warnings }
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

function packToJson(pack: Pack): Record<string, unknown> {
  const out: Record<string, unknown> = { name: pack.name }
  if (pack.session !== undefined) out['session'] = routeToJson(pack.session)
  const tiers: Record<string, unknown> = {}
  for (const tierId of TIER_IDS) {
    const tier = pack.tiers[tierId]
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
 * 序列化 `packs.json`。
 *
 * pack 按 id 排序、档按 TIER_IDS 排序、两空格缩进、结尾换行：同一份配置必须序列化成
 * 同一串字节，否则每次保存都产生一次无意义的差异。`ui` 段总是写全，`default` 总是在。
 */
export function serializePacks(book: PackBook, ui: UiState): string {
  const out: Record<string, unknown> = {
    version: 1,
    ui: { showChip: ui.showChip, defaultTab: ui.defaultTab },
  }
  const packs: Record<string, unknown> = {}
  for (const id of Object.keys(book.packs).sort()) {
    const pack = book.packs[id]
    if (pack === undefined) continue
    // default 的显示名是固定的：文件里写的是别的串（旧版是 default / 出厂方案）也归一。
    const json = packToJson(pack)
    packs[id] = id === DEFAULT_PACK_ID ? { ...json, name: DEFAULT_PACK.name } : json
  }
  out['packs'] = packs
  return serialize(out)
}

/** 序列化 `workspaces.json`：绑定键排序，只写 `bindings`。 */
export function serializeBindings(bindings: Bindings): string {
  const out: Record<string, string> = {}
  for (const key of Object.keys(bindings.bindings).sort()) {
    const packId = bindings.bindings[key]
    if (packId !== undefined) out[key] = packId
  }
  return serialize({ version: 1, bindings: out })
}

/**
 * 序列化提示词覆盖文件。
 *
 * 与 pack 文件同一口径：固定键序、两空格缩进、结尾换行，空覆盖不落无意义的空对象。
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

/** 取名册里的 default。解析保证它存在，这里只是给类型收窄一个出口。 */
export function defaultPackOf(book: PackBook): Pack {
  return book.packs[DEFAULT_PACK_ID] ?? DEFAULT_PACK
}

