/**
 * 名册文件的读侧骨架。
 *
 * 三个包各有一份逐行的 `parsePacks`：读 JSON、判顶层、按 id 排序、超上限截断、空 id
 * 跳过、`default` 缺席时补一个空 pack 并留 warning。这一段与「条目长什么样」无关，
 * 因此收在这里；条目解析与 `ui` 段形状由调用方以回调注入（见 ADR-0016）。
 */

/** 一次读的结论：名册、`ui` 段与全部 warning。 */
export interface RosterResult<TRow, TUi> {
  readonly value: { readonly book: { readonly packs: Record<string, TRow> }; readonly ui: TUi }
  readonly warnings: readonly string[]
}

/** 一张 pack 长什么样、`ui` 段长什么样：各包的领域知识，core 不猜。 */
export interface RosterDeps<TRow, TUi> {
  parsePack(id: string, raw: unknown, warnings: string[]): TRow
  parseUi(raw: unknown, warnings: string[]): TUi
}

/**
 * 求值链终点与名册上限。
 *
 * 都不在 core 里定死：`default` 显示成什么、上限多少是各包对外的口径，与 `ROUTES`
 * 同理——写死在一个共享包里，改一处就等于悄悄改了四个面板的语义（见 ADR-0007）。
 */
export interface RosterConfig<TRow> {
  readonly defaultPackId: string
  readonly defaultPackName: string
  readonly emptyPack: TRow
  readonly maxNames: number
}

/** 顶层是不是普通对象。数组与 `null` 都不算。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一份 JSON。
 *
 * 空文本、坏 JSON、顶层非对象一律降到 `null` 并记一条 warning。读侧把坏文件降级成
 * 空名册，写侧才不会拿一个「看起来空」的策略覆盖用户已有的决定——写侧的拒写在
 * `store.ts` 的 `writableReason`，两边必须成对看。
 */
export function readJson(text: string | undefined, warnings: string[]): Record<string, unknown> | null {
  if (text === undefined || text.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    warnings.push(`文件不是合法 JSON，已按空策略处理：${String(error)}`)
    return null
  }
  if (!isPlainRecord(raw)) {
    warnings.push('文件顶层不是对象，已按空策略处理')
    return null
  }
  return raw
}

/**
 * 解析 `packs.json`。
 *
 * 顺序：读 JSON → 解析 `ui` 段 → 逐 id 排序解析条目 → 上限截断 → 空 id 跳过 →
 * `default` 缺席时补一个空 pack 并留 warning。
 *
 * 键一律用 `Object.defineProperty` 写：`packs['__proto__'] = value` 改的是原型，
 * 键被静默丢弃且没有 warning。三份副本原先只有一份守了这条，因此判定不再分散。
 */
export function parseRoster<TRow extends { name: string }, TUi>(
  text: string | undefined,
  deps: RosterDeps<TRow, TUi>,
  config: RosterConfig<TRow>,
): RosterResult<TRow, TUi> {
  const warnings: string[] = []
  const raw = readJson(text, warnings)
  const ui = deps.parseUi(raw?.['ui'], warnings)
  const packs: Record<string, TRow> = {}

  if (raw !== null) {
    const rawPacks = raw['packs']
    if (rawPacks !== undefined) {
      if (!isPlainRecord(rawPacks)) {
        warnings.push('packs 不是对象，已忽略')
      } else {
        const ids = Object.keys(rawPacks).sort()
        if (ids.length > config.maxNames) {
          warnings.push(`packs 超过 ${config.maxNames} 个，已只保留前 ${config.maxNames} 个`)
          ids.length = config.maxNames
        }
        for (const id of ids) {
          if (id === '') {
            warnings.push('packs 里有空 id 的条目，已忽略')
            continue
          }
          const parsed = deps.parsePack(id, rawPacks[id], warnings)
          // 内置 pack 的显示名固定：文件里可能是旧名，读侧一并归一。
          Object.defineProperty(packs, id, {
            value: id === config.defaultPackId ? { ...parsed, name: config.defaultPackName } : parsed,
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
      }
    }
  }

  if (packs[config.defaultPackId] === undefined) {
    if (raw !== null) warnings.push('packs 缺少 default，已补一个空 pack')
    Object.defineProperty(packs, config.defaultPackId, {
      value: config.emptyPack,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return { value: { book: { packs }, ui }, warnings }
}

/**
 * 一行名册的渲染投影。
 *
 * `row` 是整个条目：值域字段（`items` / `rows`）各包自己取，core 不认识它们。
 */
export interface PackView<TRow> {
  readonly id: string
  readonly name: string
  readonly row: TRow
  readonly builtin: boolean
}

/**
 * 全部 pack，`default` 排第一，其余按名字（`localeCompare(…, 'zh')`）排序。
 *
 * `default` 不参与名字序：它是求值链终点，不是一张普通 pack，混进名字序里用户找
 * 「基线」得先扫一遍列表。重名按 id 兜底——`parsePack` 在 name 缺失时用 id 代替，
 * 手改文件可能造出重名，没有兜底就不是全序。
 */
export function packViews<TRow extends { name: string }>(
  packs: Readonly<Record<string, TRow>>,
  config: Pick<RosterConfig<TRow>, 'defaultPackId' | 'defaultPackName'>,
  nameOf: (row: TRow) => string,
): PackView<TRow>[] {
  const displayName = (id: string, row: TRow): string =>
    id === config.defaultPackId ? config.defaultPackName : nameOf(row)
  const compare = (a: string, b: string): number => {
    if (a === b) return 0
    if (a === config.defaultPackId) return -1
    if (b === config.defaultPackId) return 1
    const left = packs[a]
    const right = packs[b]
    const byName = (left === undefined ? a : displayName(a, left)).localeCompare(
      right === undefined ? b : displayName(b, right),
      'zh',
    )
    return byName !== 0 ? byName : a < b ? -1 : 1
  }
  const out: PackView<TRow>[] = []
  for (const id of Object.keys(packs).sort(compare)) {
    const row = packs[id]
    if (row === undefined) continue
    out.push({ id, name: displayName(id, row), row, builtin: id === config.defaultPackId })
  }
  return out
}
