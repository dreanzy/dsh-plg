import { OPS, filesOf, type BindingsDraft, type GroupsDraft, type PacksDraft } from './ops.js'
import { previewText, readText, storePaths, transact, writableReason } from '@dreanzy/dsh-pack-core'
import {
  normalizeCwd,
  parseBindings,
  parseGroups,
  parsePacks,
  serializeBindings,
  serializeGroups,
  serializePacks,
} from './policy.js'
import {
  DEFAULT_PACK_ID,
  EMPTY_BINDINGS,
  EMPTY_GROUPS,
  EMPTY_PACK,
  EMPTY_UI,
  type Bindings,
  type Command,
  type GroupRegistry,
  type Pack,
  type PackBook,
  type UiState,
} from './types.js'

/**
 * 三个状态文件，各自独立事务。
 *
 * 路径一律走 `dshHomePath`，不自己拼 `$DSH_HOME` 前缀：宿主允许用环境变量或
 * 显式配置改根目录，自己拼会绕开它。
 */
const PATHS = storePaths('plugin')

export function packsPath(): string {
  return PATHS.packs()
}

export function groupsPath(): string {
  return PATHS.groups()
}

export function workspacesPath(): string {
  return PATHS.workspaces()
}


function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 写入前的完整性检查：坏掉的文本必须拒写。
 *
 * 解析函数把坏文件降级成空名册，那只适合读。写路径若照此序列化回去，
 * 一次保存就会拿空名册覆盖掉用户的全部决定，且这种损失在界面上无从挽回。
 * 与「文件不存在」区分开：缺席是可写的新起点，坏文件不是。
 */
function brokenReason(text: string | undefined): string | null {
  // 最松的一档（JSON 合法 + 顶层是对象）住在 core，与 transact / previewText 共用。
  // 下面这些字段级判据是 plugin 的领域知识：它知道 packs.items 的值必须是布尔。
  const loose = writableReason(text)
  if (loose !== null) return loose
  if (text === undefined || text.trim() === '') return null
  const raw: unknown = JSON.parse(text)
  // 字段级形状：顶层是对象但内部形状坏掉时，解析会降级成空名册，写回就是拿空名册
  // 覆盖用户的全部决定。这里逐字段拒绝，让面板把原因显示出来。
  const record = raw as Record<string, unknown>
  if (record['packs'] !== undefined && !isPlainRecord(record['packs'])) return 'packs 不是对象'
  if (record['groups'] !== undefined && !Array.isArray(record['groups'])) return 'groups 不是数组'
  if (record['assignments'] !== undefined && !isPlainRecord(record['assignments'])) return 'assignments 不是对象'
  if (record['bindings'] !== undefined && !isPlainRecord(record['bindings'])) return 'bindings 不是对象'
  if (record['ui'] !== undefined && !isPlainRecord(record['ui'])) return 'ui 不是对象'
  const packs = record['packs']
  if (isPlainRecord(packs)) {
    for (const [id, pack] of Object.entries(packs)) {
      if (!isPlainRecord(pack)) return `packs.${id} 不是对象`
      const items = (pack as Record<string, unknown>)['items']
      const groups = (pack as Record<string, unknown>)['groups']
      if (items !== undefined && !isPlainRecord(items)) return `packs.${id}.items 不是对象`
      if (groups !== undefined && !isPlainRecord(groups)) return `packs.${id}.groups 不是对象`
      // 值类型也要查：解析会把非布尔值丢掉并降级，写回就是拿残缺表覆盖原文件。
      if (isPlainRecord(items)) {
        for (const [name, value] of Object.entries(items)) {
          if (typeof value !== 'boolean') return `packs.${id}.items.${name} 不是布尔值`
        }
      }
      if (isPlainRecord(groups)) {
        for (const [name, value] of Object.entries(groups)) {
          if (typeof value !== 'boolean') return `packs.${id}.groups.${name} 不是布尔值`
        }
      }
    }
  }
  return null
}

/** 普通对象判定：数组与 null 都不算。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 单个文件一次写事务。
 *
 * 骨架在 `@dreanzy/dsh-pack-core`：建父目录、拿锁、读、判、改、原子写。这里只决定
 * 「失败怎么记」——plugin 的选择是记一条 warning 并返回 false，调用方据此停下这一批
 * 剩下的文件。字段级校验（`brokenReason`）在 core 的最松判定之后自己再查一遍。
 */
async function writeFileSafely(
  path: string,
  label: string,
  mutate: (current: string | undefined) => string | null,
  warnings: string[],
): Promise<boolean> {
  const result = await transact(path, label, (current) => {
    const broken = brokenReason(current)
    if (broken !== null) throw new Error(broken)
    return mutate(current)
  })
  if (!result.ok) {
    warnings.push(result.reason)
    return false
  }
  return true
}

/**
 * 当前完整状态，读侧不加锁（原子 rename 保证读到的是完整版本）。
 *
 * `binding` 是原始绑定 id，可能悬空；`packId` / `pack` 是解析后的生效值，
 * 悬空或未绑定时都退回 `default`。读侧必须容忍悬空：删除 pack 后
 * `workspaces.json` 里会留下指向它的键。
 */
export interface PolicyState {
  readonly packs: PackBook
  readonly ui: UiState
  /** 该 cwd 的原始绑定 id；未绑定为 `null`。 */
  readonly binding: string | null
  /** 生效的 pack id；未绑定或悬空时为 `default`。 */
  readonly packId: string
  /** 生效的 pack；`packId === 'default'` 时为 `null`（按 default 求值）。 */
  readonly pack: Pack | null
  readonly groups: GroupRegistry
  /** 工作区绑定表。目录清单由宿主提供，这里只有 cwd → pack。 */
  readonly bindings: Bindings
  readonly warnings: readonly string[]
}

export async function loadState(cwd: string | null): Promise<PolicyState> {
  // 三份文件互不依赖：并行读。串行会白付两次往返，而这条路径每次新会话都走。
  const [packsText, groupsText, workspacesText] = await Promise.all([
    readText(packsPath()),
    readText(groupsPath()),
    readText(workspacesPath()),
  ])
  return buildState(cwd, packsText, groupsText, workspacesText)
}

/** 三份文本 → 视图状态。读盘与试算共用同一条解析路径，两者的视图不会漂移。 */
function buildState(
  cwd: string | null,
  packsText: string | undefined,
  groupsText: string | undefined,
  workspacesText: string | undefined,
): PolicyState {
  const warnings: string[] = []
  const parsedPacks = parsePacks(packsText)
  warnings.push(...parsedPacks.warnings)
  const packs: PackBook = parsedPacks.value.book

  const groupsParsed = parseGroups(groupsText)
  warnings.push(...groupsParsed.warnings)

  const cwdKey = normalizeCwd(cwd)
  const parsedBindings = parseBindings(workspacesText)
  warnings.push(...parsedBindings.warnings)
  const bindings: Bindings = parsedBindings.value

  const binding = cwdKey === null ? null : (bindings.bindings[cwdKey] ?? null)
  const resolvedId =
    binding === null || binding === DEFAULT_PACK_ID || packs.packs[binding] === undefined ? DEFAULT_PACK_ID : binding
  return {
    packs,
    ui: parsedPacks.value.ui,
    binding,
    packId: resolvedId,
    pack: resolvedId === DEFAULT_PACK_ID ? null : (packs.packs[resolvedId] ?? null),
    groups: groupsParsed.value,
    bindings,
    warnings,
  }
}

/** 写 `packs.json`。文件缺席时从空策略起写，`default` 由 `parsePacks` 补齐。 */
function applyToPacks(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parsePacks(current).value
  const draft: PacksDraft = { packs: { ...parsed.book.packs }, ui: { ...parsed.ui } }
  for (const command of commands) OPS[command.op].applyPacks?.(draft, command)
  return serializePacks(draft.packs, draft.ui)
}

/** 写 `groups.json`。文件缺席时从空注册表起写。 */
function applyToGroups(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parseGroups(current).value
  const draft: GroupsDraft = { groups: [...parsed.groups], assignments: { ...parsed.assignments } }
  for (const command of commands) OPS[command.op].applyGroups?.(draft, command)
  return serializeGroups(draft)
}

/**
 * 写 `workspaces.json`。
 *
 * 没有实际变化就返回 `null`，不凭空建空文件——空文件只会让后续读取多一次解析。
 */
function applyToBindings(
  current: string | undefined,
  commands: readonly Command[],
  knownPacks: ReadonlySet<string>,
): string | null {
  const parsed = parseBindings(current)
  const draft: BindingsDraft = { bindings: { ...parsed.value.bindings }, changed: false }
  for (const command of commands) OPS[command.op].applyBindings?.(draft, command, knownPacks)
  return draft.changed ? serializeBindings({ bindings: draft.bindings }) : null
}

/**
 * 名册里的 pack id：绑定合法性只能在 pack 写完之后判（同一批命令里可能刚建/删 pack）。
 * 读不到名册就判不了，返回 `null` 让调用方整批跳过绑定写入。
 */
async function loadPackIds(warnings: string[]): Promise<ReadonlySet<string> | null> {
  let text: string | undefined
  try {
    text = await readText(packsPath())
  } catch (error) {
    warnings.push(`packs.json 读取失败，已跳过绑定写入：${reasonOf(error)}`)
    return null
  }
  return new Set(Object.keys(parsePacks(text).value.book.packs))
}

/** 收尾走读侧：写失败不能变成异常，读失败也不能；两种情况都只留一条 warning。 */
async function settled(cwd: string | null, warnings: readonly string[]): Promise<PolicyState> {
  try {
    const state = await loadState(cwd)
    return warnings.length === 0 ? state : { ...state, warnings: [...warnings, ...state.warnings] }
  } catch (error) {
    return { ...emptyState(), warnings: [...warnings, `读取策略状态失败：${reasonOf(error)}`] }
  }
}

/**
 * 应用一批意图并返回写入后的完整状态。
 *
 * 不比对任何版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 三个文件各自一把锁，固定顺序（pack → 组定义 → 绑定）避免交叉等待；
 * 一个命令命中两个文件时顺序写，不引入跨文件事务。
 *
 * **永不抛**：命令被拒、文件读不出、内容坏掉、落盘失败，全部记进返回状态的
 * `warnings`。一处失败就停下这一批剩下的文件——半批落盘比整批不动更难解释，
 * 而且下一批命令会接着把差异补齐。
 */
export async function applyCommands(cwd: string | null, commands: readonly Command[]): Promise<PolicyState> {
  const files = filesOf(commands)
  const warnings: string[] = []

  // 顺序是硬要求：`deleteGroup` 同时命中两个文件，先写 groups 再写 packs。
  // 反过来的话，groups.json 写失败时 packs.json 里该组的开关已被清空，组却还在——
  // 组内成员从「关」变成「跟随 → 默认开」，是 fail-open 方向。
  // 先删组定义则安全：残留的组开关不影响求值（`groupOf` 只认仍存在的组）。
  if (files.has('groups')) {
    const ok = await writeFileSafely(groupsPath(), 'groups.json', (current) => applyToGroups(current, commands), warnings)
    if (!ok) return await settled(cwd, warnings)
  }
  if (files.has('packs')) {
    const ok = await writeFileSafely(packsPath(), 'packs.json', (current) => applyToPacks(current, commands), warnings)
    if (!ok) return await settled(cwd, warnings)
  }
  if (files.has('bindings')) {
    const known = await loadPackIds(warnings)
    if (known !== null) {
      await writeFileSafely(
        workspacesPath(),
        'workspaces.json',
        (current) => applyToBindings(current, commands, known),
        warnings,
      )
    }
  }

  return await settled(cwd, warnings)
}

/**
 * 试算：把一批命令应用在内存里，返回**不落盘**的视图。
 *
 * 面板的待保存改动靠它渲染「改了会是什么样」。应用规则与 `applyCommands` 完全共用
 * `applyToPacks` / `applyToGroups` / `applyToBindings`，所以试算结果与真写结果不会
 * 有第二条求值路径——面板因此不必在浏览器里复制一份求值链。
 *
 * 与真写一致的另一点：读取失败或命令非法都只跳过那份文件并记 warning，不整批抛错。
 */
export async function previewCommands(
  cwd: string | null,
  commands: readonly Command[],
): Promise<PolicyState> {
  const warnings: string[] = []
  const files = filesOf(commands)
  // 读失败各自兜底：真写路径会把读失败降级成 warning 并跳过那份文件，
  // 试算若直接抛，面板的「改了会是什么样」整块报错而保存却能成功。
  // 每个文件只读一次：要改的走 computeText（它自己读），不改的走 readOr。
  const readOr = async (path: string, label: string): Promise<string | undefined> => {
    try {
      return await readText(path)
    } catch (error) {
      warnings.push(`${label} 读取失败，试算按空策略处理：${reasonOf(error)}`)
      return undefined
    }
  }

  const packsText = files.has('packs')
    ? await computeText(packsPath(), 'packs.json', warnings, (current) => applyToPacks(current, commands))
    : await readOr(packsPath(), 'packs.json')
  const groupsText = files.has('groups')
    ? await computeText(groupsPath(), 'groups.json', warnings, (current) => applyToGroups(current, commands))
    : await readOr(groupsPath(), 'groups.json')
  let workspacesText = files.has('bindings') ? undefined : await readOr(workspacesPath(), 'workspaces.json')
  if (files.has('bindings')) {
    // 与真写同一顺序：bind 的目标要在 pack 变化之后才判定。
    const known = new Set(Object.keys(parsePacks(packsText).value.book.packs))
    workspacesText = await computeText(workspacesPath(), 'workspaces.json', warnings, (current) =>
      applyToBindings(current, commands, known),
    )
  }

  const state = buildState(cwd, packsText, groupsText, workspacesText)
  return { ...state, warnings: [...warnings, ...state.warnings] }
}

/**
 * 读 → 改 → 返回文本，不写盘。
 *
 * `null` 表示这批命令对这份文件没有实际变化（或原文已损坏），沿用原文即可；
 * 命令非法时跳过这份文件并记 warning——试算不该因为一条坏命令把整块视图变成错误。
 */
async function computeText(
  path: string,
  label: string,
  warnings: string[],
  mutate: (current: string | undefined) => string | null,
): Promise<string | undefined> {
  // 与真写同一条前置判定：坏文件上真写会跳过，试算也必须跳过，否则预览显示一个
  // 永远不会发生的状态。判定住在 core 的 previewText 里；字段级校验在这里补上。
  const result = await previewText(path, label, (current) => {
    const broken = brokenReason(current)
    if (broken !== null) throw new Error(broken)
    return mutate(current)
  })
  if (!result.ok) {
    warnings.push(result.reason)
    return await readText(path)
  }
  return result.next === null ? await readText(path) : result.next
}

/** 未落盘时的空状态，供读取失败的降级路径与测试使用。 */
export function emptyState(): PolicyState {
  return {
    packs: { packs: { [DEFAULT_PACK_ID]: EMPTY_PACK } },
    ui: { ...EMPTY_UI },
    binding: null,
    packId: DEFAULT_PACK_ID,
    pack: null,
    groups: EMPTY_GROUPS,
    bindings: EMPTY_BINDINGS,
    warnings: [],
  }
}
