/**
 * 一张具名策略表：项级与组级两条决定。
 *
 * 只含覆盖决定、不含成员清单。键不存在即跟随下一层，`false` 是有效取值，
 * 不是「跟随」。
 */
export interface Pack {
  readonly name: string
  /** 键是插件包名。 */
  readonly items: Readonly<Record<string, boolean>>
  readonly groups: Readonly<Record<string, boolean>>
}

/** `packs.json` 里的 pack 名册。`default` 是内置项，永远存在。 */
export interface PackBook {
  readonly packs: Readonly<Record<string, Pack>>
}

/** 工作区绑定表。`bindings` 的键是 `normalizeCwd` 之后的 cwd。 */
export interface Bindings {
  readonly bindings: Readonly<Record<string, string>>
  readonly extra: readonly string[]
}

/**
 * 单机 UI 开关，落在 `packs.json` 的 `ui` 段。
 *
 * `defaultTab` 是「打开设置时默认显示」的那一页，与「当前正在看哪一页」是两件事：
 * 临时切页不写盘，只有设置页顶部那组单选才改这个值。
 *
 * 没有 `showSidebarEntry`：侧栏入口已随侧栏面板一起废弃，旧文件里残留这个键时忽略。
 */
export interface UiState {
  /** 官方 `@deepseek-ai` 插件是否列在面板里。默认不列：它们大概率不是用户要调的。 */
  showOfficialPlugins: boolean
  showChip: boolean
  defaultTab: SettingsTab
}

/** 设置页的三页，顺序固定。 */
export type SettingsTab = 'groups' | 'packs' | 'workspace'

/** 分组身份。id 稳定，name 可改。 */
export interface GroupDef {
  readonly id: string
  readonly name: string
}

/** 组定义：跨工作区共享，不含任何开关决定。 */
export interface GroupRegistry {
  readonly groups: readonly GroupDef[]
  /** 包名 → 分组 id。没有条目的项即未分组。 */
  readonly assignments: Readonly<Record<string, string>>
}

/**
 * 一次策略变更的意图。
 *
 * `null` 一律表示「删掉这条键，回到跟随」，而不是「设成某个值」——
 * 写同值不等于跟随（见 ADR 0001）。
 *
 * `bind` 的 `cwd` 由调用方给出并在此处规范化；`packId: null` 表示解除绑定。
 */
export type Command =
  | { readonly op: 'packItem'; readonly packId: string; readonly name: string; readonly value: boolean | null }
  | { readonly op: 'packGroup'; readonly packId: string; readonly groupId: string; readonly value: boolean | null }
  | { readonly op: 'createPack'; readonly name: string }
  | { readonly op: 'renamePack'; readonly packId: string; readonly name: string }
  | { readonly op: 'deletePack'; readonly packId: string }
  | { readonly op: 'bind'; readonly cwd: string; readonly packId: string | null }
  | { readonly op: 'addExtra'; readonly cwd: string }
  | { readonly op: 'removeExtra'; readonly cwd: string }
  | { readonly op: 'assign'; readonly name: string; readonly groupId: string | null }
  | { readonly op: 'createGroup'; readonly name: string }
  | { readonly op: 'renameGroup'; readonly groupId: string; readonly name: string }
  | { readonly op: 'deleteGroup'; readonly groupId: string }
  | { readonly op: 'showOfficialPlugins'; readonly value: boolean }
  | { readonly op: 'showChip'; readonly value: boolean }
  | { readonly op: 'defaultTab'; readonly value: SettingsTab }

/** 解析结果：坏数据永不抛错，降级成空策略并附一条可读的说明。 */
export interface ParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
}

/** 内置 pack 的 id。它同时是求值链的终点，也是未绑定工作区的取值来源。 */
export const DEFAULT_PACK_ID = 'default'

/** 内置 pack 的固定显示名：界面与落盘都只用这一个，旧名在读写两侧都会归一。 */
export const DEFAULT_PACK_NAME = '默认'

export const EMPTY_PACK: Pack = { name: DEFAULT_PACK_NAME, items: {}, groups: {} }
export const EMPTY_BINDINGS: Bindings = { bindings: {}, extra: [] }
export const EMPTY_UI: UiState = {
  showOfficialPlugins: false,
  showChip: true,
  defaultTab: 'groups',
}
export const EMPTY_GROUPS: GroupRegistry = { groups: [], assignments: {} }

/**
 * 锁定工具：**不能关闭**，UI 不提供开关。
 *
 * `run_code` 单独一类：宿主 `restrict()` 对它是硬拒绝（保留给 PTC transport），
 * 写进 deny 会让**整批**限制失败，而不是只忽略这一个。所以它既不进掩码，也不给开关。
 */
export const LOCKED_TOOLS: ReadonlySet<string> = new Set(['run_code'])

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
  /**
   * 包源码里出现过的所有 `name: '…'` 字面量（去重、排序）。
   *
   * 这**不是**工具名清单：`ctx.tools.register(vTool({ name }))` 与工厂函数返回对象
   * 里的 name，结构解析都够不着。它只回答「这个包写过这些名字」，是不是工具由运行期
   * 清单裁（见 `candidateTools` 与 hooks 的 `denyFor`）。旧缓存没有这个字段。
   */
  readonly names?: readonly string[]
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
  /**
   * 这次扫描是否完整。
   *
   * 不完整（撞预算或读不到文件）时结果**仍然落盘**：读侧至少有东西可用，
   * 但下一次 `loadCatalog` 不会拿它短路扫描——残缺不能被固化成「已完成」。
   */
  readonly complete: boolean
}
