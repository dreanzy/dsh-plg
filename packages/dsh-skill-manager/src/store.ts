import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  parseGlobal,
  parseGroups,
  parseLayer,
  serializeGlobal,
  serializeGroups,
  serializeLayer,
} from './policy.js'
import {
  EMPTY_GLOBAL,
  EMPTY_GROUPS,
  type Command,
  type GlobalPolicy,
  type GroupRegistry,
  type LayerPolicy,
} from './types.js'

/** `$DSH_HOME/skill-manager/global.json`：全局层，所有工作区的默认值。 */
export function globalPath(): string {
  return dshHomePath('skill-manager', 'global.json')
}

/** `$DSH_HOME/skill-manager/groups.json`：组定义，跨工作区共享。 */
export function groupsPath(): string {
  return dshHomePath('skill-manager', 'groups.json')
}

/** `<cwd>/.dsh/skill-manager.json`：某个工作区的那一层。 */
export function workspacePath(cwd: string): string {
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
async function transact(path: string, mutate: (current: string | undefined) => string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const current = await readText(path)
    await writeFileAtomic(path, mutate(current), { mode: 0o600, dirMode: 0o700 })
  })
}

function setKey(map: Record<string, boolean>, key: string, value: boolean | null): Record<string, boolean> {
  const next = { ...map }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

function applyToGlobal(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parseGlobal(current).value
  let { items, groups, showOfficialSkills, showSidebarEntry } = parsed
  for (const command of commands) {
    if (command.op === 'item' && command.layer === 'global') {
      items = setKey(items, command.name, command.value)
    } else if (command.op === 'group' && command.layer === 'global') {
      groups = setKey(groups, command.groupId, command.value)
    } else if (command.op === 'showOfficialSkills') {
      showOfficialSkills = command.value
    } else if (command.op === 'showSidebarEntry') {
      showSidebarEntry = command.value
    }
  }
  return serializeGlobal({ items, groups, showOfficialSkills, showSidebarEntry })
}

function applyToWorkspace(current: string | undefined, commands: readonly Command[]): string {
  const parsed = parseLayer(current).value
  let { items, groups } = parsed
  for (const command of commands) {
    if (command.op === 'item' && command.layer === 'workspace') {
      items = setKey(items, command.name, command.value)
    } else if (command.op === 'group' && command.layer === 'workspace') {
      groups = setKey(groups, command.groupId, command.value)
    }
  }
  return serializeLayer({ items, groups })
}

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
      groups = groups.map((group) => (group.id === command.groupId ? { id: group.id, name } : group))
      continue
    }
    if (command.op === 'deleteGroup') {
      if (!known().has(command.groupId)) throw new Error(`未知分组：${command.groupId}`)
      groups = groups.filter((group) => group.id !== command.groupId)
      // 成员回到未分组。各层残留的组开关决定保留：组重建后语义不恢复（id 已变），
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
    const candidate = `g${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/** 当前完整状态，读侧不加锁（原子 rename 保证读到的是完整版本）。 */
export interface PolicyState {
  readonly global: GlobalPolicy
  readonly workspace: LayerPolicy | null
  readonly groups: GroupRegistry
  readonly warnings: readonly string[]
}

export async function loadState(cwd: string | null): Promise<PolicyState> {
  const warnings: string[] = []
  const globalText = await readText(globalPath())
  const globalParsed = parseGlobal(globalText)
  warnings.push(...globalParsed.warnings)

  const groupsParsed = parseGroups(await readText(groupsPath()))
  warnings.push(...groupsParsed.warnings)

  let workspace: LayerPolicy | null = null
  if (cwd !== null && cwd !== '') {
    const workspaceParsed = parseLayer(await readText(workspacePath(cwd)))
    warnings.push(...workspaceParsed.warnings)
    workspace = workspaceParsed.value
  }

  return { global: globalParsed.value, workspace, groups: groupsParsed.value, warnings }
}

function targets(cwd: string | null, commands: readonly Command[]) {
  let global = false
  let workspace = false
  let groups = false
  for (const command of commands) {
    if (command.op === 'showOfficialSkills') global = true
    else if (
      command.op === 'assign' ||
      command.op === 'createGroup' ||
      command.op === 'renameGroup' ||
      command.op === 'deleteGroup'
    ) {
      groups = true
    } else if (command.op === 'showSidebarEntry') {
      global = true
    } else if (command.layer === 'global') {
      global = true
    } else {
      if (cwd === null || cwd === '') throw new Error('工作区命令缺少工作目录')
      workspace = true
    }
  }
  return { global, workspace, groups }
}

/**
 * 应用一批意图并返回写入后的完整状态。
 *
 * 不比对任何版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 三个文件各自一把锁，固定顺序（全局 → 工作区 → 组定义）避免交叉等待。
 */
export async function applyCommands(cwd: string | null, commands: readonly Command[]): Promise<PolicyState> {
  const plan = targets(cwd, commands)

  if (plan.global) {
    await transact(globalPath(), (current) => applyToGlobal(current, commands))
  }
  if (plan.workspace && cwd !== null) {
    await transact(workspacePath(cwd), (current) => applyToWorkspace(current, commands))
  }
  if (plan.groups) {
    await transact(groupsPath(), (current) => applyToGroups(current, commands))
  }

  return await loadState(cwd)
}

/** 未落盘时的空状态，供读取失败的降级路径使用。 */
export function emptyState(): PolicyState {
  return { global: EMPTY_GLOBAL, workspace: null, groups: EMPTY_GROUPS, warnings: [] }
}
