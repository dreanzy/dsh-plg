/**
 * 本包给共享层的取值（见 ADR-0017）。
 *
 * 拼接顺序：本文件 → panel-base.js → panel.js。
 */

/** 未绑定 pack 时 chip 上的字：plugin → plg。 */
const CHIP_LABEL = 'plg'

/** 残留键里「能力项」这一类的名字：plugin 关的是插件，所以叫插件。 */
const STALE_ITEM_LABEL = '插件'

/** `ui` 段里「显示官方项」的字段名。 */
const SHOW_OFFICIAL_FIELD = 'showOfficialPlugins'

/** `ui` 段缺席时的缺省值。 */
const UI_DEFAULTS = { showChip: true, defaultTab: 'groups' }

/** 本包在共享样式表 `T` 上追加的键。 */
const T_EXTRA = () => ({ accent: 'var(--dsw-alias-state-business-primary, #4176e6)' })

/** 本包在共享样式表 `S` 上追加的键：核心层没有的 8 个。 */
const S_EXTRA = () => ({
      action: {
        padding: '4px 10px',
        cursor: 'pointer',
        borderRadius: '6px',
        border: '1px solid ' + T.border,
        background: 'transparent',
        color: T.text,
        fontSize: '12px',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      },
      badgeWarn: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'transparent',
        border: '1px solid ' + T.error,
        color: T.error,
        whiteSpace: 'nowrap',
      },
      button: (primary) => ({
        border: primary ? 0 : '1px solid ' + T.border,
        borderRadius: '6px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        background: primary ? T.accent : 'transparent',
        color: primary ? T.onAccent : T.text,
      }),
      confirmNames: {
        marginTop: '8px',
        maxHeight: '180px',
        overflow: 'auto',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: T.text,
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        padding: '6px 8px',
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      /**
       * 吸顶的区块标题。
       *
       * 分包页第二块有几百行，滚到中段时「包内开关：哪张 pack」早就滚出视口了，
       * 而这一块每一行都在往这张 pack 里写决定。标题跟着滚走等于让人盲改。
       * `top: 0` 相对最近的滚动祖先（宿主的设置弹层内容区）；要是宿主自己也吸顶，
       * 这里会被压住——那就只能退回不吸顶，别硬加偏移量去猜。
       */
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
      rowMeta: { color: T.dim, fontSize: '11px', marginTop: '2px' },
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid ' + T.border,
      },
      stat: {
        fontSize: '12px',
        color: T.text,
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + T.border,
        whiteSpace: 'nowrap',
      },
})
