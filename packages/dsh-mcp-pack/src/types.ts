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

/**
 * 一行的策略决定。每个字段各自三态：键缺席即「跟随上一层」，`false` 是有效取值。
 *
 * 空串与缺席在 `description` 上是等价的，但落盘时仍区分：写出去的就是写出去的。
 */
export interface RowPolicy {
  readonly enabled?: boolean
  readonly mode?: Mode
  readonly tools?: readonly string[]
  /** 名册段里显示的描述。空串与缺席等价。 */
  readonly description?: string
}

/**
 * 一张具名策略表。
 *
 * 组级**只有**一个布尔开关：组若也能设四个字段，立刻会遇到「组说 dynamic、
 * 行说 disabled」的合并规则，而那条规则没有便宜答案。逐字段的决定只留在行级。
 */
export interface McpPack {
  readonly name: string
  /** 键是分组 id；只决定开/关，不设 mode/tools/description。 */
  readonly groups: Readonly<Record<string, boolean>>
  /** 键是行键（`own:<name>` / `global:<name>`）；每个字段各自跟随。 */
  readonly rows: Readonly<Record<string, RowPolicy>>
}

/** `packs.json` 里的 pack 名册。`default` 是内置项，永远存在。 */
export interface PackBook {
  readonly packs: Readonly<Record<string, McpPack>>
}

/** 工作区绑定表。`bindings` 的键是 `normalizeCwd` 之后的 cwd。 */
export interface Bindings {
  readonly bindings: Readonly<Record<string, string>>
  readonly extra: readonly string[]
}

/** 设置页的三页，顺序固定。 */
export type SettingsTab = 'servers' | 'groups' | 'packs' | 'workspace'

/**
 * 单机 UI 开关，落在 `packs.json` 的 `ui` 段。
 *
 * `defaultTab` 是「打开设置时默认显示」的那一页，与「当前正在看哪一页」是两件事：
 * 临时切页不写盘，只有设置页顶部那组单选才改这个值。
 *
 * 没有 `showSidebarEntry`：侧栏入口已随侧栏面板一起废弃，旧文件里残留这个键时忽略。
 */
export interface UiState {
  /** 新会话 chip 是否注册。默认开：入口在才是用户期待的样子。 */
  readonly showChip: boolean
  readonly defaultTab: SettingsTab
}

/** 分组身份。id 稳定，name 可改。 */
export interface GroupDef {
  readonly id: string
  readonly name: string
}

/** 组定义：跨工作区共享，不含任何开关决定。 */
export interface GroupRegistry {
  readonly groups: readonly GroupDef[]
  /** 行键 → 分组 id。没有条目的行即未分组。 */
  readonly assignments: Readonly<Record<string, string>>
}

/** 行级补丁：缺省的键表示「不动」，`null` 表示「删掉这条键，回到跟随」。 */
export interface RowPatch {
  readonly enabled?: boolean | null
  readonly mode?: Mode | null
  readonly tools?: readonly string[] | null
  readonly description?: string | null
}

/**
 * 一次策略变更的意图。
 *
 * `null` 一律表示「删掉这条键，回到跟随」，而不是「设成某个值」——
 * 写同值不等于跟随。`bind` 的 `cwd` 由调用方给出，在 store 里规范化；
 * `packId: null` 表示解除绑定。
 */
export type Command =
  | { readonly op: 'packRow'; readonly packId: string; readonly rowKey: string; readonly patch: RowPatch }
  | { readonly op: 'packGroup'; readonly packId: string; readonly groupId: string; readonly value: boolean | null }
  | { readonly op: 'createPack'; readonly name: string }
  | { readonly op: 'renamePack'; readonly packId: string; readonly name: string }
  | { readonly op: 'deletePack'; readonly packId: string }
  | { readonly op: 'bind'; readonly cwd: string; readonly packId: string | null }
  | { readonly op: 'addExtra'; readonly cwd: string }
  | { readonly op: 'removeExtra'; readonly cwd: string }
  | { readonly op: 'assign'; readonly rowKey: string; readonly groupId: string | null }
  | { readonly op: 'createGroup'; readonly name: string }
  | { readonly op: 'renameGroup'; readonly groupId: string; readonly name: string }
  | { readonly op: 'deleteGroup'; readonly groupId: string }
  | { readonly op: 'showChip'; readonly value: boolean }
  | { readonly op: 'defaultTab'; readonly value: SettingsTab }

/** 解析结果：坏数据永不抛错，降级成空策略并附一条可读的说明。 */
export interface ParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
}

/** 内置 pack 的 id。它同时是求值链的终点，也是未绑定工作区的取值来源。 */
export const DEFAULT_PACK_ID = 'default'

export const EMPTY_PACK: McpPack = { name: DEFAULT_PACK_ID, groups: {}, rows: {} }
export const EMPTY_PACK_BOOK: PackBook = { packs: { [DEFAULT_PACK_ID]: EMPTY_PACK } }
export const EMPTY_BINDINGS: Bindings = { bindings: {}, extra: [] }
export const EMPTY_UI: UiState = { showChip: true, defaultTab: 'groups' }
export const EMPTY_GROUPS: GroupRegistry = { groups: [], assignments: {} }

/**
 * 旧策略文件的形状（`$DSH_HOME/mcp-manager/global.json` 与
 * `<cwd>/.dsh/mcp-manager.json` 都是它）。
 *
 * 只用于兼容读：内容在内存里映射成 pack 的 `rows`，**读取路径绝不写盘**。
 */
export interface LegacyLayer {
  readonly rows: Readonly<Record<string, RowPolicy>>
}

export const EMPTY_LEGACY: LegacyLayer = { rows: {} }

/**
 * 字段值来自哪一层。
 *
 * `pack` = 工作区绑定的 pack，`default` = 内置 pack，`builtin` = 两层都没记录，
 * 取内置缺省。组级决定归属做出决定的那个 pack。
 */
export type FieldSource = 'pack' | 'default' | 'builtin'

/** 一行求值后的完整结果：四个字段各自独立。 */
export interface ResolvedRow {
  readonly rowKey: string
  readonly enabled: boolean
  readonly mode: Mode
  readonly tools: readonly string[]
  readonly description: string
  /** 该行的分组 id，未分组为 null。 */
  readonly groupId: string | null
  /** 影响该行最具体的那一层。 */
  readonly from: FieldSource
  readonly sources: {
    readonly enabled: FieldSource
    readonly mode: FieldSource
    readonly tools: FieldSource
    readonly description: FieldSource
  }
}
