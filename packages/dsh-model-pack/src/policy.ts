/**
 * 配置读写与求值链（纯函数）：工作区绑定、pack 名册，外加提示词覆盖文件。
 *
 * 提示词覆盖与 pack 正交（spec §6.3.1）：所有 pack 共用一份，路径同样是注入的 `home`。
 * 合并逻辑不在这里——这里只负责把文件读上来、把命令落到盘上。
 *
 * 求值链严格三段：
 *   工作区绑定的 pack 存在 → 否则 `packs.default` → 否则出厂内置 `DEFAULT_PACK`。
 *
 * 不 import 任何宿主服务、不读宿主事件：这里的输入只有路径与命令，
 * 目的是让这些规则能在 `os.tmpdir()` 下被完整验证，而不依赖 DSH 进程。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  DEFAULT_PACK,
  DEFAULT_PACK_ID,
  EMPTY_BINDINGS,
  EMPTY_PACKS,
  EMPTY_PROMPTS,
  EMPTY_UI,
  MAX_PACKS,
  TIER_IDS,
  isTierId,
  normalizeCwd,
  parseBindings,
  parsePack,
  parsePacks,
  parsePromptOverrides,
  parseRoute,
  parseTier,
  serializeBindings,
  serializePacks,
  serializePromptOverrides,
  defaultPackOf,
  type Bindings,
  type Pack,
  type PackBook,
  type TierConfig,
  type PromptOverrides,
  type PromptTierOverride,
  type TierId,
  type UiState,
} from './pack.js'

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/**
 * 注入用的根覆盖。
 *
 * `home` 只在测试与显式配置时用；缺省走 `dshHomePath`（`$DSH_HOME` 或 `~/.dsh`）。
 * 工作区没有独立的状态文件，所以不需要别的覆盖点。
 */
export interface PackPathOptions {
  /** DSH home 根目录；缺省按宿主规则解析。 */
  readonly home?: string
}

function homeJoin(home: string | undefined, ...segments: string[]): string {
  if (home === undefined || home.trim() === '') return dshHomePath(...segments)
  return join(home, ...segments)
}

/** `$DSH_HOME/packs/model/packs.json`：pack 名册与 `ui` 段。 */
export function packsPath(options: PackPathOptions = {}): string {
  return homeJoin(options.home, 'packs', 'model', 'packs.json')
}

/** `$DSH_HOME/packs/model/prompts.json`：提示词覆盖（与 pack 正交，全局一份）。 */
export function promptsPath(options: PackPathOptions = {}): string {
  return homeJoin(options.home, 'packs', 'model', 'prompts.json')
}

/** `$DSH_HOME/packs/model/workspaces.json`：工作区 → pack 的绑定表。 */
export function workspacesPath(options: PackPathOptions = {}): string {
  return homeJoin(options.home, 'packs', 'model', 'workspaces.json')
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

/**
 * 读一份文本，不存在返回 `undefined`。
 *
 * 其余读取错误（权限、路径穿过文件）也按「没有这一层」处理并留一条 warning：
 * 读失败不该让会话建不出来。风险是可能覆盖一个读不了的文件，所以写入前会再读一次，
 * 那一次失败就跳过写入（见 transact）。
 */
async function readText(path: string, warnings: string[]): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    warnings.push(`读取 ${path} 失败，已按缺省处理：${String(error)}`)
    return undefined
  }
}

interface LoadedPacks {
  readonly book: PackBook
  readonly ui: UiState
  /** `default` 来自文件；假表示它是补出来的出厂内容。 */
  readonly defaultFromFile: boolean
  readonly warnings: readonly string[]
}

/** pack 名册文本 → 名册 + UI + 是否来自文件。缺席即出厂内容。 */
function packsFromText(text: string | undefined, path: string | undefined): LoadedPacks {
  if (text === undefined) {
    return { book: EMPTY_PACKS, ui: { ...EMPTY_UI }, defaultFromFile: false, warnings: [] }
  }
  const parsed = parsePacks(text, path)
  return {
    book: parsed.value.book,
    ui: parsed.value.ui,
    defaultFromFile: parsed.value.defaultFromFile,
    warnings: parsed.warnings,
  }
}

/** 读 pack 名册。文件不存在时回落到出厂内容。 */
async function loadPacks(options: PackPathOptions): Promise<LoadedPacks> {
  const warnings: string[] = []
  const path = packsPath(options)
  const text = await readText(path, warnings)
  const loaded = packsFromText(text, path)
  return { ...loaded, warnings: [...warnings, ...loaded.warnings] }
}

/** 提示词覆盖文本 → 覆盖。缺席即空覆盖。 */
function promptsFromText(
  text: string | undefined,
  path: string | undefined,
): { value: PromptOverrides; warnings: readonly string[] } {
  if (text === undefined) return { value: EMPTY_PROMPTS, warnings: [] }
  const parsed = parsePromptOverrides(text, path)
  return { value: parsed.value, warnings: parsed.warnings }
}

/** 读提示词覆盖。文件不存在时覆盖为空。 */
async function loadPrompts(options: PackPathOptions): Promise<{ value: PromptOverrides; warnings: readonly string[] }> {
  const warnings: string[] = []
  const path = promptsPath(options)
  const text = await readText(path, warnings)
  const parsed = promptsFromText(text, path)
  return { value: parsed.value, warnings: [...warnings, ...parsed.warnings] }
}

/** 绑定表文本 → 绑定。缺席即空表。 */
function bindingsFromText(
  text: string | undefined,
  path: string | undefined,
): { bindings: Bindings; warnings: readonly string[] } {
  if (text === undefined) return { bindings: EMPTY_BINDINGS, warnings: [] }
  const parsed = parseBindings(text, path)
  return { bindings: parsed.value, warnings: parsed.warnings }
}

/** 读工作区绑定表。`workspaces.json` 缺席即空表。 */
async function loadBindings(options: PackPathOptions): Promise<{ bindings: Bindings; warnings: readonly string[] }> {
  const warnings: string[] = []
  const path = workspacesPath(options)
  const text = await readText(path, warnings)
  const parsed = bindingsFromText(text, path)
  return { bindings: parsed.bindings, warnings: [...warnings, ...parsed.warnings] }
}

/**
 * 当前完整状态，读侧不加锁（原子 rename 保证读到的是完整版本）。
 *
 * `binding` 是原始绑定 id，可能悬空；`packId` / `pack` 是解析后的生效值，
 * 悬空或未绑定时都退回 `default`。读侧必须容忍悬空：删除 pack 后
 * `workspaces.json` 里会留下指向它的键。
 */
export interface PackState {
  readonly packs: PackBook
  readonly ui: UiState
  /** 工作区绑定表。目录清单由宿主提供，这里只有 cwd → pack。 */
  readonly bindings: Bindings
  /** 该 cwd 的原始绑定 id；未绑定为 `null`。 */
  readonly binding: string | null
  /** 生效的 pack id；未绑定或悬空时为 `default`。 */
  readonly packId: string
  /** 生效的 pack；`packId === 'default'` 时为 `null`（按 default 求值）。 */
  readonly pack: Pack | null
  /** `packs.default` 来自文件；假表示它是补出来的出厂内容。 */
  readonly defaultFromFile: boolean
  /** 提示词覆盖；缺省字段跟随内置（spec §6.3.1）。 */
  readonly prompts: PromptOverrides
  readonly warnings: readonly string[]
}

export async function loadState(cwd: string | null, options: PackPathOptions = {}): Promise<PackState> {
  /** 只有「读取失败」进这里：解析降级由 `buildState` 按固定顺序记。 */
  const readWarnings: string[] = []
  // 三份文件互不依赖：并行读。串行会白付两次往返，而这条路径每次新会话都走。
  const [packsText, promptsText, workspacesText] = await Promise.all([
    readText(packsPath(options), readWarnings),
    readText(promptsPath(options), readWarnings),
    readText(workspacesPath(options), readWarnings),
  ])
  const state = buildState(cwd, packsText, promptsText, workspacesText, options)
  return { ...state, warnings: [...readWarnings, ...state.warnings] }
}

/** 三份文本 → 视图状态。读盘与试算共用同一条解析路径，两者的视图不会漂移。 */
function buildState(
  cwd: string | null,
  packsText: string | undefined,
  promptsText: string | undefined,
  workspacesText: string | undefined,
  options: PackPathOptions = {},
): PackState {
  const warnings: string[] = []

  const loaded = packsFromText(packsText, packsPath(options))
  warnings.push(...loaded.warnings)

  const promptsParsed = promptsFromText(promptsText, promptsPath(options))
  warnings.push(...promptsParsed.warnings)

  const bindingsParsed = bindingsFromText(workspacesText, workspacesPath(options))
  warnings.push(...bindingsParsed.warnings)
  const bindings = bindingsParsed.bindings

  const cwdKey = normalizeCwd(cwd)
  const binding = cwdKey === null ? null : (bindings.bindings[cwdKey] ?? null)
  const bound = binding === null || binding === DEFAULT_PACK_ID ? undefined : loaded.book.packs[binding]

  return {
    packs: loaded.book,
    ui: loaded.ui,
    bindings,
    binding,
    packId: bound === undefined ? DEFAULT_PACK_ID : (binding ?? DEFAULT_PACK_ID),
    pack: bound ?? null,
    defaultFromFile: loaded.defaultFromFile,
    prompts: promptsParsed.value,
    warnings,
  }
}

/* ------------------------------------------------------------------ *
 * 求值链
 * ------------------------------------------------------------------ */

/** 取值来自哪一环。面板据此显示「工作区绑定」「默认」还是「未配置」。 */
export type PackSource = 'workspace' | 'default' | 'builtin'

export interface ResolvedPack {
  readonly id: string
  readonly pack: Pack
  /** 最终用了哪一环。 */
  readonly source: PackSource
  /** 工作区绑定指向已删 pack：面板标「绑定失效」。 */
  readonly brokenBinding: boolean
  readonly warnings: readonly string[]
}

/**
 * 求值链：工作区绑定的 pack → `packs.default` → 出厂内置。
 *
 * `cwd` 只用来把 warning 写成可读的一句话（点明是哪个工作区的绑定失效），
 * 求值本身不需要它——绑定已经随 `loadState(cwd)` 读进 `state` 了。
 *
 * 绑定失效时**不修文件**：绑定表原样留着那个已删的 id，面板据此标红，
 * 重新建出同名 pack 即自动恢复。
 */
export function resolve(state: PackState, cwd?: string | null): ResolvedPack {
  const warnings: string[] = []
  const bound = state.binding
  const where = cwd === undefined || cwd === null || cwd.trim() === '' ? '' : `「${cwd}」处的工作区`

  let brokenBinding = false
  if (bound !== null && bound !== DEFAULT_PACK_ID && state.pack === null) {
    brokenBinding = true
    warnings.push(`${where}绑定的 pack「${bound}」已不存在，已回落默认`)
  }

  if (state.pack !== null) {
    return { id: state.packId, pack: state.pack, source: 'workspace', brokenBinding, warnings }
  }

  return {
    id: DEFAULT_PACK_ID,
    pack: defaultPackOf(state.packs),
    source: state.defaultFromFile ? 'default' : 'builtin',
    brokenBinding,
    warnings,
  }
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/**
 * 写入意图。都是**绝对状态**（「让这个键等于这个值」），因此幂等且彼此可交换；
 * 同一键的多条命令后写者赢，这与用户连点两次下拉框的预期一致。
 *
 * `null` 表示删键（= 回到上一层），不是写 null。
 *
 * 与其余三个 pack 包同形的是前四条名册命令与 `bind`；
 * `putPack` / `packSession` / `packTier` 是本包特有的内容编辑命令
 * （pack 本身就是内容，没有 item/group 那种逐项开关）。
 *
 * `duplicatePack` 必须是一条命令而不是「客户端先 createPack 再 putPack」：新 id 由
 * 服务端生成，客户端拼不出要写进 `putPack.packId` 的那个值。一条命令也保证副本
 * 要么完整存在、要么完全不存在。
 */
export type PackCommand =
  | { readonly op: 'putPack'; readonly packId: string; readonly pack: unknown }
  | { readonly op: 'packSession'; readonly packId: string; readonly session: unknown | null }
  | { readonly op: 'packTier'; readonly packId: string; readonly tierId: string; readonly tier: unknown | null }
  | { readonly op: 'createPack'; readonly name: string }
  | { readonly op: 'duplicatePack'; readonly packId: string; readonly name?: string }
  | { readonly op: 'renamePack'; readonly packId: string; readonly name: string }
  | { readonly op: 'deletePack'; readonly packId: string }
  | { readonly op: 'bind'; readonly cwd: string; readonly packId: string | null }
  | { readonly op: 'showChip'; readonly value: boolean }
  | { readonly op: 'defaultTab'; readonly value: UiState['defaultTab'] }
  | {
      readonly op: 'putPrompts'
      readonly delegation?: string | null
      readonly tiers?: Readonly<Record<string, PromptTierPatch | null>>
    }
  | { readonly op: 'resetPrompts'; readonly keys?: readonly string[] | null }

/** 一档提示词的三态补丁：字符串写入，`null` 删该字段，键不存在则不动。 */
export interface PromptTierPatch {
  readonly label?: string | null
  readonly text?: string | null
}

/**
 * 命令落到哪个文件。
 *
 * 用 `Record<PackCommand['op'], ...>` 声明：新增一个 op 时编译器会强制补齐这张表，
 * 不会出现「新命令被接受、却悄悄不落盘」。
 */
type CommandTarget = 'packs' | 'prompts' | 'bindings'

const COMMAND_TARGET: Readonly<Record<PackCommand['op'], CommandTarget>> = {
  putPack: 'packs',
  packSession: 'packs',
  packTier: 'packs',
  createPack: 'packs',
  duplicatePack: 'packs',
  renamePack: 'packs',
  deletePack: 'packs',
  bind: 'bindings',
  showChip: 'packs',
  defaultTab: 'packs',
  putPrompts: 'prompts',
  resetPrompts: 'prompts',
}

/**
 * 一次写事务：建父目录 → 拿跨进程锁 → 读 → 改 → 原子覆盖写。
 *
 * 父目录必须在拿锁之前建好：withFileLock 用 `wx` 直接建 `.lock` 兄弟文件，它不建父目录。
 * 读失败（非 ENOENT）时跳过写入而不是覆盖——读不到就写等于拿缺省值抹掉别人的配置。
 * 读得到但读不懂（坏 JSON、顶层不是对象）同样跳过：解析失败会得到一份空名册，照写
 * 就是拿空名册覆盖用户手改坏的文件，而这种覆盖没有任何办法撤回。
 * `mutate` 返回 `null` 表示这一批没有实际改变：不落盘，兼容读期间凭空建空文件会让
 * 旧文件的降级路径立刻失效。
 */
async function transact(
  path: string,
  mutate: (current: string | undefined) => string | null,
  warnings: string[],
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await withFileLock(path, async () => {
      let current: string | undefined
      try {
        current = await readFile(path, 'utf8')
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          warnings.push(`写入前读取 ${path} 失败，已跳过本次写入：${String(error)}`)
          return
        }
        current = undefined
      }
      if (current !== undefined && !isOverwritable(current)) {
        warnings.push(`写入前发现 ${path} 不是合法 JSON，已跳过本次写入`)
        return
      }
      const next = mutate(current)
      if (next === null) return
      await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
    })
  } catch (error) {
    warnings.push(`写入 ${path} 失败：${String(error)}`)
  }
}

/**
 * 写前判定：这份内容还能被安全改写吗。
 *
 * 空文件算可写：它表示「还没有任何决定」，不是「读不懂」。其余只要解析出来的顶层
 * 不是对象，就当作外部改坏，由调用方跳过写入并记 warning。
 */
function isOverwritable(text: string): boolean {
  if (text.trim() === '') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
}

/** 名字已存在？`default` 的出厂名也参与比较：两张同名 pack 在面板上分不清。 */
function nameTaken(packs: Readonly<Record<string, Pack>>, name: string, exceptId?: string): boolean {
  for (const [id, pack] of Object.entries(packs)) {
    if (id !== exceptId && pack.name === name) return true
  }
  return false
}

/** 造一个短且稳定的 pack id，与名字脱钩：改名不影响绑定。 */
function nextPackId(packs: Readonly<Record<string, Pack>>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `p${String(index)}`
    if (packs[candidate] === undefined) return candidate
  }
}

/**
 * 副本的显示名：原名 + 空格 + 序号，从 2 起，撞名就往后数。
 *
 * 不做尾部数字识别：「前端 2」的副本叫「前端 2 2」。规则只有一条，用户看一眼就能
 * 预测下一个叫什么；识别尾部数字会让「前端 2 3」这类名字产生歧义。
 */
function copyName(packs: Readonly<Record<string, Pack>>, base: string): string {
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${String(index)}`
    if (!nameTaken(packs, candidate)) return candidate
  }
}

/** 深拷贝一张 pack：副本与原 pack 之后各改各的，共享任何一层对象都会串味。 */
function clonePack(pack: Pack): Pack {
  const tiers: Partial<Record<TierId, TierConfig>> = {}
  for (const tierId of TIER_IDS) {
    const tier = pack.tiers[tierId]
    if (tier === undefined) continue
    tiers[tierId] = {
      name: tier.name,
      primary: { ...tier.primary },
      fallbacks: tier.fallbacks.map((route) => ({ ...route })),
    }
  }
  return pack.session === undefined
    ? { name: pack.name, tiers }
    : { name: pack.name, session: { ...pack.session }, tiers }
}

/**
 * 写 packs.json。
 *
 * `seed` 是文件缺席时的初值：它来自兼容读的旧配置。没有这个 seed，
 * 兼容读之后第一次保存会从空名册起写，旧决定被静默丢掉。
 */
function applyToPacks(
  current: string | undefined,
  commands: readonly PackCommand[],
  seed: LoadedPacks,
  warnings: string[],
): string {
  let book: PackBook
  let ui: UiState
  if (current === undefined) {
    book = seed.book
    ui = { ...seed.ui }
    warnings.push(...seed.warnings)
  } else {
    const parsed = parsePacks(current)
    book = parsed.value.book
    ui = { ...parsed.value.ui }
    warnings.push(...parsed.warnings)
  }

  const packs: Record<string, Pack> = { ...book.packs }

  for (const command of commands) {
    switch (command.op) {
      case 'createPack': {
        const name = command.name.trim()
        if (name === '') {
          warnings.push('pack 名不能为空，已忽略')
          break
        }
        if (nameTaken(packs, name)) {
          warnings.push(`pack 名已存在：${name}`)
          break
        }
        if (Object.keys(packs).length >= MAX_PACKS) {
          warnings.push(`pack 已达上限 ${String(MAX_PACKS)} 个，新建已忽略`)
          break
        }
        const id = nextPackId(packs)
        packs[id] = { name, tiers: {} }
        break
      }
      case 'duplicatePack': {
        const source = packs[command.packId]
        if (source === undefined) {
          warnings.push(`pack「${command.packId}」不存在，复制已忽略`)
          break
        }
        if (Object.keys(packs).length >= MAX_PACKS) {
          warnings.push(`pack 已达上限 ${String(MAX_PACKS)} 个，复制已忽略`)
          break
        }
        const given = command.name === undefined ? '' : command.name.trim()
        if (given !== '' && nameTaken(packs, given)) {
          warnings.push(`pack 名已存在：${given}`)
          break
        }
        const id = nextPackId(packs)
        const copy = clonePack(source)
        packs[id] = { ...copy, name: given === '' ? copyName(packs, source.name) : given }
        break
      }
      case 'renamePack': {
        if (command.packId === DEFAULT_PACK_ID) {
          warnings.push('默认 pack 不可改名，已忽略')
          break
        }
        const pack = packs[command.packId]
        if (pack === undefined) {
          warnings.push(`pack「${command.packId}」不存在，改名已忽略`)
          break
        }
        const name = command.name.trim()
        if (name === '') {
          warnings.push('pack 名不能为空，已忽略')
          break
        }
        if (nameTaken(packs, name, command.packId)) {
          warnings.push(`pack 名已存在：${name}`)
          break
        }
        packs[command.packId] = { ...pack, name }
        break
      }
      case 'deletePack': {
        if (command.packId === DEFAULT_PACK_ID) {
          warnings.push('默认 pack 不可删除，已忽略')
          break
        }
        if (!Object.hasOwn(packs, command.packId)) {
          warnings.push(`pack「${command.packId}」不存在，删除已忽略`)
          break
        }
        // 只删 pack 本身，绑定清理由 applyToBindings 负责（它也可能什么都不用清）。
        delete packs[command.packId]
        break
      }
      case 'putPack': {
        const id = command.packId.trim()
        if (id === '') {
          warnings.push('pack id 不能为空，已忽略')
          break
        }
        const pack = parsePack(command.pack, id, warnings)
        if (pack === null) break
        // default 的显示名固定：它不可改名，整体替换也不能把它改掉。
        packs[id] = id === DEFAULT_PACK_ID ? { ...pack, name: DEFAULT_PACK.name } : pack
        break
      }
      case 'packSession': {
        const pack = packs[command.packId]
        if (pack === undefined) {
          warnings.push(`pack「${command.packId}」不存在，session 未写入`)
          break
        }
        if (command.session === null) {
          packs[command.packId] = { name: pack.name, tiers: pack.tiers }
          break
        }
        const route = parseRoute(command.session, `pack「${command.packId}」的 session`, warnings)
        if (route !== undefined) packs[command.packId] = { ...pack, session: route }
        break
      }
      case 'packTier': {
        const pack = packs[command.packId]
        if (pack === undefined) {
          warnings.push(`pack「${command.packId}」不存在，档未写入`)
          break
        }
        if (!isTierId(command.tierId)) {
          warnings.push(`packTier 有不存在的档 id「${command.tierId}」，已忽略`)
          break
        }
        const tierId: TierId = command.tierId
        if (command.tier === null) {
          const tiers = { ...pack.tiers }
          delete tiers[tierId]
          packs[command.packId] = { ...pack, tiers }
          break
        }
        const tier = parseTier(command.tier, tierId, command.packId, warnings)
        if (tier !== undefined) packs[command.packId] = { ...pack, tiers: { ...pack.tiers, [tierId]: tier } }
        break
      }
      case 'showChip':
        ui.showChip = command.value
        break
      case 'defaultTab':
        ui.defaultTab = command.value
        break
      default:
        break
    }
  }

  return serializePacks({ packs }, ui)
}

/**
 * 一个提示词字段的三态补丁。
 *
 * 空串是坏输入：降级成「不动」并留 warning——严格拒绝在路由层，那里能给出 bad-request。
 * 这里宽容是因为它同时服务手写文件与内部调用，抛错会把一次保存整批废掉。
 */
function patchField(
  current: string | undefined,
  patch: string | null | undefined,
  label: string,
  warnings: string[],
): string | undefined {
  if (patch === undefined) return current
  if (patch === null) return undefined
  const value = patch.trim()
  if (value === '') {
    warnings.push(`${label} 不能为空串，已忽略`)
    return current
  }
  return value
}

/**
 * 应用提示词类命令。
 *
 * `putPrompts` 是绝对状态：给了哪个键就设哪个键，`null` 删键（= 恢复内置）。
 * `resetPrompts` 不传 keys 即全部恢复内置；落盘表现同样是删键，不写空串。
 */
function applyToPrompts(
  current: string | undefined,
  commands: readonly PackCommand[],
  seed: PromptOverrides,
  warnings: string[],
): string {
  let base: PromptOverrides
  if (current === undefined) {
    base = seed
  } else {
    const parsed = parsePromptOverrides(current)
    base = parsed.value
    warnings.push(...parsed.warnings)
  }

  let delegation = base.delegation
  const tiers: Partial<Record<TierId, PromptTierOverride>> = { ...base.tiers }

  for (const command of commands) {
    if (command.op === 'putPrompts') {
      delegation = patchField(delegation, command.delegation, 'putPrompts 的 delegation', warnings)
      const patches = command.tiers
      if (patches === undefined || patches === null) continue
      for (const [key, patch] of Object.entries(patches)) {
        if (!isTierId(key)) {
          warnings.push(`putPrompts 有不存在的档 id「${key}」，已忽略`)
          continue
        }
        if (patch === null) {
          delete tiers[key]
          continue
        }
        const previous = tiers[key]
        const label = patchField(previous?.label, patch.label, `putPrompts 的 tiers.${key}.label`, warnings)
        const text = patchField(previous?.text, patch.text, `putPrompts 的 tiers.${key}.text`, warnings)
        if (label === undefined && text === undefined) {
          delete tiers[key]
          continue
        }
        tiers[key] = {
          ...(label === undefined ? {} : { label }),
          ...(text === undefined ? {} : { text }),
        }
      }
      continue
    }

    if (command.op === 'resetPrompts') {
      const keys = command.keys
      if (keys === undefined || keys === null) {
        delegation = undefined
        for (const tierId of TIER_IDS) delete tiers[tierId]
        continue
      }
      for (const raw of keys) {
        const key = raw.trim()
        if (key === 'delegation') {
          delegation = undefined
          continue
        }
        if (isTierId(key)) {
          delete tiers[key]
          continue
        }
        warnings.push(`resetPrompts 有不存在的键「${raw}」，已忽略`)
      }
    }
  }

  return serializePromptOverrides({
    ...(delegation === undefined ? {} : { delegation }),
    tiers,
  })
}

function applyToBindings(
  current: string | undefined,
  commands: readonly PackCommand[],
  seed: Bindings,
  warnings: string[],
): string | null {
  let base: Bindings
  if (current === undefined) {
    base = seed
  } else {
    const parsed = parseBindings(current)
    base = parsed.value
    warnings.push(...parsed.warnings)
  }

  const bindings: Record<string, string> = { ...base.bindings }
  let changed = false

  for (const command of commands) {
    if (command.op === 'deletePack') {
      // 删除 pack 后清理指向它的绑定；残留的悬空键也能读（按 default 求值），
      // 这里主动清是为了不让文件无限积累垃圾。
      for (const [key, packId] of Object.entries(bindings)) {
        if (packId === command.packId) {
          delete bindings[key]
          changed = true
        }
      }
      continue
    }
    if (command.op !== 'bind') continue
    const key = normalizeCwd(command.cwd)
    if (key === null) {
      warnings.push('绑定的工作目录不能为空')
      continue
    }
    if (command.packId === null || command.packId === DEFAULT_PACK_ID) {
      // 显式绑到 default 与解除绑定等价，落盘时不留冗余键。
      if (bindings[key] !== undefined) {
        delete bindings[key]
        changed = true
      }
      continue
    }
    if (bindings[key] !== command.packId) {
      bindings[key] = command.packId
      changed = true
    }
  }

  // 没有实际变化就不创建文件：workspaces.json 一旦存在，旧工作区层的兼容读
  // 就会关闭，凭空建空文件等于丢掉旧配置。
  return changed ? serializeBindings({ bindings }) : null
}

interface Targets {
  readonly packs: boolean
  readonly prompts: boolean
  readonly bindings: boolean
}

function targets(commands: readonly PackCommand[]): Targets {
  let packs = false
  let prompts = false
  let bindings = false
  for (const command of commands) {
    switch (COMMAND_TARGET[command.op]) {
      case 'packs':
        packs = true
        break
      case 'prompts':
        prompts = true
        break
      case 'bindings':
        bindings = true
        break
      default:
        break
    }
    // deletePack 还要清绑定，所以同时命中两个文件。
    if (command.op === 'deletePack') bindings = true
  }
  return { packs, prompts, bindings }
}

/**
 * 应用一批意图并返回写入后的完整状态。
 *
 * 不比对任何版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 三个文件各自一把锁，固定顺序（pack → 提示词 → 绑定）避免交叉等待；
 * 一个命令命中两个文件时顺序写，不引入跨文件事务。
 *
 * `cwd` 只决定回读时算哪一条绑定与哪一份响应；`bind` 自带目录，
 * 所以写入本身不依赖它。
 */
export async function applyCommands(
  cwd: string | null,
  commands: readonly PackCommand[],
  options: PackPathOptions = {},
): Promise<PackState> {
  const plan = targets(commands)
  const warnings: string[] = []

  if (plan.packs) {
    // seed 承接读侧：文件缺席时以读到的内容为起点，不让第一次保存清空已有决定。
    const seed = await loadPacks(options)
    await transact(packsPath(options), (current) => applyToPacks(current, commands, seed, warnings), warnings)
  }
  if (plan.prompts) {
    const seed = await loadPrompts(options)
    await transact(promptsPath(options), (current) => applyToPrompts(current, commands, seed.value, warnings), warnings)
  }
  if (plan.bindings) {
    const seed = await loadBindings(options)
    await transact(
      workspacesPath(options),
      (current) => applyToBindings(current, commands, seed.bindings, warnings),
      warnings,
    )
  }

  const state = await loadState(cwd, options)
  return { ...state, warnings: [...state.warnings, ...warnings] }
}

/**
 * 试算：把一批命令应用在内存里，返回**不落盘**的视图。
 *
 * 面板的待保存改动靠它渲染「改了会是什么样」。应用规则与 `applyCommands` 完全共用
 * `applyToPacks` / `applyToPrompts` / `applyToBindings`，所以试算结果与真写结果不会
 * 有第二条求值路径——面板因此不必在浏览器里复制一份求值链。
 *
 * 与真写一致：某个文件的命令非法时只跳过那份文件并记 warning，不整批失败。
 */
export async function previewCommands(
  cwd: string | null,
  commands: readonly PackCommand[],
  options: PackPathOptions = {},
): Promise<PackState> {
  const plan = targets(commands)
  const warnings: string[] = []
  /** 只有「读取失败」进这里：与 `loadState` 同一种口径。 */
  const readWarnings: string[] = []
  const [packsCurrent, promptsCurrent, workspacesCurrent] = await Promise.all([
    readText(packsPath(options), readWarnings),
    readText(promptsPath(options), readWarnings),
    readText(workspacesPath(options), readWarnings),
  ])

  let packsText = packsCurrent
  let promptsText = promptsCurrent
  let workspacesText = workspacesCurrent

  if (plan.packs) {
    // seed 承接读侧：文件缺席时以旧配置为起点，与真写同一份起点。
    const seed = packsFromText(packsCurrent, packsPath(options))
    packsText = computeText(packsCurrent, 'packs.json', warnings, (current) =>
      applyToPacks(current, commands, seed, warnings),
    )
  }
  if (plan.prompts) {
    const seed = promptsFromText(promptsCurrent, promptsPath(options))
    promptsText = computeText(promptsCurrent, 'prompts.json', warnings, (current) =>
      applyToPrompts(current, commands, seed.value, warnings),
    )
  }
  if (plan.bindings) {
    const seed = bindingsFromText(workspacesCurrent, workspacesPath(options))
    workspacesText = computeText(workspacesCurrent, 'workspaces.json', warnings, (current) =>
      applyToBindings(current, commands, seed.bindings, warnings),
    )
  }

  const state = buildState(cwd, packsText, promptsText, workspacesText, options)
  return { ...state, warnings: [...readWarnings, ...state.warnings, ...warnings] }
}

/**
 * 读 → 改 → 返回文本，不写盘。
 *
 * `null` 表示这批命令对这份文件没有实际变化（或原文已损坏），沿用原文即可；
 * 命令非法时跳过这份文件并记 warning——与 `transact` 的失败口径一致。
 */
function computeText(
  current: string | undefined,
  label: string,
  warnings: string[],
  mutate: (current: string | undefined) => string | null,
): string | undefined {
  try {
    const next = mutate(current)
    return next === null ? current : next
  } catch (error) {
    warnings.push(`${label} 试算失败：${String(error)}`)
    return current
  }
}

