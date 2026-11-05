/** 本插件管理的 MCP 行的轻量视图。 */
export interface McpRow {
  /** 稳定键：`own:<serverName>` 或 `global:<serverName>`。 */
  readonly rowKey: string
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http'
  /** 人读摘要：stdio 给 command 与首个参数，http 给 url。 */
  readonly definition: string
  /** 来源短标签：托管文件名、用户 include 文件名，或 `profile`。 */
  readonly source: string
  /** 来源文件的绝对路径；写在组合本身里时为 null。 */
  readonly sourcePath: string | null
  /** 定义是否由本插件托管（只有托管文件可写）。 */
  readonly owned: boolean
  /** 声明里的 disabled。闸门状态不在这里。 */
  readonly declaredDisabled: boolean
  /** 原始配置对象，用于构造连接参数。形状以宿主 Config 为准。 */
  readonly config: unknown
  readonly entryId: string
}

/** 一次行发现的产物。`complete` 为 false 时调用方不得据此算隐藏集。 */
export interface RowScan {
  readonly rows: readonly McpRow[]
  readonly complete: boolean
  readonly warnings: readonly string[]
}

/** 宿主 Loader 在本插件用到的面。 */
export interface LoaderFace {
  entries(): Iterable<unknown>
}

/** 加载模式。三档语义见 spec 第 4 节。 */
export type Mode = 'eager' | 'dynamic' | 'lazy'

/** 合法模式列表，顺序即 UI 顺序。 */
export const MODES: readonly Mode[] = ['eager', 'dynamic', 'lazy']

/** 默认模式：与社区实现一致，按需加载。 */
export const DEFAULT_MODE: Mode = 'dynamic'

/** 一行的策略决定。键缺席即「跟随上一层」，不是某个特殊取值。 */
export interface RowPolicy {
  readonly enabled?: boolean
  readonly mode?: Mode
  readonly tools?: readonly string[]
  /** 名册段里显示的描述。空串与缺席等价。 */
  readonly description?: string
}

/** 全局层独有的界面开关。工作区层不写这些。 */
export interface LayerSettings {
  /** 是否在左侧栏显示面板入口。只影响入口，不影响策略生效。 */
  readonly showSidebarEntry: boolean
}

/** 一层策略文件的内容。 */
export interface LayerPolicy {
  readonly version: 1
  readonly rows: Readonly<Record<string, RowPolicy>>
  /** 只有全局层写；工作区层一律取默认。 */
  readonly settings: LayerSettings
}

export const EMPTY_SETTINGS: LayerSettings = { showSidebarEntry: true }

export type LayerId = 'global' | 'workspace'

/**
 * 一次策略变更的意图。
 *
 * `value === null` 表示「删掉这条键，回到跟随」，不是「设成某个值」。
 * 命令是绝对状态、幂等、可交换；服务端不比对任何版本号。
 */
export type Command =
  | { readonly op: 'enabled'; readonly layer: LayerId; readonly rowKey: string; readonly value: boolean | null }
  | { readonly op: 'mode'; readonly layer: LayerId; readonly rowKey: string; readonly value: Mode | null }
  | { readonly op: 'tools'; readonly layer: LayerId; readonly rowKey: string; readonly value: readonly string[] | null }
  | { readonly op: 'description'; readonly layer: LayerId; readonly rowKey: string; readonly value: string | null }
  | { readonly op: 'showSidebarEntry'; readonly layer: 'global'; readonly value: boolean }

/** 解析结果：坏数据永不抛错，降级成空策略并附可读说明。 */
export interface ParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
}

/** 字段级来源：这一项是谁定的。 */
export type FieldSource = LayerId | 'default'

/** 一行求值后的完整结果。 */
export interface ResolvedRow {
  readonly rowKey: string
  readonly enabled: boolean
  readonly mode: Mode
  readonly tools: readonly string[]
  readonly description: string
  /** 影响该行最具体的那一层。 */
  readonly from: FieldSource
  readonly sources: {
    readonly enabled: FieldSource
    readonly mode: FieldSource
    readonly tools: FieldSource
    readonly description: FieldSource
  }
}

export const EMPTY_LAYER: LayerPolicy = { version: 1, rows: {}, settings: EMPTY_SETTINGS }