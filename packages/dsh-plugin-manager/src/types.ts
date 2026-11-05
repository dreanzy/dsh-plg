/** 一层策略：项级与组级两条决定。键不存在即跟随上层，`false` 是有效取值。 */
export interface LayerPolicy {
  readonly items: Record<string, boolean>
  readonly groups: Record<string, boolean>
}

/** 全局层多一个单机级 UI 开关。 */
export interface GlobalPolicy extends LayerPolicy {
  /** 是否在左侧栏显示面板入口。只影响入口，不影响策略生效。 */
  readonly showSidebarEntry: boolean
}

/** 分组身份。id 稳定，name 可改。 */
export interface GroupDef {
  readonly id: string
  readonly name: string
}

/** 组定义：跨工作区共享，不含任何开关决定。 */
export interface GroupRegistry {
  readonly groups: readonly GroupDef[]
  /** 工具名 → 分组 id。没有条目的项即未分组。 */
  readonly assignments: Readonly<Record<string, string>>
}

/** 写入路径的两层标识。 */
export type LayerId = 'global' | 'workspace'

/**
 * 一次策略变更的意图。
 *
 * `null` 一律表示「删掉这条键，回到跟随」，而不是「设成某个值」——
 * 写同值不等于跟随。
 */
export type Command =
  | { readonly op: 'item'; readonly layer: LayerId; readonly name: string; readonly value: boolean | null }
  | { readonly op: 'group'; readonly layer: LayerId; readonly groupId: string; readonly value: boolean | null }
  | { readonly op: 'assign'; readonly name: string; readonly groupId: string | null }
  | { readonly op: 'createGroup'; readonly name: string }
  | { readonly op: 'renameGroup'; readonly groupId: string; readonly name: string }
  | { readonly op: 'deleteGroup'; readonly groupId: string }
  | { readonly op: 'showSidebarEntry'; readonly value: boolean }

/** 解析结果：坏数据永不抛错，降级成空策略并附一条可读的说明。 */
export interface ParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
}

/**
 * 受保护工具：关闭前需要二次确认。名单固定，不由任何一层策略改写。
 *
 * 判据是「关掉之后没法自救」——没有读写文件的能力，用户只能重装整套环境。
 */
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write'])

/**
 * 锁定工具：**不能关闭**，UI 不提供开关。
 *
 * `run_code` 单独一类：宿主 `restrict()` 对它是硬拒绝（保留给 PTC transport），
 * 写进 deny 会让**整批**限制失败，而不是只忽略这一个。所以它既不进掩码，也不给开关。
 */
export const LOCKED_TOOLS: ReadonlySet<string> = new Set(['run_code'])

export const EMPTY_LAYER: LayerPolicy = { items: {}, groups: {} }
export const EMPTY_GLOBAL: GlobalPolicy = { items: {}, groups: {}, showSidebarEntry: true }
export const EMPTY_GROUPS: GroupRegistry = { groups: [], assignments: {} }
/**
 * 一个插件对模型的贡献，由静态扫描得到。
 *
 * 两个 known 分开记：工具与段各有自己的识别率，一个可靠不代表另一个可靠。
 * 认不出的部分留在 `Catalog` 的 orphan 列表里，不参与任何开关。
 */
export interface PluginContribution {
  /** 包名，同时是策略里的键。 */
  readonly pkg: string
  /** 该插件注册的工具名。 */
  readonly tools: readonly string[]
  /** 该插件注入的提示词段名。 */
  readonly sections: readonly string[]
  /** 工具 schema 的估算 token（按 schema 投影长度折算）。 */
  readonly toolVolume: number
  /** 提示词段的字符数。 */
  readonly sectionChars: number
  /** 工具归属是否完整（扫描时没有因读不到文件而漏掉）。 */
  readonly toolsKnown: boolean
  /** 段归属是否完整。段名可能是运行期拼的，这部分天然不可靠。 */
  readonly sectionsKnown: boolean
}

/** 一次扫描的产物：插件清单 + 认不出归属的孤儿。 */
export interface Catalog {
  /** 指纹：包名@版本 + 入口 mtime，变了就重扫。 */
  readonly key: string
  readonly plugins: readonly PluginContribution[]
  /** 认不出归属的工具名。它们照常可见、照常可用，只是任何插件开关都管不到。 */
  readonly orphanTools: readonly string[]
  /** 认不出归属的段名。面板只提示，不处理。 */
  readonly orphanSections: readonly string[]
}
