/**
 * 浏览器半边。手写单文件：宿主用 `require('react')` 提供 React，
 * 因此不引入 JSX、CSS Modules 或打包器，避免给这个仓库加第二套构建链。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-skill-pack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PANEL_ID = 'skill-pack'
    const CHIP_ID = 'skill-pack-chip'
    const MODAL_ID = 'skill-pack-chip-modal'
    const TITLE = 'Skill Pack'
    /** 内置 pack 的 id。未绑定的工作区按它求值。 */
    const DEFAULT_PACK_ID = 'default'
    /** 工作区清单上限：会话一多，绑定表会变成一堵墙。 */
    const MAX_WORKSPACES = 30
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
    const CHIP_CSS = '@container (max-width: 560px) { .dsh-skill-pack-chip-text { display: none } }'

    // ---------- 传输 ----------

    const PATHS = {
      global: '/api/skill-pack/global',
      workspace: '/api/skill-pack/workspace',
      apply: '/api/skill-pack/apply',
    }

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
    }

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token。
     *
     * 宿主的真实前缀是 `--dsw-`（不是 `--dsh-`），且全部 token 都要求浅色与深色两套取值，
     * 底色用 `--dsw-alias-bg-layer-1`，不用 `--dsw-alias-bg-overlay`：后者在暗色主题下
 * 绑定的是 neutral-bluish-700（中灰），弹窗会比页面亮一大截；后者是给「半透明浮层」
 * 用的，语义也不是卡片底。layer-1 与页面同色，界线交给边框与阴影。
     * 弹窗优先用它，弹层才与它自绘的浮层同色。
     */
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
      error: { color: T.error, fontSize: '12px', marginBottom: '8px' },
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

    /**
     * 删除的二次确认：第一次点变成「删除」（警告色），再点一次才执行。
     *
     * 不用弹窗：这类删除都发生在列表行里，弹窗要额外一次「关闭」动作；
     * 行内二次确认把成本压到一次点击，误点的代价只是多看一眼。
     * 进入确认态后 4 秒自动撤销，避免一直停在危险状态。
     */
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

    /** 内置 pack 的显示名。数据里仍是 `default`，不写盘，也不参与重名校验。 */
    function packLabel(pack) {
      if (pack === null || pack === undefined) return ''
      return pack.builtin === true || pack.id === DEFAULT_PACK_ID ? '默认' : pack.name
    }

    /** pack 里的项级显式值；没有键返回 null（跟随）。 */
    function itemValue(pack, name) {
      const value = pack && pack.items ? pack.items[name] : undefined
      return typeof value === 'boolean' ? value : null
    }

    /** pack 里的组级显式值；没有键返回 null（跟随）。 */
    function groupValue(pack, groupId) {
      const value = pack && pack.groups ? pack.groups[groupId] : undefined
      return typeof value === 'boolean' ? value : null
    }

    function groupIdOf(row) {
      return row.groupId || null
    }

    /**
     * 排序档位：显式开 0、显式关 1、跟随且落到开 2、跟随且落到关 3。
     *
     * 两种跟随在界面上长得一样，但一个等于开、一个等于关，混在同一档里
     * 用户没法按状态扫读。
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
    function uiOf(view) {
      if (!view) return null
      if (view.ui) return view.ui
      return { showOfficialSkills: false, showChip: true, defaultTab: 'groups' }
    }

    /**
     * 已知工作区：从会话列表里取 cwd，排除子代理会话，按最近更新倒序去重，
     * 当前会话所在目录置顶。取不到会话时返回空列表——面板仍能编辑 pack，
     * 只是绑定块里只剩手动添加的路径。
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

    function useGlobalView() {
      const [state, setState] = useState({ loading: true, error: null, data: null })
      // 单调序号：连点时多个请求同时在途，旧响应可能后到；只认最后一次。
      const seq = useRef(0)

      const load = useCallback(async () => {
        const mine = (seq.current += 1)
        try {
          // 带当前会话：服务端用它的 scope 读清单，否则会退回到 list() 的第一个。
          const data = await api.global(env.sessionId)
          if (mine === seq.current) setState({ loading: false, error: null, data: data })
          return data
        } catch (error) {
          if (mine === seq.current) {
            setState({ loading: false, error: String(error.message || error), data: null })
          }
          return null
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const run = useCallback(
        async (commands) => {
          const mine = (seq.current += 1)
          try {
            const data = await api.apply(commands)
            if (mine === seq.current) {
              setState({ loading: false, error: null, data: data })
              // 绑定改了要把 chip 上的 pack 名一起更新：chip 直接读当前会话的工作区视图，
              // 与设置页之间没有通道，只能在这里主动重读一次。
              if (commands.some((command) => command.op === 'bind')) refreshChipName(env.sessionId)
            }
            return true
          } catch (error) {
            if (mine === seq.current) {
              setState((prev) => ({ ...prev, error: String(error.message || error) }))
            }
            await load()
            return false
          }
        },
        [load],
      )

      return { state, run, reload: load }
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
        { style: { marginTop: '0', marginBottom: '8px', display: 'flex', gap: '8px', alignItems: 'center' } },
        h('input', {
          style: { ...S.input, flex: '0 0 200px' },
          placeholder: '新分组名',
          value: name,
          onChange: (event) => setName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
          },
        }),
        h(
          'button',
          {
            type: 'button',
            style: { ...S.segItem(false), border: '1px solid ' + T.border, borderRadius: '6px' },
            onClick: submit,
          },
          '新建分组',
        ),
        h('span', { style: S.hint }, '分组对全部 pack 共享；这里改的是成员归属，不是开关。'),
      )
    }

    // ---------- 弹层 ----------

    /**
     * 当前 pack 相对 default 的差异：分组在上，技能在下。
     *
     * 只列「记录过、且与 default 取值不同」的键。没有键是「不表态」，与 default
     * 同值的记录不改变任何结果——两者都不算「差在哪」。
     * 没绑 pack 时的生效值是 `default.items ?? default.groups[该技能的组] ?? true`。
     */
    function diffOf(data) {
      const packs = Array.isArray(data.packs) ? data.packs : []
      const pack = packById(packs, data.packId)
      const fallback = defaultPackOf(packs)
      const assignments = data.groups && data.groups.assignments ? data.groups.assignments : {}
      const rows = []
      // 组已从注册表删掉时没有名字可显示：那是悬空引用，不是差异。
      const registry = (data.groups && data.groups.groups) || []
      for (const group of registry) {
        const own = groupValue(pack, group.id)
        if (own === null) continue
        if (own === (groupValue(fallback, group.id) ?? true)) continue
        rows.push({ key: 'group:' + group.id, isGroup: true, name: group.name, on: own })
      }
      for (const skill of data.skills || []) {
        const own = itemValue(pack, skill.name)
        if (own === null) continue
        const gid = assignments[skill.name] || null
        const base = itemValue(fallback, skill.name) ?? (gid === null ? null : groupValue(fallback, gid))
        if (own === (base ?? true)) continue
        rows.push({ key: 'skill:' + skill.name, isGroup: false, name: skill.name, on: own })
      }
      return rows
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
            chipName.set(view && view.packId !== DEFAULT_PACK_ID ? view.packName : null)
          },
          (error) => setState((prev) => ({ ...prev, error: String(error.message || error) })),
        )
      }

      // 生效的 pack 就是 default 时没有差异可言：整块只留一句说明。
      const usingDefault = data !== null && (data.binding === null || data.packId === DEFAULT_PACK_ID)
      const rows = data !== null && !usingDefault ? diffOf(data) : []
      const bound =
        data !== null && data.binding !== null && hasPack(data.packs, data.binding) ? data.binding : DEFAULT_PACK_ID

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
                              h(
                                'span',
                                { style: row.on ? S.badge : { ...S.badge, color: T.text } },
                                row.on ? '开' : '关',
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
                    ...data.packs
                      .filter((pack) => pack.id !== DEFAULT_PACK_ID)
                      .map((pack) => ({ value: pack.id, label: pack.name })),
                  ],
                  onChange: (next) => bindTo(next),
                }),
                h(
                  'div',
                  { style: { ...S.hint, marginTop: '6px' } },
                  '保存后，这个目录里已开着的会话也会在下一个回合边界重新求值。',
                ),
              ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.segItem(false), border: '1px solid ' + T.border, borderRadius: '6px' },
                onClick: props.onClose,
              },
              '关闭',
            ),
          ),
        ),
      )
    }
    /** chip 与设置页共用的图标；`size` 缺省 12，设置页会传 16。 */
    function ChipIcon(props) {
      const size = props && props.size ? props.size : 12
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M3 4h10M3 8h6M3 12h8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          fill: 'none',
        }),
      )
    }

    // ---------- 设置页 ----------

    function SettingRow(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 0',
            borderTop: '1px solid ' + T.border,
          },
        },
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
      { value: 'groups', label: '分组' },
      { value: 'packs', label: '分包' },
      { value: 'workspace', label: '工作区' },
    ]

    /**
     * 设置 → Skill Pack。
     *
     * 三页：分组管结构（项与分组），分包管 pack 名册与包内开关，工作区管目录到
     * pack 的绑定。「当前页」与「默认页」是两件事：切页只改当前页，打开设置时落在
     * 哪一页由顶部那组单选写盘（`ui.defaultTab`）——两者混成一个状态时，
     * 「临时看一眼分包」会顺手改掉用户的默认页。
     */
    function SettingsPanel(props) {
      const host = props.host
      const { state, run } = useGlobalView()
      // 当前页只由分页按钮切；初值取 `ui.defaultTab`，之后不再跟随任何外部请求。
      const [tab, setTab] = useState(null)

      const data = state.data
      const ui = uiOf(data)
      const defaultTab = ui ? ui.defaultTab : 'groups'
      const current = tab !== null ? tab : defaultTab

      if (state.loading) return h('div', { style: S.hint }, '加载中…')
      if (!data) return h('div', { style: S.error }, state.error || '读取失败')

      return h(
        'div',
        { style: { fontSize: '13px', color: T.text } },
        h('div', { style: S.title }, TITLE),
        h(
          'div',
          { style: { ...S.hint, marginTop: '4px' } },
          '一张 pack 是一套具名策略：工作区绑到哪个 pack，就按哪套开关生效；未绑定按默认。',
        ),
        h(
          'div',
          { style: { ...S.bar, marginTop: '10px', marginBottom: '0' } },
          h('span', { style: S.hint }, '打开设置时默认显示'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '120px' } },
            h(Picker, {
              value: defaultTab,
              options: TABS.map((entry) => ({ value: entry.value, label: entry.label })),
              onChange: (next) => run([{ op: 'defaultTab', value: next }]),
            }),
          ),
        ),
        h(
          'div',
          { style: { marginTop: '10px' } },
          h(Segmented, { value: current, onChange: setTab, options: TABS }),
        ),
        state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,
        // 「显示官方技能」只影响列表：分组页要它才看得见官方技能，分包页要靠它
        // 才能给官方技能设开关。工作区页是绑定表，与列不列官方项无关，因此不显示。
        current === 'workspace'
          ? null
          : h(SettingRow, {
              label: '显示官方技能',
              hint: '官方 @deepseek-ai 技能默认不上面板，但模型仍可调用；打开后可逐项关闭。',
              on: ui.showOfficialSkills === true,
              onChange: (value) => run([{ op: 'showOfficialSkills', value: value }]),
            }),
        current === 'groups'
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { marginTop: '12px' } },
                h(SettingRow, {
                  label: '在输入框右侧显示入口',
                  hint: '关掉后会话输入框右侧不再出现 Skills chip；pack 绑定仍可在「工作区」页操作。立刻生效。',
                  on: ui.showChip !== false,
                  onChange: (value) =>
                    run([{ op: 'showChip', value: value }]).then((ok) => {
                      if (!ok) return
                      if (env.onChipChange) env.onChipChange(value)
                    }),
                }),
              ),
              h(GroupsPage, { data: data, run: run }),
            )
          : null,
        current === 'packs' ? h(PackSettings, { data: data, run: run }) : null,
        current === 'workspace' ? h(WorkspacePage, { data: data, run: run, host: host }) : null,
      )
    }

    /**
     * 「分组」页：只做结构，不做策略。
     *
     * 按分组折叠展示成员，展开后在行内直接改归属；开关不在这里——它属于 pack，
     * 由「分包」页按 pack 设置。一页只做一件事，否则同一个开关会有两个入口。
     *
     * 顺序是「新建 → 搜索 → 列表」：新建入口在列表底下时，用户要滚到最底才看得见。
     * 搜索同时匹配分组名——搜「三维」多半是想找那一组，而不是名字里恰好含这两个
     * 字的项，所以组名命中时整组保留。
     */
    function GroupsPage(props) {
      const data = props.data
      const run = props.run
      const [query, setQuery] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const [editing, setEditing] = useState(null)
      /** 批量归组的目标分组；`''` 表示未分组。 */
      const [bulkGroup, setBulkGroup] = useState('')

      const groups = data.groups.groups
      const needle = query.trim().toLowerCase()

      const buckets = useMemo(() => {
        const matchRow = (row) =>
          needle === '' ? true : (row.name + ' ' + row.description).toLowerCase().indexOf(needle) >= 0
        const byId = new Map()
        const loose = []
        for (const row of data.skills) {
          const gid = row.groupId
          if (gid === null || gid === undefined || gid === '' || !groups.some((group) => group.id === gid)) {
            if (matchRow(row)) loose.push(row)
            continue
          }
          if (!byId.has(gid)) byId.set(gid, [])
          byId.get(gid).push(row)
        }
        const byName = (a, b) => a.name.localeCompare(b.name, 'zh')
        // 未分组恒在最上：新装的项先落这里，用户第一眼要看到的就是它。
        const out = [{ id: null, name: '未分组', rows: loose.sort(byName) }]
        for (const group of [...groups].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
          const members = byId.get(group.id) || []
          const groupHit = needle !== '' && group.name.toLowerCase().indexOf(needle) >= 0
          out.push({
            id: group.id,
            name: group.name,
            rows: (groupHit ? members : members.filter(matchRow)).sort(byName),
          })
        }
        return out
      }, [data.skills, groups, needle])

      const searching = needle !== ''
      const total = buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0)
      /** 当前筛选命中的项（跨分组拍平），批量归组的对象。 */
      const matched = buckets.reduce((list, bucket) => list.concat(bucket.rows), [])
      const assignTo = (row, groupId) =>
        run([{ op: 'assign', name: row.name, groupId: groupId === '' ? null : groupId }])
      // 一次 apply 带上 N 条 assign，只发一条请求：逐个发在几十项时会被乱序返回的
      // 响应来回覆盖。
      const assignAll = () => {
        if (matched.length === 0) return
        run(
          matched.map((row) => ({
            op: 'assign',
            name: row.name,
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
          '点分组展开成员，在行内直接改归属。开关不在这里——去「分包」页按 pack 设置。',
        ),
        h(GroupCreator, { onCreate: (name) => run([{ op: 'createGroup', name: name }]) }),
        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            placeholder: '搜索名字、描述或分组名',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { style: S.hint }, total + ' 项'),
        ),
        h(
          'div',
          { style: { ...S.bar, marginTop: '0' } },
          h('span', { style: S.hint }, '把当前 ' + matched.length + ' 项归到'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '130px' } },
            h(Picker, {
              value: bulkGroup,
              options: [
                { value: '', label: '未分组' },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
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
              h('span', { style: S.badge }, bucket.rows.length + ' 项'),
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
                      { key: row.name, style: S.row },
                      h(
                        'div',
                        { style: S.rowMain },
                        h(
                          'div',
                          { style: S.rowName },
                          row.name,
                          row.origin ? h('span', { style: S.origin }, row.origin) : null,
                        ),
                        h('div', { style: S.rowDesc, title: row.description }, row.description),
                      ),
                      row.official ? h('span', { style: S.badge }, '官方') : null,
                      h(
                        'div',
                        { style: { flex: '0 0 auto', minWidth: '128px' } },
                        h(Picker, {
                          value: bucket.id === null ? '' : bucket.id,
                          options: [
                            { value: '', label: '未分组' },
                            ...groups.map((group) => ({ value: group.id, label: group.name })),
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

    /** 「分包」页：包名册 → 包内开关，自上而下两块。工作区绑定已独立成一页。 */
    function PackSettings(props) {
      const data = props.data
      const run = props.run
      const packs = data.packs
      const defaultPack = defaultPackOf(packs)
      const [selected, setSelected] = useState(DEFAULT_PACK_ID)
      const [query, setQuery] = useState('')
      const [newName, setNewName] = useState('')
      const [editing, setEditing] = useState(null)
      const pack = packById(packs, selected)
      /** `default` 没有上一层，未记录直接显示成「开」，排序也按开算。 */
      const isDefault = pack === null || pack.id === DEFAULT_PACK_ID
      /** 已注册遮蔽但复验仍可见：同层被别的插件先占了，这条关不掉。 */
      const stuck = new Set(Array.isArray(data.stuck) ? data.stuck : [])

      const items = useMemo(() => {
        const needle = query.trim().toLowerCase()
        // 命中组名等于命中整组：在分包页搜「前端」应该把该组的所有项都筛出来，
        // 而不是因为项名里没有「前端」两个字就报没结果。
        const hitGroups = new Set()
        if (needle !== '') {
          for (const group of data.groups.groups) {
            if (group.name.toLowerCase().indexOf(needle) >= 0) hitGroups.add(group.id)
          }
        }
        const visible =
          needle === ''
            ? [...data.skills]
            : data.skills.filter((row) => {
                if ((row.name + ' ' + row.description).toLowerCase().indexOf(needle) >= 0) return true
                const gid = groupIdOf(row)
                return gid !== null && hitGroups.has(gid)
              })
        // 顺序是「开 > 关 > 跟随(开) > 跟随(关)」：显式决定过的排在前面，
        // 跟随项再按它实际会落到开还是关分档。同档按名字排。
        // 「跟随」会落到哪：选中 pack 的组记录优先，其余由宿主给的 default 链答案决定。
        const landing = (row) => groupValue(pack, groupIdOf(row)) ?? row.openGlobal
        return visible.sort((a, b) => {
          const left = rankOf(itemValue(pack, a.name), isDefault, landing(a))
          const right = rankOf(itemValue(pack, b.name), isDefault, landing(b))
          if (left !== right) return left - right
          return a.name.localeCompare(b.name, 'zh')
        })
      }, [data.skills, data.groups.groups, data.groups.assignments, query, pack, defaultPack, isDefault])

      /** 分组同样「开 > 关 > 跟随(开) > 跟随(关)」。 */
      const orderedGroups = useMemo(() => {
        return [...data.groups.groups].sort((a, b) => {
          // 选中 pack 没有组记录时，落在 default 的组记录上；再没有就是开。
          const left = rankOf(groupValue(pack, a.id), isDefault, groupValue(defaultPack, a.id) ?? true)
          const right = rankOf(groupValue(pack, b.id), isDefault, groupValue(defaultPack, b.id) ?? true)
          if (left !== right) return left - right
          return a.name.localeCompare(b.name, 'zh')
        })
      }, [data.groups.groups, pack, isDefault])

      const groupCounts = useMemo(() => {
        const counts = {}
        for (const row of data.skills) {
          const gid = groupIdOf(row)
          if (gid === null) continue
          counts[gid] = (counts[gid] || 0) + 1
        }
        return counts
      }, [data.skills])

      if (pack === null) return h('div', { style: S.hint }, '没有可用的 pack')

      const createPack = () => {
        const trimmed = newName.trim()
        if (trimmed === '') return
        run([{ op: 'createPack', name: trimmed }])
        setNewName('')
      }
      const overrides = (entry) => Object.keys(entry.items).length + Object.keys(entry.groups).length

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
                : h('span', { style: S.groupName }, packLabel(entry)),
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
                    title: '删除 pack（指向它的绑定会变成悬空引用，按默认求值）',
                    onConfirm: () => {
                      run([{ op: 'deletePack', packId: entry.id }])
                      if (entry.id === selected) setSelected(DEFAULT_PACK_ID)
                    },
                  }),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
            h('input', {
              style: { ...S.input, flex: '0 0 200px' },
              placeholder: '新 pack 名',
              value: newName,
              onChange: (event) => setNewName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') createPack()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.segItem(false), border: '1px solid ' + T.border, borderRadius: '6px' },
                onClick: createPack,
              },
              '新建 pack',
            ),
          ),
        ),

        // 2. 包内开关
        h(
          'div',
          { style: S.block },
          h('div', { style: S.blockTitle }, '包内开关：' + packLabel(pack)),
          h(
            'div',
            { style: { ...S.hint, marginBottom: '8px' } },
            '每个开关三态：开 / 关 / 跟随。「跟随」是独立的第三个选项——显式关掉与「这张 pack 不表态」是两件事。',
          ),
          data.groups.groups.length === 0
            ? h('div', { style: S.hint }, '还没有分组。到「分组」页新建，或直接在下面逐项设置。')
            : orderedGroups.map((group) => {
                const value = groupValue(pack, group.id)
                const inherited = groupValue(defaultPack, group.id) ?? true
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
                  h('span', { style: S.badge }, (groupCounts[group.id] || 0) + ' 项'),
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
          h('div', { style: { ...S.bar, marginTop: '10px' } },
            h('input', {
              style: S.input,
              placeholder: '搜索名字或描述',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            h('span', { style: S.hint }, items.length + ' 项'),
          ),
          items.length === 0
            ? h('div', { style: S.empty }, '没有匹配的项')
            : items.map((row) => {
                const value = itemValue(pack, row.name)
                const gid = groupIdOf(row)
                const inherited = groupValue(pack, gid) ?? row.openGlobal
                return h(
                  'div',
                  {
                    key: row.name,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 0',
                      borderTop: '1px solid ' + T.border,
                    },
                  },
                  h(
                    'div',
                    { style: S.rowMain },
                    h('div', { style: S.rowName }, row.name, row.origin
                      ? h('span', { style: S.origin }, row.origin)
                      : null),
                    h('div', { style: S.rowDesc, title: row.description }, row.description),
                  ),
                  h('span', { style: S.badge }, gid === null ? '未分组' : groupNameOf(data.groups.groups, gid)),
                  stuck.has(row.name)
                    ? h(
                        'span',
                        {
                          style: { ...S.badge, color: T.error, borderColor: T.error },
                          title: '同层已被别的插件先注册，关闭不生效',
                        },
                        '关不掉',
                      )
                    : null,
                  row.open === null
                    ? h(
                        'span',
                        {
                          style: { ...S.badge, color: T.dim },
                          title: '清单不完整：这一行此刻没有生效状态，改动会在清单补齐后生效',
                        },
                        '未生效',
                      )
                    : null,
                  value === null && !isDefault
                    ? h('span', { style: { ...S.hint, whiteSpace: 'nowrap' } }, inherited ? '跟随（开）' : '跟随（关）')
                    : null,
                  h(TriState, {
                    value: value,
                    allowInherit: !isDefault,
                    onChange: (next) => run([{ op: 'packItem', packId: pack.id, name: row.name, value: next }]),
                  }),
                )
              }),
        ),
      )
    }

    /**
     * 「工作区」页：会话 cwd 去重 + 手动添加的路径，每行一个 pack 下拉。
     *
     * 顺序是「说明 → 手动添加 → 列表」：手动添加是入口，放到列表底下等于没有。
     * 绑定保存时就会对所有 live 会话重新求值（`reapply`），不是只影响新会话：
     * 每个 Agent 按自己的 cwd 重新读绑定，改动落在下一个回合边界。
     */
    function WorkspacePage(props) {
      const data = props.data
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

      const extras = data.bindings && Array.isArray(data.bindings.extra) ? data.bindings.extra : []
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
          '保存后立即生效：该目录下已开着的会话也在下一个回合边界重新求值。未绑定即默认。',
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
          h(
            'button',
            {
              type: 'button',
              style: { ...S.segItem(false), border: '1px solid ' + T.border, borderRadius: '6px' },
              onClick: addManual,
            },
            '添加',
          ),
        ),
        !settled
          ? h('div', { style: S.hint }, '读取会话列表…')
          : paths.length === 0
            ? h('div', { style: S.empty }, '没有可绑定的工作区。用上面的输入框手动添加。')
            : paths.map((cwd) => {
                const isExtra = extras.indexOf(cwd) >= 0
                const bound = bindingOf(data.bindings, cwd)
                // 悬空引用（pack 已删）显示成「默认」，与服务端读侧的行为一致。
                const value = bound !== null && hasPack(data.packs, bound) ? bound : ''
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
                      value: value === '' ? '' : value,
                      options: [
                        { value: '', label: '默认' },
                        // 内置 default 与「默认」等价（服务端把 bind default 当解绑），
                        // 列出来只会让人以为有两个不同的选择。
                        ...data.packs
                          .filter((pack) => pack.id !== DEFAULT_PACK_ID)
                          .map((pack) => ({ value: pack.id, label: pack.name })),
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
          chipName.set(view && view.packId !== DEFAULT_PACK_ID ? view.packName : null)
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
          const SettingsIcon = (props) => h(ChipIcon, { size: props && props.size ? props.size : 16 })
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: PANEL_ID, order: 60, label: () => TITLE },
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

          const SkillChip = (props) => {
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
                  title: '当前工作区绑定的 skill pack：' + label,
                  onClick: () => {
                    chipOpen = !isOpen
                    notifyChip()
                  },
                },
                h(ChipIcon),
                h('span', { key: 'chip-text', className: 'dsh-skill-pack-chip-text' }, label),
              ),
            )
          }

          const ChipOverlay = () => {
            const isOpen = useSyncExternalStore(subscribeChip, readChipOpen, readChipOpen)
            return h(ChipModal, {
              open: isOpen,
              host: host,
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
                ctx.slots.register({ name: 'conversation.input.right', id: CHIP_ID, order: 42 }, SkillChip),
              ),
            )
            chipDisposers.push(
              ctx.slots.inject('shell.overlay', () =>
                ctx.slots.register({ name: 'shell.overlay', id: MODAL_ID, order: 60 }, ChipOverlay),
              ),
            )
          }
          env.onChipChange = (visible) => {
            if (visible) registerChip()
            else unmountChip()
          }

          // 读一次 UI 开关决定挂不挂 chip。失败按缺省（显示）处理，不让入口整体缺失。
          api.global().then(
            (view) => {
              const ui = uiOf(view)
              const chip = !ui || ui.showChip !== false
              env.onChipChange(chip)
            },
            () => {
              env.onChipChange(true)
            },
          )
        } catch (error) {
          console.error('dsh-skill-pack: 客户端初始化失败', error)
        }
      },
    }
  },
})
