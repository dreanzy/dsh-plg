/**
 * 本包给共享层的取值（见 ADR-0017）。
 *
 * 拼接顺序：本文件 → panel-base.js → client/protocol.js → panel.js。
 */

/** 未绑定 pack 时 chip 上的字：mcp 本就是念字母的专名，恰好同形。 */
const CHIP_LABEL = 'mcp'

/** 残留键里「能力项」这一类的名字：mcp 关的是一行服务器配置。 */
const STALE_ITEM_LABEL = '服务器'

/** `ui` 段里「显示官方项」的字段名。mcp 没有这个开关。 */
const SHOW_OFFICIAL_FIELD = 'showOfficialServers'

/** `ui` 段缺席时的缺省值。 */
const UI_DEFAULTS = { showChip: true, defaultTab: 'groups' }

/** 本包在共享样式表 `T` 上追加的键。 */
const T_EXTRA = () => ({

})

/** 本包在共享样式表 `S` 上追加的键。 */
const S_EXTRA = () => ({
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid ' + T.border,
      },
      /** 分包页的一行：行头常驻，点开才出现四个字段的编辑器。 */
      mono: { fontFamily: 'ui-monospace, monospace' },
      stat: {
        fontSize: '12px',
        color: T.text,
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + T.border,
        whiteSpace: 'nowrap',
      },
      lineHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 4px',
        borderTop: '1px solid ' + T.border,
        cursor: 'pointer',
      },
      rowMeta: { color: T.dim, fontSize: '11px', marginTop: '2px' },
      lineBody: { display: 'grid', gap: '8px', padding: '2px 4px 10px 22px' },
      field: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      fieldLabel: { flex: '0 0 84px', color: T.dim, fontSize: '12px' },
      toolInput: {
        flex: '1 1 320px',
        minWidth: '180px',
        padding: '5px 8px',
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        background: 'transparent',
        color: T.text,
        fontSize: '12px',
      },
})
