/**
 * 本包的命令定义。
 *
 * 骨架（`op` / `files` / `parse` 的调用约定）在 `@dreanzy/dsh-pack-core`；
 * 这里只把三个草稿类型绑到本包的形状上。
 *
 * 与另外三个 manager 的差别：model 的 `applyTo*` 是「一次遍历处理整批」，而
 * `OpSpec.apply*` 是「一条命令一次」。表里只放 `parse` 与 `files`——批处理语义
 * 留在 `policy.ts` 的自由函数里，不强行套进单条命令的接口。
 */

import type { OpSpec, OpTable } from '@dreanzy/dsh-pack-core'
import type { PackCommand, PromptTierPatch } from './policy.js'
import type { PromptTierOverride, TierId, UiState } from './pack.js'

/** 写 `packs.json`（含 ui 段）时的草稿。 */
export interface PacksDraft {
  packs: Record<string, unknown>
  ui: UiState
}

/** 写 `prompts.json` 时的草稿。 */
export interface PromptsDraft {
  delegation: string | undefined
  tiers: Partial<Record<TierId, PromptTierOverride>>
}

/** 写 `workspaces.json` 时的草稿；`changed` 决定要不要真建文件。 */
export interface BindingsDraft {
  bindings: Record<string, string>
  changed: boolean
}

export type ModelOpSpec = OpSpec<PackCommand, PacksDraft, PromptsDraft, BindingsDraft>

/** 与 `pack.ts` 的 `TIER_IDS` / `PROMPT_KEYS` 逐字一致；本层刻意不 import 那份类型。 */
const TIER_IDS: readonly string[] = ['tier1', 'tier2', 'tier3', 'tier4']
const PROMPT_TIER_IDS: readonly string[] = [...TIER_IDS]
const PROMPT_KEYS: readonly string[] = ['delegation', ...PROMPT_TIER_IDS]
const PROMPT_TIER_FIELDS: readonly ('label' | 'text')[] = ['label', 'text']

/**
 * 提示词覆盖字段的字符上限。
 *
 * 这份文本进系统提示词，每次模型请求都完整发送。内置文本的预算断言只测内置值，
 * 用户覆盖必须单独设限，否则一次误粘贴就是 MB 级提示词。
 */
const MAX_PROMPT_CHARS = 8000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 覆盖段的一个字段：`null` 删键（= 恢复内置），空串与纯空白一律拒绝。 */
function readPromptField(
  value: unknown,
  at: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: at + ' 必须是非空字符串或 null' }
  if (value.trim() === '') return { ok: false, message: at + ' 不能为空串：恢复内置请用 null 或 resetPrompts' }
  if (value.length > MAX_PROMPT_CHARS) return { ok: false, message: at + ' 超过 ' + String(MAX_PROMPT_CHARS) + ' 字符' }
  return { ok: true, value }
}

function readId(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  // 返回 trim 后的值：putPack 自己 trim，其余命令直接用 packs[packId]，
  // 不 trim 会让「保存 pack 内容成功、改会话路由报不存在」。
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 字段级错误：`packId 必须是非空字符串`。调用方会拼上 `commands[i]`。 */
function fieldError(field: string, message: string): string {
  return field + ' ' + message
}

const CREATE_PACK: ModelOpSpec = {
  op: 'createPack',
  files: ['packs'],
  parse(record) {
    const name = record['name']
    if (typeof name !== 'string' || name.trim() === '') return fieldError('name', '必须是非空字符串')
    return { op: 'createPack', name }
  },
}

const DUPLICATE_PACK: ModelOpSpec = {
  op: 'duplicatePack',
  files: ['packs'],
  parse(record) {
    const packId = readId(record, 'packId')
    if (packId === null) return fieldError('packId', '必须是非空字符串')
    // name 可省：省了由服务端按「原名 + 序号」生成，面板走的就是这条路。
    const name = record['name']
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
      return fieldError('name', '必须是非空字符串')
    }
    return name === undefined ? { op: 'duplicatePack', packId } : { op: 'duplicatePack', packId, name }
  },
}

const RENAME_PACK: ModelOpSpec = {
  op: 'renamePack',
  files: ['packs'],
  parse(record) {
    const packId = readId(record, 'packId')
    if (packId === null) return fieldError('packId', '必须是非空字符串')
    const name = record['name']
    if (typeof name !== 'string' || name.trim() === '') return fieldError('name', '必须是非空字符串')
    return { op: 'renamePack', packId, name }
  },
}

const DELETE_PACK: ModelOpSpec = {
  op: 'deletePack',
  // 删除 pack 还要清绑定：一条命令命中两个文件。
  files: ['packs', 'bindings'],
  parse(record) {
    const packId = readId(record, 'packId')
    if (packId === null) return fieldError('packId', '必须是非空字符串')
    return { op: 'deletePack', packId }
  },
}

const PUT_PACK: ModelOpSpec = {
  op: 'putPack',
  files: ['packs'],
  parse(record) {
    const packId = readId(record, 'packId')
    if (packId === null) return fieldError('packId', '必须是非空字符串')
    const pack = record['pack']
    if (!isRecord(pack)) return fieldError('pack', '必须是对象')
    return { op: 'putPack', packId, pack }
  },
}

const PACK_SESSION: ModelOpSpec = {
  op: 'packSession',
  files: ['packs'],
  parse(record) {
    const packId = readId(record, 'packId')
    if (packId === null) return fieldError('packId', '必须是非空字符串')
    const session = record['session']
    if (session !== null && !isRecord(session)) return fieldError('session', '必须是对象或 null')
    return { op: 'packSession', packId, session }
  },
}

const PACK_TIER: ModelOpSpec = {
  op: 'packTier',
  files: ['packs'],
  parse(record) {
    const packId = readId(record, 'packId')
    if (packId === null) return fieldError('packId', '必须是非空字符串')
    const tierId = record['tierId']
    if (typeof tierId !== 'string' || !TIER_IDS.includes(tierId)) {
      return fieldError('tierId', '必须是 ' + TIER_IDS.join(' / ') + ' 之一')
    }
    const tier = record['tier']
    if (tier !== null && !isRecord(tier)) return fieldError('tier', '必须是对象或 null')
    return { op: 'packTier', packId, tierId, tier }
  },
}

const BIND: ModelOpSpec = {
  op: 'bind',
  files: ['bindings'],
  parse(record) {
    const cwd = record['cwd']
    if (typeof cwd !== 'string' || cwd.trim() === '') return fieldError('cwd', '必须是非空字符串')
    const packId = record['packId']
    // trim 后判空：纯空白会落成永久悬空绑定，面板显示一条无法解读的「绑定失效」。
    if (packId !== null && (typeof packId !== 'string' || packId.trim() === '')) {
      return fieldError('packId', '必须是 pack id 或 null')
    }
    return { op: 'bind', cwd, packId }
  },
}

const SHOW_CHIP: ModelOpSpec = {
  op: 'showChip',
  files: ['packs'],
  parse(record) {
    const value = record['value']
    if (typeof value !== 'boolean') return fieldError('value', '必须是布尔')
    return { op: 'showChip', value }
  },
}

const DEFAULT_TAB: ModelOpSpec = {
  op: 'defaultTab',
  files: ['packs'],
  parse(record) {
    const value = record['value']
    if (value !== 'packs' && value !== 'workspace' && value !== 'prompts') {
      return fieldError('value', '必须是 packs、workspace 或 prompts')
    }
    return { op: 'defaultTab', value }
  },
}

const PUT_PROMPTS: ModelOpSpec = {
  op: 'putPrompts',
  files: ['prompts'],
  parse(record) {
    const hasDelegation = Object.hasOwn(record, 'delegation')
    const hasTiers = Object.hasOwn(record, 'tiers')
    if (!hasDelegation && !hasTiers) return '至少需要 delegation 或 tiers 之一'
    const command: {
      op: 'putPrompts'
      delegation?: string | null
      tiers?: Record<string, PromptTierPatch | null>
    } = { op: 'putPrompts' }
    if (hasDelegation) {
      const field = readPromptField(record['delegation'], 'delegation')
      if (!field.ok) return field.message
      command.delegation = field.value
    }
    if (hasTiers) {
      const tiersRaw = record['tiers']
      if (!isRecord(tiersRaw)) return fieldError('tiers', '必须是对象')
      const tiers: Record<string, PromptTierPatch | null> = {}
      for (const [key, value] of Object.entries(tiersRaw)) {
        if (!PROMPT_TIER_IDS.includes(key)) return fieldError('tiers', '有不存在的档 id「' + key + '」')
        if (value === null) {
          tiers[key] = null
          continue
        }
        if (!isRecord(value)) return fieldError('tiers.' + key, '必须是对象或 null')
        const patch: { label?: string | null; text?: string | null } = {}
        for (const field of PROMPT_TIER_FIELDS) {
          if (!Object.hasOwn(value, field)) continue
          const parsedField = readPromptField(value[field], 'tiers.' + key + '.' + field)
          if (!parsedField.ok) return parsedField.message
          patch[field] = parsedField.value
        }
        tiers[key] = patch
      }
      command.tiers = tiers
    }
    return command
  },
}

const RESET_PROMPTS: ModelOpSpec = {
  op: 'resetPrompts',
  files: ['prompts'],
  parse(record) {
    const keysRaw = record['keys']
    if (keysRaw === undefined || keysRaw === null) return { op: 'resetPrompts' }
    if (!Array.isArray(keysRaw)) return fieldError('keys', '必须是字符串数组')
    if (keysRaw.length === 0) return fieldError('keys', '不能为空数组：省略即全部恢复内置')
    const keys: string[] = []
    for (const [position, value] of keysRaw.entries()) {
      if (typeof value !== 'string') return fieldError('keys[' + String(position) + ']', '必须是字符串')
      const key = value.trim()
      if (!PROMPT_KEYS.includes(key)) {
        return fieldError('keys[' + String(position) + ']', '不是已知的键「' + value + '」')
      }
      keys.push(key)
    }
    return { op: 'resetPrompts', keys }
  },
}

/** op → 定义。加一个 op 只改这里与 `pack.ts` 的 union。 */
export const OPS: OpTable<PackCommand, PacksDraft, PromptsDraft, BindingsDraft> = {
  putPack: PUT_PACK,
  packSession: PACK_SESSION,
  packTier: PACK_TIER,
  createPack: CREATE_PACK,
  duplicatePack: DUPLICATE_PACK,
  renamePack: RENAME_PACK,
  deletePack: DELETE_PACK,
  bind: BIND,
  showChip: SHOW_CHIP,
  defaultTab: DEFAULT_TAB,
  putPrompts: PUT_PROMPTS,
  resetPrompts: RESET_PROMPTS,
}
