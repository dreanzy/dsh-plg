/**
 * 命令协议的骨架。
 *
 * 一个 op 原先在四处各声明一次：`types.ts` 的 union、`routes.ts` 的校验分支、
 * `store.ts` 的应用分支、`client.js` 的队列键。加一个 op 要同步四个文件，漏一处就是
 * 「解析得过、落不了盘」或者「落得了盘、队列不去重」。
 *
 * 这里只收**跨包相同的协议事实**：op 名、落点文件、条数上限、解析骨架。`parse` 与
 * `apply*` 是各包的领域逻辑（skill 的 `packItem` 改 `items`，mcp 的 `packRow` 改
 * `rows`），由各包提供 adapter。
 */

/** 这批命令要落到哪份文件。决定事务边界。 */
export type StoreFile = 'packs' | 'groups' | 'bindings' | 'prompts'

/**
 * 一批命令的条数上限。
 *
 * `applyToPacks` 对每条命令复制一次整张 items 表，N 条命令是 O(N²)：实测 2 万条
 * 要跑 70 秒并阻塞宿主主线程（所有会话的流式输出一起停摆）。正常 UI 操作最多几百条。
 */
export const MAX_COMMANDS = 1000

/**
 * 一条命令的协议元数据。
 *
 * `T` 是各包自己的命令 union；`P` / `G` / `B` 是三个草稿类型，默认 `unknown`。
 * 草稿是各包的领域形状（`PacksDraft` 与 `McpPacksDraft` 不同），core 不该知道，
 * 但也不该逼各包在实现里断言——泛型参数让各包一次绑好，实现里就是具体类型。
 */
export interface OpSpec<T extends { readonly op: string }, P = unknown, G = unknown, B = unknown> {
  readonly op: T['op']
  /** 这条命令会碰到哪些文件。一条命令可以命中多个（`deletePack` 同时清绑定）。 */
  readonly files: readonly StoreFile[]
  /** 校验一条入站记录；不合法时返回一句人话（调用方会拼上 `commands[i]`）。 */
  parse(record: Record<string, unknown>): T | string
  applyPacks?(draft: P, command: T): void
  applyGroups?(draft: G, command: T): void
  /** 绑定合法性只能在 pack 写完之后判：同一批命令里可能刚建或刚删了 pack。 */
  applyBindings?(draft: B, command: T, knownPacks: ReadonlySet<string>): void
}

/** 一张 op → 定义的表。加一个 op 只改这里与各包的 union。 */
export type OpTable<T extends { readonly op: string }, P = unknown, G = unknown, B = unknown> = Readonly<
  Record<T['op'], OpSpec<T, P, G, B>>
>

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 校验入站意图。宁可拒绝整批，也不要半懂地写一半。
 *
 * 分派与校验都来自 `table`：校验器里不再有第二个开关，加 op 时也不会出现「表里加了、
 * 开关里忘了」这种半通状态。
 */
export function parseCommands<T extends { readonly op: string }>(
  raw: unknown,
  table: OpTable<T, never, never, never>,
): { ok: true; commands: T[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'commands 必须是数组' }
  if (raw.length === 0) return { ok: false, message: 'commands 不能为空' }
  if (raw.length > MAX_COMMANDS) {
    return { ok: false, message: `commands 一次最多 ${String(MAX_COMMANDS)} 条，收到 ${String(raw.length)} 条` }
  }
  const commands: T[] = []
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    if (record === null) return { ok: false, message: `commands[${String(index)}] 不是对象` }
    const op = record['op']
    if (typeof op !== 'string') return { ok: false, message: `commands[${String(index)}] op 不是已知操作` }
    // 必须用 hasOwn：`table['toString']` 拿到的是 Object.prototype.toString，
    // 不是 undefined，会让 spec.parse 抛 TypeError 并被报成 internal。
    const spec = Object.hasOwn(table, op)
      ? (table as Record<string, OpSpec<T, never, never, never> | undefined>)[op]
      : undefined
    if (spec === undefined) return { ok: false, message: `commands[${String(index)}] op 不是已知操作` }
    const parsed = spec.parse(record)
    if (typeof parsed === 'string') return { ok: false, message: `commands[${String(index)}] ${parsed}` }
    commands.push(parsed)
  }
  return { ok: true, commands }
}

/** 这批命令会碰到哪些文件。事务边界由此决定。 */
export function filesOf<T extends { readonly op: string }>(
  commands: readonly T[],
  table: OpTable<T, never, never, never>,
): ReadonlySet<StoreFile> {
  const files = new Set<StoreFile>()
  for (const command of commands) {
    // 命令已经过 parseCommands 校验，这里只防原型链键。
    const spec = Object.hasOwn(table, command.op)
      ? (table as Record<string, OpSpec<T, never, never, never> | undefined>)[command.op]
      : undefined
    if (spec === undefined) continue
    for (const file of spec.files) files.add(file)
  }
  return files
}
