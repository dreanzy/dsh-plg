/** 一个待回灌的文件：路径 + 内容版本。 */
export interface DirtyEntry {
  readonly path: string
  readonly version: string
  readonly markedAt: number
}

/**
 * 脏文件表。去重键是「路径 + 内容版本」：同一版本只登记一次，
 * 新版本覆盖旧版本并刷新登记时间。
 */
export class DirtySet {
  readonly #entries = new Map<string, DirtyEntry>()

  mark(path: string, version: string, now: number = Date.now()): void {
    const previous = this.#entries.get(path)
    if (previous !== undefined && previous.version === version) return
    this.#entries.set(path, { path, version, markedAt: now })
  }

  has(path: string, version: string): boolean {
    const entry = this.#entries.get(path)
    return entry !== undefined && entry.version === version
  }

  /** 按登记顺序取出至多 limit 个，并移出表——回灌过的不再重复。 */
  take(limit: number): DirtyEntry[] {
    const taken: DirtyEntry[] = []
    for (const [path, entry] of this.#entries) {
      if (taken.length >= limit) break
      taken.push(entry)
      this.#entries.delete(path)
    }
    return taken
  }

  get size(): number {
    return this.#entries.size
  }

  clear(): void {
    this.#entries.clear()
  }
}
