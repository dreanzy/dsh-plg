import { pendingKeyOf } from '@dreanzy/dsh-pack-core'
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
 * 一条命令的完整定义。
 *
 * 一个 op 原先在四处各声明一次：`types.ts` 的 union、`routes.ts` 的 OPS 集合与校验分支、
 * `store.ts` 的应用分支、`client.js` 的队列键。加一个 op 要同步四个文件，漏一处就是
 * 「解析得过、落不了盘」或者「落得了盘、队列不去重」。
 *
 * 现在四件事收在一格里。`client.js` 的队列键仍是一份复制品——浏览器半边走不了服务端
 * 模块，它只能由构建期从这张表生成，那一步还没做。
 */

/** 这批命令要落到哪份文件。决定事务边界。 */
export type StoreFile = 'packs' | 'groups' | 'bindings'

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

export interface OpSpec {
  readonly op: Command['op']
  readonly files: readonly StoreFile[]
  /** 校验一条入站记录；不合法时返回一句人话（调用方会拼上 commands[i]）。 */
  parse(record: Record<string, unknown>): Command | string
  /** 待保存队列的去重键；`null` 表示没有可覆盖的目标，每条都独立。 */
  key(command: Command): string | null
  applyPacks?(draft: PacksDraft, command: Command): void
  applyGroups?(draft: GroupsDraft, command: Command): void
  /** 绑定合法性只能在 pack 写完之后判：同一批命令里可能刚建或刚删了 pack。 */
  applyBindings?(draft: BindingsDraft, command: Command, knownPacks: ReadonlySet<string>): void
}

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
  if (value === null) delete next[key]
  else next[key] = value
  return next
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

const PACK_ITEM: OpSpec = {
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
  key: (command) => pendingKeyOf(command),
  applyPacks(draft, command) {
    if (command.op !== 'packItem') return
    const pack = findPack(draft.packs, command.packId)
    draft.packs[command.packId] = { ...pack, items: setKey(pack.items, command.name, command.value) }
  },
}

const PACK_GROUP: OpSpec = {
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
  key: (command) => pendingKeyOf(command),
  applyPacks(draft, command) {
    if (command.op !== 'packGroup') return
    const pack = findPack(draft.packs, command.packId)
    draft.packs[command.packId] = { ...pack, groups: setKey(pack.groups, command.groupId, command.value) }
  },
}

const CREATE_PACK: OpSpec = {
  op: 'createPack',
  files: ['packs'],
  parse(record) {
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'createPack', name }
  },
  key: () => null,
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
const DUPLICATE_PACK: OpSpec = {
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
  key: () => null,
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

const RENAME_PACK: OpSpec = {
  op: 'renamePack',
  files: ['packs'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'renamePack', packId, name }
  },
  key: (command) => pendingKeyOf(command),
  applyPacks(draft, command) {
    if (command.op !== 'renamePack') return
    if (command.packId === DEFAULT_PACK_ID) throw new Error('默认 pack 不可改名')
    const pack = findPack(draft.packs, command.packId)
    const name = requireName(command.name)
    assertNameFree(draft.packs, name, command.packId)
    draft.packs[command.packId] = { ...pack, name }
  },
}

const DELETE_PACK: OpSpec = {
  op: 'deletePack',
  files: ['packs', 'bindings'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    return { op: 'deletePack', packId }
  },
  key: () => null,
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

const BIND: OpSpec = {
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
  key: (command) => pendingKeyOf(command),
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

const ASSIGN: OpSpec = {
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
  key: (command) => pendingKeyOf(command),
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

const CREATE_GROUP: OpSpec = {
  op: 'createGroup',
  files: ['groups'],
  parse(record) {
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    return { op: 'createGroup', name }
  },
  key: () => null,
  applyGroups(draft, command) {
    if (command.op !== 'createGroup') return
    const name = groupNameOf(command)
    // 重名必须在写入前拦住：同一批命令里的前一条已经进 `groups`，所以这条检查对批量
    // 新建同样成立。放过去就会在名册里留下两张同名分组，界面上无法区分。
    if (draft.groups.some((group) => group.name === name)) throw new Error(`分组名已存在：${name}`)
    draft.groups.push({ id: nextGroupId(draft.groups), name })
  },
}

const RENAME_GROUP: OpSpec = {
  op: 'renameGroup',
  files: ['groups'],
  parse(record) {
    const name = readName(record)
    if (name === null) return 'name 必须是非空字符串'
    const groupId = readNonEmpty(record, 'groupId')
    if (groupId === null) return 'groupId 必须是非空字符串'
    return { op: 'renameGroup', groupId, name }
  },
  key: (command) => pendingKeyOf(command),
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

const DELETE_GROUP: OpSpec = {
  op: 'deleteGroup',
  files: ['packs', 'groups'],
  parse(record) {
    const groupId = readNonEmpty(record, 'groupId')
    if (groupId === null) return 'groupId 必须是非空字符串'
    return { op: 'deleteGroup', groupId }
  },
  key: () => null,
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

const SETTING_SPEC = (op: 'showOfficialSkills' | 'showChip'): OpSpec => ({
  op,
  files: ['packs'],
  parse(record) {
    const value = readBoolValue(record)
    if (typeof value === 'string') return value
    return { op, value } as Command
  },
  key: () => null,
  applyPacks(draft, command) {
    if (command.op !== op) return
    draft.ui = { ...draft.ui, [op]: command.value }
  },
})

const SHOW_OFFICIAL_PLUGINS = SETTING_SPEC('showOfficialSkills')
const SHOW_CHIP = SETTING_SPEC('showChip')

const DEFAULT_TAB: OpSpec = {
  op: 'defaultTab',
  files: ['packs'],
  parse(record) {
    const value = readTab(record)
    if (value === null) return 'value 必须是 groups、packs 或 workspace'
    return { op: 'defaultTab', value }
  },
  key: () => null,
  applyPacks(draft, command) {
    if (command.op !== 'defaultTab') return
    draft.ui = { ...draft.ui, defaultTab: command.value }
  },
}

/** op → 定义。加一个 op 只改这里与 `types.ts` 的 union。 */
export const OPS: Readonly<Record<Command['op'], OpSpec>> = {
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
  showOfficialSkills: SHOW_OFFICIAL_PLUGINS,
  showChip: SHOW_CHIP,
  defaultTab: DEFAULT_TAB,
}

/**
 * 校验入站意图。宁可拒绝整批，也不要半懂地写一半。
 *
 * 分派与校验都来自 `OPS`：校验器里不再有第二个开关，加 op 时也不会出现「表里加了、
 * 开关里忘了」这种半通状态。
 */
export function parseCommands(raw: unknown): { ok: true; commands: Command[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }
  const commands: Command[] = []
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    if (record === null) return { ok: false, message: `commands[${String(index)}] 不是对象` }
    const op = record['op']
    if (typeof op !== 'string') return { ok: false, message: `commands[${String(index)}] op 不是已知操作` }
    const spec = (OPS as Record<string, OpSpec | undefined>)[op]
    if (spec === undefined) return { ok: false, message: `commands[${String(index)}] op 不是已知操作` }
    const parsed = spec.parse(record)
    if (typeof parsed === 'string') return { ok: false, message: `commands[${String(index)}] ${parsed}` }
    commands.push(parsed)
  }
  return { ok: true, commands }
}

/** 这批命令会碰到哪些文件。事务边界由此决定。 */
export function filesOf(commands: readonly Command[]): ReadonlySet<StoreFile> {
  const files = new Set<StoreFile>()
  for (const command of commands) {
    const spec = OPS[command.op]
    for (const file of spec.files) files.add(file)
  }
  return files
}
