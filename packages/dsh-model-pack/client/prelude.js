/**
 * 本包给共享层的取值（见 ADR-0017）。
 *
 * 拼接顺序：本文件 → panel-base.js → client/protocol.js → panel.js。
 */

/** 未绑定 pack 时 chip 上的字：model → mdl。 */
const CHIP_LABEL = 'mdl'

/** 残留键里「能力项」这一类的名字。model 没有残留键的概念，这里只为满足共享层。 */
const STALE_ITEM_LABEL = '条目'

/** `ui` 段里「显示官方项」的字段名。model 没有这个开关。 */
const SHOW_OFFICIAL_FIELD = 'showOfficialModels'

/** `ui` 段缺席时的缺省值。 */
const UI_DEFAULTS = { showChip: true, defaultTab: 'packs' }

/** 本包在共享样式表 `T` 上追加的键。 */
const T_EXTRA = () => ({

})

/** 本包在共享样式表 `S` 上追加的键。 */
const S_EXTRA = () => ({
      badgeWarn: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'transparent',
        border: '1px solid ' + T.error,
        color: T.error,
        whiteSpace: 'nowrap',
      },
      reset: {
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        color: T.dim,
        fontSize: '12px',
        padding: '2px 4px',
        minHeight: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      rowMeta: { color: T.dim, fontSize: '12px', marginTop: '3px', lineHeight: 1.5 },
      field: { padding: '6px 0 10px', borderTop: '1px solid ' + T.border },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', marginTop: '8px' },
      fieldRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '4px 10px' },
      fieldLabel: { color: T.dim, fontSize: '11px', minWidth: '64px' },
      notice: { marginTop: '8px', padding: '6px 10px', borderRadius: '6px', border: '1px solid ' + T.border, color: T.dim, fontSize: '12px' },
      fallbackRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '4px 10px 4px 22px' },
      mono: { color: T.faint, fontSize: '11px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
      probeFail: {
        marginTop: '8px',
        padding: '6px 10px',
        borderRadius: '6px',
        border: '1px solid ' + T.error,
        background: 'rgba(192,57,43,0.10)',
        color: T.error,
        fontSize: '12px',
        lineHeight: 1.6,
      },
      disabledSection: { opacity: 0.5, pointerEvents: 'none', userSelect: 'none' },
      /**
       * 行内操作按钮的尺寸与排布。颜色、hover、危险态全部在 `PANEL_CSS` 里——
       * 内联写 `background` / `color` 会压掉 CSS 的 `:hover`（ui-baseline 红线 7）。
       * 尺寸对齐官方设置页行内按钮：高 28px、左右 10px、12px 字、radius-sm。
       */
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '88px',
        padding: '6px 8px',
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        background: 'transparent',
        color: T.text,
        fontSize: '12px',
        lineHeight: 1.6,
        fontFamily: 'inherit',
        resize: 'vertical',
      },
      // 分段控件照官方：容器不画整条外框，每个选项是各自独立的小按钮；
      // 选中项用浅底 + 更亮的文字，而不是整块品牌色——官方设置页就是这个观感。
      section: { borderRadius: '8px', border: '1px solid ' + T.border, marginBottom: '8px' },
      rowFirst: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px',
        borderBottom: '1px solid ' + T.border,
      },
      root: { fontSize: '13px', color: T.text },
      hero: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },

      delta: { padding: '3px 0', fontSize: '12px', color: T.text, lineHeight: 1.6 },
})
