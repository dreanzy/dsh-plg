import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 宿主对 `serverName` 的约束，逐字复刻：超出它的名字无法挂载。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u

/** 一台托管 server 的定义。形状与宿主 `dsh-mcp-client` 的 Config 对齐。 */
export type ServerDef =
  | {
      readonly transport: 'stdio'
      readonly command: string
      readonly args: readonly string[]
      readonly env: Readonly<Record<string, string>>
      readonly cwd: string
    }
  | {
      readonly transport: 'streamable-http'
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }

/** 托管定义文件的内容。键是 `serverName`。 */
export interface OwnedServers {
  readonly version: 1
  readonly servers: Readonly<Record<string, ServerDef>>
}

export const EMPTY_OWNED: OwnedServers = { version: 1, servers: {} }

/** `$DSH_HOME/packs/mcp/servers.json`。`home` 只给测试用。 */
export function serversPath(home?: string): string {
  if (home !== undefined) return join(home, 'servers.json')
  return dshHomePath('packs', 'mcp', 'servers.json')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value)
  if (record === null) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** 读一台定义；形状不完整返回 null，不猜。 */
export function parseServerDef(raw: unknown): ServerDef | null {
  const record = asRecord(raw)
  if (record === null) return null
  if (record['transport'] === 'stdio') {
    const command = record['command']
    if (typeof command !== 'string' || command.trim() === '') return null
    return {
      transport: 'stdio',
      command: command.trim(),
      args: stringList(record['args']),
      env: stringRecord(record['env']),
      cwd: typeof record['cwd'] === 'string' ? record['cwd'] : '',
    }
  }
  if (record['transport'] === 'streamable-http') {
    const url = record['url']
    if (typeof url !== 'string' || url.trim() === '') return null
    try {
      // 早失败：挂载时才发现 URL 非法，错误会混在启动日志里。
      void new URL(url)
    } catch {
      return null
    }
    return { transport: 'streamable-http', url: url.trim(), headers: stringRecord(record['headers']) }
  }
  return null
}

/**
 * 解析托管定义文件。
 *
 * 与策略文件同一套原则：坏数据降级成空表并给 warning，一个手误不该让面板消失。
 */
export function parseOwned(text: string | undefined): { readonly value: OwnedServers; readonly warnings: readonly string[] } {
  if (text === undefined || text.trim() === '') return { value: EMPTY_OWNED, warnings: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { value: EMPTY_OWNED, warnings: [`托管定义不是合法 JSON：${String(error)}`] }
  }
  const record = asRecord(parsed)
  if (record === null || record['version'] !== 1) {
    return { value: EMPTY_OWNED, warnings: ['托管定义版本不认识'] }
  }
  const raw = asRecord(record['servers'])
  if (raw === null) return { value: EMPTY_OWNED, warnings: ['托管定义缺少 servers 对象'] }

  const warnings: string[] = []
  const servers: Record<string, ServerDef> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      warnings.push(`忽略 ${name}：名字不符合 ${String(SERVER_NAME_PATTERN)}`)
      continue
    }
    const parsedServer = parseServerDef(value)
    if (parsedServer === null) {
      warnings.push(`忽略 ${name}：定义不完整`)
      continue
    }
    servers[name] = parsedServer
  }
  return { value: { version: 1, servers }, warnings }
}

/** 序列化：名字排序、字段固定，便于人工审阅与 diff。 */
export function serializeOwned(owned: OwnedServers): string {
  const servers: Record<string, unknown> = {}
  for (const name of Object.keys(owned.servers).sort((left, right) => left.localeCompare(right))) {
    const def = owned.servers[name]
    if (def === undefined) continue
    if (def.transport === 'stdio') {
      servers[name] = {
        transport: 'stdio',
        command: def.command,
        args: def.args,
        ...(Object.keys(def.env).length === 0 ? {} : { env: def.env }),
        ...(def.cwd === '' ? {} : { cwd: def.cwd }),
      }
      continue
    }
    servers[name] = {
      transport: 'streamable-http',
      url: def.url,
      ...(Object.keys(def.headers).length === 0 ? {} : { headers: def.headers }),
    }
  }
  return JSON.stringify({ version: 1, servers }, null, 2) + '\n'
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

/** 读当前托管定义。读侧不加锁：原子写保证读到的是完整版本。 */
export async function readOwned(home?: string): Promise<{ readonly value: OwnedServers; readonly warnings: readonly string[] }> {
  return parseOwned(await readText(serversPath(home)))
}

/**
 * 改一次托管定义：建目录 → 拿锁 → 读 → 改 → 原子写。
 *
 * 与策略写入同一套事务形状（先建父目录，再拿锁）。
 */
export async function updateOwned(
  home: string | undefined,
  mutate: (current: OwnedServers) => OwnedServers,
): Promise<OwnedServers> {
  const path = serversPath(home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let next: OwnedServers = EMPTY_OWNED
  await withFileLock(path, async () => {
    const current = (await readOwned(home)).value
    next = mutate(current)
    await writeFileAtomic(path, serializeOwned(next), { mode: 0o600, dirMode: 0o700 })
  })
  return next
}

/** 新增或覆盖一台。 */
export function upsertServer(owned: OwnedServers, name: string, def: ServerDef): OwnedServers {
  if (!SERVER_NAME_PATTERN.test(name)) throw new Error(`serverName 不合法：${name}`)
  return { version: 1, servers: { ...owned.servers, [name]: def } }
}

/** 删除一台；不存在是幂等的。 */
export function removeServer(owned: OwnedServers, name: string): OwnedServers {
  const servers = { ...owned.servers }
  delete servers[name]
  return { version: 1, servers }
}
