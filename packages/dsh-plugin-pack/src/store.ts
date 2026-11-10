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
  return dshHomePath('packs', 'plugin', 'packs.json')
}

export function groupsPath(): string {
  return dshHomePath('packs', 'plugin', 'groups.json')
}

export function workspacesPath(): string {
  return dshHomePath('packs', 'plugin', 'workspaces.json')
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
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
  if (text === undefined || text.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return `内容不是合法 JSON（${String(error)}）`
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '顶层不是对象'
  return null
}

/**
 * 一次写事务：建父目录 → 拿跨进程锁 → 读 → 改 → 原子覆盖写。
 *
 * 父目录必须在拿锁之前建好：`withFileLock` 用 `wx` 直接建 `<file>.lock`，
 * 它不会建父目录。`writeFileAtomic` 自己会 mkdir，但那是拿锁之后的事。
 *
 * 返回 `false` 表示文件没写成（读失败、内容坏、命令被拒、落盘失败），调用方据此
 * 停下这一批剩下的文件。写侧一律不抛：失败说明进 `warnings`，因为「保存没生效」
 * 只能从这里读到。
 */
async function transact(
  path: string,
  label: string,
  mutate: (current: string | undefined) => string | null,
  warnings: string[],
): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    warnings.push(`${label} 无法创建所在目录，已跳过本次写入：${reasonOf(error)}`)
    return false
  }

  let written = true
  try {
    await withFileLock(path, async () => {
      let current: string | undefined
      try {
        current = await readText(path)
      } catch (error) {
        // 读不出来就不知道现有内容，照着想象中的空策略写下去等于清空。
        warnings.push(`${label} 读取失败，已跳过本次写入：${reasonOf(error)}`)
        written = false
        return
      }
      const broken = brokenReason(current)
      if (broken !== null) {
        warnings.push(`${label} ${broken}，已拒写以免覆盖：${path}`)
        written = false
        return
      }
      let next: string | null
      try {
        next = mutate(current)
      } catch (error) {
        // 命令本身不合法（未知 pack、默认 pack 不可删）：整批不写，与「写一半」相比更容易解释。
        warnings.push(`${label} 未写入：${reasonOf(error)}`)
        written = false
        return
      }
      // `null` 表示这一批命令没有实际改变：不落盘，不留空转的空文件。
      if (next === null) return
      await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
    })
  } catch (error) {
    // 拿锁或落盘失败：目录只读、锁被占着、磁盘满。
    warnings.push(`${label} 写入失败：${reasonOf(error)}`)
    return false
  }
  return written
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

/** 写 `packs.json`。文件缺席时从空策略起写，`default` 由 `parsePacks` 补齐。 */
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
      case 'deleteGroup': {
        // 组删掉后各 pack 里针对它的开关必须一起清：分组 id 会复用（见 nextGroupId），
        // 留着就等于让重建的新组继承旧组的决定。
        for (const [id, pack] of Object.entries(packs)) {
          if (pack.groups[command.groupId] === undefined) continue
          packs[id] = { ...pack, groups: setKey(pack.groups, command.groupId, null) }
        }
        break
      }
      case 'showOfficialPlugins':
        ui.showOfficialPlugins = command.value
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

/** 写 `groups.json`。文件缺席时从空注册表起写。 */
function applyToGroups(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parseGroups(current).value
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
      groups = groups.map((group) =>
        group.id === command.groupId ? { id: group.id, name } : group,
      )
      continue
    }
    if (command.op === 'deleteGroup') {
      if (!known().has(command.groupId)) throw new Error(`未知分组：${command.groupId}`)
      groups = groups.filter((group) => group.id !== command.groupId)
      // 成员回到未分组。各 pack 残留的组开关决定保留：组重建后语义不恢复（id 已变），
      // 但它们不影响求值——孤儿 gid 永远不会被任何项命中。
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

  // 没有实际变化就不创建文件：空文件只会让后续读取多一次解析。
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
      case 'showOfficialPlugins':
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
    // deletePack 还要清绑定，所以同时命中两个文件。
    if (command.op === 'deletePack') bindings = true
    // deleteGroup 还要清各 pack 里的组开关，理由见 applyToPacks。
    if (command.op === 'deleteGroup') packs = true
  }
  return { packs, groups, bindings }
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
  const plan = targets(commands)
  const warnings: string[] = []

  if (plan.packs) {
    const ok = await transact(packsPath(), 'packs.json', (current) => applyToPacks(current, commands), warnings)
    if (!ok) return await settled(cwd, warnings)
  }
  if (plan.groups) {
    const ok = await transact(groupsPath(), 'groups.json', (current) => applyToGroups(current, commands), warnings)
    if (!ok) return await settled(cwd, warnings)
  }
  if (plan.bindings) {
    const known = await loadPackIds(warnings)
    if (known !== null) {
      await transact(
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
 * 命令非法时跳过这份文件并记 warning——试算不该因为一条坏命令把整块视图变成错误。
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
    warnings.push(`${label} 更新失败：${reasonOf(error)}`)
    return current
  }
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
