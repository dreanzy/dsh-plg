/** 一层策略：项级与组级两条决定。键不存在即跟随上层，`false` 是有效取值。 */
export interface LayerPolicy {
  readonly items: Record<string, boolean>
  readonly groups: Record<string, boolean>
}

/** 全局层多两个单机级 UI 开关。 */
export interface GlobalPolicy extends LayerPolicy {
  readonly showOfficialSkills: boolean
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
  /** 能力项名 → 分组 id。没有条目的项即未分组。 */
  readonly assignments: Readonly<Record<string, string>>
}

/** 写入路径的两层标识。 */
export type LayerId = 'global' | 'workspace'

/**
 * 一次策略变更的意图。
 *
 * `null` 一律表示「删掉这条键，回到跟随」，而不是「设成某个值」——
 * 写同值不等于跟随（见 ADR 0001）。
 */
export type Command =
  | { readonly op: 'item'; readonly layer: LayerId; readonly name: string; readonly value: boolean | null }
  | { readonly op: 'group'; readonly layer: LayerId; readonly groupId: string; readonly value: boolean | null }
  | { readonly op: 'assign'; readonly name: string; readonly groupId: string | null }
  | { readonly op: 'createGroup'; readonly name: string }
  | { readonly op: 'renameGroup'; readonly groupId: string; readonly name: string }
  | { readonly op: 'deleteGroup'; readonly groupId: string }
  | { readonly op: 'showOfficialSkills'; readonly value: boolean }
  | { readonly op: 'showSidebarEntry'; readonly value: boolean }

/** 解析结果：坏数据永不抛错，降级成空策略并附一条可读的说明。 */
export interface ParseResult<T> {
  readonly value: T
  readonly warnings: readonly string[]
}

export const EMPTY_LAYER: LayerPolicy = { items: {}, groups: {} }
export const EMPTY_GLOBAL: GlobalPolicy = { items: {}, groups: {}, showOfficialSkills: false, showSidebarEntry: true }
export const EMPTY_GROUPS: GroupRegistry = { groups: [], assignments: {} }
