import { OPS, filesOf, type BindingsDraft, type GroupsDraft, type PacksDraft } from './ops.js'
import { readText, storePaths } from '@dreanzy/dsh-pack-core'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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
  type Bindings,
  type Command,
  type GroupRegistry,
  type McpPack,
  type PackBook,
  type UiState,
} from './types.js'

/**
 * 三个状态文件，各自独立事务。
 *
 * 路径一律走 `dshHomePath`，不自己拼 `$DSH_HOME` 前缀：宿主允许用环境变量或
 * 显式配置改根目录，自己拼会绕开它。
 */
const PATHS = storePaths('mcp')

export function packsPath(): string {
  return PATHS.packs()
}

export function groupsPath(): string {
  return PATHS.groups()
}

export function workspacesPath(): string {
  return PATHS.workspaces()
}

/** 运行期自检快照。不是策略，只是排查用的证据。 */
export function diagPath(): string {
  return PATHS.file('diag.json')
}


/** 读失败的说明要带文件名：它最终进 warnings，用户只看得见这一串字。 */
function readFailure(label: string, error: unknown): Error {
  return new Error(`${label} 读取失败，已跳过本次写入：${String(error)}`)
}

/**
 * 写入前的读。
 *
 * 非 ENOENT 的读失败（权限、目录占位、被别的进程独占）不能当成「文件不存在」：
 * 那会拿一份空名册把原文件盖掉。这里让本次写入作罢，由 `applyCommands` 记进 warnings。
 * 读侧不走这里：读侧照旧抛，降级成什么只由 `parse*` 决定。
 */
async function readForWrite(path: string, label: string): Promise<string | undefined> {
  try {
    return await readText(path)
  } catch (error) {
    throw readFailure(label, error)
  }
}

/**
 * 写之前确认目标文件还能读懂。
 *
 * 读侧把坏文件降级成空策略；写侧若照抄那份空结果，一次手误编辑就会被下一次保存
 * 覆盖成空文件。这里直接拒绝，让面板把错误显示出来。
 */
function assertWritable(current: string | undefined, label: string): void {
  if (current === undefined || current.trim() === '') return
  let parsed: unknown
  try {
    parsed = JSON.parse(current)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON，拒绝覆盖：${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} 顶层不是对象，拒绝覆盖`)
  }
}

/**
 * 一次写事务：建父目录 → 拿跨进程锁 → 读 → 改 → 原子覆盖写。
 *
 * 父目录必须在拿锁之前建好：`withFileLock` 用 `wx` 直接建 `<file>.lock`，
 * 它不会建父目录。`writeFileAtomic` 自己会 mkdir，但那是拿锁之后的事。
 */
async function transact(
  path: string,
  label: string,
  mutate: (current: string | undefined) => string | null,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const current = await readForWrite(path, label)
    const next = mutate(current)
    // `null` 表示这一批命令没有实际改变：不落盘，不凭空建空文件。
    if (next === null) return
    try {
      await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      throw new Error(`写入 ${label} 失败：${String(error)}`)
    }
  })
}



interface LoadedPacks {
  readonly book: PackBook
  readonly ui: UiState
  readonly warnings: readonly string[]
}

/** 读 `packs.json`；文件缺席时 `parsePacks` 已给出只有 `default` 的空名册。 */
async function loadPacks(): Promise<LoadedPacks> {
  const { value, warnings } = parsePacks(await readText(packsPath()))
  return { book: value.book, ui: value.ui, warnings }
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
  readonly pack: McpPack | null
  readonly groups: GroupRegistry
  /** 工作区绑定表（目录 → pack）。 */
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
  const { packs } = parsedPacks.value.book

  const groupsParsed = parseGroups(groupsText)
  warnings.push(...groupsParsed.warnings)

  const cwdKey = normalizeCwd(cwd)
  const parsedBindings = parseBindings(workspacesText)
  warnings.push(...parsedBindings.warnings)
  const bindings: Bindings = parsedBindings.value

  const binding = cwdKey === null ? null : (bindings.bindings[cwdKey] ?? null)
  const resolvedId =
    binding === null || binding === DEFAULT_PACK_ID || packs[binding] === undefined ? DEFAULT_PACK_ID : binding
  return {
    packs: { packs },
    ui: parsedPacks.value.ui,
    binding,
    packId: resolvedId,
    pack: resolvedId === DEFAULT_PACK_ID ? null : (packs[resolvedId] ?? null),
    groups: groupsParsed.value,
    bindings,
    warnings,
  }
}

function requireName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw new Error('pack 名不能为空')
  return name
}

function findPack(packs: Readonly<Record<string, McpPack>>, packId: string): McpPack {
  const pack = packs[packId]
  if (pack === undefined) throw new Error(`未知 pack：${packId}`)
  return pack
}

function assertNameFree(packs: Readonly<Record<string, McpPack>>, name: string, exceptId?: string): void {
  for (const [id, pack] of Object.entries(packs)) {
    if (id !== exceptId && pack.name === name) throw new Error(`pack 名已存在：${name}`)
  }
}

/** 造一个短且稳定的 pack id，与分组 id 一样与名字脱钩。 */
function nextPackId(packs: Readonly<Record<string, McpPack>>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `p${String(index)}`
    if (packs[candidate] === undefined) return candidate
  }
}

/** 写 packs.json。文件缺席时从缺省名册起步。 */
/** 写 `packs.json`。文件缺席时从空策略起写，`default` 由 `parsePacks` 补齐。 */
function applyToPacks(current: string | undefined, commands: readonly Command[]): string {
  assertWritable(current, 'packs.json')
  const parsed = parsePacks(current).value
  const draft: PacksDraft = { packs: { ...parsed.book.packs }, ui: { ...parsed.ui } }
  for (const command of commands) OPS[command.op].applyPacks?.(draft, command)
  return serializePacks(draft.packs, draft.ui)
}

/** 写 `groups.json`。文件缺席时从空注册表起写。 */
function applyToGroups(current: string | undefined, commands: readonly Command[]): string {
  assertWritable(current, 'groups.json')
  const parsed = current === undefined ? EMPTY_GROUPS : parseGroups(current).value
  const draft: GroupsDraft = { groups: [...parsed.groups], assignments: { ...parsed.assignments } }
  for (const command of commands) OPS[command.op].applyGroups?.(draft, command)
  return serializeGroups(draft)
}

/**
 * 写 `workspaces.json`。没有实际变化就返回 `null`，不凭空建空文件。
 */
function applyToBindings(
  current: string | undefined,
  commands: readonly Command[],
  knownPacks: ReadonlySet<string>,
): string | null {
  assertWritable(current, 'workspaces.json')
  const parsed = parseBindings(current)
  const draft: BindingsDraft = { bindings: { ...parsed.value.bindings }, changed: false }
  for (const command of commands) OPS[command.op].applyBindings?.(draft, command, knownPacks)
  return draft.changed ? serializeBindings({ bindings: draft.bindings }) : null
}



/** 真正落盘的那一半：前置校验 + 三个文件按固定顺序写。失败照旧抛出，由调用方收成 warning。 */
async function writeCommands(commands: readonly Command[]): Promise<void> {
  const files = filesOf(commands)
  // 名册读不出来时无从校验 pack id：整批作罢，别写到一个看不见的名册上。
  let known: Set<string>
  try {
    known = new Set(Object.keys((await loadPacks()).book.packs))
  } catch (error) {
    throw readFailure('packs.json', error)
  }

  // 写任何文件之前先把跨文件的前置条件验一遍：packs 写成功、bindings 抛错会留下半提交。
  for (const command of commands) {
    switch (command.op) {
      case 'packRow':
      case 'packGroup':
        if (!known.has(command.packId)) throw new Error(`未知 pack：${command.packId}`)
        break
      case 'renamePack':
        if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可改名')
        if (!known.has(command.packId)) throw new Error(`未知 pack：${command.packId}`)
        break
      case 'duplicatePack':
        // 源必须存在。副本本身是新 id，不进 `known`：同一批里没有命令能引用它。
        if (!known.has(command.packId)) throw new Error(`未知 pack：${command.packId}`)
        break
      case 'deletePack':
        if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可删除')
        if (!known.has(command.packId)) throw new Error(`未知 pack：${command.packId}`)
        known.delete(command.packId)
        break
      case 'bind':
        if (command.packId !== null && command.packId !== DEFAULT_PACK_ID && !known.has(command.packId)) {
          throw new Error(`未知 pack：${command.packId}`)
        }
        break
      default:
        break
    }
  }

  if (files.has('packs')) {
    await transact(packsPath(), 'packs.json', (current) => applyToPacks(current, commands))
  }
  if (files.has('groups')) {
    await transact(groupsPath(), 'groups.json', (current) => applyToGroups(current, commands))
  }
  if (files.has('bindings')) {
    // bind 的合法目标要在 pack 写完之后再读：同一批命令里可能有 createPack / deletePack。
    await transact(workspacesPath(), 'workspaces.json', (current) => applyToBindings(current, commands, known))
  }
}

/**
 * 写入后的状态。
 *
 * 写失败常常正是因为文件读不懂，这时状态同样读不出来。按缺省给一份空策略：
 * 面板照常渲染，失败原因在 warnings 里看得见，而不是整页变成一条错误。
 */
async function stateAfter(cwd: string | null, warnings: string[]): Promise<PolicyState> {
  try {
    const state = await loadState(cwd)
    return { ...state, warnings: [...warnings, ...state.warnings] }
  } catch (error) {
    warnings.push(`读取策略失败，按缺省继续：${String(error)}`)
    const fallback = parsePacks(undefined).value
    return {
      packs: fallback.book,
      ui: fallback.ui,
      binding: null,
      packId: DEFAULT_PACK_ID,
      pack: null,
      groups: EMPTY_GROUPS,
      bindings: EMPTY_BINDINGS,
      warnings,
    }
  }
}

/**
 * 应用一批意图并返回写入后的完整状态。
 *
 * 永不抛：写不进去的原因（坏文件、读失败、未知 pack、落盘失败）进 `state.warnings`。
 * 这是面板与路由唯一的失败通道——面板把它和读警告显示在同一处，路由照常回最新状态。
 *
 * 不比对任何版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 三个文件各自一把锁，固定顺序（pack → 组定义 → 绑定）避免交叉等待；
 * 一个命令命中两个文件时顺序写，不引入跨文件事务。
 */
export async function applyCommands(cwd: string | null, commands: readonly Command[]): Promise<PolicyState> {
  const warnings: string[] = []
  try {
    await writeCommands(commands)
  } catch (error) {
    // 第一个失败就停：半批写下去比整批不写更难解释，也更难收拾。
    warnings.push(error instanceof Error ? error.message : String(error))
  }
  return await stateAfter(cwd, warnings)
}

/**
 * 试算：把一批命令应用在内存里，返回**不落盘**的视图。
 *
 * 面板的待保存改动靠它渲染「改了会是什么样」。应用规则与 `applyCommands` 完全共用
 * `applyToPacks` / `applyToGroups` / `applyToBindings`，所以试算结果与真写结果不会
 * 有第二条求值路径——面板因此不必在浏览器里复制一份求值链。
 *
 * 与真写一致：某个文件的解析或命令非法时只记 warning、跳过那份文件，不整批失败。
 */
export async function previewCommands(
  cwd: string | null,
  commands: readonly Command[],
): Promise<PolicyState> {
  const warnings: string[] = []
  const files = filesOf(commands)
  const [packsCurrent, groupsCurrent, workspacesCurrent] = await Promise.all([
    readText(packsPath()),
    readText(groupsPath()),
    readText(workspacesPath()),
  ])

  let packsText = packsCurrent
  let groupsText = groupsCurrent
  let workspacesText = workspacesCurrent

  if (files.has('packs')) {
    packsText = computeText(packsCurrent, 'packs.json', warnings, (current) => applyToPacks(current, commands))
  }
  if (files.has('groups')) {
    groupsText = computeText(groupsCurrent, 'groups.json', warnings, (current) => applyToGroups(current, commands))
  }
  if (files.has('bindings')) {
    // 与真写同一顺序：bind 的目标要在 pack 变化之后才判定。
    const known = new Set(Object.keys(parsePacks(packsText).value.book.packs))
    workspacesText = computeText(workspacesCurrent, 'workspaces.json', warnings, (current) =>
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
 * 命令非法时跳过这份文件并记 warning——与真写的失败口径一致。
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
    noteWarning(warnings, `${label} 更新失败：${String(error)}`)
    return current
  }
}

/**
 * 同一句说明只留一条。
 *
 * 真写路径里一批命令可能两次读到同一份文件（`bind` 之前要先读 packs 名册），那两处
 * 失败会记同一句；试算路径每个文件只应用一次，用不到这层去重。两条路径共用这段
 * 失败说明，保留去重让两边口径一致。
 */
function noteWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message)
}
