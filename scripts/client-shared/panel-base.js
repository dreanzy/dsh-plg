/**
 * 面板的基础层：React、样式、基础组件、以及不依赖条目形状的工具。
 *
 * 这些在四个包里真的相同（`Switch` 不会因为管的是 MCP 行而变形）。协议相关的部分
 * （路径、传输、待保存键、求值对象）在 `panel-protocol.js` 或各包的 `client/protocol.js`。
 *
 * 拼接顺序：`client/prelude.js` → 本文件 → 协议层 → `client/panel.js`。
 */
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** 内置 pack 的 id。未绑定的工作区按它求值。 */
    const DEFAULT_PACK_ID = 'default'

/**
 * 排序档位的序。与 core 的 `RANK_ORDER` 逐字一致——浏览器半边走不了服务端模块，
 * 只能复制；`test/client.test.js` 逐档比对两边，漂移立刻红。
 */
const RANK_ORDER = {
  'explicit-on': 0,
  'explicit-off': 1,
  'follow-on': 2,
  'follow-off': 3,
}
    /** 工作区清单上限：会话一多，绑定表会变成一堵墙。 */
    const MAX_WORKSPACES = 30
    /**
     * chip 的容器查询断点与两态交互样式。
     *
     * 宿主输入框底栏 `.row` 声明了 `container-type: inline-size`，并用
     * `@container (width <= 560px)` 控制这一带按钮的间距。chip 的字号与图标
     * 对齐官方控件后整体变宽，断点相应上调到 640px，仍与官方同步折叠。
     *
     * 用 CSS 容器查询而不是 JS 量宽：插槽把 chip 包在一个与它等宽的容器里，
     * 量父级永远偏小；往上找祖先又依赖具体层级，两种做法都会误判。
     *
     * hover 与 focus 只能写在 CSS 里：内联 style 表达不了伪类。两态各抄官方
     * 对应控件——默认态用 ModelSelect trigger 的 hover，绑定态用 PlanChip 的。
     */
    const CHIP_CSS =
      '.__PREFIX__-chip { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, GrayText); font-weight: 400 }' +
      '.__PREFIX__-chip[data-bound="true"] { border-color: transparent; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-weight: 500 }' +
      '.__PREFIX__-chip:hover { background: var(--dsw-alias-interactive-bg-hover) }' +
      '.__PREFIX__-chip[data-bound="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 6%) }' +
      '.__PREFIX__-chip:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px }' +
      '@container (max-width: 640px) { .__PREFIX__-chip-text { display: none } }'

    /**
     * 面板按钮与待保存标记的样式。
     *
     * 尺寸抄官方设置页的行内操作按钮（`ModelsSection.module.css` 的
     * `.rowActions .secondaryButton`）：高 28px、左右 10px、12px 字、`--dsw-radius-sm`。
     * 颜色一律留在类里：内联写 `background` / `color` 会压掉 `:hover`（ui-baseline 红线 7）。
     *
     * 删除确认态抄官方的危险按钮：浅红底 + 红字，hover 用
     * `--dsw-alias-interactive-bg-hover-danger`。官方二次确认是弹窗，这里压成行内两段，
     * 所以只换底色与字重、不加描边；加重靠底色，靠描边会像被框住的一块错误。
     */
    /**
     * 待保存行的底色。
     *
     * 原先用左侧 `inset` 竖条，真机上它紧贴行首的箭头与文字，`inset` 阴影又没法
     * 给文字让出间距，压字比不标更糟。改成整行浅底：与官方标记「当前项」同一套
     * 做法（pack 行就是浅底），也不会和任何文字抢位置。
     */
    const PENDING_BG =
      'color-mix(in srgb, var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.16)) 55%, transparent)'

    const PANEL_CSS =
      '.__PREFIX__-btn { transition: background 120ms ease, border-color 120ms ease, color 120ms ease }' +
      '.__PREFIX__-btn-secondary { border-color: var(--dsw-alias-border-l1, rgba(127,127,127,0.3)); background: transparent; color: var(--dsw-alias-label-primary, inherit) }' +
      '.__PREFIX__-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) }' +
      // 确认条上的次要按钮：无边框、浅灰底。照官方弹窗的「取消」——透明底 + 描边在浅色面板上
      // 会读成一条黑框，有底色才显得是按钮而不是一个框。
      '.__PREFIX__-btn-quiet { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, inherit) }' +
      '.__PREFIX__-btn-quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)) }' +
      // 主操作：实心。官方弹窗的「保存」就是这个范式（`button-primary-fill` + `label-primary-foreground`）。
      '.__PREFIX__-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff) }' +
      '.__PREFIX__-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #33383f) }' +
      '.__PREFIX__-btn-danger { border-color: transparent; background: transparent; color: var(--dsw-alias-state-error-primary, #c0392b) }' +
      '.__PREFIX__-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.12)) }' +
      // 确认态照官方的 dangerButton：无边框，只换底色与字重。
      // 官方没有任何"加红描边"的危险按钮，那是我自己发明的，观感上像被框住的一块错误。
      '.__PREFIX__-btn-danger[data-armed="true"] { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.14)); color: var(--dsw-alias-state-error-primary, #c0392b); font-weight: 500 }' +
      '.__PREFIX__-btn-danger[data-armed="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.22)) }' +
      '.__PREFIX__-btn:disabled { opacity: 0.4; cursor: default }' +
      '.__PREFIX__-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px }' +
      /*
       * 可点行的底色与 hover 全走类。
       *
       * 这几行的底色原本是内联写的（当前项灰底 / 待保存浅蓝），内联会压掉 `:hover`
       * ——红线 7 那条坑。改成 `data-state` 交给 CSS，两种状态与 hover 才能共存。
       */
      '.__PREFIX__-row { transition: background 120ms ease; cursor: pointer }' +
      '.__PREFIX__-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)) }' +
      '.__PREFIX__-row[data-state="current"] { background: rgba(127,127,127,0.16) }' +
      '.__PREFIX__-row[data-state="pending"] { background: ' + PENDING_BG + ' }'

    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface:
        'var(--dsw-alias-bg-layer-1, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      // 不用 --dsw-alias-state-idle-primary：暗色主题下它解析成接近白色，
      // 与白色圆点叠成一条纯白胶囊，开/关完全看不出来。这里用固定的半透明灰，
      // 再给轨道加一圈内描边，暗色与亮色下都有轮廓。
      idle: 'rgba(127, 127, 127, 0.38)',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
      onAccent: '#ffffff',
      /*
       * 开关配色照官方「反色」风格：开态轨道取前景色（暗色主题下是亮白），圆点取底色
       * （近黑）；关态轨道是中灰、圆点是浅圆点。反色在亮暗两套主题里都成立，
       * 也不依赖品牌色——品牌色在主题里存在与否不确定，撞色时开关就废了。
       */
      track: 'var(--dsw-alias-label-primary, #e6e6e6)',
      trackOff: 'rgba(127, 127, 127, 0.30)',
      knob: 'var(--dsw-alias-bg-layer-1, #111111)',
      knobOff: 'rgba(255, 255, 255, 0.92)',
      /*
       * 待保存行的底色。
       *
       * 原先用左侧 `inset` 竖条，真机上它紧贴行首的箭头与文字，`inset` 阴影又没法
       * 给文字让出间距，压字比不标更糟。改成整行浅底：与官方标记「当前项」同一套
       * 做法（pack 行就是浅底），也不会和任何文字抢位置。
       */
      pendingBg: PENDING_BG,
      // 各包追加的样式键（见 client/prelude.js 的 T_EXTRA）。
      ...T_EXTRA(),
    }

    const S = {
      title: { fontSize: '15px', fontWeight: 600, color: T.text },
      hint: { color: T.dim, fontSize: '12px', lineHeight: 1.6 },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '14px 0 10px' },
      input: {
        flex: '1 1 200px',
        minWidth: '160px',
        padding: '6px 8px',
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        background: 'transparent',
        color: T.text,
        fontSize: '13px',
      },
      // 分段控件照官方：容器不画整条外框，每个选项是各自独立的小按钮；
      // 选中项用浅底 + 更亮的文字，而不是整块品牌色——官方设置页就是这个观感，
      // 品牌色实心块在暗色主题下会盖掉周围所有信息。
      segment: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
      segItem: (active) => ({
        padding: '4px 10px',
        cursor: 'pointer',
        borderRadius: '6px',
        border: '1px solid ' + (active ? T.borderStrong : T.border),
        background: active ? 'rgba(127, 127, 127, 0.22)' : 'transparent',
        color: active ? T.text : T.dim,
        fontSize: '12px',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
      }),
      group: { borderRadius: '8px', border: '1px solid ' + T.border, marginBottom: '8px' },
      groupHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', cursor: 'pointer' },
      groupName: { fontWeight: 600, flex: '1 1 auto', color: T.text },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'transparent',
        border: '1px solid ' + T.border,
        color: T.dim,
        whiteSpace: 'nowrap',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 10px 6px 22px',
        borderTop: '1px solid ' + T.border,
      },
      rowMain: { flex: '1 1 auto', minWidth: 0 },
      rowName: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', color: T.text },
      origin: {
        marginLeft: '6px',
        padding: '0 4px',
        fontSize: '10px',
        fontFamily: 'inherit',
        color: T.dim,
        border: '1px solid ' + T.border,
        borderRadius: '3px',
        whiteSpace: 'nowrap',
      },
      groupInput: {
        flex: '1 1 auto',
        minWidth: '80px',
        fontWeight: 600,
        fontSize: '13px',
        color: T.text,
        background: 'transparent',
        border: '1px solid ' + T.border,
        borderRadius: '4px',
        padding: '2px 6px',
      },
      rowDesc: { color: T.dim, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      sw: (on, disabled) => ({
        width: '36px',
        height: '20px',
        borderRadius: '999px',
        border: 0,
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: on ? T.track : T.trackOff,
        position: 'relative',
        flex: '0 0 auto',
        transition: 'background 140ms ease',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: on ? T.knob : T.knobOff,
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
        transition: 'left 140ms ease, background 140ms ease',
      }),
      /**
       * 行内操作按钮的尺寸与排布。颜色、hover、危险态全部在 `PANEL_CSS` 里——
       * 内联写 `background` / `color` 会压掉 CSS 的 `:hover`（ui-baseline 红线 7）。
       * 尺寸对齐官方设置页行内按钮：高 28px、左右 10px、12px 字、radius-sm。
       */
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 10px',
        borderWidth: '.5px',
        borderStyle: 'solid',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      /**
       * 底部停靠区：提示行 + 待保存条。贴住面板底边，内容再长也一直看得见。
       * 分隔线只在停靠区顶沿画一条，内部两行之间不再加线。
       */
      dock: {
        position: 'sticky',
        bottom: 0,
        zIndex: 20,
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      },
      /** 提示行：警告色浅底，右侧一个关闭。 */
      noticeBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(245,158,11,0.14))',
      },
      /** 待保存条：不贴边，位置由 `dock` 决定。 */
      pendingBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 12px',
      },
      /** 弹层里的同一条：不贴边、不画分隔线，交给外层的 `bottomBar`。 */
      pendingInline: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '1 1 auto',
        minWidth: 0,
      },
      /**
       * 弹层的底栏：左「关闭」右「待保存 + 撤销/保存」。
       * 「关闭」位置固定在最左：它一会儿在左一会儿在右，只会让人重新找一次按钮。
       */
      bottomBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '14px',
        paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      },
      /*
       * 自绘下拉。原生 <select> 的弹出层由系统绘制，不跟主题：暗色下一点开是一块
       * 蓝底浮层，与官方设置页的语言选择器完全不是一个观感。这里改成按钮 + 浮层。
       */
      pickerTrigger: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
        padding: '5px 8px',
        border: '1px solid ' + T.border,
        borderRadius: '8px',
        background: 'transparent',
        color: T.text,
        fontSize: '12px',
        lineHeight: 1.5,
        cursor: 'pointer',
        textAlign: 'left',
      },
      pickerLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickerMenu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        zIndex: 30,
        padding: '4px',
        borderRadius: '10px',
        border: '1px solid ' + T.border,
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, Canvas))',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
        maxHeight: '260px',
        overflowY: 'auto',
      },
      pickerItem: (active, hover) => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '12px',
        color: T.text,
        cursor: 'pointer',
        background: active || hover ? 'rgba(127, 127, 127, 0.18)' : 'transparent',
      }),
      error: { color: T.error, fontSize: '12px', marginBottom: '8px' },
      empty: { color: T.faint, padding: '12px 4px', fontSize: '12px' },
      /**
       * 需要用户注意但不阻断的提示（残留键、宿主能力缺失）。
       *
       * 与另外两包同形：浅黄底 + 黄字 + 描边。用 `S.hint` 代替它会让这类提示
       * 与普通说明文字长得一样，用户扫过去不会停。
       */
      probeWarn: {
        marginTop: '8px',
        padding: '6px 10px',
        borderRadius: '6px',
        border: '1px solid ' + T.warn,
        background: 'rgba(183,121,31,0.10)',
        color: T.warn,
        fontSize: '12px',
        lineHeight: 1.6,
      },
      modalBack: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      },
      modal: {
        width: 'min(560px, 92vw)',
        maxHeight: '78vh',
        // 下拉浮层要溢出弹层边缘，裁切会把它切掉一半；内容本来就短，不需要滚动。
        overflow: 'visible',
        background: T.surface,
        color: T.text,
        border: '1px solid ' + T.borderStrong,
        borderRadius: '12px',
        padding: '16px 18px',
        boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
        fontSize: '13px',
      },
      /**
       * 吸顶的区块标题。
       *
       * 分包页第二块有几百行，滚到中段时「包内开关：哪张 pack」早就滚出视口了，
       * 而这一块每一行都在往这张 pack 里写决定。标题跟着滚走等于让人盲改。
       * `top: 0` 相对最近的滚动祖先（宿主的设置弹层内容区）；要是宿主自己也吸顶，
       * 这里会被压住——那就只能退回不吸顶，别硬加偏移量去猜。
       */
      blockTitleSticky: {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        padding: '6px 0',
        marginBottom: '6px',
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        fontSize: '12px',
        fontWeight: 600,
        color: T.text,
      },
      block: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid ' + T.border },
      blockTitle: { fontSize: '12px', fontWeight: 600, color: T.text, marginBottom: '6px' },
      packRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        border: '1px solid ' + T.border,
        marginBottom: '6px',
      },
      path: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: T.dim, wordBreak: 'break-all' },
      /**
       * chip 的尺寸与排布。颜色、字重、hover、focus 全部在 `CHIP_CSS` 里。
       *
       * 尺寸对齐官方输入框右侧控件（ModelSelect trigger / PlanChip）：高 28px、
       * 字号 13px、圆角 `--dsw-radius-sm`（8px）。两态尺寸必须一致，否则绑定与
       * 解绑时 chip 会横向跳动。
       *
       * 颜色为什么不在内联里：内联 style 的优先级压过任何类选择器，写了
       * `background` 之后 `:hover` 就永远不会生效。内联只留布局，颜色交给
       * 类选择器，hover 才有机会盖上去。
       */
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        maxWidth: '140px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      },
      /**
       * 文字要能缩：`text-overflow` 在内联的 button 上不生效，
       * 必须落在真正被裁的那个 flex item 上，且 `min-width: 0` 才肯缩。
       */
      chipText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 各包追加的样式键（见 client/prelude.js 的 S_EXTRA）。
      ...S_EXTRA(),
    }

    /**
     * 极小的可观测量。
     *
     * 设置页改的是持久化配置，槽位注册却发生在 `apply` 里，两者在 React 上没有
     * 父子关系，改完不会自动重挂；chip 在会话页、设置页在设置弹层里，同理。
     * 一个 set/subscribe 就够了，不引任何状态库。
     */
    function createSignal(initial) {
      let value = initial
      const listeners = new Set()
      return {
        read: () => value,
        set: (next) => {
          if (value === next) return
          value = next
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * 跨组件共享的界面状态。
     *
     * `showChip` 由 `apply` 订阅：设置页拨动后立刻挂上或摘下槽位。
     * `chipName` 是 chip 上显示的 pack 名。
     */
    const env = {
      onChipChange: null,
      sessionId: undefined,
    }
    const chipName = createSignal(null)

    // CHIP_LABEL 来自 `client/prelude.js`：chip 上的缩写是各包对外的口径。

    // ---------- 基础组件 ----------

    /**
     * 策略文件的告警。
     *
     * 写入失败不再是错误信封：它和既有的读告警一样，跟着视图的 `warnings` 回来，
     * 所以面板得有一处能看见。默认折起只显示条数——正常情况一条都没有，出现时才
     * 占位置；展开才列出全文。
     */
    function Warnings(props) {
      const [open, setOpen] = useState(false)
      const list = Array.isArray(props.warnings) ? props.warnings : []
      if (list.length === 0) return null
      return h(
        'div',
        { style: { marginTop: '8px' } },
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': open,
            style: { ...S.badge, cursor: 'pointer' },
            onClick: () => setOpen(!open),
          },
          (open ? '▾ ' : '▸ ') + list.length + ' 条告警',
        ),
        open
          ? h(
              'div',
              { style: { ...S.hint, marginTop: '4px' } },
              list.map((warning, index) => h('div', { key: index }, warning)),
            )
          : null,
      )
    }

    /** 残留键的种类标签。键空间不同，混着显示用户分不清是能力项还是组。 */
    const STALE_KIND_LABEL = { item: STALE_ITEM_LABEL, group: '分组', assignment: '归属' }

    /**
     * 残留键的提示与清理入口。
     *
     * 与 plugin-pack 同形：默认折叠，展开后每个键一行，带种类与「出现在哪些 pack 里」，
     * 并给清理按钮。清理走待保存改动，用户能先试算看到要删多少条再决定落盘。
     */
    function StaleKeys(props) {
      const [open, setOpen] = useState(false)
      const entries = Array.isArray(props.entries) ? props.entries : []
      if (entries.length === 0) return null

      /** 一个残留键对应的清理命令：按种类发不同的 op，键空间不同不能合并。 */
      const commandsFor = (entry) => {
        if (entry.kind === 'assignment') return [{ op: 'assign', name: entry.key, groupId: null }]
        if (entry.kind === 'group') {
          return (entry.packs || []).map((packId) => ({ op: 'packGroup', packId: packId, groupId: entry.key, value: null }))
        }
        return (entry.packs || []).map((packId) => ({ op: 'packItem', packId: packId, name: entry.key, value: null }))
      }

      const collapsed = entries.length > 6
      const shown = open || !collapsed ? entries : entries.slice(0, 6)

      return h(
        'div',
        { style: S.probeWarn },
        h(
          'div',
          null,
          entries.length + ' 个键在策略里、当前名册里没有。已保留不删（重新装回来时决定还在），也可以现在清掉：',
        ),
        h(
          'div',
          { style: { marginTop: '6px' } },
          shown.map((entry) =>
            h(
              'div',
              {
                key: entry.kind + ':' + entry.key,
                style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' },
              },
              h('span', { style: S.badge }, STALE_KIND_LABEL[entry.kind] || entry.kind),
              h(
                'span',
                { style: { fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word', flex: '1 1 auto' } },
                entry.key,
              ),
              h(
                'span',
                { style: { ...S.hint, flex: '0 0 auto' } },
                Array.isArray(entry.packs) && entry.packs.length > 0 ? entry.packs.join('、') : '全局',
              ),
              h(Button, { variant: 'secondary', onClick: () => props.onClear(commandsFor(entry)) }, '清理'),
            ),
          ),
        ),
        h(
          'div',
          { style: { marginTop: '6px', display: 'flex', gap: '8px' } },
          collapsed
            ? h(Button, { variant: 'quiet', onClick: () => setOpen(!open) }, open ? '收起' : '展开全部 ' + entries.length + ' 个')
            : null,
          h(Button, { variant: 'quiet', onClick: () => props.onClear(entries.flatMap(commandsFor)) }, '清理全部 ' + entries.length + ' 个'),
        ),
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          'aria-pressed': props.on,
          title: props.title || (props.on ? '已开启' : '已关闭'),
          disabled: props.disabled,
          style: S.sw(props.on, props.disabled),
          onClick: props.disabled ? undefined : () => props.onChange(!props.on),
        },
        h('span', { style: S.knob(props.on) }),
      )
    }

    function Segmented(props) {
      return h(
        'div',
        { style: S.segment },
        props.options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              style: S.segItem(props.value === option.value),
              onClick: () => props.onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * 三态开关：开 / 关 / 跟随。
     *
     * 「跟随」必须是独立可点的第三个选项：显式关掉与「不表态」是两件事，
     * 用「点两次循环」或和「开」共用一个按钮都表达不出来。选中态沿用分段控件的
     * 浅底样式，不引新样式。
     */
    const TRI_STATE = [
      { value: 'on', label: '开', title: '显式打开（压过组）' },
      { value: 'off', label: '关', title: '显式关闭（压过组）' },
      { value: 'follow', label: '跟随', title: '不记录，按组与默认求值' },
    ]

    function triStateOf(value, allowInherit) {
      if (value === true) return 'on'
      if (value === false) return 'off'
      // default pack 没有上一层：未记录就是取内置缺省（开），显示成「开」而不是「跟随」。
      return allowInherit === false ? 'on' : 'follow'
    }

    function TriState(props) {
      // `default` 是求值链的终点，没有「跟随」可言；两态就够，多一个按钮反而让人
      // 以为还能往上找。
      const allowInherit = props.allowInherit !== false
      const active = triStateOf(props.value, allowInherit)
      const options = allowInherit ? TRI_STATE : TRI_STATE.filter((option) => option.value !== 'follow')
      return h(
        'div',
        { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', flex: '0 0 auto' } },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              title: option.title,
              'aria-pressed': active === option.value,
              disabled: props.disabled,
              style: {
                ...S.segItem(active === option.value),
                /*
                 * 三态是这个面板里点得最多的控件。原来是 11px 字 + 2px 7px 内距，
                 * 热区只有 19px 高——比被抱怨"太小"的删除按钮还小一截。
                 * 高度按官方控件档位取 24px（一排三个，28 会显得笨重）。
                 */
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                height: '24px',
                padding: '0 10px',
                fontSize: '12px',
                lineHeight: '18px',
                opacity: props.disabled ? 0.45 : 1,
                cursor: props.disabled ? 'not-allowed' : 'pointer',
              },
              onClick: () => {
                if (props.disabled) return
                props.onChange(option.value === 'on' ? true : option.value === 'off' ? false : null)
              },
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * 面板按钮。颜色全部在 `PANEL_CSS` 里，这里只给尺寸与语义。
     *
     * 尺寸抄官方设置页的行内操作按钮（28px 高、左右 10px、12px 字、radius-sm），
     * 比原来的裸文字热区大一倍以上——裸文字只有字号那么高，指针要精确压住才点得中。
     */
    function Button(props) {
      const variant = props.variant || (props.danger === true ? 'danger' : 'secondary')
      const className = '__PREFIX__-btn __PREFIX__-btn-' + variant
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled === true,
          className: className,
          style: { ...S.btn, ...(props.style || {}) },
          title: props.title || '',
          ref: props.innerRef,
          'data-armed': variant === 'danger' && props.armed === true ? 'true' : undefined,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /**
     * 删除的二次确认：第一次点变成「确认」（浅红底 + 红字），再点一次才执行。
     *
     * 不用弹窗：这类删除都发生在列表行里，弹窗要额外一次「关闭」动作；
     * 行内二次确认把成本压到一次点击，误点的代价只是多看一眼。
     * 进入确认态后 4 秒自动撤销，点别处也撤销，避免一直停在危险状态。
     *
     * 删除是唯一「点了就没了」的动作（不进待保存队列，见 ADR 0006），
     * 所以确认态必须比常态明显：文案换成「确认」、红字、浅红底。
     */
    function ConfirmButton(props) {
      const [armed, setArmed] = useState(false)
      const boxRef = useRef(null)
      const disabled = props.disabled === true
      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [armed])
      useEffect(() => {
        if (!armed) return undefined
        const onDown = (event) => {
          const node = boxRef.current
          if (node && node.contains(event.target)) return
          setArmed(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [armed])
      return h(
        Button,
        {
          danger: true,
          armed: armed,
          disabled: disabled,
          innerRef: boxRef,
          style: props.style,
          title: armed ? '再点一次确认删除' : props.title || '',
          onClick: (event) => {
            event.stopPropagation()
            if (disabled) return
            if (!armed) {
              setArmed(true)
              return
            }
            setArmed(false)
            props.onConfirm()
          },
        },
        armed ? props.confirmLabel || '确认' : props.label || '删除',
      )
    }

    /**
     * 面板内输入框的 Esc 只作用于输入框自己，不冒泡。
     *
     * 宿主的设置弹层把 Esc 当「关闭面板」：改名途中按 Esc 想反悔，
     * 结果整个面板关掉，改了一半的名字也一起没了。
     */
    function stopEscape(event) {
      if (event.key === 'Escape') event.stopPropagation()
    }

    /** 每条命令命中哪一格状态。同键后写覆盖，队列里永远只有最后一次取值。 */
    /**
     * 待保存期间的组名回溯表：组 id → 改动前的名字。
     *
     * 冻结的是「排序键」，不是视图。组 id 与行键都不变，只有分组名要回溯——否则改完名
     * 的那一组会立刻跳到新位置，下一次点击就落在别的组上。也不能用 `base` 的数组位置
     * 当序：列表平时按名字排，两者顺序本来就不同，那样一进待保存状态反而会重排一次。
     *
     * `frozen` 为 false 时返回空表，调用方按当前名字排即可。
     */
    function frozenGroupNames(base, frozen) {
      const map = new Map()
      if (!frozen) return map
      const groups = base && base.groups && Array.isArray(base.groups.groups) ? base.groups.groups : []
      for (const group of groups) {
        if (group && typeof group.id === 'string') map.set(group.id, group.name)
      }
      return map
    }

    function createQueue(keyOf) {
      let entries = []
      let uid = 0

      const set = (next) => {
        entries = next
        return next
      }

      return {
        get entries() {
          return entries
        },
        get count() {
          return entries.length
        },
        /** 被改动命中的键，供行渲染标出「这一行还没保存」。 */
        keys() {
          const set = new Set()
          for (const entry of entries) if (entry.key !== null) set.add(entry.key)
          return set
        },
        commands() {
          return entries.map((entry) => entry.command)
        },
        push(commands) {
          const list = Array.isArray(commands) ? commands : [commands]
          const next = entries.slice()
          for (const command of list) {
            const key = keyOf(command)
            if (key !== null) {
              for (let index = next.length - 1; index >= 0; index -= 1) {
                if (next[index].key === key) next.splice(index, 1)
              }
            }
            uid += 1
            next.push({ id: uid, key: key, command: command })
          }
          return set(next)
        },
        undo() {
          return set(entries.slice(0, -1))
        },
        discard() {
          return set([])
        },
        /** 换一个新引用但内容不变：删除是另一条写盘路径，队列没变也要重算一次试算。 */
        touch() {
          return set(entries.slice())
        },
        /** 丢掉命中 predicate 的命令，返回丢掉的条数。 */
        drop(predicate) {
          const victims = entries.filter((entry) => predicate(entry.command))
          if (victims.length === 0) return 0
          set(entries.filter((entry) => !predicate(entry.command)))
          return victims.length
        },
      }
    }

    /**
     * 待保存改动。
     *
     * 点一下只入队，不发写请求；队列非空时每次变化都用 `dryRun` 试算一次，
     * 拿服务端算好的视图来渲染——浏览器不复制求值链。
     * 点「保存」才把整批命令写盘。
     *
     * 队列活在这一次挂载里：关闭面板即丢。跨面板保留会被「我到底存了没」拖住，
     * 而用户关掉面板再回来时通常已经不记得点过什么了。
     *
     * 这里只剩两件需要 React 的事：试算的世代号与提交。队列规则全在 `createQueue`，
     * 因此可以脱离渲染直接测。
     */
    function usePending(options) {
      const queueRef = useRef(null)
      if (queueRef.current === null) queueRef.current = createQueue(pendingKey)
      const queue = queueRef.current
      const [entries, setEntries] = useState(queue.entries)
      const [preview, setPreview] = useState({ data: null, loading: false, error: null })
      const seq = useRef(0)
      const latest = useRef(options)
      latest.current = options

      useEffect(() => {
        if (entries.length === 0) {
          // 队列空了就让上一次在途的试算作废，避免它的响应把视图改回「有改动」。
          seq.current += 1
          setPreview({ data: null, loading: false, error: null })
          return
        }
        const mine = (seq.current += 1)
        setPreview((prev) => ({ data: prev.data, loading: true, error: null }))
        latest.current.preview(queue.commands()).then(
          (data) => {
            if (mine === seq.current) setPreview({ data: data, loading: false, error: null })
          },
          (error) => {
            if (mine === seq.current) {
              setPreview((prev) => ({ data: prev.data, loading: false, error: String(error.message || error) }))
            }
          },
        )
      }, [entries])

      /** 把队列的新数组交给 React：队列自己同步持有同一份，事件回调里读到的永远是最新。 */
      const apply = useCallback((next) => {
        setEntries(next)
        return next
      }, [])

      const push = useCallback((commands) => apply(queue.push(commands)), [apply, queue])
      const undo = useCallback(() => apply(queue.undo()), [apply, queue])
      const discard = useCallback(() => apply(queue.discard()), [apply, queue])
      const refresh = useCallback(() => apply(queue.touch()), [apply, queue])

      const resetPreview = useCallback(() => {
        seq.current += 1
        setPreview({ data: null, loading: false, error: null })
      }, [])

      const drop = useCallback(
        (predicate) => {
          const dropped = queue.drop(predicate)
          if (dropped > 0) apply(queue.entries)
          return dropped
        },
        [apply, queue],
      )

      const commit = useCallback(async () => {
        const commands = queue.commands()
        if (commands.length === 0) return true
        try {
          const data = await latest.current.apply(commands)
          apply(queue.discard())
          latest.current.onApplied(data)
          return true
        } catch (error) {
          setPreview((prev) => ({ ...prev, error: String(error.message || error) }))
          return false
        }
      }, [apply, queue])

      const keys = useMemo(() => queue.keys(), [entries, queue])

      return {
        entries: entries,
        keys: keys,
        preview: preview,
        push: push,
        undo: undo,
        discard: discard,
        drop: drop,
        refresh: refresh,
        resetPreview: resetPreview,
        commit: commit,
        count: entries.length,
      }
    }

    /** 停靠区上方那一行提示：说清楚发生了什么，给一个关掉它的入口。 */
    function NoticeBar(props) {
      return h(
        'div',
        { style: S.noticeBar },
        h(
          'span',
          {
            style: {
              ...S.hint,
              flex: '1 1 auto',
              minWidth: 0,
              color: 'var(--dsw-alias-state-warn-label, #b7791f)',
            },
          },
          props.text,
        ),
        h(Button, { variant: 'quiet', onClick: props.onClose, title: '关闭提示' }, '关闭'),
      )
    }

    /** 底部待保存条：左计数与错误，右「撤销 / 放弃全部 / 保存」。 */
    function PendingBar(props) {
      if (props.count === 0) return null
      const busy = props.busy === true
      // 设置页里贴住底边（内容很长，要一直看得见）；弹层里不贴，由外层底栏排布。
      const inline = props.inline === true
      const style = inline ? S.pendingInline : S.pendingBar
      return h(
        'div',
        { style: style },
        // 弹层里「关闭」占住最左，这里先把空位弹开，让文字与按钮一起靠右。
        inline ? h('span', { key: 'spacer', style: { flex: '1 1 auto' } }) : null,
        h(
          'span',
          {
            style: { ...S.hint, flex: inline ? '0 0 auto' : '1 1 auto', color: props.error ? T.error : undefined },
          },
          props.error ? '未保存：' + props.error : '已改 ' + props.count + ' 项，尚未保存',
        ),
        h(Button, { variant: 'quiet', onClick: props.onUndo, disabled: busy }, '撤销'),
        // 只有一项时「撤销」与「放弃全部」做的是同一件事，多一个按钮只是多一次选择。
        props.count > 1
          ? h(Button, { variant: 'quiet', onClick: props.onDiscard, disabled: busy }, '放弃全部')
          : null,
        h(Button, { variant: 'primary', onClick: props.onCommit, disabled: busy }, busy ? '保存中…' : '保存'),
      )
    }

    function Chevron() {
      return h(
        'svg',
        {
          width: 10,
          height: 10,
          viewBox: '0 0 10 10',
          'aria-hidden': true,
          style: { flex: '0 0 auto', opacity: 0.65 },
        },
        h('path', {
          d: 'M2.5 4L5 6.5L7.5 4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          fill: 'none',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * 下拉选择器。
     *
     * `options` 是 `[{ value, label }]`。点外部或按 Esc 关闭：监听挂在文档上，
     * 不依赖父级的点击处理，所以嵌在可点击的列表行里也不会误触。
     */
    function Picker(props) {
      const [open, setOpen] = useState(false)
      const [hover, setHover] = useState(null)
      const boxRef = useRef(null)
      const options = Array.isArray(props.options) ? props.options : []
      let current = null
      for (const option of options) {
        if (option.value === props.value) current = option
      }
      const label = current === null ? props.placeholder || '' : current.label

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = boxRef.current
          if (node && node.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      return h(
        'div',
        { ref: boxRef, style: { position: 'relative', minWidth: props.minWidth || '120px' } },
        h(
          'button',
          {
            type: 'button',
            style: { ...S.pickerTrigger, ...(props.triggerStyle || {}) },
            title: props.title || label,
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            onClick: (event) => {
              event.stopPropagation()
              setOpen(!open)
            },
          },
          h('span', { style: S.pickerLabel }, label),
          h(Chevron),
        ),
        open
          ? h(
              'div',
              { style: S.pickerMenu, role: 'listbox' },
              options.map((option) =>
                h(
                  'div',
                  {
                    key: option.value,
                    role: 'option',
                    'aria-selected': option.value === props.value,
                    style: S.pickerItem(option.value === props.value, hover === option.value),
                    onMouseEnter: () => setHover(option.value),
                    onMouseLeave: () => setHover(null),
                    onClick: (event) => {
                      event.stopPropagation()
                      setOpen(false)
                      props.onChange(option.value)
                    },
                  },
                  h('span', { style: S.pickerLabel }, option.label),
                  option.value === props.value ? h('span', { style: { opacity: 0.9 } }, '✓') : null,
                ),
              ),
            )
          : null,
      )
    }

    // ---------- 宿主与求值 ----------

    /**
     * 取 `ctx.remote`。
     *
     * 服务是否在 `ctx` 上由 `inject` 决定：声明了才可能有值。但 `ctx.get` 对取不到
     * 的已声明服务是**抛错**而不是返回 undefined，所以探测必须包 try/catch——
     * 这一行漏了会让整个 client 模块加载失败，桌面端直接起不来。
     * 取不到就退化成 `remote: null`：工作区页会空着（目录清单就来自 `remote`），
     * 其它页照常工作。
     */
    function createHost(ctx) {
      let remote = null
      try {
        remote = (ctx && ctx.remote) || null
      } catch {
        remote = null
      }
      if (remote === null || !remote.session) {
        try {
          const session = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined
          if (session) remote = { session: session }
        } catch {
          // 取不到就保持 null。
        }
      }
      return { ctx: ctx, remote: remote }
    }

    /**
     * 工作区键归一，必须与服务端 `normalizeCwd` 逐字节一致：
     * 反斜杠转正斜杠、去尾斜杠、Windows 下转小写、盘符根保留尾斜杠（`c:/`）。
     * 这里只用它回读 `bindings`；发出去的 cwd 保持原样，由服务端自己归一。
     */
    function normalizeCwd(cwd) {
      if (typeof cwd !== 'string') return null
      const trimmed = cwd.trim()
      if (trimmed === '') return null
      let unified = trimmed.replace(/\\/gu, '/')
      if (isWindows()) unified = unified.toLowerCase()
      if (unified.length > 1) {
        const stripped = unified.replace(/\/+$/u, '')
        if (stripped === '') return '/'
        return /^[a-z]:$/iu.test(stripped) ? stripped + '/' : stripped
      }
      return unified
    }

    /**
     * 绑定命令的待保存键。
     *
     * 服务端按归一化后的 cwd 落盘，所以「这一行有没有未保存改动」也必须按归一化后的
     * cwd 查。两边各写一遍时 Windows 上必然不等（`C:\\x` vs `c:/x`），
     * 待保存标记永不出现。
     */
    function bindKeyOf(cwd) {
      const key = normalizeCwd(cwd)
      return 'bind:' + (key === null ? cwd : key)
    }

    function isWindows() {
      try {
        if (typeof process !== 'undefined' && process && typeof process.platform === 'string') {
          return process.platform === 'win32'
        }
      } catch {
        // 浏览器里没有 process。
      }
      try {
        return typeof navigator !== 'undefined' && /windows/i.test(String(navigator.userAgent || ''))
      } catch {
        return false
      }
    }

    /** 读绑定：先精确匹配；历史键大小写不同时再比一次小写。 */
    function bindingOf(bindings, cwd) {
      if (!bindings || !bindings.bindings) return null
      const key = normalizeCwd(cwd)
      if (key === null) return null
      const exact = bindings.bindings[key]
      if (typeof exact === 'string') return exact
      const lower = key.toLowerCase()
      for (const candidate of Object.keys(bindings.bindings)) {
        if (candidate.toLowerCase() === lower) return bindings.bindings[candidate]
      }
      return null
    }

    function hasPack(packs, id) {
      if (typeof id !== 'string') return false
      for (const pack of packs || []) {
        if (pack.id === id) return true
      }
      return false
    }

    function packById(packs, id) {
      if (!Array.isArray(packs)) return null
      for (const pack of packs) {
        if (pack.id === id) return pack
      }
      return packs.length > 0 ? packs[0] : null
    }

    function defaultPackOf(packs) {
      for (const pack of packs || []) {
        if (pack.id === DEFAULT_PACK_ID) return pack
      }
      return null
    }

    /**
     * 名册的显示序。
     *
     * 服务端已按名字排好（`default` 恒置顶），这里只在待保存期间覆盖成改动前的 id 序：
     * 改名会让那张 pack 立刻跳到新位置，下一次点击就落在别的 pack 上——与分组、行
     * 同一条规则。新建的 pack 不在改动前的序里，落到末尾，同档沿用服务端的名字序
     * （`Array.prototype.sort` 稳定）。
     */
    function packLabel(pack) {
      if (pack === null || pack === undefined) return ''
      return pack.builtin === true || pack.id === DEFAULT_PACK_ID ? '默认' : pack.name
    }

    /**
     * 分包页读的是**选中那张 pack 的原始记录**，不是工作区求值链。
     *
     * 两者不是一回事：服务端行上的 `itemWorkspace` / `rank` 按**工作区绑定的** pack
     * 算，而分包页让用户逐张编辑 pack——选中哪张由本地状态决定，服务端不知道。
     * 拿绑定 pack 的结论渲染分包页，结果是每张 pack 都显示成同一份值：默认 pack 里
     * 显式关掉的项显示成「开」，其余 pack 全部显示成「跟随」，排序也退化成按名字。
     *
     * 这里只做「读原始记录 + 算档位」，不碰求值链：链（`pack.items ?? pack.groups ??
     * default.items ?? default.groups ?? true`）仍由服务端算，行上的 `open` 就是它。
     */
    function packRankOf(explicit, isDefault, landing) {
      if (explicit === true) return 'explicit-on'
      if (explicit === false) return 'explicit-off'
      if (isDefault) return 'explicit-on'
      return landing ? 'follow-on' : 'follow-off'
    }

    function groupIdOf(row) {
      return row.groupId || null
    }

    function groupNameOf(groups, groupId) {
      for (const group of groups || []) {
        if (group.id === groupId) return group.name
      }
      return '未分组'
    }

    /**
     * `ui` 段。
     *
     * 服务端一定有 `ui`；旧面板靠 `policy` 投影兜底的那条分支随兼容层一起删掉了。
     */
    function compareCwd(left, right) {
      const order = left.localeCompare(right, 'zh', { numeric: true, sensitivity: 'base' })
      return order !== 0 ? order : left < right ? -1 : left > right ? 1 : 0
    }

    /**
     * 已知工作区：从会话列表里取 cwd，排除子代理会话，按路径去重排序。
     *
     * 截断仍按最近使用取舍：先按 `updatedAt` 倒序取前 MAX_WORKSPACES 条，
     * 展示序只由路径决定。取不到会话时返回空列表——面板仍能编辑 pack，
     * 只是工作区清单读不到，其它页照常。
     */
    async function listWorkspaceCwds(host) {
      const session = host && host.remote ? host.remote.session : null
      if (!session || typeof session.list !== 'function') return []
      let result
      try {
        result = await session.list({})
      } catch {
        return []
      }
      if (!result || result.ok !== true) return []
      const items = result.value && Array.isArray(result.value.items) ? result.value.items : []
      const roots = items.filter(
        (item) => item && typeof item.cwd === 'string' && item.cwd !== '' && item.origin !== 'subagent',
      )
      roots.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const cwds = []
      const seen = {}
      for (const item of roots) {
        const key = normalizeCwd(item.cwd)
        if (key === null || seen[key] === true) continue
        seen[key] = true
        cwds.push(item.cwd)
        if (cwds.length >= MAX_WORKSPACES) break
      }
      return cwds.sort((a, b) => compareCwd(normalizeCwd(a), normalizeCwd(b)))
    }
