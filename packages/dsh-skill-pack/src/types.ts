/**
 * 一张具名策略表：项级与组级两条决定。
 *
 * 只含覆盖决定、不含成员清单。键不存在即跟随下一层，`false` 是有效取值，
 * 不是「跟随」——这与旧的 `LayerPolicy` 语义完全一致。
 */
export interface Pack {
  readonly name: string
  readonly items: Readonly<Record<string, boolean>>
  readonly groups: Readonly<Record<string, boolean>>
}

/** `packs.json` 里的 pack 名册。`default` 是内置项，永远存在。 */
export interface PackBook {
  readonly packs: Readonly<Record<string, Pack>>
}

/**
 * 工作区绑定表。`bindings` 的键是 `normalizeCwd` 之后的 cwd。
 *
 * 目录清单本身不归这里管：可绑定的目录由宿主提供（开过会话的目录）。
 */
export interface Bindings {
  readonly bindings: Readonly<Record<string, string>>
}

/**
 * 单机 UI 开关，落在 `packs.json` 的 `ui` 段。
 *
 * `defaultTab` 是「打开设置时默认显示」的那一页，与「当前正在看哪一页」是两件事：
 * 临时切页不写盘，只有设置页顶部那组单选才改这个值。
 */
export interface UiState {
  showOfficialSkills: boolean
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
  /** 能力项名 → 分组 id。没有条目的项即未分组。 */
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
  | { readonly op: 'assign'; readonly name: string; readonly groupId: string | null }
  | { readonly op: 'createGroup'; readonly name: string }
  | { readonly op: 'renameGroup'; readonly groupId: string; readonly name: string }
  | { readonly op: 'deleteGroup'; readonly groupId: string }
  | { readonly op: 'showOfficialSkills'; readonly value: boolean }
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
export const EMPTY_PACK_BOOK: PackBook = { packs: { [DEFAULT_PACK_ID]: EMPTY_PACK } }
export const EMPTY_BINDINGS: Bindings = { bindings: {} }
export const EMPTY_UI: UiState = {
  showOfficialSkills: false,
  showChip: true,
  defaultTab: 'groups',
}
export const EMPTY_GROUPS: GroupRegistry = { groups: [], assignments: {} }
