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
const PATHS = storePaths('skill')

export function packsPath(): string {
  return PATHS.packs()
}

export function groupsPath(): string {
  return PATHS.groups()
}

export function workspacesPath(): string {
  return PATHS.workspaces()
}


/** 同一批命令可能读写同一份文件两次（bind 要先读 pack 名册），失败说明只留一条。 */
function note(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message)
}

/**
 * 写前读取。`null` 表示这份文件这次不能写：读失败或原文已损坏时，把解析出来的
 * 空名册覆盖回去等于删掉用户的全部决定（坏 JSON 正是被解析成空 book 的）。
 *
 * 空文件仍然可写：它不是损坏，只是还没写过。
 */
async function readForWrite(
  path: string,
  label: string,
  warnings: string[],
): Promise<string | null | undefined> {
  let text: string | undefined
  try {
    text = await readText(path)
  } catch (error) {
    note(warnings, `读取 ${label} 失败，本次未写入：${String(error)}`)
    return null
  }
  if (text === undefined || text.trim() === '') return text
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    note(warnings, `${label} 不是合法 JSON，已拒绝写入`)
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    note(warnings, `${label} 顶层不是对象，已拒绝写入`)
    return null
  }
  return text
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
  warnings: string[],
  mutate: (current: string | undefined) => string | null,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const current = await readForWrite(path, label, warnings)
    // 没有可写的基线就跳过本次写入：不覆盖、也不凭空建一份。
    if (current === null) return
    const next = mutate(current)
    // `null` 表示这一批命令没有实际改变：不落盘，不留下无意义的空文件。
    if (next === null) return
    await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
  })
}

/** 单个文件一次写事务。失败只记 warning：三个文件各自独立，一个坏了不该拖住另外两个。 */
async function writeFileSafely(
  path: string,
  label: string,
  warnings: string[],
  mutate: (current: string | undefined) => string | null,
): Promise<void> {
  try {
    await transact(path, label, warnings, mutate)
  } catch (error) {
    note(warnings, `${label} 更新失败：${String(error)}`)
  }
}

function setKey(
  map: Readonly<Record<string, boolean>>,
  key: string,
  value: boolean | null,
): Record<string, boolean> {
  const next = { ...map }
  if (value === null) delete next[key]
  else next[key] = value
  return next
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
 * 应用一批意图并返回写入后的完整状态。
 *
 * 不比对任何版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 三个文件各自一把锁，固定顺序（pack → 组定义 → 绑定）避免交叉等待；
 * 一个命令命中两个文件时顺序写，不引入跨文件事务。
 *
 * **永不抛**：写失败、文件损坏都一样，说明只落进返回值的 `warnings`。
 * 写盘失败是一次「没写成」，不该让路由把它当异常回滚成错误信封——那会连带
 * 丢掉这次已经算出来的最新 state。
 */
export async function applyCommands(cwd: string | null, commands: readonly Command[]): Promise<PolicyState> {
  const files = filesOf(commands)
  const warnings: string[] = []

  if (files.has('packs')) {
    await writeFileSafely(packsPath(), 'packs.json', warnings, (current) => applyToPacks(current, commands))
  }
  if (files.has('groups')) {
    await writeFileSafely(groupsPath(), 'groups.json', warnings, (current) => applyToGroups(current, commands))
  }
  if (files.has('bindings')) {
    // bind 的合法目标要在 pack 写完之后再读：同一批命令里可能有 createPack / deletePack。
    const packsText = await readForWrite(packsPath(), 'packs.json', warnings)
    if (packsText !== null) {
      const known = new Set(Object.keys(parsePacks(packsText).value.book.packs))
      await writeFileSafely(workspacesPath(), 'workspaces.json', warnings, (current) =>
        applyToBindings(current, commands, known),
      )
    }
  }

  try {
    const state = await loadState(cwd)
    return { ...state, warnings: [...warnings, ...state.warnings] }
  } catch (error) {
    // 写失败后连回读也失败时，仍要给出一个能渲染的状态：宁可面板空一轮，也不抛。
    note(warnings, `读取最新状态失败：${String(error)}`)
    return { ...emptyState(), warnings }
  }
}

/**
 * 试算：把一批命令应用在内存里，返回**不落盘**的视图。
 *
 * 面板的待保存改动靠它渲染「改了会是什么样」。应用规则与 `applyCommands` 完全共用
 * `applyToPacks` / `applyToGroups` / `applyToBindings`，所以试算结果与真写结果不会
 * 有第二条求值路径——面板因此不必在浏览器里复制一份求值链。
 *
 * 与真写一致：某个文件的解析或命令非法时只跳过那份文件并记 warning，不整批失败。
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
 * 命令非法时跳过这份文件并记 warning——与 `writeFileSafely` 的失败口径一致。
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
    note(warnings, `${label} 更新失败：${String(error)}`)
    return current
  }
}

/** 未落盘时的空状态，供读取失败的降级路径使用。 */
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
