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
 * 清单读取只剩「调宿主 `snapshot()` 一次」这一件事。
 *
 * 缓存与失效搬到了 `snapshot.ts`：那里的键含 scope 身份，而且与 hooks、路由共用，
 * 所以面板与模型看到的是同一次求值的结果。这里刻意不再留第二份缓存——两份缓存
 * 必然分叉，早先按「cwd + 有没有 scope」建键时，不同 preset 的会话会读到彼此的清单。
 *
 * 读清单的调用点只剩 hooks 的 `readFresh`；`cwd` 缺省时读全局清单（`snapshot({})`），
 * 不要用空字符串表示「全局」：`''` 会被当作一个目录去解析工程根。
 */

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
