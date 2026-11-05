import { renderInventory, type InventoryRow } from './inventory-section.js'
import type { ScopeSnapshot, SnapshotValue } from './snapshot.js'
import type { ToolTarget } from './tools.js'
import type { Mode } from './types.js'

export interface InventoryState {
  /** 同步快照。系统提示装配是同步的，只能读缓存。 */
  snapshot(): readonly InventoryRow[]
  /** 按名字找一台可加载的 server。同步，读缓存。 */
  target(name: string): ToolTarget | null
  /** 某个 server 的启用状态与模式；策略未就绪或没有这行时返回 null。 */
  policyOf(name: string): { readonly enabled: boolean; readonly mode: Mode } | null
  /** 重算缓存。失败保留上一版并返回错误。 */
  refresh(): Promise<void>
  warnings(): readonly string[]
}

/**
 * 把共享快照适配成「某个 cwd + scope 的只读视图」。
 *
 * 求值本身在 `snapshot.ts`：读盘、合并托管定义、沿链求值、缓存与失效都在那里。
 * 这里只做快照不该管的两件事：按名字查目标（带大小写兜底），以及同步暴露名册行。
 * 之所以保留这层薄适配，是因为两个调用方（名册段与 `mcp_load`）要的是不同切面，
 * 而它们都不该自己去遍历快照的 Map。
 */
export function createInventoryState(
  snapshot: ScopeSnapshot,
  cwd: string | null,
  scope?: unknown,
): InventoryState {
  const view = (): SnapshotValue | null => snapshot.read(cwd, scope)
  return {
    snapshot() {
      return view()?.inventory ?? []
    },
    target(name) {
      const value = view()
      if (value === null) return null
      const trimmed = name.trim()
      if (trimmed === '') return null
      const direct = value.targets.get(trimmed)
      if (direct !== undefined) return direct
      for (const candidate of value.targets.values()) {
        if (candidate.serverName === trimmed) return candidate
      }
      // 模型会把名字写成小写（`unitymcp8082`），而 serverName 是大小写敏感的。
      // 这里做一次不区分大小写的兜底：唯一命中才认，多个命中就放弃，避免串台。
      const lower = trimmed.toLowerCase()
      const loose = [...value.targets.values()].filter((candidate) => candidate.serverName.toLowerCase() === lower)
      return loose.length === 1 ? loose[0] ?? null : null
    },
    policyOf(name) {
      return view()?.policies.get(name.trim()) ?? null
    },
    async refresh() {
      await snapshot.refresh(cwd, scope)
    },
    warnings() {
      return view()?.warnings ?? []
    },
  }
}

/** 段文本，给 `systemPrompt.section` 的 text 用。 */
export function sectionText(state: InventoryState): string {
  return renderInventory(state.snapshot())
}
