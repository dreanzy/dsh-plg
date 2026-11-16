import {
  filesOf as filesOfTable,
  parseCommands as parseCommandsTable,
  type OpSpec,
  type OpTable,
  type StoreFile,
} from '@dreanzy/dsh-pack-core'
import { MAX_NAMES, normalizeCwd } from './policy.js'
import {
  DEFAULT_PACK_ID,
  type Bindings,
  type Command,
  type GroupRegistry,
  type Pack,
  type SettingsTab,
  type UiState,
} from './types.js'

/**
 * 本包的命令定义。
 *
 * 骨架（`op` / `files` / `parse` 的调用约定）在 `@dreanzy/dsh-pack-core`；
 * 这里只把三个草稿类型绑到本包的形状上。`key` 已从 interface 删掉——它全仓零消费点，
 * 队列键由 core 的 `pendingKeyOf` 直接查表。
 */

/** 写 `packs.json`（含 ui 段）时的草稿。 */
export interface PacksDraft {
  packs: Record<string, Pack>
  ui: UiState
}

/** 写 `groups.json` 时的草稿。 */
export interface GroupsDraft {
  groups: { id: string; name: string }[]
  assignments: Record<string, string>
}

/** 写 `workspaces.json` 时的草稿；`changed` 决定要不要真建文件。 */
export interface BindingsDraft {
  bindings: Record<string, string>
  changed: boolean
}

export type PluginOpSpec = OpSpec<Command, PacksDraft, GroupsDraft, BindingsDraft>
/* ------------------------------------------------------------------ *
 * 校验：入站记录 → 命令
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readNonEmpty(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function readValue(record: Record<string, unknown>): boolean | null | undefined {
  const value = record['value']
  if (value === null) return null
  return typeof value === 'boolean' ? value : undefined
}

function readName(record: Record<string, unknown>): string | null {
  const name = record['name']
  return typeof name === 'string' && name.trim() !== '' ? name : null
}

function readBoolValue(record: Record<string, unknown>): boolean | string {
  const value = record['value']
  return typeof value === 'boolean' ? value : 'value 必须是布尔'
}

function readTab(record: Record<string, unknown>): SettingsTab | null {
  const value = record['value']
  if (value === 'groups' || value === 'packs' || value === 'workspace') return value
  return null
}

/* ------------------------------------------------------------------ *
 * 应用：命令 → 草稿
 * ------------------------------------------------------------------ */

function setKey(
  map: Readonly<Record<string, boolean>>,
  key: string,
  value: boolean | null,
): Record<string, boolean> {
  const next = { ...map }
  if (value === null) {
    delete next[key]
    return next
  }
  // 用 defineProperty 而不是赋值：`next['__proto__'] = value` 改的是原型，
  // 键被静默丢弃，序列化时消失且没有 warning。
  Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true })
  return next
}

function requireName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw new Error('pack 名不能为空')
  return name
}

function findPack(packs: Readonly<Record<string, Pack>>, packId: string): Pack {
  // hasOwn：`packs['__proto__']` 拿到的是 Object.prototype，不是 undefined，
  // 会让「未知 pack」的报错消失，后续求值抛 TypeError。
  const pack = Object.hasOwn(packs, packId) ? packs[packId] : undefined
  if (pack === undefined) throw new Error(`未知 pack：${packId}`)
  return pack
}

function assertNameFree(packs: Readonly<Record<string, Pack>>, name: string, exceptId?: string): void {
  for (const [id, pack] of Object.entries(packs)) {
    if (id !== exceptId && pack.name === name) throw new Error(`pack 名已存在：${name}`)
  }
}

/** 造一个短且稳定的 pack id，与名字脱钩。 */
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
    let taken = false
    for (const pack of Object.values(packs)) {
      if (pack.name === candidate) {
        taken = true
        break
      }
    }
    if (!taken) return candidate
  }
}

/** 深拷贝一张 pack：副本与原 pack 之后各改各的，共享任何一层对象都会串味。 */
function clonePack(pack: Pack): Pack {
  return { name: pack.name, items: { ...pack.items }, groups: { ...pack.groups } }
}

/** 写侧也按读侧的上限拒绝：写得进去、读不回来是最难排查的一类问题。 */
function assertPackRoom(packs: Readonly<Record<string, Pack>>): void {
  if (Object.keys(packs).length >= MAX_NAMES) throw new Error(`pack 已达上限 ${String(MAX_NAMES)} 个`)
}

/** 造一个短且稳定的分组 id，与名字脱钩。 */
function nextGroupId(groups: readonly { id: string }[]): string {
  const taken = new Set(groups.map((group) => group.id))
  for (let index = groups.length + 1; ; index += 1) {
    const candidate = `g${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

const groupNameOf = (command: Extract<Command, { op: 'createGroup' | 'renameGroup' }>): string => {
  const name = command.name.trim()
  if (name === '') throw new Error('分组名不能为空')
  return name
}

/* ------------------------------------------------------------------ *
 * 表
 * ------------------------------------------------------------------ */

const PACK_ITEM: PluginOpSpec = {
  op: 'packItem',
  files: ['packs'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    const name = readNonEmpty(record, 'name')
    if (name === null) return 'name 必须是非空字符串'
    const value = readValue(record)
    if (value === undefined) return 'value 必须是布尔或 null'
    return { op: 'packItem', packId, name, value }
  },
  applyPacks(draft, command) {
    if (command.op !== 'packItem') return
    const pack = findPack(draft.packs, command.packId)
    draft.packs[command.packId] = { ...pack, items: setKey(pack.items, command.name, command.value) }
  },
}

const PACK_GROUP: PluginOpSpec = {
  op: 'packGroup',
  files: ['packs'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    const groupId = readNonEmpty(record, 'groupId')
    if (groupId === null) return 'groupId 必须是非空字符串'
    const value = readValue(record)
    if (value === undefined) return 'value 必须是布尔或 null'
    return { op: 'packGroup', packId, groupId, value }
  },
  applyPacks(draft, command) {
    if (command.op !== 'packGroup') return
    const pack = findPack(draft.packs, command.packId)
    draft.packs[command.packId] = { ...pack, groups: setKey(pack.groups, command.groupId, command.value) }
  },
}

const CREATE_PACK: PluginOpSpec = {
  op: 'createPack',
  files: ['packs'],
  parse(record) {
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'createPack', name }
  },
  applyPacks(draft, command) {
    if (command.op !== 'createPack') return
    const name = requireName(command.name)
    assertNameFree(draft.packs, name)
    assertPackRoom(draft.packs)
    const id = nextPackId(draft.packs)
    draft.packs[id] = { name, items: {}, groups: {} }
  },
}

/**
 * 复制一张 pack。
 *
 * 必须是一条命令而不是「客户端先 createPack 再 putPack」：新 id 由服务端生成，
 * 客户端拼不出要写进后续命令的那个值。一条命令也保证副本要么完整存在、要么完全不存在。
 */
const DUPLICATE_PACK: PluginOpSpec = {
  op: 'duplicatePack',
  files: ['packs'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    // name 可省：省了由服务端按「原名 + 序号」生成，面板走的就是这条路。
    if (!Object.hasOwn(record, 'name')) return { op: 'duplicatePack', packId }
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'duplicatePack', packId, name }
  },
  applyPacks(draft, command) {
    if (command.op !== 'duplicatePack') return
    const source = findPack(draft.packs, command.packId)
    assertPackRoom(draft.packs)
    const given = command.name === undefined ? '' : requireName(command.name)
    if (given !== '') assertNameFree(draft.packs, given)
    const id = nextPackId(draft.packs)
    const copy = clonePack(source)
    draft.packs[id] = { ...copy, name: given === '' ? copyName(draft.packs, source.name) : given }
  },
}

const RENAME_PACK: PluginOpSpec = {
  op: 'renamePack',
  files: ['packs'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'renamePack', packId, name }
  },
  applyPacks(draft, command) {
    if (command.op !== 'renamePack') return
    if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可改名')
    const pack = findPack(draft.packs, command.packId)
    const name = requireName(command.name)
    assertNameFree(draft.packs, name, command.packId)
    draft.packs[command.packId] = { ...pack, name }
  },
}

const DELETE_PACK: PluginOpSpec = {
  op: 'deletePack',
  files: ['packs', 'bindings'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    return { op: 'deletePack', packId }
  },
  applyPacks(draft, command) {
    if (command.op !== 'deletePack') return
    if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可删除')
    findPack(draft.packs, command.packId)
    delete draft.packs[command.packId]
  },
  applyBindings(draft, command) {
    if (command.op !== 'deletePack') return
    // 删除 pack 后清理指向它的绑定；悬空键本来也能读（按 default 求值），主动清是
    // 为了不让文件无限积累垃圾。
    for (const [key, packId] of Object.entries(draft.bindings)) {
      if (packId === command.packId) {
        delete draft.bindings[key]
        draft.changed = true
      }
    }
  },
}

const BIND: PluginOpSpec = {
  op: 'bind',
  files: ['bindings'],
  parse(record) {
    const cwd = readNonEmpty(record, 'cwd')
    if (cwd === null || cwd.trim() === '') return 'cwd 必须是非空字符串'
    const packId = record['packId']
    if (packId !== null && (typeof packId !== 'string' || packId === '')) {
      return 'packId 必须是 pack id 或 null'
    }
    return { op: 'bind', cwd, packId }
  },
  applyBindings(draft, command, knownPacks) {
    if (command.op !== 'bind') return
    const key = normalizeCwd(command.cwd)
    if (key === null) throw new Error('绑定的工作目录不能为空')
    if (command.packId === null || command.packId === DEFAULT_PACK_ID) {
      // 显式绑到 default 与解除绑定等价，落盘时不留冗余键。
      if (draft.bindings[key] !== undefined) {
        delete draft.bindings[key]
        draft.changed = true
      }
      return
    }
    if (!knownPacks.has(command.packId)) throw new Error(`未知 pack：${command.packId}`)
    if (draft.bindings[key] !== command.packId) {
      draft.bindings[key] = command.packId
      draft.changed = true
    }
  },
}

const ASSIGN: PluginOpSpec = {
  op: 'assign',
  files: ['groups'],
  parse(record) {
    const name = readNonEmpty(record, 'name')
    if (name === null) return 'name 必须是非空字符串'
    const groupId = record['groupId']
    if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) {
      return 'groupId 必须是分组 id 或 null'
    }
    return { op: 'assign', name, groupId }
  },
  applyGroups(draft, command) {
    if (command.op !== 'assign') return
    if (command.groupId === null) {
      delete draft.assignments[command.name]
      return
    }
    if (!draft.groups.some((group) => group.id === command.groupId)) {
      throw new Error(`未知分组：${command.groupId}`)
    }
    draft.assignments[command.name] = command.groupId
  },
}

const CREATE_GROUP: PluginOpSpec = {
  op: 'createGroup',
  files: ['groups'],
  parse(record) {
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'createGroup', name }
  },
  applyGroups(draft, command) {
    if (command.op !== 'createGroup') return
    const name = groupNameOf(command)
    // 重名必须在写入前拦住：同一批命令里的前一条已经进 `groups`，所以这条检查对批量
    // 新建同样成立。放过去就会在名册里留下两张同名分组，界面上无法区分。
    if (draft.groups.some((group) => group.name === name)) throw new Error(`分组名已存在：${name}`)
    draft.groups.push({ id: nextGroupId(draft.groups), name })
  },
}

const RENAME_GROUP: PluginOpSpec = {
  op: 'renameGroup',
  files: ['groups'],
  parse(record) {
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    const groupId = readNonEmpty(record, 'groupId')
    if (groupId === null) return 'groupId 必须是非空字符串'
    return { op: 'renameGroup', groupId, name }
  },
  applyGroups(draft, command) {
    if (command.op !== 'renameGroup') return
    const name = groupNameOf(command)
    if (!draft.groups.some((group) => group.id === command.groupId)) {
      throw new Error(`未知分组：${command.groupId}`)
    }
    if (draft.groups.some((group) => group.id !== command.groupId && group.name === name)) {
      throw new Error(`分组名已存在：${name}`)
    }
    draft.groups = draft.groups.map((group) => (group.id === command.groupId ? { id: group.id, name } : group))
  },
}

const DELETE_GROUP: PluginOpSpec = {
  op: 'deleteGroup',
  files: ['packs', 'groups'],
  parse(record) {
    const groupId = readNonEmpty(record, 'groupId')
    if (groupId === null) return 'groupId 必须是非空字符串'
    return { op: 'deleteGroup', groupId }
  },
  applyPacks(draft, command) {
    if (command.op !== 'deleteGroup') return
    // 组删掉后各 pack 里针对它的开关必须一起清：分组 id 会复用，留着等于让重建的新组
    // 继承旧组的决定。
    for (const [id, pack] of Object.entries(draft.packs)) {
      if (pack.groups[command.groupId] === undefined) continue
      draft.packs[id] = { ...pack, groups: setKey(pack.groups, command.groupId, null) }
    }
  },
  applyGroups(draft, command) {
    if (command.op !== 'deleteGroup') return
    if (!draft.groups.some((group) => group.id === command.groupId)) {
      throw new Error(`未知分组：${command.groupId}`)
    }
    draft.groups = draft.groups.filter((group) => group.id !== command.groupId)
    // 成员回到未分组。各 pack 残留的组开关不影响求值——孤儿 gid 不会被任何项命中。
    for (const [name, groupId] of Object.entries(draft.assignments)) {
      if (groupId === command.groupId) delete draft.assignments[name]
    }
  },
}

const SETTING_SPEC = (op: 'showOfficialPlugins' | 'showChip'): PluginOpSpec => ({
  op,
  files: ['packs'],
  parse(record) {
    const value = readBoolValue(record)
    if (typeof value === 'string') return value
    return { op, value } as Command
  },
  applyPacks(draft, command) {
    if (command.op !== op) return
    draft.ui = { ...draft.ui, [op]: command.value }
  },
})

const SHOW_OFFICIAL_PLUGINS = SETTING_SPEC('showOfficialPlugins')
const SHOW_CHIP = SETTING_SPEC('showChip')

const DEFAULT_TAB: PluginOpSpec = {
  op: 'defaultTab',
  files: ['packs'],
  parse(record) {
    const value = readTab(record)
    if (value === null) return 'value 必须是 groups、packs 或 workspace'
    return { op: 'defaultTab', value }
  },
  applyPacks(draft, command) {
    if (command.op !== 'defaultTab') return
    draft.ui = { ...draft.ui, defaultTab: command.value }
  },
}

/** op → 定义。加一个 op 只改这里与 `types.ts` 的 union。 */
export const OPS: OpTable<Command, PacksDraft, GroupsDraft, BindingsDraft> = {
  packItem: PACK_ITEM,
  packGroup: PACK_GROUP,
  createPack: CREATE_PACK,
  duplicatePack: DUPLICATE_PACK,
  renamePack: RENAME_PACK,
  deletePack: DELETE_PACK,
  bind: BIND,
  assign: ASSIGN,
  createGroup: CREATE_GROUP,
  renameGroup: RENAME_GROUP,
  deleteGroup: DELETE_GROUP,
  showOfficialPlugins: SHOW_OFFICIAL_PLUGINS,
  showChip: SHOW_CHIP,
  defaultTab: DEFAULT_TAB,
}

/**
 * 校验入站意图。宁可拒绝整批，也不要半懂地写一半。
 *
 * 骨架在 `@dreanzy/dsh-pack-core`：数组检查、空批检查、条数上限、逐条查表、
 * 错误消息拼下标。这里只把本包的表传进去。
 */
export function parseCommands(raw: unknown): { ok: true; commands: Command[] } | { ok: false; message: string } {
  return parseCommandsTable(raw, OPS)
}

/** 这批命令会碰到哪些文件。事务边界由此决定。 */
export function filesOf(commands: readonly Command[]): ReadonlySet<StoreFile> {
  return filesOfTable(commands, OPS)
}
