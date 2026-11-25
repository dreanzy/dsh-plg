/** 一个待回灌的文件：路径 + 内容版本。 */
export interface DirtyEntry {
  readonly path: string
  readonly version: string
  readonly markedAt: number
}

const SEP = '\u0000'

/**
 * 脏文件表。去重键是「路径 + 内容版本」：同一版本只登记一次，
 * 新版本覆盖旧版本并刷新登记时间。
 *
 * 「已取走」的记忆独立于待回灌条目：take() 取走条目时同时记下版本，
 * 此后任何来源（写入、观测、git 差分）重标同一版本都无效。没有这层
 * 记忆，git 差分会把长期未提交的文件每一步重新标脏——实测同一版本
 * 因此被回灌 20 次。
 */
export class DirtySet {
  readonly #entries = new Map<string, DirtyEntry>()
  readonly #seen = new Map<string, number>()
  readonly #seenLimit: number

  constructor(seenLimit = 2000) {
    this.#seenLimit = seenLimit
  }

  mark(path: string, version: string, now: number = Date.now()): void {
    if (this.#seen.has(path + SEP + version)) return
    const previous = this.#entries.get(path)
    if (previous !== undefined && previous.version === version) return
    this.#entries.set(path, { path, version, markedAt: now })
  }

  has(path: string, version: string): boolean {
    const entry = this.#entries.get(path)
    return entry !== undefined && entry.version === version
  }

  /** 按登记顺序取出至多 limit 个并锁定：取走的版本此后不再登记。 */
  take(limit: number): DirtyEntry[] {
    const taken: DirtyEntry[] = []
    for (const [path, entry] of this.#entries) {
      if (taken.length >= limit) break
      taken.push(entry)
      this.#entries.delete(path)
      this.#remember(path, entry.version)
    }
    return taken
  }

  /** 放回一个没被发起的条目：取走时锁的版本要解开，否则它再也进不来。 */
  putBack(entry: DirtyEntry, now: number = Date.now()): void {
    this.#seen.delete(entry.path + SEP + entry.version)
    this.#entries.set(entry.path, { path: entry.path, version: entry.version, markedAt: now })
  }

  #remember(path: string, version: string): void {
    this.#seen.set(path + SEP + version, Date.now())
    while (this.#seen.size > this.#seenLimit) {
      const oldest = this.#seen.keys().next().value
      if (typeof oldest !== 'string') break
      this.#seen.delete(oldest)
    }
  }

  get size(): number {
    return this.#entries.size
  }

  /** 已锁定记忆的条数，测试与调试用。 */
  get seenSize(): number {
    return this.#seen.size
  }

  clear(): void {
    this.#entries.clear()
    this.#seen.clear()
  }
}
