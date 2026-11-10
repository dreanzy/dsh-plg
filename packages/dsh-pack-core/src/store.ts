import { readFile } from 'node:fs/promises'
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
