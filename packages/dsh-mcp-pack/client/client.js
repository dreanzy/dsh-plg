/**
 * 浏览器半边。手写单文件：宿主用 `require('react')` 提供 React，
 * 因此不引入 JSX、CSS Modules 或打包器，避免给这个仓库加第二套构建链。
 *
 * 结构照抄 `dsh-plugin-pack`：设置页三页（分组 | 分包 | 工作区），chip 是当前工作区
 * 绑定 pack 的摘要与切换入口。本包的差异集中在「分包」页：
 *
 *   1. 一行不是一个布尔，而是一组字段（enabled / mode / tools / description），
 *      所以行默认折叠，展开后才出现四个字段的编辑器；
 *   2. 组级只决定开合，不设 mode——「组说 dynamic、行说 disabled」的合并规则没有
 *      廉价答案，四个字段只留在行级。
 *
 * 求值链全部在服务端；这里只负责把 pack 的决定读出来、画出来、按命令写回去：
 *
 *   pack.rows[行][字段] ?? pack.groups[组] ?? default.rows[行][字段] ?? 内置默认
 *
 * 「跟随」与「写了个同值」是两件事：跟随看的是 pack 里有没有这条键，不是值比没比平。
 * 回到跟随的写法是给 `packRow` 的那一个字段发 `null`。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-mcp-pack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PANEL_ID = 'mcp-pack'
    const CHIP_ID = 'mcp-pack-chip'
    const MODAL_ID = 'mcp-pack-chip-modal'
    const TITLE = 'MCP Pack'
    /** 内置 pack 的 id。未绑定的工作区按它求值。 */
    const DEFAULT_PACK_ID = 'default'
    /** 工作区清单上限：会话一多，绑定表会变成一堵墙。 */
    const MAX_WORKSPACES = 30

    /** 三档加载方式。取值与服务端 `types.ts` 的 `MODES` 一致，顺序即 UI 顺序。 */
    const MODES = ['eager', 'dynamic', 'lazy']
    const MODE_LABELS = { eager: '全部加载', dynamic: '动态插入', lazy: '延迟加载' }
    const DEFAULT_MODE = 'dynamic'

    /** 三档的一句话说明。分包页常驻，用户不必猜这三项的差别。 */
    const MODE_HELP = [
      {
        mode: 'eager',
        label: '全部加载',
        text: '启动就挂载，工具常驻上下文。最省事，但每轮都带着全部 schema。',
      },
      {
        mode: 'dynamic',
        label: '动态插入',
        text: '默认不加载；mcp_load 之后把可见工具原生注册进本会话。推荐。',
      },
      {
        mode: 'lazy',
        label: '延迟加载',
        text: '默认不加载；mcp_load 只返回参数表，调用走 mcp_call。工具列表永不变，请求前缀缓存不失效。',
      },
    ]

    /**
     * chip 文字隐藏的断点。
     *
     * 宿主输入框底栏 `.row` 声明了 `container-type: inline-size`，并用
     * `@container (width <= 560px)` 控制这一带按钮的间距。跟随同一个断点，
     * chip 就和官方那几个按钮同步折叠，而不是各自算一套阈值。
     *
     * 用 CSS 容器查询而不是 JS 量宽：插槽把 chip 包在一个与它等宽的容器里，
     * 量父级永远偏小；往上找祖先又依赖具体层级，两种做法都会误判。
     */
    const CHIP_CSS = '@container (max-width: 560px) { .dsh-mcp-pack-chip-text { display: none } }'

    // ---------- 传输 ----------

    const PATHS = {
      global: '/api/mcp-pack/global',
      workspace: '/api/mcp-pack/workspace',
      apply: '/api/mcp-pack/apply',
      diag: '/api/mcp-pack/diag',
      servers: '/api/mcp-pack/servers',
    }

    /**
     * 五个路由共用一套信封：{ ok: true, value } 或 { ok: false, error }。
     * HTTP 状态恒为 200，所以判定只能看 ok 字段，不能看 response.ok。
     */
    async function post(path, body) {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      } catch (error) {
        throw new Error('网络请求失败：' + String(error))
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('响应不是合法 JSON（HTTP ' + response.status + '）')
      }
      if (payload && payload.ok === true) return payload.value
      const message = payload && payload.error && payload.error.message ? payload.error.message : '请求失败'
      throw new Error(message)
    }

    const api = {
      // 带上当前会话：服务端优先用它的 scope 读清单，否则会退回到「恰好排第一的那个会话」。
      global: (sessionId) => post(PATHS.global, sessionId ? { sessionId: sessionId } : {}),
      workspace: (sessionId) => post(PATHS.workspace, { sessionId: sessionId }),
      apply: (commands, sessionId) =>
        post(PATHS.apply, sessionId ? { sessionId: sessionId, commands: commands } : { commands: commands }),
      diag: () => post(PATHS.diag, {}),
      servers: (payload) => post(PATHS.servers, payload),
    }

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token。
     *
     * 宿主的真实前缀是 `--dsw-`（不是 `--dsh-`），且全部 token 都要求浅色与深色两套取值，
     * 底色用 `--dsw-alias-bg-layer-1`，不用 `--dsw-alias-bg-overlay`：后者在暗色主题下
     * 绑定的是 neutral-bluish-700（中灰），弹窗会比页面亮一大截；它的语义是「半透明
     * 浮层」，本来也不该当卡片底。layer-1 与页面同色，界线交给边框与阴影。
     */
    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      // 不用 --dsw-alias-state-idle-primary：暗色主题下它解析成接近白色，
      // 与白色圆点叠成一条纯白胶囊，开/关完全看不出来。这里用固定的半透明灰，
      // 再给轨道加一圈内描边，暗色与亮色下都有轮廓。
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
      /*
       * 开关配色照官方「反色」风格：开态轨道取前景色（暗色主题下是亮白），圆点取底色
       * （近黑）；关态轨道是中灰、圆点是浅圆点。反色在亮暗两套主题里都成立，
       * 也不依赖品牌色——品牌色在主题里存在与否不确定，撞色时开关就废了。
       */
      track: 'var(--dsw-alias-label-primary, #e6e6e6)',
      trackOff: 'rgba(127, 127, 127, 0.30)',
      knob: 'var(--dsw-alias-bg-layer-1, #111111)',
      knobOff: 'rgba(255, 255, 255, 0.92)',
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
      /** 行内的动作按钮（新建、添加、关闭）：与分段按钮同观感，不引新样式。 */
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
      reset: {
        padding: 0,
        margin: 0,
        border: 'none',
        background: 'transparent',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
      },
      stat: {
        fontSize: '12px',
        color: T.text,
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + T.border,
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
      rowName: {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: T.text,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        // server 名是开关的键，必须完整显示：own:x 与 global:x 同名的场景真实存在，
        // 短名会让人分不清关的是哪一个。长名允许折行，不做省略号。
        wordBreak: 'break-all',
      },
      rowDesc: { color: T.dim, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { color: T.dim, fontSize: '11px', marginTop: '2px' },
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
      reset: { border: 0, background: 'transparent', cursor: 'pointer', color: T.dim, fontSize: '12px', padding: '2px 4px' },
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
      error: { color: T.error, fontSize: '12px', marginTop: '8px' },
      empty: { color: T.faint, padding: '12px 4px', fontSize: '12px' },
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
        // 下拉浮层要溢出弹层边缘，裁切会把它切掉一半；内容长了由内层自己滚。
        overflow: 'visible',
        background: T.surface,
        color: T.text,
        border: '1px solid ' + T.borderStrong,
        borderRadius: '12px',
        padding: '16px 18px',
        boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
        fontSize: '13px',
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
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 8px',
        borderRadius: '999px',
        border: '1px solid ' + T.border,
        background: 'transparent',
        color: T.text,
        fontSize: '11px',
        cursor: 'pointer',
      },
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid ' + T.border,
      },
      /** 分包页的一行：行头常驻，点开才出现四个字段的编辑器。 */
      lineHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 4px',
        borderTop: '1px solid ' + T.border,
        cursor: 'pointer',
      },
      lineBody: { display: 'grid', gap: '8px', padding: '2px 4px 10px 22px' },
      field: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      fieldLabel: { flex: '0 0 84px', color: T.dim, fontSize: '12px' },
      mono: { fontFamily: 'ui-monospace, monospace' },
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
      reset: {
        padding: 0,
        margin: 0,
        border: 'none',
        background: 'transparent',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
      },
    }

    function ConfirmButton(props) {
      const [armed, setArmed] = useState(false)
      const disabled = props.disabled === true
      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [armed])
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled,
          style: armed
            ? { ...S.reset, color: T.error, fontWeight: 600, whiteSpace: 'nowrap' }
            : props.style || S.reset,
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
        armed ? props.confirmLabel || '删除' : props.label || '✕',
      )
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
        get: () => value,
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
      showChip: true,
      onChipChange: null,
      sessionId: undefined,
    }
    const chipName = createSignal(null)
    /**
     * 未绑定 pack 时 chip 上的字。
     *
     * 跟宿主的语言走：中文下「默认」比 `Default` 自然。取不到语言服务就退回英文，
     * 不让 chip 因为一个文案取不到而消失。
     */
    const chipFallback = createSignal('Default')

    // ---------- 基础组件 ----------

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
      { value: 'on', label: '开', title: '显式打开（压过组与 default）' },
      { value: 'off', label: '关', title: '显式关闭（压过组与 default）' },
      { value: 'follow', label: '跟随', title: '不记录，按组与 default 求值' },
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
                fontSize: '11px',
                padding: '2px 7px',
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

    function Chevron(props) {
      const open = props && props.open === true
      return h(
        'svg',
        {
          width: 10,
          height: 10,
          viewBox: '0 0 10 10',
          'aria-hidden': true,
          style: {
            flex: '0 0 auto',
            opacity: 0.65,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 120ms ease',
          },
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
          h(Chevron, { open: open }),
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

    /**
     * 文本字段：失焦或按 Enter 才提交。
     *
     * 逐字符发请求会把服务器打满，也会让每次响应把正在输入的光标顶掉。本地草稿在
     * 未聚焦时跟随外部值，聚焦时只认用户输入。
     */
    function TextField(props) {
      const [text, setText] = useState(props.value)
      const focused = useRef(false)
      // Esc 是「放弃这一格」：blur 会紧跟着触发，得先立一个标记让那次 blur 不提交。
      const skip = useRef(false)
      useEffect(() => {
        if (!focused.current) setText(props.value)
      }, [props.value])
      const commit = () => {
        if (text === props.value) return
        props.onCommit(text)
      }
      return h('input', {
        style: props.style || S.input,
        value: text,
        placeholder: props.placeholder,
        'aria-label': props.label,
        onChange: (event) => setText(event.target.value),
        onFocus: () => {
          focused.current = true
        },
        onBlur: () => {
          focused.current = false
          if (skip.current) {
            skip.current = false
            return
          }
          commit()
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.target.blur()
          if (event.key === 'Escape') {
            skip.current = true
            setText(props.value)
            event.target.blur()
          }
        },
      })
    }

    /**
     * MCP 用的图标：两条横排 + 左侧圆点，与 skill / plugin 的图标区分开。
     *
     * 输入的右侧一排 chip 只靠图标辨认，用同一组宫格会把「找 MCP 设置」变成逐个读文字。
     */
    function McpiIcon(props) {
      const size = props && props.size ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2, y: 2.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
        h('rect', { x: 2, y: 9.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
        h('circle', { cx: 4.6, cy: 4.5, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 4.6, cy: 11.5, r: 1, fill: 'currentColor' }),
      )
    }

    // ---------- 宿主与求值 ----------

    /**
     * 取 `ctx.remote`。
     *
     * 服务是否在 `ctx` 上由 `inject` 决定：声明了才可能有值。但 `ctx.get` 对取不到
     * 的已声明服务是**抛错**而不是返回 undefined，所以探测必须包 try/catch——
     * 这一行漏了会让整个 client 模块加载失败，桌面端直接起不来。
     * 取不到就退化成 `remote: null`，工作区清单只剩 extra 里的路径，其它功能照常。
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

    // ---------- 数据读取 ----------

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

    /** 视图字段的宽容读：服务端还没投影时退回空表，不让整页渲染崩掉。 */
    function rowsOf(data) {
      return data && Array.isArray(data.rows) ? data.rows : []
    }

    function groupsOf(data) {
      const groups = data && data.groups ? data.groups : null
      if (groups === null || !Array.isArray(groups.groups)) return { groups: [], assignments: {} }
      return {
        groups: groups.groups,
        assignments: groups.assignments && typeof groups.assignments === 'object' ? groups.assignments : {},
      }
    }

    function bindingsOf(data) {
      const bindings = data && data.bindings ? data.bindings : null
      if (bindings === null || typeof bindings !== 'object') return { bindings: {}, extra: [] }
      return {
        bindings: bindings.bindings && typeof bindings.bindings === 'object' ? bindings.bindings : {},
        extra: Array.isArray(bindings.extra) ? bindings.extra : [],
      }
    }

    /** `ui` 段兼容读：新服务端给 `ui`，缺字段时按内置缺省。 */
    function uiOf(view) {
      const ui = view && view.ui ? view.ui : null
      return {
        showChip: !ui || ui.showChip !== false,
        defaultTab: ui && typeof ui.defaultTab === 'string' ? ui.defaultTab : 'groups',
      }
    }

    /**
     * 行的稳定键：`own:<name>` / `global:<name>`。
     *
     * pack 的 rows 以它为键，所以这个字符串本身就是发出去的命令的一部分——不做任何
     * 归一化（大小写、前后缀都不动）。
     */
    function rowKeyOf(row) {
      if (row && typeof row.rowKey === 'string' && row.rowKey !== '') return row.rowKey
      return row && typeof row.key === 'string' ? row.key : ''
    }

    function rowNameOf(row) {
      if (row && typeof row.serverName === 'string' && row.serverName !== '') return row.serverName
      if (row && typeof row.name === 'string' && row.name !== '') return row.name
      return rowKeyOf(row)
    }

    function rowTransportOf(row) {
      return row && row.transport === 'stdio' ? 'stdio' : 'HTTP'
    }

    function isOwned(row) {
      return Boolean(row) && (row.owned === true || row.source === 'managed')
    }

    function rowSourceOf(row) {
      if (!row) return ''
      if (row.source === 'managed') return '托管'
      return typeof row.source === 'string' ? row.source : ''
    }

    /** 一行求值后的结果；服务端没给 `resolved` 时按行上的平铺字段降级。 */
    function resolvedOf(row) {
      const resolved = row && row.resolved && typeof row.resolved === 'object' ? row.resolved : null
      const source = resolved !== null ? resolved : row || {}
      return {
        enabled: source.enabled !== false,
        mode: MODE_LABELS[source.mode] ? source.mode : DEFAULT_MODE,
        tools: Array.isArray(source.tools) ? source.tools : [],
        description: typeof source.description === 'string' ? source.description : '',
      }
    }

    function rowDescriptionOf(row) {
      const description = resolvedOf(row).description
      if (description !== '') return description
      return row && typeof row.definition === 'string' ? row.definition : ''
    }

    /** pack 里某行的原始条目；没有条目返回 null（整行跟随）。 */
    function policyOf(pack, rowKey) {
      const rows = pack && pack.rows && typeof pack.rows === 'object' ? pack.rows : null
      const entry = rows === null ? null : rows[rowKey]
      return entry && typeof entry === 'object' ? entry : null
    }

    /**
     * 一条行条目里某字段的显式值；没有键返回 null（跟随）。
     *
     * 空串与缺席等价（描述与工具规则都是这个语义），所以空串也返回 null。
     * 取值规则只写一处：pack 条目与 `defaultEntry` 都走它。
     */
    function entryField(entry, field) {
      if (entry === null || entry === undefined) return null
      const value = entry[field]
      if (field === 'enabled') return typeof value === 'boolean' ? value : null
      if (field === 'mode') return typeof value === 'string' && value !== '' ? value : null
      if (field === 'tools') return Array.isArray(value) ? value : null
      if (field === 'description') return typeof value === 'string' && value !== '' ? value : null
      return null
    }

    /** pack 里某行某字段的显式值；没有键返回 null（跟随）。 */
    function fieldOf(pack, rowKey, field) {
      return entryField(policyOf(pack, rowKey), field)
    }

    /**
     * MCP 页的编辑目标：default pack 里这一行的原始条目。
     *
     * 服务端把每行的 `defaultEntry` 一起投影下来；没带这个字段的老快照退回 default
     * pack 自己的 rows——两者语义相同，后者只是少一次序列化。
     */
    function defaultEntryOf(row, defaultPack) {
      const entry = row && row.defaultEntry
      if (entry !== null && typeof entry === 'object') return entry
      return policyOf(defaultPack, rowKeyOf(row))
    }

    /** pack 里的组级显式值；没有键返回 null（跟随）。 */
    function groupValueOf(pack, groupId) {
      const groups = pack && pack.groups && typeof pack.groups === 'object' ? pack.groups : null
      const value = groups === null ? undefined : groups[groupId]
      return typeof value === 'boolean' ? value : null
    }

    /**
     * 这一行属于哪个组。
     *
     * 优先用行上的 `groupId`；行上没带时退回组注册表的 `assignments`——两处都读
     * 才不会因为服务端少投影一个字段就把整页显示成「未分组」。指向未知组时按
     * 未分组处理（那是悬空引用，不是分组）。
     */
    function groupOfRow(groups, row) {
      const own = row && typeof row.groupId === 'string' && row.groupId !== '' ? row.groupId : null
      const fromMap = groups.assignments[rowKeyOf(row)] || null
      const gid = own !== null ? own : fromMap
      if (gid === null) return null
      for (const group of groups.groups) {
        if (group.id === gid) return gid
      }
      return null
    }

    function groupNameOf(registry, gid) {
      for (const group of registry || []) {
        if (group.id === gid) return group.name
      }
      return '未分组'
    }

    /** 组级开合：`null` 表示该层不表态。 */
    function groupFlagOf(pack, gid) {
      if (!pack || !pack.groups || typeof gid !== 'string') return null
      const value = pack.groups[gid]
      return typeof value === 'boolean' ? value : null
    }

    /**
     * 某行「跟随」时会落到的开合值。
     *
     * 链与 src 一致：本 pack 组级 → default 行级 → default 组级 → 开。
     * （问这个问题时，本 pack 的行级已经是「没记录」。）
     */
    function inheritEnabledOf(pack, defaultPack, groups, row) {
      const gid = groupOfRow(groups, row)
      const byGroup = groupFlagOf(pack, gid)
      if (byGroup !== null) return byGroup
      const fromRow = fieldOf(defaultPack, rowKeyOf(row), 'enabled')
      if (fromRow !== null) return fromRow
      const fromDefaultGroup = groupFlagOf(defaultPack, gid)
      if (fromDefaultGroup !== null) return fromDefaultGroup
      return true
    }

    /**
     * 排序档位：显式开 0、显式关 1、跟随且落到开 2、跟随且落到关 3。
     *
     * 跟随要按「实际会落到哪」再分一次：两种跟随在界面上长得一样，但一个等于开、
     * 一个等于关，混在同一档里用户没法按状态扫读。
     *
     * `default` 没有上一层，它的「未记录」就等于开，所以直接归 0——否则同一屏会
     * 出现「排在跟随档、按钮却亮在开上」的错位。
     */
    function rankOf(value, isDefault, inherit) {
      if (value === true) return 0
      if (value === false) return 1
      if (isDefault) return 0
      return inherit ? 2 : 3
    }

    /**
     * 已知工作区：从会话列表里取 cwd，排除子代理会话，按最近更新倒序去重，
     * 当前会话所在目录置顶。取不到会话时返回空列表——面板仍能编辑 pack，
     * 只是工作区页里只剩手动添加的路径。
     */
    async function listWorkspaceCwds(host, sessionId) {
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
      let pinned = null
      if (typeof sessionId === 'string' && sessionId !== '') {
        for (const item of roots) {
          const id = item.sessionId ?? item.id ?? (item.session && item.session.id)
          if (id === sessionId) {
            pinned = item.cwd
            break
          }
        }
      }
      roots.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const cwds = []
      if (pinned !== null) cwds.push(pinned)
      for (const item of roots) {
        if (cwds.indexOf(item.cwd) < 0) cwds.push(item.cwd)
        if (cwds.length >= MAX_WORKSPACES) break
      }
      return cwds
    }

    // ---------- 面板 ----------

    /** 一次全量读取 + 一次写命令的落回。所有页面共用同一份视图。 */
    function useGlobalView() {
      const [state, setState] = useState({ loading: true, error: null, data: null })

      const load = useCallback(async () => {
        try {
          const data = await api.global(env.sessionId)
          setState({ loading: false, error: null, data: data })
          return data
        } catch (error) {
          setState({ loading: false, error: String(error.message || error), data: null })
          return null
        }
      }, [])

      useEffect(() => {
        let alive = true
        setState((prev) => ({ loading: prev.data === null, error: null, data: prev.data }))
        // 面板可能被渲染在任意路由下，但这是一次显式的全量读取，不需要防抖。
        api.global(env.sessionId).then(
          (data) => {
            if (alive) setState({ loading: false, error: null, data: data })
          },
          (error) => {
            if (alive) setState({ loading: false, error: String(error.message || error), data: null })
          },
        )
        return () => {
          alive = false
        }
      }, [load])

      const run = useCallback(
        async (commands) => {
          try {
            const data = await api.apply(commands)
            setState({ loading: false, error: null, data: data })
            // 绑定改了要把 chip 上的 pack 名一起更新：chip 直接读当前会话的工作区视图，
            // 与设置页之间没有通道，只能在这里主动重读一次。
            if (commands.some((command) => command.op === 'bind')) refreshChipName(env.sessionId)
            return true
          } catch (error) {
            setState((prev) => ({ ...prev, error: String(error.message || error) }))
            await load()
            return false
          }
        },
        [load],
      )

      return { state: state, run: run, reload: load }
    }

    /** 新建分组。组定义跨工作区共享，建一次处处可用。 */
    function GroupCreator(props) {
      const [name, setName] = useState('')
      const submit = () => {
        const trimmed = name.trim()
        if (trimmed === '') return
        props.onCreate(trimmed)
        setName('')
      }
      return h(
        'div',
        { style: { marginBottom: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('input', {
          style: { ...S.input, flex: '0 0 200px' },
          placeholder: '新分组名',
          value: name,
          onChange: (event) => setName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
          },
        }),
        h('button', { type: 'button', style: S.action, onClick: submit }, '新建分组'),
        h('span', { style: S.hint }, '分组对全部 pack 共享；这里改的是成员归属，不是开关。'),
      )
    }

    // ---------- 弹层 ----------

    /**
     * 当前 pack 相对 default 的差异：分组在上，行在下。
     *
     * 只列「记录过、且与 default 取值不同」的键。没有键是「不表态」，与 default
     * 同值的记录不改变任何结果——两者都不算「差在哪」。
     */
    function diffOf(data) {
      const packs = Array.isArray(data.packs) ? data.packs : []
      const pack = packById(packs, data.packId)
      const fallback = defaultPackOf(packs)
      const groups = groupsOf(data)
      const rows = []
      // 组已从注册表删掉时没有名字可显示：那是悬空引用，不是差异。
      for (const group of groups.groups) {
        const own = groupValueOf(pack, group.id)
        if (own === null) continue
        const base = groupValueOf(fallback, group.id)
        if (own === (base === null ? true : base)) continue
        rows.push({ key: 'group:' + group.id, isGroup: true, name: group.name, on: own, fields: [] })
      }
      for (const row of rowsOf(data)) {
        const rowKey = rowKeyOf(row)
        if (rowKey === '') continue
        const entry = policyOf(pack, rowKey)
        if (entry === null) continue
        const baseEntry = policyOf(fallback, rowKey)
        const item = { key: 'row:' + rowKey, isGroup: false, name: rowNameOf(row), on: null, fields: [] }
        if (typeof entry.enabled === 'boolean') {
          const baseEnabled = baseEntry && typeof baseEntry.enabled === 'boolean' ? baseEntry.enabled : true
          if (entry.enabled !== baseEnabled) item.on = entry.enabled
        }
        // 行级还有三档字段：只要有一个与 default 不同，就把字段名标出来。
        // `null` 与缺席同义（服务端删键后可能留下 null），都不算记录过。
        if (hasKey(entry, 'mode') && entry.mode !== baseModeOf(baseEntry)) item.fields.push('mode')
        if (hasKey(entry, 'tools') && !sameRules(entry.tools, baseRulesOf(baseEntry))) item.fields.push('tools')
        if (hasKey(entry, 'description') && (entry.description || '') !== baseDescriptionOf(baseEntry)) {
          item.fields.push('description')
        }
        if (item.on === null && item.fields.length === 0) continue
        rows.push(item)
      }
      return rows
    }

    /** 字段有没有被记录过；`null` 与 `undefined` 都按「没记录」处理。 */
    function hasKey(entry, key) {
      return entry !== null && entry[key] !== undefined && entry[key] !== null
    }

    function baseModeOf(entry) {
      return entry && typeof entry.mode === 'string' && entry.mode !== '' ? entry.mode : DEFAULT_MODE
    }

    function baseRulesOf(entry) {
      return entry && Array.isArray(entry.tools) ? entry.tools : []
    }

    function baseDescriptionOf(entry) {
      return entry && typeof entry.description === 'string' ? entry.description : ''
    }

    function sameRules(left, right) {
      const a = Array.isArray(left) ? left : []
      const b = Array.isArray(right) ? right : []
      if (a.length !== b.length) return false
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false
      }
      return true
    }

    /**
     * chip 的弹层：这张 pack 与默认差在哪，就地切换。
     *
     * 选「默认」发 `packId: null`（解除绑定），不是写一个 default 的 id——
     * 未绑定与悬空引用在服务端是同一种状态。
     */
    function ChipModal(props) {
      const open = props.open === true
      const sessionId = props.sessionId
      const [state, setState] = useState({ loading: false, error: null, data: null })

      useEffect(() => {
        if (!open) return undefined
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let alive = true
        setState((prev) => ({ loading: prev.data === null, error: null, data: prev.data }))
        api.workspace(sessionId).then(
          (data) => {
            if (alive) setState({ loading: false, error: null, data: data })
          },
          (error) => {
            if (alive) setState({ loading: false, error: String(error.message || error), data: null })
          },
        )
        return () => {
          alive = false
        }
      }, [open, sessionId])

      if (!open) return null

      const data = state.data
      const bindTo = (value) => {
        const cwd = data ? data.cwd : null
        if (typeof cwd !== 'string' || cwd === '') return
        // 带 sessionId 才拿得到 WorkspaceView（`binding` / `cwd`）；不带只回 GlobalView。
        api.apply([{ op: 'bind', cwd: cwd, packId: value === DEFAULT_PACK_ID ? null : value }], sessionId).then(
          (view) => {
            setState({ loading: false, error: null, data: view })
            chipName.set(view && view.binding !== null ? view.packName : null)
          },
          (error) => setState((prev) => ({ ...prev, error: String(error.message || error) })),
        )
      }

      // 生效的 pack 就是 default 时没有差异可言：整块只留一句说明。
      const usingDefault = data !== null && (data.binding === null || data.packId === DEFAULT_PACK_ID)
      const rows = data !== null && !usingDefault ? diffOf(data) : []
      const packs = data !== null && Array.isArray(data.packs) ? data.packs : []
      const bound = data !== null && data.binding !== null && hasPack(packs, data.binding) ? data.binding : DEFAULT_PACK_ID

      return h(
        'div',
        { style: S.modalBack, onClick: props.onClose },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          // 插件名常驻在标题上方：这一排 chip 只靠图标区分，弹层里不写明是哪个插件，
          // 从图标点进来的人会先愣一下。
          h('div', { style: { ...S.hint, fontSize: '11px' } }, TITLE),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginTop: '2px' } },
            h('div', { style: S.title }, data === null ? '读取中' : usingDefault ? '默认' : data.packName),
            h('span', { style: { ...S.hint, marginLeft: 'auto' } }, '当前工作区'),
          ),
          state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,
          data === null
            ? h('div', { style: S.empty }, state.loading ? '加载中…' : '读不到当前工作区')
            : h(
                'div',
                { style: { marginTop: '10px' } },
                usingDefault
                  ? h('div', { style: S.hint }, '这个目录没有指定 pack，按默认运行。')
                  : h(
                      'div',
                      null,
                      h('div', { style: { ...S.hint, marginBottom: '4px' } }, '与默认相比'),
                      rows.length === 0
                        ? h('div', { style: S.hint }, '没有任何改动。')
                        : rows.map((row) =>
                            h(
                              'div',
                              {
                                key: row.key,
                                style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' },
                              },
                              h(
                                'span',
                                {
                                  style: row.isGroup
                                    ? { ...S.rowMain, fontWeight: 600, color: T.text }
                                    : { ...S.rowMain, ...S.rowName },
                                },
                                row.name,
                              ),
                              row.on !== null
                                ? h('span', { style: row.on ? S.badge : { ...S.badge, color: T.text } }, row.on ? '开' : '关')
                                : null,
                              row.fields.map((field) =>
                                h('span', { key: field, style: { ...S.badge, ...S.mono } }, field),
                              ),
                            ),
                          ),
                    ),
                h(
                  'div',
                  { style: { ...S.hint, marginTop: '14px', marginBottom: '6px' } },
                  '给这个目录换一张 pack',
                ),
                h(Picker, {
                  value: bound,
                  options: [
                    { value: DEFAULT_PACK_ID, label: '默认' },
                    ...packs
                      .filter((pack) => pack.id !== DEFAULT_PACK_ID)
                      .map((pack) => ({ value: pack.id, label: pack.name })),
                  ],
                  onChange: (next) => bindTo(next),
                }),
                h('div', { style: { ...S.hint, marginTop: '6px' } }, '只影响这个目录里新开的会话。'),
              ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
            h('button', { type: 'button', style: S.action, onClick: props.onClose }, '关闭'),
          ),
        ),
      )
    }

    // ---------- 设置页 ----------

    function SettingRow(props) {
      return h(
        'div',
        { style: S.settingRow },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { color: T.text, fontSize: '13px' } }, props.label),
          props.hint ? h('div', { style: { color: T.dim, fontSize: '11px', marginTop: '2px' } }, props.hint) : null,
        ),
        h(Switch, { on: props.on, onChange: props.onChange }),
      )
    }

    /** 设置页的三页，顺序固定：分组 → 分包 → 工作区。 */
    const TABS = [
      { value: 'servers', label: 'MCP' },
      { value: 'groups', label: '分组' },
      { value: 'packs', label: '分包' },
      { value: 'workspace', label: '工作区' },
    ]

    /**
     * 设置 → MCP Pack。
     *
     * 三页：分组管结构（行与分组），分包管 pack 名册与包内开关，工作区管目录到
     * pack 的绑定。「当前页」与「默认页」是两件事：切页只改当前页，打开设置时落在
     * 哪一页由顶部那组选项写盘（`ui.defaultTab`）——两者混成一个状态时，
     * 「临时看一眼分包」会顺手改掉用户的默认页。
     */
    function SettingsPanel(props) {
      const host = props.host
      const view = useGlobalView()
      const state = view.state
      const run = view.run
      // 当前页只由分页按钮切；初值取 `ui.defaultTab`，之后不再跟随任何外部请求。
      const [tab, setTab] = useState(null)
      const [diag, setDiag] = useState(null)

      useEffect(() => {
        let alive = true
        api.diag().then(
          (value) => {
            if (alive) setDiag(value)
          },
          () => {
            if (alive) setDiag(null)
          },
        )
        return () => {
          alive = false
        }
      }, [])

      // 自检快照含工具清单，序列化不便宜；它只随 diag 变化，不该每次渲染重做一遍。
      const diagText = useMemo(() => (diag === null ? '' : JSON.stringify(diag, null, 2)), [diag])
      const diagLabel =
        diag === null
          ? '运行期自检：适配器、闸门、连接池'
          : '运行期自检：适配器、闸门、连接池（' +
            (diag.toolsRegistered === true
              ? '按需工具已注册'
              : diag.toolsRegistered === false
                ? '按需工具未注册'
                : '已采集') +
            '）'

      const data = state.data
      const ui = uiOf(data)
      const current = tab !== null ? tab : ui.defaultTab

      if (state.loading) return h('div', { style: S.hint }, '加载中…')
      if (!data) return h('div', { style: S.error }, state.error || '读取失败')

      const packs = Array.isArray(data.packs) ? data.packs : []
      const groups = groupsOf(data)
      const rows = rowsOf(data)
      const bindings = bindingsOf(data)
      const warnings = Array.isArray(data.warnings) ? data.warnings : []

      return h(
        'div',
        { style: { fontSize: '13px', color: T.text } },
        h('div', { style: S.title }, TITLE),

        h(
          'div',
          { style: { ...S.hint, marginTop: '8px' } },
          '一张 pack 是一套具名策略：工作区绑到哪个 pack，就按哪套开关生效；未绑定按默认。加载方式、工具规则与描述是每台 server 的全局默认，在「MCP」页改；分包页只决定每张 pack 的开关。',
        ),
        data.complete === false
          ? h(
              'div',
              { style: S.probeWarn },
              '行扫描不完整：列表可能缺少条目。这里的开关只对已经发现的行生效，不会抹掉没扫到的决定。',
            )
          : null,
        warnings.length > 0
          ? h('div', { style: S.probeWarn }, '策略文件有告警：' + warnings.slice(0, 4).join('；'))
          : null,

        h(
          'div',
          { style: { ...S.bar, marginTop: '10px', marginBottom: '0' } },
          h('span', { style: S.hint }, '打开设置时默认显示'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '120px' } },
            h(Picker, {
              value: ui.defaultTab,
              options: TABS.map((entry) => ({ value: entry.value, label: entry.label })),
              onChange: (next) => run([{ op: 'defaultTab', value: next }]),
            }),
          ),
        ),
        h('div', { style: { marginTop: '10px' } }, h(Segmented, { value: current, onChange: setTab, options: TABS })),
        state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,
        current === 'groups'
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { marginTop: '12px' } },
                h(SettingRow, {
                  label: '在输入框右侧显示入口',
                  hint: '关掉后会话输入框右侧不再出现 MCP chip；pack 绑定仍可在「工作区」页操作。立刻生效。',
                  on: ui.showChip,
                  onChange: (value) =>
                    run([{ op: 'showChip', value: value }]).then((ok) => {
                      if (!ok) return
                      env.showChip = value
                      if (env.onChipChange) env.onChipChange(value)
                    }),
                }),
              ),
              h(GroupsPage, { rows: rows, groups: groups, run: run }),
            )
          : null,
        current === 'servers'
          ? h(
              'div',
              null,
              h(ServersBlock, { rows: rows, reload: view.reload }),
              h(RowsBoard, { rows: rows, defaultPack: defaultPackOf(packs), run: run, reload: view.reload }),
            )
          : null,
        current === 'packs' ? h(PackSettings, { packs: packs, groups: groups, rows: rows, run: run }) : null,
        current === 'workspace'
          ? h(WorkspacePage, { packs: packs, bindings: bindings, run: run, host: host })
          : null,

        // 运行期自检放页面最末：适配器、闸门、连接池的数字只在排查时看，
        // 顶在标题下面会把正文挤下去。
        h(
          'details',
          { style: { margin: '20px 0 0', borderTop: '1px solid ' + T.border, paddingTop: '10px' } },
          h('summary', { style: { ...S.hint, cursor: 'pointer' } }, diagLabel),
          h(
            'pre',
            {
              style: {
                fontSize: '11px',
                color: T.dim,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                marginTop: '6px',
                maxHeight: '220px',
                overflow: 'auto',
              },
            },
            diagText || '读取中…',
          ),
        ),
      )
    }

    /**
     * 「分组」页：只做结构，不做策略。
     *
     * 按分组折叠展示成员，展开后在行内直接改归属；开关与加载方式都不在这里——它们
     * 属于 pack，由「分包」页按 pack 设置。一页只做一件事，否则同一个开关会有两个入口。
     *
     * 顺序是「新建 → 搜索 → 列表」：新建入口在列表底下时，用户要滚到最底才看得见。
     * 搜索同时匹配分组名——搜「数据库」多半是想找那一组，而不是名字里恰好含这三个
     * 字的行，所以组名命中时整组保留。
     */
    function GroupsPage(props) {
      const rows = props.rows
      const groups = props.groups
      const run = props.run
      const [query, setQuery] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const [editing, setEditing] = useState(null)
      /** 批量归组的目标分组；`''` 表示未分组。 */
      const [bulkGroup, setBulkGroup] = useState('')

      const registry = groups.groups
      const needle = query.trim().toLowerCase()

      const buckets = useMemo(() => {
        const matchRow = (row) =>
          needle === ''
            ? true
            : (rowNameOf(row) + ' ' + rowKeyOf(row) + ' ' + rowDescriptionOf(row)).toLowerCase().indexOf(needle) >= 0
        const byId = new Map()
        const loose = []
        for (const row of rows) {
          const gid = groupOfRow(groups, row)
          if (gid === null) {
            if (matchRow(row)) loose.push(row)
            continue
          }
          if (!byId.has(gid)) byId.set(gid, [])
          byId.get(gid).push(row)
        }
        const byName = (a, b) => rowNameOf(a).localeCompare(rowNameOf(b), 'zh') || rowKeyOf(a).localeCompare(rowKeyOf(b))
        // 未分组恒在最上：新发现的行先落这里，用户第一眼要看到的就是它。
        const out = [{ id: null, name: '未分组', rows: loose.sort(byName) }]
        for (const group of [...registry].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
          const members = byId.get(group.id) || []
          const groupHit = needle !== '' && group.name.toLowerCase().indexOf(needle) >= 0
          out.push({
            id: group.id,
            name: group.name,
            rows: (groupHit ? members : members.filter(matchRow)).sort(byName),
          })
        }
        return out
      }, [rows, groups.groups, groups.assignments, needle])

      const searching = needle !== ''
      const total = buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0)
      /** 当前筛选命中的行（跨分组拍平），批量归组的对象。 */
      const matched = buckets.reduce((list, bucket) => list.concat(bucket.rows), [])
      const assignTo = (row, groupId) =>
        run([{ op: 'assign', rowKey: rowKeyOf(row), groupId: groupId === '' ? null : groupId }])
      // 一次 apply 带上 N 条 assign，只发一条请求：逐个发在几十行时会被乱序返回的
      // 响应来回覆盖。
      const assignAll = () => {
        if (matched.length === 0) return
        run(
          matched.map((row) => ({
            op: 'assign',
            rowKey: rowKeyOf(row),
            groupId: bulkGroup === '' ? null : bulkGroup,
          })),
        )
      }

      return h(
        'div',
        { style: { marginTop: '12px' } },
        h(
          'div',
          { style: { ...S.hint, marginBottom: '6px' } },
          '点分组展开成员，在行内直接改归属。开关与加载方式不在这里——去「分包」页按 pack 设置。',
        ),
        h(GroupCreator, { onCreate: (name) => run([{ op: 'createGroup', name: name }]) }),
        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            placeholder: '搜索 server 名、描述或分组名',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { style: S.hint }, total + ' 行'),
        ),
        h(
          'div',
          { style: { ...S.bar, marginTop: '0' } },
          h('span', { style: S.hint }, '把当前 ' + matched.length + ' 行归到'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '130px' } },
            h(Picker, {
              value: bulkGroup,
              options: [
                { value: '', label: '未分组' },
                ...registry.map((group) => ({ value: group.id, label: group.name })),
              ],
              onChange: (next) => setBulkGroup(next),
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: matched.length === 0,
              style: {
                ...S.segItem(false),
                border: '1px solid ' + T.border,
                borderRadius: '6px',
                opacity: matched.length === 0 ? 0.45 : 1,
                cursor: matched.length === 0 ? 'not-allowed' : 'pointer',
              },
              onClick: assignAll,
            },
            '应用',
          ),
        ),
        buckets.map((bucket) => {
          const key = bucket.id === null ? '__loose' : bucket.id
          // 组一多，全展开会把列表拉成长条：未分组默认展开，其余默认折叠。
          // 搜索时按「这一组有没有命中」决定展开，否则要么摊出一片「（空）」，
          // 要么把命中藏起来。
          const isCollapsed = searching
            ? bucket.rows.length === 0
            : collapsed[key] === undefined
              ? bucket.id !== null
              : collapsed[key] === true
          return h(
            'div',
            { key: key, style: S.group },
            h(
              'div',
              { style: S.groupHead, onClick: () => setCollapsed({ ...collapsed, [key]: !isCollapsed }) },
              h('span', { style: { opacity: 0.5, width: '12px' } }, isCollapsed ? '▸' : '▾'),
              // 未分组的 id 就是 null，与「没有在改名」共享同一个值，所以这里必须
              // 先判 bucket.id !== null，否则未分组一进来就被渲染成输入框。
              bucket.id !== null && editing === bucket.id
                ? h('input', {
                    autoFocus: true,
                    defaultValue: bucket.name,
                    style: S.groupInput,
                    onClick: (event) => event.stopPropagation(),
                    onBlur: (event) => {
                      const trimmed = String(event.target.value || '').trim()
                      setEditing(null)
                      if (trimmed === '' || trimmed === bucket.name) return
                      run([{ op: 'renameGroup', groupId: bucket.id, name: trimmed }])
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.target.blur()
                      if (event.key === 'Escape') {
                        event.target.value = bucket.name
                        event.target.blur()
                      }
                    },
                  })
                : h('span', { style: S.groupName }, bucket.name),
              h('span', { style: S.badge }, bucket.rows.length + ' 行'),
              bucket.id !== null && editing !== bucket.id
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.reset,
                      title: '重命名分组',
                      onClick: (event) => {
                        event.stopPropagation()
                        setEditing(bucket.id)
                      },
                    },
                    '✎',
                  )
                : null,
              bucket.id !== null
                ? h(ConfirmButton, {
                    title: '删除分组（成员回到未分组）',
                    onConfirm: () => run([{ op: 'deleteGroup', groupId: bucket.id }]),
                  })
                : null,
            ),
            isCollapsed
              ? null
              : bucket.rows.length === 0
                ? h('div', { style: { ...S.empty, paddingLeft: '22px' } }, '（空）')
                : bucket.rows.map((row) =>
                    h(
                      'div',
                      { key: rowKeyOf(row), style: S.row },
                      h(
                        'div',
                        { style: S.rowMain },
                        h(
                          'div',
                          { style: S.rowName },
                          rowNameOf(row),
                          h('span', { style: S.badge }, rowTransportOf(row)),
                          isOwned(row) ? h('span', { style: S.badge }, '托管') : null,
                        ),
                        h('div', { style: { ...S.rowDesc, ...S.mono }, title: rowKeyOf(row) }, rowKeyOf(row)),
                        h(
                          'div',
                          { style: S.rowDesc, title: rowDescriptionOf(row) },
                          rowDescriptionOf(row) || '（无描述）',
                        ),
                      ),
                      h(
                        'div',
                        { style: { flex: '0 0 auto', minWidth: '128px' } },
                        h(Picker, {
                          value: bucket.id === null ? '' : bucket.id,
                          options: [
                            { value: '', label: '未分组' },
                            ...registry.map((group) => ({ value: group.id, label: group.name })),
                          ],
                          onChange: (next) => assignTo(row, next),
                        }),
                      ),
                    ),
                  ),
          )
        }),
      )
    }

    /**
     * 「MCP」页的上块：全局行清单。
     *
     * 加载方式、工具规则与描述描述的是「这台 server 怎么加载」，是全局默认值，写进
     * `default` pack；分包页只决定开关。所以这三个字段只有这一个编辑入口，每次失焦
     * 或 Enter 发一条 `packRow` 到 `default`，patch 里只带本次改的那个键——值为 `null`
     * 表示删掉这条键、回到内置缺省。合并规则仍在服务端，这里不做本地推导。
     */
    function RowsBoard(props) {
      const rows = props.rows
      const defaultPack = props.defaultPack
      const run = props.run
      const reload = props.reload
      return h(
        'div',
        { style: S.block },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('div', { style: S.blockTitle }, '加载方式与描述'),
          h('span', { style: S.stat }, rows.length + ' 行'),
        ),
        h('div', { style: { ...S.hint, marginBottom: '8px' } }, '这些是全局默认值，各 pack 只覆盖开关。'),
        // 三档差别是参考信息，折叠起来：这一页的正文是行清单与托管服务器。
        h(
          'details',
          { style: { marginBottom: '8px' } },
          h('summary', { style: { ...S.hint, cursor: 'pointer' } }, '三档加载方式有什么区别'),
          h(
            'div',
            { style: { ...S.hint, marginTop: '4px' } },
            MODE_HELP.map((item) =>
              h(
                'div',
                { key: item.mode },
                h('span', { style: { color: T.text, fontWeight: 600 } }, item.label),
                '：',
                item.text,
              ),
            ),
          ),
        ),
        rows.length === 0
          ? h('div', { style: S.empty }, '还没有发现 MCP 服务器。')
          : rows.map((row) =>
              h(RowEditor, { key: rowKeyOf(row), row: row, defaultPack: defaultPack, run: run, reload: reload }),
            ),
      )
    }

    /** MCP 页的一行：行头常驻，展开后是三个字段的编辑器。 */
    function RowEditor(props) {
      const row = props.row
      const defaultPack = props.defaultPack
      const run = props.run
      const [open, setOpen] = useState(false)
      const rowKey = rowKeyOf(row)
      const entry = defaultEntryOf(row, defaultPack)
      const resolved = resolvedOf(row)
      const mode = entryField(entry, 'mode')
      const tools = entryField(entry, 'tools')
      const description = entryField(entry, 'description')
      const source = rowSourceOf(row)
      const toolCount = resolved.tools.length
      const patch = (delta) => run([{ op: 'packRow', packId: DEFAULT_PACK_ID, rowKey: rowKey, patch: delta }])
      // 托管服务器的连接定义可以就地删掉；只关开关定义仍然在，与删除是两件事。
      const removeOwned = (event) => {
        event.stopPropagation()
        if (!isOwned(row)) return
        api.servers({ op: 'remove', name: rowNameOf(row) }).then(
          () => props.reload(),
          () => {},
        )
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.lineHead, onClick: () => setOpen(!open) },
          h(Chevron, { open: open }),
          h(
            'div',
            { style: S.rowMain },
            h(
              'div',
              { style: S.rowName },
              rowNameOf(row),
              h('span', { style: S.badge }, rowTransportOf(row)),
              source !== '' ? h('span', { style: S.badge }, source) : null,
            ),
            h('div', { style: { ...S.rowMeta, ...S.mono } }, rowKey),
          ),
          h(
            'span',
            {
              style: {
                ...S.hint,
                flex: '0 1 auto',
                minWidth: '80px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'right',
              },
            },
            '当前生效：' + MODE_LABELS[resolved.mode] + (toolCount === 0 ? ' · 工具不限' : ' · 工具 ' + toolCount + ' 条'),
          ),
          isOwned(row)
            ? h(ConfirmButton, {
                // 未确认态用 ✕，与其余三包的删除入口一致；红色只在确认态出现。
                title: '删除这台托管 server 的定义（所有工作区都不再发现它）',
                onConfirm: removeOwned,
                style: { ...S.reset, flex: '0 0 auto' },
              })
            : null,
        ),
        open
          ? h(
              'div',
              { style: S.lineBody },
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }, '加载方式'),
                h(
                  'div',
                  { style: { flex: '0 0 auto', minWidth: '150px' } },
                  h(Picker, {
                    value: mode === null ? '' : mode,
                    options: [{ value: '', label: '跟随' }].concat(
                      MODES.map((item) => ({ value: item, label: MODE_LABELS[item] })),
                    ),
                    onChange: (next) => patch({ mode: next === '' ? null : next }),
                  }),
                ),
                h('span', { style: S.hint }, '跟随 = 不记录，按内置默认（' + MODE_LABELS[DEFAULT_MODE] + '）'),
              ),
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }, '工具规则'),
                h(TextField, {
                  value: (tools === null ? [] : tools).join(', '),
                  placeholder: '留空则不筛工具',
                  label: '工具规则',
                  style: S.toolInput,
                  onCommit: (text) => patch({ tools: parseRules(text) }),
                }),
              ),
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }),
                h(
                  'span',
                  { style: { ...S.hint, flex: '1 1 320px' } },
                  '逗号分隔：read_* 只留匹配项，!delete_* 排除匹配项；清空回到不筛。',
                ),
              ),
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }, '描述'),
                h(TextField, {
                  value: description === null ? '' : description,
                  placeholder: '名册里显示的描述',
                  label: '描述',
                  style: S.input,
                  onCommit: (text) => patch({ description: text.trim() === '' ? null : text }),
                }),
              ),
            )
          : null,
      )
    }

    /**
     * 分包页的一行：只决定开合。
     *
     * 加载方式、工具规则与描述搬去「MCP」页当全局默认值了，这里只剩 enabled 的三态：
     * 显式开/关压过组与 default，「跟随」表示这张 pack 不表态。
     */
    function RowLine(props) {
      const row = props.row
      const pack = props.pack
      const defaultPack = props.defaultPack
      const groups = props.groups
      const isDefault = props.isDefault
      const run = props.run
      const [open, setOpen] = useState(false)
      const rowKey = rowKeyOf(row)
      const gid = groupOfRow(groups, row)
      const enabled = fieldOf(pack, rowKey, 'enabled')
      const source = rowSourceOf(row)
      // 「跟随」不是一种状态值，而是一个待求值的位置：告诉用户它此刻落到开还是关，
      // 否则三态里那个中间项等于什么也没说。
      const inherit = isDefault ? true : inheritEnabledOf(pack, defaultPack, groups, row)
      // 迁移可能把老的三个字段带进非 default 的 pack。MCP 页只读 default，看不到这些
      // 覆盖；这里只提示，绝不删数据。
      const overridden =
        !isDefault &&
        (fieldOf(pack, rowKey, 'mode') !== null ||
          fieldOf(pack, rowKey, 'tools') !== null ||
          fieldOf(pack, rowKey, 'description') !== null)

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.lineHead, onClick: () => setOpen(!open) },
          h(Chevron, { open: open }),
          h(
            'div',
            { style: S.rowMain },
            h(
              'div',
              { style: S.rowName },
              rowNameOf(row),
              h('span', { style: S.badge }, rowTransportOf(row)),
              source !== '' ? h('span', { style: S.badge }, source) : null,
              h('span', { style: S.badge }, gid === null ? '未分组' : groupNameOf(groups.groups, gid)),
            ),
            h('div', { style: { ...S.rowMeta, ...S.mono } }, rowKey),
          ),
          // 三态按钮在可折叠的行头里：拦下冒泡，否则点一次开关就顺手把行折起来。
          h(
            'span',
            { style: { display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: '6px' }, onClick: (event) => event.stopPropagation() },
            enabled === null && !isDefault
              ? h('span', { style: { ...S.hint, whiteSpace: 'nowrap' } }, inherit ? '跟随（开）' : '跟随（关）')
              : null,
            h(TriState, {
              value: enabled,
              allowInherit: !isDefault,
              onChange: (next) => run([{ op: 'packRow', packId: pack.id, rowKey: rowKey, patch: { enabled: next } }]),
            }),
          ),
        ),
        open
          ? h(
              'div',
              { style: S.lineBody },
              h('span', { style: S.hint }, '加载方式、工具规则与描述的全局值在「MCP」页设置；这一行只决定开合。'),
              overridden
                ? h(
                    'span',
                    { style: S.hint },
                    '这张 pack 还覆盖了加载方式/工具规则/描述——它们不影响这里的开关，可在「MCP」页查看全局值。',
                  )
                : null,
            )
          : null,
      )
    }

    /** 工具规则以数组存盘，界面上用逗号分隔的字符串编辑；空列表等价「跟随」。 */
    function parseRules(text) {
      const rules = String(text)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
      return rules.length === 0 ? null : rules
    }

    /**
     * 托管 server 的增删。
     *
     * 这是本包独有的能力（别处没有托管 MCP 连接定义的地方）：删除只动托管文件里的
     * 定义，不动任何开关；新增走同一个 `servers` 路由，成功与否都整页重读一次。
     */
    function ServersBlock(props) {
      const rows = props.rows
      const reload = props.reload
      const [adding, setAdding] = useState(false)
      const [name, setName] = useState('')
      const [transport, setTransport] = useState('stdio')
      const [command, setCommand] = useState('')
      const [args, setArgs] = useState('')
      const [url, setUrl] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const close = () => {
        setAdding(false)
        setName('')
        setCommand('')
        setArgs('')
        setUrl('')
      }

      const submit = () => {
        const trimmed = name.trim()
        if (trimmed === '') {
          setError('先给 server 起个名字')
          return
        }
        const def =
          transport === 'stdio'
            ? {
                transport: 'stdio',
                command: command.trim(),
                args: args
                  .split(/\s+/)
                  .map((item) => item.trim())
                  .filter((item) => item !== ''),
              }
            : { transport: 'streamable-http', url: url.trim() }
        setBusy(true)
        setError('')
        api.servers({ op: 'upsert', name: trimmed, def }).then(
          () => {
            setBusy(false)
            close()
            reload()
          },
          (cause) => {
            setBusy(false)
            setError(String(cause.message || cause))
          },
        )
      }

      return h(
        'div',
        { style: S.block },
        h('div', { style: S.blockTitle }, '新增托管服务器'),
        h(
          'div',
          { style: { ...S.hint, marginBottom: '8px' } },
          '这里维护的是连接定义本身，与 pack 的开关无关：删掉定义，所有工作区都不再发现它；只关开关，定义仍然在。删除入口在上面的行清单里。',
        ),
        adding
          ? h(
              'div',
              { style: { marginTop: '8px' } },
              h(
                'div',
                { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('input', {
                  style: { ...S.input, flex: '1 1 140px' },
                  placeholder: 'serverName（字母数字_-，≤32）',
                  value: name,
                  onChange: (event) => setName(event.target.value),
                }),
                h(
                  'div',
                  { style: { flex: '0 0 auto', minWidth: '120px' } },
                  h(Picker, {
                    value: transport,
                    options: [
                      { value: 'stdio', label: 'stdio' },
                      { value: 'streamable-http', label: 'HTTP' },
                    ],
                    onChange: (next) => setTransport(next),
                  }),
                ),
              ),
              transport === 'stdio'
                ? h(
                    'div',
                    null,
                    h('input', {
                      style: S.input,
                      placeholder: 'command，例如 npx',
                      value: command,
                      onChange: (event) => setCommand(event.target.value),
                    }),
                    h('input', {
                      style: S.input,
                      placeholder: '参数，空格分隔',
                      value: args,
                      onChange: (event) => setArgs(event.target.value),
                    }),
                  )
                : h('input', {
                    style: S.input,
                    placeholder: 'url，例如 http://127.0.0.1:8080/mcp',
                    value: url,
                    onChange: (event) => setUrl(event.target.value),
                  }),
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' } },
                h('button', { type: 'button', style: S.action, onClick: close }, '取消'),
                h('button', { type: 'button', style: S.action, disabled: busy, onClick: submit }, busy ? '保存中…' : '保存'),
              ),
            )
          : h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
              h('button', { type: 'button', style: S.action, onClick: () => setAdding(true) }, '新增服务器'),
            ),
        error ? h('div', { style: S.error }, error) : null,
      )
    }

    /** 「分包」页：包名册 → 包内开关 → 托管服务器，自上而下三块。 */
    function PackSettings(props) {
      const packs = props.packs
      const groups = props.groups
      const rows = props.rows
      const run = props.run
      const defaultPack = defaultPackOf(packs)
      const [selected, setSelected] = useState(DEFAULT_PACK_ID)
      const [query, setQuery] = useState('')
      const [newName, setNewName] = useState('')
      const [editing, setEditing] = useState(null)
      const pack = packById(packs, selected)
      /** `default` 没有上一层，未记录直接显示成「开」，排序也按开算。 */
      const isDefault = pack === null || pack.id === DEFAULT_PACK_ID

      const items = useMemo(() => {
        const needle = query.trim().toLowerCase()
        // 命中组名等于命中整组：在分包页搜「数据库」应该把该组的所有行都筛出来，
        // 而不是因为 server 名里没有这三个字就报没结果。
        const hitGroups = new Set()
        if (needle !== '') {
          for (const group of groups.groups) {
            if (group.name.toLowerCase().indexOf(needle) >= 0) hitGroups.add(group.id)
          }
        }
        const visible =
          needle === ''
            ? [...rows]
            : rows.filter((row) => {
                if ((rowNameOf(row) + ' ' + rowKeyOf(row) + ' ' + rowDescriptionOf(row)).toLowerCase().indexOf(needle) >= 0) {
                  return true
                }
                const gid = groupOfRow(groups, row)
                return gid !== null && hitGroups.has(gid)
              })
        // 顺序是「开 > 关 > 跟随(开) > 跟随(关)」：显式决定过的排在前面，
        // 跟随项再按它会落到开还是关区分。同档按 server 名排。
        return visible.sort((a, b) => {
          const left = rankOf(
            fieldOf(pack, rowKeyOf(a), 'enabled'),
            isDefault,
            inheritEnabledOf(pack, defaultPack, groups, a),
          )
          const right = rankOf(
            fieldOf(pack, rowKeyOf(b), 'enabled'),
            isDefault,
            inheritEnabledOf(pack, defaultPack, groups, b),
          )
          if (left !== right) return left - right
          return rowNameOf(a).localeCompare(rowNameOf(b), 'zh') || rowKeyOf(a).localeCompare(rowKeyOf(b))
        })
      }, [rows, groups, query, pack, defaultPack, isDefault])

      /** 分组同样「开 > 关 > 跟随(开) > 跟随(关)」。 */
      const orderedGroups = useMemo(() => {
        const inheritOf = (gid) => {
          const fromDefault = groupFlagOf(defaultPack, gid)
          return fromDefault === null ? true : fromDefault
        }
        return [...groups.groups].sort((a, b) => {
          const left = rankOf(groupValueOf(pack, a.id), isDefault, inheritOf(a.id))
          const right = rankOf(groupValueOf(pack, b.id), isDefault, inheritOf(b.id))
          if (left !== right) return left - right
          return a.name.localeCompare(b.name, 'zh')
        })
      }, [groups.groups, pack, isDefault])

      const groupCounts = useMemo(() => {
        const counts = {}
        for (const row of rows) {
          const gid = groupOfRow(groups, row)
          if (gid === null) continue
          counts[gid] = (counts[gid] || 0) + 1
        }
        return counts
      }, [rows, groups.groups, groups.assignments])

      if (pack === null) return h('div', { style: S.hint }, '没有可用的 pack')

      const createPack = () => {
        const trimmed = newName.trim()
        if (trimmed === '') return
        run([{ op: 'createPack', name: trimmed }])
        setNewName('')
      }
      const overrides = (entry) =>
        Object.keys(entry.rows || {}).length + Object.keys(entry.groups || {}).length

      return h(
        'div',
        { style: { marginTop: '12px' } },

        // 1. pack 列表
        h(
          'div',
          { style: S.block },
          h('div', { style: S.blockTitle }, 'pack'),
          packs.map((entry) =>
            h(
              'div',
              {
                key: entry.id,
                style: {
                  ...S.packRow,
                  borderColor: entry.id === pack.id ? T.borderStrong : T.border,
                  background: entry.id === pack.id ? 'rgba(127, 127, 127, 0.16)' : 'transparent',
                },
                onClick: () => setSelected(entry.id),
              },
              editing === entry.id
                ? h('input', {
                    autoFocus: true,
                    defaultValue: entry.name,
                    style: S.groupInput,
                    onClick: (event) => event.stopPropagation(),
                    onBlur: (event) => {
                      const trimmed = String(event.target.value || '').trim()
                      setEditing(null)
                      if (trimmed === '' || trimmed === entry.name) return
                      run([{ op: 'renamePack', packId: entry.id, name: trimmed }])
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.target.blur()
                      if (event.key === 'Escape') {
                        event.target.value = entry.name
                        event.target.blur()
                      }
                    },
                  })
                : h(
                  'span',
                  { style: S.groupName, title: entry.builtin ? '未绑定的工作区按它运行' : undefined },
                  entry.name,
                ),
              h('span', { style: S.badge }, overrides(entry) + ' 条覆盖'),
              // `default` 没有改名与删除入口：它是求值链终点，删掉或改个名都会让
              // 「未绑定即默认」失去指代。
              entry.builtin
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      style: S.reset,
                      title: '重命名 pack',
                      onClick: (event) => {
                        event.stopPropagation()
                        setEditing(entry.id)
                      },
                    },
                    '✎',
                  ),
              entry.builtin
                ? null
                : h(ConfirmButton, {
                    title: '删除 pack（指向它的绑定会变成悬空引用，按默认 求值）',
                    onConfirm: () => {
                      run([{ op: 'deletePack', packId: entry.id }])
                      if (entry.id === selected) setSelected(DEFAULT_PACK_ID)
                    },
                  }),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.input, flex: '0 0 200px' },
              placeholder: '新 pack 名',
              value: newName,
              onChange: (event) => setNewName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') createPack()
              },
            }),
            h('button', { type: 'button', style: S.action, onClick: createPack }, '新建 pack'),
          ),
        ),

        // 2. 包内开关：组与行都只决定开合
        h(
          'div',
          { style: S.block },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('div', { style: S.blockTitle }, '包内开关：' + pack.name),
            h('span', { style: S.stat }, rows.length + ' 行'),
          ),
          h(
            'div',
            { style: { ...S.hint, marginBottom: '8px' } },
            '组与行都只决定开合：显式打开/关闭压过上一层，「跟随」表示这张 pack 不表态。加载方式、工具规则与描述是全局默认值，在「MCP」页设置。',
          ),
          groups.groups.length === 0
            ? h('div', { style: S.hint }, '还没有分组。到「分组」页新建，或直接在下面逐行设置。')
            : orderedGroups.map((group) => {
                const value = groupValueOf(pack, group.id)
                const inherited = defaultPack === null ? true : groupValueOf(defaultPack, group.id) !== false
                return h(
                  'div',
                  {
                    key: group.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 0',
                      borderTop: '1px solid ' + T.border,
                    },
                  },
                  h('span', { style: { ...S.groupName, flex: '1 1 auto' } }, group.name),
                  h('span', { style: S.badge }, (groupCounts[group.id] || 0) + ' 行'),
                  value === null && !isDefault
                    ? h('span', { style: { ...S.hint, whiteSpace: 'nowrap' } }, inherited ? '跟随（开）' : '跟随（关）')
                    : null,
                  h(TriState, {
                    value: value,
                    allowInherit: !isDefault,
                    onChange: (next) => run([{ op: 'packGroup', packId: pack.id, groupId: group.id, value: next }]),
                  }),
                )
              }),
          h(
            'div',
            { style: { ...S.bar, marginTop: '10px' } },
            h('input', {
              style: S.input,
              placeholder: '搜索 server 名、描述或分组名',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            h('span', { style: S.hint }, items.length + ' 行'),
          ),
          items.length === 0
            ? h('div', { style: S.empty }, rows.length === 0 ? '还没有发现 MCP 服务器。' : '没有匹配的行')
            : items.map((row) =>
                h(RowLine, {
                  key: rowKeyOf(row),
                  row: row,
                  pack: pack,
                  defaultPack: defaultPack,
                  groups: groups,
                  isDefault: isDefault,
                  run: run,
                }),
              ),
        ),
      )
    }

    /**
     * 「工作区」页：会话 cwd 去重 + 手动添加的路径，每行一个 pack 下拉。
     *
     * 顺序是「说明 → 手动添加 → 列表」：手动添加是入口，放到列表底下等于没有。
     * 绑定只影响该目录下**新开**的会话：策略在会话创建时求值，已经开着的会话不会
     * 因为这里改了绑定就换一套 pack。
     */
    function WorkspacePage(props) {
      const packs = props.packs
      const bindings = props.bindings
      const run = props.run
      const host = props.host
      const [cwds, setCwds] = useState([])
      const [settled, setSettled] = useState(false)
      const [manual, setManual] = useState('')

      useEffect(() => {
        let alive = true
        setSettled(false)
        listWorkspaceCwds(host, env.sessionId).then(
          (list) => {
            if (!alive) return
            setCwds(list)
            setSettled(true)
          },
          () => {
            if (!alive) return
            setCwds([])
            setSettled(true)
          },
        )
        return () => {
          alive = false
        }
      }, [host])

      const extras = Array.isArray(bindings.extra) ? bindings.extra : []
      const paths = []
      const seen = {}
      for (const cwd of [...cwds, ...extras]) {
        if (typeof cwd !== 'string' || cwd === '') continue
        const key = normalizeCwd(cwd)
        if (key === null || seen[key] === true) continue
        seen[key] = true
        paths.push(cwd)
      }

      const addManual = () => {
        const trimmed = manual.trim()
        if (trimmed === '') return
        run([{ op: 'addExtra', cwd: trimmed }])
        setManual('')
      }

      return h(
        'div',
        { style: { marginTop: '12px' } },
        h(
          'div',
          { style: { ...S.hint, marginBottom: '8px' } },
          '绑定只影响该目录下新开的会话；已经开着的会话不换 pack。未绑定即默认。',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' } },
          h('input', {
            style: S.input,
            placeholder: '手动添加路径，例如 D:/work/repo',
            value: manual,
            onChange: (event) => setManual(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') addManual()
            },
          }),
          h('button', { type: 'button', style: S.action, onClick: addManual }, '添加'),
        ),
        !settled
          ? h('div', { style: S.hint }, '读取会话列表…')
          : paths.length === 0
            ? h('div', { style: S.empty }, '没有可绑定的工作区。用上面的输入框手动添加。')
            : paths.map((cwd) => {
                const isExtra = extras.indexOf(cwd) >= 0
                const bound = bindingOf(bindings, cwd)
                // 悬空引用（pack 已删）显示成「跟随 default」，与服务端读侧的行为一致。
                const value = bound !== null && hasPack(packs, bound) ? bound : ''
                return h(
                  'div',
                  {
                    key: cwd,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '6px 0',
                      borderTop: '1px solid ' + T.border,
                    },
                  },
                  h(
                    'div',
                    { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { style: S.path, title: cwd }, cwd),
                    h('div', { style: S.rowDesc }, isExtra ? '手动添加' : '来自会话'),
                  ),
                  h(
                    'div',
                    { style: { flex: '0 0 auto', minWidth: '150px' } },
                    h(Picker, {
                      value: value,
                      options: [
                        { value: '', label: '默认' },
                        ...packs.map((pack) => ({ value: pack.id, label: pack.name })),
                      ],
                      onChange: (next) => run([{ op: 'bind', cwd: cwd, packId: next === '' ? null : next }]),
                    }),
                  ),
                  isExtra
                    ? h(ConfirmButton, {
                        title: '从手动清单移除（不影响已有绑定）',
                        onConfirm: () => run([{ op: 'removeExtra', cwd: cwd }]),
                      })
                    : null,
                )
              }),
      )
    }

    // ---------- 注册 ----------

    /** chip 上的 pack 名：绑到哪个 pack 就显示哪个，未绑定显示「默认」/`Default`。 */
    function refreshChipName(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        chipName.set(null)
        return
      }
      api.workspace(sessionId).then(
        (view) => {
          chipName.set(view && view.binding !== null ? view.packName : null)
        },
        () => {
          // 读不到就退回 Default：chip 本身不能因此消失。
          chipName.set(null)
        },
      )
    }

    return {
      // `remote` 与 `remote.session` 都是独立服务名：只声明 `remote` 拿不到 session。
      // 声明是「服务在不在 ctx 上」的唯一开关；取用仍要 try/catch（ctx.get 对取不到的
      // 已声明服务会抛错）。缺了这两个，工作区清单只剩手动添加的路径。
      // `locale` 只用来判断 chip 的缺省文案该写「默认」还是 Default。
      inject: ['slots', 'remote', 'remote.session', 'locale'],
      apply(ctx) {
        // 兜底：client 模块的 apply 抛错会把 web boot 判成 entry failed，桌面端整个起不来。
        // 任何意外都只降级成「面板不出来」，绝不连坐宿主。
        try {
          const host = createHost(ctx)

          // chip 的缺省文案随宿主语言走。只读一次：语言切换后刷新页面生效——
          // 为一个词多挂一条 locale/change 生命周期不值得。
          try {
            const locale = typeof ctx.get === 'function' ? ctx.get('locale') : null
            const snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
            const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
            chipFallback.set(/^zh/i.test(active) ? '默认' : 'Default')
          } catch {
            // 取不到就保持 Default，chip 照常显示。
          }

          // 组件必须是稳定标识符：内联箭头每次渲染都是新类型，React 会整棵卸载重挂
          // （AGENTS.md 客户端红线 4）。apply 只跑一次，闭包里拿 host 是安全的。
          const SettingsSection = () => h(SettingsPanel, { host: host })
          // 设置页侧栏的图标：宿主给 `settings.section.icon` 留了槽位，按 section 的 id
          // 匹配。不注册就落到 `navIcon(id)` 的通用齿轮上，那一排分不清谁是谁。
          const SettingsIcon = (props) => h(McpiIcon, { size: props && props.size ? props.size : 16 })
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: PANEL_ID, order: 62, label: () => TITLE },
              SettingsSection,
            ),
          )
          ctx.slots.inject('settings.section.icon', () =>
            ctx.slots.register({ name: 'settings.section.icon', id: PANEL_ID }, SettingsIcon),
          )

          // ---------- chip ----------

          let chipOpen = false
          const chipListeners = new Set()
          const notifyChip = () => {
            for (const listener of chipListeners) listener()
          }
          const subscribeChip = (listener) => {
            chipListeners.add(listener)
            return () => chipListeners.delete(listener)
          }
          const readChipOpen = () => chipOpen

          const McpChip = (props) => {
            const sessionId = props && props.sessionId ? props.sessionId : undefined
            env.sessionId = sessionId
            const name = useSyncExternalStore(chipName.subscribe, chipName.read, chipName.read)
            const isOpen = useSyncExternalStore(subscribeChip, readChipOpen, readChipOpen)
            const fallback = useSyncExternalStore(chipFallback.subscribe, chipFallback.read, chipFallback.read)
            useEffect(() => {
              refreshChipName(sessionId)
            }, [sessionId])
            const label = name || fallback
            return h(
              React.Fragment,
              null,
              // 容器查询的规则随组件一起挂载：没有 `container-type` 的祖先时它不生效，
              // 结果就是一直显示文字——降级方向是「多显示」，不是「永远只有图标」。
              h('style', { key: 'chip-css' }, CHIP_CSS),
              h(
                'button',
                {
                  type: 'button',
                  style: S.chip,
                  title: '当前工作区绑定的 MCP pack：' + label,
                  onClick: () => {
                    chipOpen = !isOpen
                    notifyChip()
                  },
                },
                h(McpiIcon, { size: 12 }),
                h('span', { key: 'chip-text', className: 'dsh-mcp-pack-chip-text' }, label),
              ),
            )
          }

          const ChipOverlay = () => {
            const isOpen = useSyncExternalStore(subscribeChip, readChipOpen, readChipOpen)
            return h(ChipModal, {
              open: isOpen,
              sessionId: env.sessionId,
              onClose: () => {
                chipOpen = false
                notifyChip()
              },
            })
          }

          /**
           * `ui.showChip === false` 时不注册这个槽位。
           * 记住 disposer：拨回去要真的重挂，不能只读一次配置。
           */
          let chipDisposers = []
          const unmountChip = () => {
            for (const dispose of chipDisposers) {
              try {
                dispose()
              } catch {
                // 槽位可能已随视图卸载，忽略。
              }
            }
            chipDisposers = []
          }
          const registerChip = () => {
            if (chipDisposers.length > 0) return
            chipDisposers.push(
              ctx.slots.inject('conversation.input.right', () =>
                ctx.slots.register({ name: 'conversation.input.right', id: CHIP_ID, order: 41 }, McpChip),
              ),
            )
            chipDisposers.push(
              ctx.slots.inject('shell.overlay', () =>
                ctx.slots.register({ name: 'shell.overlay', id: MODAL_ID, order: 62 }, ChipOverlay),
              ),
            )
          }
          env.onChipChange = (visible) => {
            if (visible) registerChip()
            else unmountChip()
          }

          // 读一次 UI 开关决定挂不挂 chip。失败按缺省（显示）处理，不让入口整体缺失。
          api.global(env.sessionId).then(
            (view) => {
              const ui = uiOf(view)
              env.showChip = ui.showChip
              env.onChipChange(ui.showChip)
            },
            () => {
              env.showChip = true
              env.onChipChange(true)
            },
          )
        } catch (error) {
          console.error('dsh-mcp-pack: 客户端初始化失败', error)
        }
      },
    }
  },
})
