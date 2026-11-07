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
  type ParseResult,
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

/**
 * 一次写事务：建父目录 → 拿跨进程锁 → 读 → 改 → 原子覆盖写。
 *
 * 父目录必须在拿锁之前建好：`withFileLock` 用 `wx` 直接建 `<file>.lock`，
 * 它不会建父目录。`writeFileAtomic` 自己会 mkdir，但那是拿锁之后的事。
 */
async function transact(path: string, mutate: (current: string | undefined) => string | null): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const current = await readText(path)
    const next = mutate(current)
    // `null` 表示这一批命令没有实际改变：不落盘，不留空转的空文件。
    if (next === null) return
    await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
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

interface LoadedPacks {
  readonly book: PackBook
  readonly ui: UiState
  readonly warnings: readonly string[]
}

/** 读 `packs.json`。文件不存在时按空策略处理，`default` 由 `parsePacks` 补齐。 */
async function loadPacks(): Promise<LoadedPacks> {
  const parsed = parsePacks(await readText(packsPath()))
  return { book: parsed.value.book, ui: parsed.value.ui, warnings: parsed.warnings }
}

async function loadGroups(): Promise<ParseResult<GroupRegistry>> {
  return parseGroups(await readText(groupsPath()))
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
  /** 工作区绑定表（含全部 cwd 的绑定与 `extra`）。 */
  readonly bindings: Bindings
  readonly warnings: readonly string[]
}

export async function loadState(cwd: string | null): Promise<PolicyState> {
  const warnings: string[] = []
  const loaded = await loadPacks()
  warnings.push(...loaded.warnings)
  const packs: PackBook = loaded.book

  const groupsParsed = await loadGroups()
  warnings.push(...groupsParsed.warnings)

  const cwdKey = normalizeCwd(cwd)
  const bindingsParsed = parseBindings(await readText(workspacesPath()))
  const bindings: Bindings = bindingsParsed.value
  warnings.push(...bindingsParsed.warnings)

  const binding = cwdKey === null ? null : (bindings.bindings[cwdKey] ?? null)
  const resolvedId =
    binding === null || binding === DEFAULT_PACK_ID || packs.packs[binding] === undefined ? DEFAULT_PACK_ID : binding
  return {
    packs,
    ui: loaded.ui,
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
        if (command.packId === DEFAULT_PACK_ID) throw new Error('default pack 不可改名')
        const pack = findPack(packs, command.packId)
        const name = requireName(command.name)
        assertNameFree(packs, name, command.packId)
        packs[command.packId] = { ...pack, name }
        break
      }
      case 'deletePack': {
        if (command.packId === DEFAULT_PACK_ID) throw new Error('default pack 不可删除')
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

  // 没有实际变化就不创建文件：空文件只会让后续读取多一次解析。
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
      case 'addExtra':
      case 'removeExtra':
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
 * 应用一批意图并返回写入后的完整状态。
 *
 * 不比对任何版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 三个文件各自一把锁，固定顺序（pack → 组定义 → 绑定）避免交叉等待；
 * 一个命令命中两个文件时顺序写，不引入跨文件事务。
 */
export async function applyCommands(cwd: string | null, commands: readonly Command[]): Promise<PolicyState> {
  const plan = targets(commands)

  if (plan.packs) {
    await transact(packsPath(), (current) => applyToPacks(current, commands))
  }
  if (plan.groups) {
    await transact(groupsPath(), (current) => applyToGroups(current, commands))
  }
  if (plan.bindings) {
    // bind 的合法目标要在 pack 写完之后再读：同一批命令里可能有 createPack / deletePack。
    const known = new Set(Object.keys((await loadPacks()).book.packs))
    await transact(workspacesPath(), (current) => applyToBindings(current, commands, known))
  }

  return await loadState(cwd)
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
