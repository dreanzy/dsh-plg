/** 名册里的一行：面板与系统提示共用同一个形状。 */
export interface InventoryRow {
  readonly serverName: string
  /** 用户写的描述；空串表示没写。 */
  readonly description: string
}

/** 单条描述的字符预算。 */
const PER_ROW_DESCRIPTION_BUDGET = 80
/** 整段描述的字符预算。 */
const TOTAL_DESCRIPTION_BUDGET = 900

/**
 * 导语不按模式分叉。
 *
 * 每行都有自己的模式，而名册是**一段**文本：按模式分叉会在混合配置下说错话。
 * 所以导语一次把三条路径说全，具体某台服务器怎么调，由 `mcp_load` 的结果再说一遍。
 */
const PREAMBLE = 'MCP servers available on demand: call `mcp_load` with one of these names to add that server\'s tools to this session — pass `query` to add only what matches, or `tool` for one tool and its argument schema. Servers declared as lazy register no tools; call those through `mcp_call`. Call `mcp_unload` with the same name to release it again.'

/**
 * 渲染名册段。
 *
 * 四条约束（理由都是实测出来的）：
 * 1. 渲染是纯函数：只吃行，不碰 Loader、不读磁盘，所以能直接单测。
 * 2. 预算是先削描述、不删名字：模型看不到名字的服务器就加载不了，宁可只给名字。
 * 3. 整段超预算时从后往前丢描述，名字照列。
 * 4. 没有行时返回空串，宿主会把空段过滤掉，等于不出段。
 */
export function renderInventory(rows: readonly InventoryRow[]): string {
  if (rows.length === 0) return ''
  const lines: string[] = []
  let remaining = TOTAL_DESCRIPTION_BUDGET
  for (const row of rows) {
    const name = row.serverName.trim()
    if (name === '') continue
    const description = row.description.trim().slice(0, PER_ROW_DESCRIPTION_BUDGET)
    if (description !== '' && description.length <= remaining) {
      remaining -= description.length
      lines.push(`- ${name} — ${description}`)
      continue
    }
    lines.push(`- ${name}`)
  }
  if (lines.length === 0) return ''
  return `${PREAMBLE}\n\n${lines.join('\n')}`
}

/** 段名。固定值，改名等于另起一段。 */
export const INVENTORY_SECTION = 'mcp-manager:on-demand'
