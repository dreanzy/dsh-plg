import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
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
  type ParseResult,
  type RowPatch,
  type RowPolicy,
  type UiState,
} from './types.js'

/**
 * 三个状态文件，各自独立事务。
 *
 * 路径一律走 `dshHomePath`，不自己拼 `$DSH_HOME` 前缀：宿主允许用环境变量或
 * 显式配置改根目录，自己拼会绕开它。
 */
export function packsPath(): string {
  return dshHomePath('packs', 'mcp', 'packs.json')
}

export function groupsPath(): string {
  return dshHomePath('packs', 'mcp', 'groups.json')
}

export function workspacesPath(): string {
  return dshHomePath('packs', 'mcp', 'workspaces.json')
}

/** 运行期自检快照。不是策略，只是排查用的证据。 */
export function diagPath(): string {
  return dshHomePath('packs', 'mcp', 'diag.json')
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
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
 * 把一份补丁落到一条行策略上。
 *
 * 「键不在补丁里」与「键是 `null`」是两件事：前者不动，后者删掉回跟随。
 * 四个字段全空等于跟随：整条删掉，别留下一个空对象冒充覆盖。
 */
function applyPatch(
  rows: Readonly<Record<string, RowPolicy>>,
  rowKey: string,
  patch: RowPatch,
): Record<string, RowPolicy> {
  const source = rows[rowKey]
  const next: { enabled?: boolean; mode?: RowPolicy['mode']; tools?: readonly string[]; description?: string } = {
    ...(source === undefined ? {} : source),
  }
  if ('enabled' in patch) {
    if (patch.enabled === null || patch.enabled === undefined) delete next.enabled
    else next.enabled = patch.enabled
  }
  if ('mode' in patch) {
    if (patch.mode === null || patch.mode === undefined) delete next.mode
    else next.mode = patch.mode
  }
  if ('tools' in patch) {
    if (patch.tools === null || patch.tools === undefined) delete next.tools
    else next.tools = patch.tools
  }
  if ('description' in patch) {
    if (patch.description === null || patch.description === undefined) delete next.description
    else next.description = patch.description
  }
  const out = { ...rows }
  if (Object.keys(next).length === 0) delete out[rowKey]
  else out[rowKey] = next
  return out
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

async function loadGroups(): Promise<ParseResult<GroupRegistry>> {
  const text = await readText(groupsPath())
  if (text !== undefined) return parseGroups(text)
  return { value: EMPTY_GROUPS, warnings: [] }
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
  /** 工作区绑定表（含全部 cwd 的绑定与 `extra`）。 */
  readonly bindings: Bindings
  readonly warnings: readonly string[]
}

export async function loadState(cwd: string | null): Promise<PolicyState> {
  const warnings: string[] = []
  const loaded = await loadPacks()
  warnings.push(...loaded.warnings)
  const packs = loaded.book.packs

  const groupsParsed = await loadGroups()
  warnings.push(...groupsParsed.warnings)

  const cwdKey = normalizeCwd(cwd)
  const bindingsText = await readText(workspacesPath())
  let bindings: Bindings = EMPTY_BINDINGS
  if (bindingsText !== undefined) {
    const parsed = parseBindings(bindingsText)
    bindings = parsed.value
    warnings.push(...parsed.warnings)
  }

  const binding = cwdKey === null ? null : (bindings.bindings[cwdKey] ?? null)
  const resolvedId =
    binding === null || binding === DEFAULT_PACK_ID || packs[binding] === undefined ? DEFAULT_PACK_ID : binding
  return {
    packs: { packs },
    ui: loaded.ui,
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
function applyToPacks(current: string | undefined, commands: readonly Command[]): string {
  assertWritable(current, 'packs.json')
  const parsed = parsePacks(current).value
  const ui = { ...parsed.ui }
  const packs: Record<string, McpPack> = { ...parsed.book.packs }

  for (const command of commands) {
    switch (command.op) {
      case 'createPack': {
        const name = requireName(command.name)
        assertNameFree(packs, name)
        const id = nextPackId(packs)
        packs[id] = { name, groups: {}, rows: {} }
        break
      }
      case 'renamePack': {
        if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可改名')
        const pack = findPack(packs, command.packId)
        const name = requireName(command.name)
        assertNameFree(packs, name, command.packId)
        packs[command.packId] = { ...pack, name }
        break
      }
      case 'deletePack': {
        if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可删除')
        findPack(packs, command.packId)
        delete packs[command.packId]
        break
      }
      case 'packRow': {
        const pack = findPack(packs, command.packId)
        packs[command.packId] = { ...pack, rows: applyPatch(pack.rows, command.rowKey, command.patch) }
        break
      }
      case 'packGroup': {
        const pack = findPack(packs, command.packId)
        packs[command.packId] = { ...pack, groups: setKey(pack.groups, command.groupId, command.value) }
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

  return serializePacks(packs, ui)
}

/** 写 groups.json。文件缺席时从空注册表起步。 */
function applyToGroups(current: string | undefined, commands: readonly Command[]): string {
  assertWritable(current, 'groups.json')
  const parsed = current === undefined ? EMPTY_GROUPS : parseGroups(current).value
  const assignments = { ...parsed.assignments }
  let groups = [...parsed.groups]
  const known = () => new Set(groups.map((group) => group.id))

  for (const command of commands) {
    if (command.op === 'createGroup') {
      const name = command.name.trim()
      if (name === '') throw new Error('分组名不能为空')
      // id 稳定且与名字脱钩：改名不需要扫任何工程文件。
      const id = nextGroupId(groups)
      groups = [...groups, { id, name }]
      continue
    }
    if (command.op === 'renameGroup') {
      const name = command.name.trim()
      if (name === '') throw new Error('分组名不能为空')
      if (!known().has(command.groupId)) throw new Error(`未知分组：${command.groupId}`)
      groups = groups.map((group) => (group.id === command.groupId ? { id: group.id, name } : group))
      continue
    }
    if (command.op === 'deleteGroup') {
      if (!known().has(command.groupId)) throw new Error(`未知分组：${command.groupId}`)
      groups = groups.filter((group) => group.id !== command.groupId)
      // 成员回到未分组。各 pack 残留的组开关决定保留：组重建后语义不恢复（id 已变），
      // 但它们不影响求值——孤儿 gid 永远不会被任何行命中。
      for (const [rowKey, groupId] of Object.entries(assignments)) {
        if (groupId === command.groupId) delete assignments[rowKey]
      }
      continue
    }
    if (command.op !== 'assign') continue
    if (command.groupId === null) {
      delete assignments[command.rowKey]
      continue
    }
    if (!known().has(command.groupId)) {
      throw new Error(`未知分组：${command.groupId}`)
    }
    assignments[command.rowKey] = command.groupId
  }
  return serializeGroups({ groups, assignments })
}

/** 造一个短且稳定的分组 id。 */
function nextGroupId(groups: readonly { id: string }[]): string {
  const taken = new Set(groups.map((group) => group.id))
  for (let index = groups.length + 1; ; index += 1) {
    const candidate = `g${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

function applyToBindings(
  current: string | undefined,
  commands: readonly Command[],
  knownPacks: ReadonlySet<string>,
): string | null {
  assertWritable(current, 'workspaces.json')
  const parsed = parseBindings(current)
  const bindings: Record<string, string> = { ...parsed.value.bindings }
  const extra = [...parsed.value.extra]
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
    if (command.op === 'addExtra') {
      const key = normalizeCwd(command.cwd)
      if (key === null) throw new Error('extra 的工作目录不能为空')
      if (extra.indexOf(key) < 0) {
        extra.push(key)
        changed = true
      }
      continue
    }
    if (command.op === 'removeExtra') {
      const key = normalizeCwd(command.cwd)
      if (key === null) throw new Error('extra 的工作目录不能为空')
      const at = extra.indexOf(key)
      if (at >= 0) {
        extra.splice(at, 1)
        changed = true
      }
      continue
    }
    if (command.op !== 'bind') continue
    const key = normalizeCwd(command.cwd)
    if (key === null) throw new Error('绑定的工作目录不能为空')
    if (command.packId === null || command.packId === DEFAULT_PACK_ID) {
      // 显式绑到 default 与解除绑定等价，落盘时不留冗余键。
      if (bindings[key] !== undefined) {
        delete bindings[key]
        changed = true
      }
      continue
    }
    if (!knownPacks.has(command.packId)) throw new Error(`未知 pack：${command.packId}`)
    if (bindings[key] !== command.packId) {
      bindings[key] = command.packId
      changed = true
    }
  }

  // 没有实际变化就不创建文件：避免产生无意义的空文件。
  return changed ? serializeBindings({ bindings, extra }) : null
}

interface Targets {
  readonly packs: boolean
  readonly groups: boolean
  readonly bindings: boolean
}

function targets(commands: readonly Command[]): Targets {
  let packs = false
  let groups = false
  let bindings = false
  for (const command of commands) {
    switch (command.op) {
      case 'createPack':
      case 'renamePack':
      case 'deletePack':
      case 'packRow':
      case 'packGroup':
      case 'showChip':
      case 'defaultTab':
        packs = true
        break
      case 'assign':
      case 'createGroup':
      case 'renameGroup':
      case 'deleteGroup':
        groups = true
        break
      case 'bind':
      case 'addExtra':
      case 'removeExtra':
        bindings = true
        break
      default:
        break
    }
    // deletePack 还要清绑定，所以同时命中两个文件。
    if (command.op === 'deletePack') bindings = true
  }
  return { packs, groups, bindings }
}

/** 真正落盘的那一半：前置校验 + 三个文件按固定顺序写。失败照旧抛出，由调用方收成 warning。 */
async function writeCommands(commands: readonly Command[]): Promise<void> {
  const plan = targets(commands)
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

  if (plan.packs) {
    await transact(packsPath(), 'packs.json', (current) => applyToPacks(current, commands))
  }
  if (plan.groups) {
    await transact(groupsPath(), 'groups.json', (current) => applyToGroups(current, commands))
  }
  if (plan.bindings) {
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
