import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  normalizeCwd,
  parseBindings,
  parseGlobal,
  parseGroups,
  parseLayer,
  parsePacks,
  serializeBindings,
  serializeGroups,
  serializePacks,
  type ParsedPacks,
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
  return dshHomePath('packs', 'skill', 'packs.json')
}

export function groupsPath(): string {
  return dshHomePath('packs', 'skill', 'groups.json')
}

export function workspacesPath(): string {
  return dshHomePath('packs', 'skill', 'workspaces.json')
}

/** 旧全局层路径。只用于兼容读，写路径不再碰它。 */
export function legacyGlobalPath(): string {
  return dshHomePath('skill-manager', 'global.json')
}

/** 旧组定义路径。只用于兼容读。 */
export function legacyGroupsPath(): string {
  return dshHomePath('skill-manager', 'groups.json')
}

/** 旧的工作区层路径。只用于兼容读，且只在内存里映射，不写盘。 */
export function legacyWorkspacePath(cwd: string): string {
  return join(cwd, '.dsh', 'skill-manager.json')
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
    // `null` 表示这一批命令没有实际改变：不落盘。兼容读期间这很重要——
    // 凭空建一个空文件会让旧文件的降级路径立刻失效。
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

/**
 * 读 `packs.json`。
 *
 * 新文件不存在、旧的 `$DSH_HOME/skill-manager/global.json` 存在时，把旧全局层
 * 在**内存里**映射成 `packs.default`。读取路径绝不写盘：迁移由独立脚本完成。
 */
async function loadPacks(): Promise<LoadedPacks> {
  const text = await readText(packsPath())
  if (text !== undefined) {
    const parsed = parsePacks(text)
    return { book: parsed.value.book, ui: parsed.value.ui, warnings: parsed.warnings }
  }

  const legacyText = await readText(legacyGlobalPath())
  if (legacyText !== undefined) {
    const legacy = parseGlobal(legacyText)
    return {
      book: {
        packs: {
          [DEFAULT_PACK_ID]: {
            name: DEFAULT_PACK_ID,
            items: legacy.value.items,
            groups: legacy.value.groups,
          },
        },
      },
      ui: {
        ...EMPTY_UI,
        showOfficialSkills: legacy.value.showOfficialSkills,
      },
      warnings: legacy.warnings,
    }
  }

  return { book: { packs: { [DEFAULT_PACK_ID]: EMPTY_PACK } }, ui: { ...EMPTY_UI }, warnings: [] }
}

async function loadGroups(): Promise<ParseResult<GroupRegistry>> {
  const text = await readText(groupsPath())
  if (text !== undefined) return parseGroups(text)
  const legacyText = await readText(legacyGroupsPath())
  if (legacyText !== undefined) return parseGroups(legacyText)
  return { value: EMPTY_GROUPS, warnings: [] }
}

function hasEntries(layer: { readonly items: Record<string, boolean>; readonly groups: Record<string, boolean> }): boolean {
  return Object.keys(layer.items).length > 0 || Object.keys(layer.groups).length > 0
}

/** 给兼容读造出来的 pack 取一个不冲突的 id。 */
function uniquePackId(packs: Readonly<Record<string, Pack>>, base: string): string {
  if (packs[base] === undefined) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${String(index)}`
    if (packs[candidate] === undefined) return candidate
  }
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
  const packs: Record<string, Pack> = { ...loaded.book.packs }

  const groupsParsed = await loadGroups()
  warnings.push(...groupsParsed.warnings)

  const cwdKey = normalizeCwd(cwd)
  const bindingsText = await readText(workspacesPath())
  let bindings: Bindings = EMPTY_BINDINGS
  if (bindingsText !== undefined) {
    const parsed = parseBindings(bindingsText)
    bindings = parsed.value
    warnings.push(...parsed.warnings)
  } else if (cwdKey !== null) {
    // 兼容读：旧的 `<cwd>/.dsh/skill-manager.json` 合成一个内存 pack 并绑定到该 cwd。
    const legacyText = await readText(legacyWorkspacePath(cwdKey))
    if (legacyText !== undefined) {
      const legacy = parseLayer(legacyText)
      warnings.push(...legacy.warnings)
      if (hasEntries(legacy.value)) {
        const id = uniquePackId(packs, 'legacy')
        packs[id] = {
          name: basename(cwdKey) || cwdKey,
          items: legacy.value.items,
          groups: legacy.value.groups,
        }
        bindings = { bindings: { ...bindings.bindings, [cwdKey]: id }, extra: [] }
      }
    }
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

/**
 * 写 packs.json。
 *
 * `seed` 是文件缺席时的初值：它来自兼容读的旧 `global.json`。没有这个 seed，
 * 兼容读之后第一次保存会从空策略起写，旧决定被静默丢掉。
 */
function applyToPacks(
  current: string | undefined,
  commands: readonly Command[],
  seed: ParsedPacks,
): string {
  const parsed = current === undefined ? seed : parsePacks(current).value
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

/**
 * 写 groups.json。`seed` 的用途同 `applyToPacks`：文件缺席时先承接兼容读的旧组定义。
 */
function applyToGroups(
  current: string | undefined,
  commands: readonly Command[],
  seed: GroupRegistry,
): string {
  const parsed = current === undefined ? seed : parseGroups(current).value
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

  // 没有实际变化就不创建文件：workspaces.json 一旦存在，旧工作区层的兼容读
  // 就会关闭，凭空建空文件等于丢掉旧配置。
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
    // seed 承接兼容读：文件缺席时从旧 global.json 起步，不让第一次保存清空旧决定。
    const seed = await loadPacks()
    await transact(packsPath(), (current) =>
      applyToPacks(current, commands, { book: seed.book, ui: seed.ui }),
    )
  }
  if (plan.groups) {
    const seed = (await loadGroups()).value
    await transact(groupsPath(), (current) => applyToGroups(current, commands, seed))
  }
  if (plan.bindings) {
    // bind 的合法目标要在 pack 写完之后再读：同一批命令里可能有 createPack / deletePack。
    const known = new Set(Object.keys((await loadPacks()).book.packs))
    await transact(workspacesPath(), (current) => applyToBindings(current, commands, known))
  }

  return await loadState(cwd)
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
