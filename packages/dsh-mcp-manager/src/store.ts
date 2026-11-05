import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseLayer, serializeLayer } from './policy.js'
import { EMPTY_LAYER, type Command, type LayerPolicy, type Mode, type RowPolicy } from './types.js'

/** `$DSH_HOME/mcp-manager/global.json`：全局层。`home` 只给测试用。 */
export function globalPath(home?: string): string {
  if (home !== undefined) return join(home, 'global.json')
  return dshHomePath('mcp-manager', 'global.json')
}

/** `$DSH_HOME/mcp-manager/diag.json`：运行期自检快照，供排查用。 */
export function diagPath(home?: string): string {
  if (home !== undefined) return join(home, 'diag.json')
  return dshHomePath('mcp-manager', 'diag.json')
}

/** `<cwd>/.dsh/mcp-manager.json`：某个工作区的那一层。 */
export function workspacePath(cwd: string): string {
  return join(cwd, '.dsh', 'mcp-manager.json')
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
export async function transact(path: string, mutate: (current: string | undefined) => string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const current = await readText(path)
    await writeFileAtomic(path, mutate(current), { mode: 0o600, dirMode: 0o700 })
  })
}

/** 两层策略的当前值，读侧不加锁（原子 rename 保证读到完整版本）。 */
export interface Layers {
  readonly global: LayerPolicy
  readonly workspace: LayerPolicy | null
  readonly warnings: readonly string[]
}

export interface LoadOptions {
  /** 测试用：覆盖全局层目录。 */
  readonly home?: string
  /** 显式 cwd；null 表示只读全局层。 */
  readonly cwd: string | null
}

export async function loadLayers(options: LoadOptions): Promise<Layers> {
  const warnings: string[] = []
  const globalParsed = parseLayer(await readText(globalPath(options.home)))
  warnings.push(...globalParsed.warnings)

  let workspace: LayerPolicy | null = null
  if (options.cwd !== null && options.cwd !== '') {
    const workspaceParsed = parseLayer(await readText(workspacePath(options.cwd)))
    warnings.push(...workspaceParsed.warnings)
    workspace = workspaceParsed.value
  }
  return { global: globalParsed.value, workspace, warnings }
}

function setKey(rows: Record<string, RowPolicy>, rowKey: string, key: 'enabled' | 'mode' | 'tools' | 'description', value: unknown): void {
  const current = rows[rowKey] ?? {}
  const next: { enabled?: boolean; mode?: Mode; tools?: readonly string[]; description?: string } = { ...current }
  if (value === null) delete next[key]
  else (next as Record<string, unknown>)[key] = value
  // 三个字段全空等于「跟随」：整条删掉，别留下一个空对象冒充覆盖。
  if (Object.keys(next).length === 0) delete rows[rowKey]
  else rows[rowKey] = next
}

function applyTo(current: string | undefined, commands: readonly Command[], global: boolean): string {
  const parsed = parseLayer(current).value
  const rows: Record<string, RowPolicy> = { ...parsed.rows }
  let settings = parsed.settings
  for (const command of commands) {
    if (command.op === 'showSidebarEntry') {
      settings = { showSidebarEntry: command.value }
      continue
    }
    setKey(rows, command.rowKey, command.op, command.value)
  }
  // settings 只写进全局层：工作区层写它就是噪声。
  return serializeLayer({ version: 1, rows, settings }, { settings: global })
}

/**
 * 应用一批意图并返回写入后的两层状态。
 *
 * 不比对版本：命令是绝对状态，幂等、可交换，写同一键即后点者赢。
 * 加锁顺序固定（全局 → 工作区），避免两个工作区并发写交叉等待。
 */
export async function applyCommands(options: LoadOptions, commands: readonly Command[]): Promise<Layers> {
  const globalCommands = commands.filter((command) => command.layer === 'global')
  const workspaceCommands = commands.filter((command) => command.layer === 'workspace')

  if (globalCommands.length > 0) {
    await transact(globalPath(options.home), (current) => applyTo(current, globalCommands, true))
  }
  if (workspaceCommands.length > 0) {
    if (options.cwd === null || options.cwd === '') throw new Error('工作区命令缺少工作目录')
    await transact(workspacePath(options.cwd), (current) => applyTo(current, workspaceCommands, false))
  }
  return await loadLayers(options)
}

/** 未落盘时的空状态。 */
export function emptyLayers(): Layers {
  return { global: EMPTY_LAYER, workspace: null, warnings: [] }
}