import { pendingKeyOf } from '@dreanzy/dsh-pack-core'
import { MAX_NAMES } from './policy.js'
import { normalizeCwd } from './policy.js'
import {
  DEFAULT_PACK_ID,
  type Bindings,
  type Command,
  type GroupRegistry,
  type McpPack,
  type RowPatch,
  type RowPolicy,
  type SettingsTab,
  type UiState,
} from './types.js'

/**
 * 一条命令的完整定义。
 *
 * 原先一个 op 在四处各声明一次：`types.ts` 的 union、`routes.ts` 的 OPS 集合与校验分支、
 * `store.ts` 的应用分支、`client.js` 的队列键。加一个 op 要同步四个文件，漏一处就是
 * 「解析得过、落不了盘」或者「落得了盘、队列不去重」。
 *
 * 现在四件事收在一格里。`client.js` 的队列键仍是复制品——浏览器半边走不了服务端模块。
 */

/** 这批命令要落到哪份文件。决定事务边界。 */
export type StoreFile = 'packs' | 'groups' | 'bindings'

/** 写 `packs.json`（含 ui 段）时的草稿。 */
export interface PacksDraft {
  packs: Record<string, McpPack>
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readNonEmpty(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function readName(record: Record<string, unknown>): string | null {
  const name = record['name']
  return typeof name === 'string' && name.trim() !== '' ? name : null
}

function readTab(record: Record<string, unknown>): SettingsTab | null {
  const value = record['value']
  if (value === 'groups' || value === 'packs' || value === 'workspace') return value
  return null
}

/** 读行级补丁：缺省的键不动，`null` 删键；出现未知类型就拒绝整批。 */
function readPatch(raw: unknown): RowPatch | string {
  const record = asRecord(raw)
  if (record === null) return 'patch 必须是对象'
  const patch: {
    enabled?: boolean | null
    mode?: RowPatch['mode']
    tools?: readonly string[] | null
    description?: string | null
  } = {}
  if ('enabled' in record) {
    const value = record['enabled']
    if (value !== null && typeof value !== 'boolean') return 'patch.enabled 必须是布尔或 null'
    patch.enabled = value
  }
  if ('mode' in record) {
    const value = record['mode']
    if (value !== null && value !== 'eager' && value !== 'dynamic' && value !== 'lazy') {
      return 'patch.mode 必须是合法模式或 null'
    }
    patch.mode = value
  }
  if ('tools' in record) {
    const value = record['tools']
    if (value !== null && !(Array.isArray(value) && value.every((item): item is string => typeof item === 'string'))) {
      return 'patch.tools 必须是字符串数组或 null'
    }
    patch.tools = value
  }
  if ('description' in record) {
    const value = record['description']
    if (value !== null && typeof value !== 'string') return 'patch.description 必须是字符串或 null'
    patch.description = value
  }
  return patch
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

function nextPackId(packs: Readonly<Record<string, McpPack>>): string {
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
function copyName(packs: Readonly<Record<string, McpPack>>, base: string): string {
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

/**
 * 深拷贝一张 pack。
 *
 * 三层都要新对象：组开关、行策略表、以及每行策略里的 `tools` 数组。少拷一层，
 * 副本与原 pack 就会共享同一个引用，改一边另一边跟着变。
 */
function clonePack(pack: McpPack): McpPack {
  const rows: Record<string, RowPolicy> = {}
  for (const [rowKey, policy] of Object.entries(pack.rows)) {
    rows[rowKey] = policy.tools === undefined ? { ...policy } : { ...policy, tools: [...policy.tools] }
  }
  return { name: pack.name, groups: { ...pack.groups }, rows }
}

/** 写侧也按读侧的上限拒绝：写得进去、读不回来是最难排查的一类问题。 */
function assertPackRoom(packs: Readonly<Record<string, McpPack>>): void {
  if (Object.keys(packs).length >= MAX_NAMES) throw new Error(`pack 已达上限 ${String(MAX_NAMES)} 个`)
}

function nextGroupId(groups: readonly { id: string }[]): string {
  const taken = new Set(groups.map((group) => group.id))
  for (let index = groups.length + 1; ; index += 1) {
    const candidate = `g${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

function groupNameOf(command: Extract<Command, { op: 'createGroup' | 'renameGroup' }>): string {
  const name = command.name.trim()
  if (name === '') throw new Error('分组名不能为空')
  return name
}

const PACK_ROW: OpSpec = {
  op: 'packRow',
  files: ['packs'],
  parse(record) {
    const packId = readNonEmpty(record, 'packId')
    if (packId === null) return 'packId 必须是非空字符串'
    const rowKey = readNonEmpty(record, 'rowKey')
    if (rowKey === null) return 'rowKey 必须是非空字符串'
    const patch = readPatch(record['patch'])
    if (typeof patch === 'string') return patch
    return { op: 'packRow', packId, rowKey, patch }
  },
  key: (command) => pendingKeyOf(command),
  applyPacks(draft, command) {
    if (command.op !== 'packRow') return
    const pack = findPack(draft.packs, command.packId)
    draft.packs[command.packId] = { ...pack, rows: applyPatch(pack.rows, command.rowKey, command.patch) }
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
    const value = record['value']
    if (value !== null && typeof value !== 'boolean') return 'value 必须是布尔或 null'
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
    draft.packs[id] = { name, groups: {}, rows: {} }
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
    const rowKey = readNonEmpty(record, 'rowKey')
    if (rowKey === null) return 'rowKey 必须是非空字符串'
    const groupId = record['groupId']
    if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) {
      return 'groupId 必须是分组 id 或 null'
    }
    return { op: 'assign', rowKey, groupId }
  },
  key: (command) => pendingKeyOf(command),
  applyGroups(draft, command) {
    if (command.op !== 'assign') return
    if (command.groupId === null) {
      delete draft.assignments[command.rowKey]
      return
    }
    if (!draft.groups.some((group) => group.id === command.groupId)) {
      throw new Error(`未知分组：${command.groupId}`)
    }
    draft.assignments[command.rowKey] = command.groupId
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
    for (const [rowKey, groupId] of Object.entries(draft.assignments)) {
      if (groupId === command.groupId) delete draft.assignments[rowKey]
    }
  },
}

const SHOW_CHIP: OpSpec = {
  op: 'showChip',
  files: ['packs'],
  parse(record) {
    const value = record['value']
    if (typeof value !== 'boolean') return 'value 必须是布尔'
    return { op: 'showChip', value }
  },
  key: () => null,
  applyPacks(draft, command) {
    if (command.op !== 'showChip') return
    draft.ui = { ...draft.ui, showChip: command.value }
  },
}

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
  packRow: PACK_ROW,
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
  showChip: SHOW_CHIP,
  defaultTab: DEFAULT_TAB,
}

/** 校验入站意图。宁可拒绝整批，也不要半懂地写一半。 */
export function parseCommands(
  raw: unknown,
): { readonly ok: true; readonly commands: readonly Command[] } | { readonly ok: false; readonly message: string } {
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
    for (const file of OPS[command.op].files) files.add(file)
  }
  return files
}
