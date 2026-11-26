/**
 * 本包给共享层的取值。
 *
 * 四个包的骨架同构，但有几处值必须不同：chip 上的缩写、残留键的种类名、承载
 * 「显示官方项」的字段名，以及各包在 `T` / `S` 上追加的样式键。这些不进共享层，
 * 因为它们是各包对外的口径（见 ADR-0017）。
 *
 * 拼接顺序：本文件 → panel-core.js → panel.js。这里只声明共享层要读的常量，
 * 不放业务代码。
 */

/**
 * 未绑定 pack 时 chip 上的字。
 *
 * 固定英文小写、三字母、去元音（skill→skl、plugin→plg、model→mdl；mcp 本就是
 * 念字母的专名，恰好同形）。不随宿主语言：这四个是领域标识符，不是句子，
 * 中文界面下缩写比中文译名更准，四个 chip 也等长。全名留在 title 里。
 */
const CHIP_LABEL = 'skl'

/** 残留键里「能力项」这一类的名字：skill 叫技能、plugin 叫插件、mcp 叫行。 */
const STALE_ITEM_LABEL = '技能'

/** `ui` 段里「显示官方项」的字段名。四包的开关语义相同，只是历史键名不同。 */
const SHOW_OFFICIAL_FIELD = 'showOfficialSkills'

/** `ui` 段缺席时的缺省值。 */
const UI_DEFAULTS = { showChip: true, defaultTab: 'groups' }

/** 本包在共享样式表 `T` 上追加的键。函数形式避免在 `T` 初始化前引用它。 */
const T_EXTRA = () => ({})

/** 本包在共享样式表 `S` 上追加的键。 */
const S_EXTRA = () => ({})
