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
export function packsPath(): string {
  return dshHomePath('packs', 'skill', 'packs.json')
}

export function groupsPath(): string {
  return dshHomePath('packs', 'skill', 'groups.json')
}

export function workspacesPath(): string {
  return dshHomePath('packs', 'skill', 'workspaces.json')
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
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

function requireName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw new Error('pack 名不能为空')
  return name
}

function findPack(packs: Readonly<Record<string, Pack>>, packId: string): Pack {
  const pack = packs[packId]
  if (pack === undefined) throw new Error(`未知 pack：${packId}`)
  return pack
}

function assertNameFree(packs: Readonly<Record<string, Pack>>, name: string, exceptId?: string): void {
  for (const [id, pack] of Object.entries(packs)) {
    if (id !== exceptId && pack.name === name) throw new Error(`pack 名已存在：${name}`)
  }
}

/** 造一个短且稳定的 pack id，与分组 id 一样与名字脱钩。 */
function nextPackId(packs: Readonly<Record<string, Pack>>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `p${String(index)}`
    if (packs[candidate] === undefined) return candidate
  }
}

/** 写 packs.json。 */
function applyToPacks(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parsePacks(current).value
  const ui = { ...parsed.ui }
  const packs: Record<string, Pack> = { ...parsed.book.packs }

  for (const command of commands) {
    switch (command.op) {
      case 'createPack': {
        const name = requireName(command.name)
        assertNameFree(packs, name)
        const id = nextPackId(packs)
        packs[id] = { name, items: {}, groups: {} }
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
      case 'deleteGroup': {
        // 组没了，它的开关就没有意义：一并从每张 pack 里删掉。
        // 留成 orphan 会在同一个 id 被复用时突然生效，而 id 是按现有数量生成的。
        for (const [id, pack] of Object.entries(packs)) {
          if (pack.groups[command.groupId] === undefined) continue
          packs[id] = { ...pack, groups: setKey(pack.groups, command.groupId, null) }
        }
        break
      }
      case 'packItem': {
        const pack = findPack(packs, command.packId)
        packs[command.packId] = { ...pack, items: setKey(pack.items, command.name, command.value) }
        break
      }
      case 'packGroup': {
        const pack = findPack(packs, command.packId)
        packs[command.packId] = { ...pack, groups: setKey(pack.groups, command.groupId, command.value) }
        break
      }
      case 'showOfficialSkills':
        ui.showOfficialSkills = command.value
        break
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

/** 写 groups.json。 */
function applyToGroups(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parseGroups(current).value
  const assignments = { ...parsed.assignments }
  let groups = [...parsed.groups]
  const known = () => new Set(groups.map((group) => group.id))

  for (const command of commands) {
    if (command.op === 'createGroup') {
      const name = command.name.trim()
      if (name === '') throw new Error('分组名不能为空')
      // 重名必须在写入前拦住：同一批命令里的前一条已经进 `groups`，所以这条检查
      // 对批量新建同样成立。放过去就会在名册里留下两张同名分组，界面上无法区分。
      if (groups.some((group) => group.name === name)) throw new Error(`分组名已存在：${name}`)
      // id 稳定且与名字脱钩：改名不需要扫任何工程文件。
      const id = nextGroupId(groups)
      groups = [...groups, { id, name }]
      continue
    }
    if (command.op === 'renameGroup') {
      const name = command.name.trim()
      if (name === '') throw new Error('分组名不能为空')
      if (!known().has(command.groupId)) throw new Error(`未知分组：${command.groupId}`)
      if (groups.some((group) => group.id !== command.groupId && group.name === name)) {
        throw new Error(`分组名已存在：${name}`)
      }
      groups = groups.map((group) =>
        group.id === command.groupId ? { id: group.id, name } : group,
      )
      continue
    }
    if (command.op === 'deleteGroup') {
      if (!known().has(command.groupId)) throw new Error(`未知分组：${command.groupId}`)
      groups = groups.filter((group) => group.id !== command.groupId)
      // 成员回到未分组。各 pack 里该组的开关由 applyToPacks 同批清除：
      // id 按现有数量生成，删除后可能被复用，留着 orphan 会让新组继承旧决定。
      for (const [name, groupId] of Object.entries(assignments)) {
        if (groupId === command.groupId) delete assignments[name]
      }
      continue
    }
    if (command.op !== 'assign') continue
    if (command.groupId === null) {
      delete assignments[command.name]
      continue
    }
    if (!known().has(command.groupId)) {
      throw new Error(`未知分组：${command.groupId}`)
    }
    assignments[command.name] = command.groupId
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
  const parsed = parseBindings(current)
  const bindings: Record<string, string> = { ...parsed.value.bindings }
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

  // 没有实际变化就不创建文件：只改 pack 的批量命令不该顺手留下一个空绑定文件。
  return changed ? serializeBindings({ bindings }) : null
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
      case 'packItem':
      case 'packGroup':
      case 'showOfficialSkills':
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
        bindings = true
        break
      default:
        break
    }
    // deletePack 还要清绑定，deleteGroup 还要清各 pack 里的组开关。
    if (command.op === 'deletePack') bindings = true
    if (command.op === 'deleteGroup') packs = true
  }
  return { packs, groups, bindings }
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
  const plan = targets(commands)
  const warnings: string[] = []

  if (plan.packs) {
    await writeFileSafely(packsPath(), 'packs.json', warnings, (current) => applyToPacks(current, commands))
  }
  if (plan.groups) {
    await writeFileSafely(groupsPath(), 'groups.json', warnings, (current) => applyToGroups(current, commands))
  }
  if (plan.bindings) {
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
  const plan = targets(commands)
  const [packsCurrent, groupsCurrent, workspacesCurrent] = await Promise.all([
    readText(packsPath()),
    readText(groupsPath()),
    readText(workspacesPath()),
  ])

  let packsText = packsCurrent
  let groupsText = groupsCurrent
  let workspacesText = workspacesCurrent

  if (plan.packs) {
    packsText = computeText(packsCurrent, 'packs.json', warnings, (current) => applyToPacks(current, commands))
  }
  if (plan.groups) {
    groupsText = computeText(groupsCurrent, 'groups.json', warnings, (current) => applyToGroups(current, commands))
  }
  if (plan.bindings) {
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
