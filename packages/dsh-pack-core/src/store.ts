import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * 一份插件的三份状态文件。
 *
 * 路径一律走 `dshHomePath`，不自己拼 `$DSH_HOME` 前缀：宿主允许用环境变量或显式配置
 * 改根目录，自己拼会绕开它。包名只在这里出现一次，避免四个包里各拼一次、拼错一个字母
 * 就把状态落到别人的目录。
 */
export interface StorePaths {
  readonly id: string
  /** 任意状态文件：`<DSH_HOME>/packs/<id>/<name>`。 */
  file(name: string): string
  packs(): string
  groups(): string
  workspaces(): string
}

export function storePaths(id: string): StorePaths {
  const file = (name: string): string => dshHomePath('packs', id, name)
  return {
    id,
    file,
    packs: () => file('packs.json'),
    groups: () => file('groups.json'),
    workspaces: () => file('workspaces.json'),
  }
}

/** 读一份文本；文件不存在返回 `undefined`，其余错误照旧抛。 */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 一次写事务的结论。
 *
 * `ok: true` 且 `next: null` 表示这一批命令对这份文件没有实际改变——不落盘，也不凭空
 * 建一个空文件。`ok: false` 带原因，由调用方决定怎么记：skill 塞进 warnings 继续写
 * 下一个文件，plugin 停下这一批，mcp 抛成异常，model 聚合成 `written`。
 *
 * 骨架不碰 warnings：那是各包的视图状态字段，措辞与去重规则都不一样。
 */
export type TransactResult =
  | { readonly ok: true; readonly next: string | null }
  | { readonly ok: false; readonly reason: string }

/**
 * 这份文本还能被安全改写吗。`null` 表示可以。
 *
 * 只判最松的一档：JSON 合法 + 顶层是对象。空文件算可写——它表示「还没有任何决定」，
 * 不是「读不懂」。字段级校验是各包的领域知识（plugin 知道 `packs.items` 的值必须是
 * 布尔），留在包里，在 `mutate` 之前自己再查一遍。
 *
 * 读侧把坏文件降级成空名册，那只适合读；写侧若照此序列化回去，一次保存就会拿空名册
 * 覆盖掉用户的全部决定，且这种损失在界面上无从挽回。
 */
export function writableReason(text: string | undefined): string | null {
  if (text === undefined || text.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return '不是合法 JSON'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '顶层不是对象'
  return null
}

/**
 * 一次写事务：建父目录 → 拿跨进程锁 → 读 → 判 → 改 → 原子覆盖写。
 *
 * 父目录必须在拿锁之前建好：`withFileLock` 用 `wx` 直接建 `<file>.lock`，它不会建
 * 父目录。`writeFileAtomic` 自己会 mkdir，但那是拿锁之后的事。
 *
 * 失败一律走返回值，不抛：`mkdir` 失败、拿锁失败、读失败、内容坏、`mutate` 抛错、
 * 落盘失败，对调用方都是同一件事——这份文件没写成。
 */
export async function transact(
  path: string,
  label: string,
  mutate: (current: string | undefined) => string | null,
): Promise<TransactResult> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    return { ok: false, reason: `${label} 无法创建所在目录：${String(error)}` }
  }

  let result: TransactResult = { ok: true, next: null }
  try {
    await withFileLock(path, async () => {
      let current: string | undefined
      try {
        current = await readText(path)
      } catch (error) {
        // 读不出来就不知道现有内容，照着想象中的空策略写下去等于清空。
        result = { ok: false, reason: `${label} 读取失败，本次未写入：${String(error)}` }
        return
      }
      const broken = writableReason(current)
      if (broken !== null) {
        result = { ok: false, reason: `${label} ${broken}，已拒写以免覆盖` }
        return
      }
      let next: string | null
      try {
        next = mutate(current)
      } catch (error) {
        // 命令本身不合法（未知 pack、默认 pack 不可删）：整批不写，与「写一半」相比更容易解释。
        result = { ok: false, reason: `${label} 未写入：${String(error)}` }
        return
      }
      if (next === null) return
      await writeFileAtomic(path, next, { mode: 0o600, dirMode: 0o700 })
      result = { ok: true, next }
    })
  } catch (error) {
    // 拿锁或落盘失败：目录只读、锁被占着、磁盘满。
    return { ok: false, reason: `${label} 写入失败：${String(error)}` }
  }
  return result
}

/**
 * 读 → 判 → 改 → 返回文本，不写盘。
 *
 * 与 `transact` 是同一个 module 的两个 adapter：三步完全一样，只有最后一步不同。
 * 试算若跳过前置判定，坏文件上会产出一个「全部重置」的假视图，而真写拒绝——面板
 * 预览显示一个永远不会发生的状态。
 */
export async function previewText(
  path: string,
  label: string,
  mutate: (current: string | undefined) => string | null,
): Promise<TransactResult> {
  let current: string | undefined
  try {
    current = await readText(path)
  } catch (error) {
    return { ok: false, reason: `${label} 读取失败，试算已跳过：${String(error)}` }
  }
  const broken = writableReason(current)
  if (broken !== null) return { ok: false, reason: `${label} ${broken}，试算已跳过` }
  try {
    return { ok: true, next: mutate(current) }
  } catch (error) {
    return { ok: false, reason: `${label} 更新失败：${String(error)}` }
  }
}
