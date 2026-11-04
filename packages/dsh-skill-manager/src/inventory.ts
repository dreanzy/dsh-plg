/**
 * 清单读取与官方判定。
 *
 * 只有一条硬约束：**清单不完整时不许拿它算隐藏集**。不完整意味着有些名字暂时
 * 没读到，而「没读到」与「清单里不存在」在求值上看起来一样——用它重算会把
 * 本来关着的项当成不需要处理而悄悄放行。宁可这一轮不动，也不要放行。
 */

/** `ctx.skills.snapshot()` 返回条目里本插件用到的字段。 */
export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly path?: string
  readonly provider: string
  readonly source: string
  readonly invocation?: {
    readonly modelInvocable?: boolean
    readonly userInvocable?: boolean
  }
}

/** 宿主 `skills` 服务在本插件用到的面。 */
export interface SkillsFace {
  snapshot(options: { cwd?: string; scope?: unknown }): Promise<{
    skills: readonly SkillSummaryLike[]
    complete: boolean
  }>
  get(
    name: string,
    options?: { cwd?: string; scope?: unknown },
  ): Promise<{ readonly content?: string } | undefined>
  register(skill: {
    readonly name: string
    readonly description: string
    readonly content: string
    readonly source: string
    readonly path?: string
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }): () => void
}

export interface Inventory {
  readonly rows: readonly SkillSummaryLike[]
  readonly complete: boolean
}

/**
 * 一次 `snapshot()` 要枚举全部 provider 并解析每个 `SKILL.md` 的 frontmatter，
 * 一百多项就是几百毫秒。打开面板、保存、再打开会连着触发好几次，所以加一层
 * 很短的缓存：命中时不改变正确性，只省掉重复扫描。
 *
 * 只缓存 `complete` 的结果——残缺清单本来就不该被复用。
 * 清单变化（装上/卸载 skill）最多延迟 `INVENTORY_TTL_MS` 才可见，这个代价
 * 换来的是一次保存从「两次全量扫描」降到「零次」。
 */
const INVENTORY_TTL_MS = 2500
const inventoryCache = new Map<string, { rows: readonly SkillSummaryLike[]; complete: boolean; at: number }>()

/**
 * 读清单。
 *
 * `cwd` **缺省时读全局清单**（`snapshot({})`），带上时读该工作区的工程清单。
 * 不要用空字符串表示「全局」：`''` 会被当作一个目录去解析工程根，
 * 取不到任何工程级 provider，结果是面板只剩运行时与官方那几条。
 *
 * 带 `scope` 的读取已经包含 global 层（`dsh-skill` 的 `collectFresh` 是
 * `[global, ...chainLayers(scope)]`），调用方**不要**再去读一次全局清单做并集。
 */
export async function readInventory(skills: SkillsFace, cwd?: string, scope?: unknown): Promise<Inventory> {
  const key = `${cwd ?? ''}|${scope === undefined ? '-' : 'scoped'}`
  const now = Date.now()
  const hit = inventoryCache.get(key)
  if (hit !== undefined && now - hit.at < INVENTORY_TTL_MS) {
    return { rows: hit.rows, complete: hit.complete }
  }

  const options: { cwd?: string; scope?: unknown } = {}
  if (cwd !== undefined && cwd !== '') options.cwd = cwd
  if (scope !== undefined) options.scope = scope
  const snapshot = await skills.snapshot(options)
  if (snapshot.complete) {
    inventoryCache.set(key, { rows: snapshot.skills, complete: true, at: now })
  }
  return { rows: snapshot.skills, complete: snapshot.complete }
}

/**
 * 官方 `@deepseek-ai` 基础设施 skill。
 *
 * 判定只能靠路径与 provider 白名单，不能靠 `source`：官方那批由同一个
 * `filesystem` provider 持有，`source` 与用户自己的 custom skill 完全相同，
 * 按 source 过滤会把用户技能一起误伤。
 *
 * 第二条判据覆盖「没有 path」的官方 provider（`dsh-office` 注册的 `office-*`
 * 不填 path）。名单是白名单：名单外的第三方 provider 照常展示。
 */
const OFFICIAL_SCOPE = '@deepseek-ai'
const OFFICIAL_PROVIDERS: ReadonlySet<string> = new Set(['dsh-office'])

export function isOfficialSkill(entry: { path?: string; provider?: string }): boolean {
  if (entry.path !== undefined && entry.path.includes(OFFICIAL_SCOPE)) return true
  return entry.provider !== undefined && OFFICIAL_PROVIDERS.has(entry.provider)
}
