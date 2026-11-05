/**
 * 浏览器半边。手写单文件：宿主用「require('react')」提供 React，
 * 因此不引入 JSX、CSS Modules 或打包器，避免给这个仓库加第二套构建链。
 *
 * 与按单个工具裁剪的做法相比只差一层：这里的开关单位是**插件包**，不是工具。
 * 一个插件对模型的贡献走两条通道（工具进 deny 掩码、段从装配里剔除），
 * 所以一行的体积按「toolVolume + sectionChars/4」计——停用一个插件省的是两边之和。
 *
 * 一个挂载点只编辑一层，不提供层切换器：
 *
 *   侧栏 main、设置页          → 全局层
 *   会话输入框右侧的浮层        → 本工作区层
 *
 * 开关值一律走「previewOpen」：它把草稿也算进求值链，链序与服务端逐段一致：
 *
 *   本层项级 ?? 本层组级 ?? 上层项级 ?? 上层组级 ?? 默认开
 *
 * 「跟随」与「相等」是两个状态：跟随看的是「本层有没有这条键」，不是值比没比平。
 * 因此行内标签按「itemGlobal / itemWorkspace」是否为 null 判定，草稿里的 null
 * 表示删键（回到跟随），与 false（显式停用）严格区分。
 *
 * 分组 UI 不做：插件本身就是开关单位，再叠一层组只是同一件事的两种写法。
 * policy.groups 仍然参与求值（老策略里可能留着组决定），只是不渲染，原样透传。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-plugin-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState, useSyncExternalStore } = React

    const PANEL_ID = 'plugin-manager'
    const CHIP_ID = 'plugin-manager-workspace'
    const MODAL_ID = 'plugin-manager-workspace-modal'
    const TITLE = 'Plugin 管理'

    /**
     * 两个分区按来源切，不参与求值，也不能当开关单位。
     * 顺序固定：官方在前——用户通常先看「宿主自带的那批」占了多少钱。
     */
    const SECTION_ORDER = ['official', 'profile']
    const SECTION_TITLE = { official: '官方', profile: '第三方' }

    // ---------- 传输 ----------

    const PATHS = {
      global: '/api/plugin-manager/global',
      workspace: '/api/plugin-manager/workspace',
      apply: '/api/plugin-manager/apply',
    }

    /**
     * 三路由共用一套信封：{ ok: true, value } 或 { ok: false, error }。
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
      global: () => post(PATHS.global, {}),
      workspace: (sessionId) => post(PATHS.workspace, { sessionId: sessionId }),
      apply: (commands, sessionId) =>
        post(PATHS.apply, sessionId ? { sessionId: sessionId, commands: commands } : { commands: commands }),
    }

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token。
     *
     * 宿主的真实前缀是 --dsw-（不是 --dsh-），且所有 token 都要求浅色与深色两套取值，
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
      // 同理不依赖品牌变量：变量在主题里存在但取值不明时，开态可能和关态撞色。
      accent: '#2f6fed',
      // 不用 --dsw-alias-state-idle-primary：暗色主题下它解析成接近白色，
      // 与白色圆点叠成一条纯白胶囊，开/关完全看不出来。这里用固定的半透明灰，
      // 再给轨道加一圈内描边，暗色与亮色下都有轮廓。
      idle: 'rgba(127, 127, 127, 0.38)',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
      onAccent: '#ffffff',
    }

    const S = {
      page: {
        padding: '24px 32px',
        maxWidth: '880px',
        margin: '0 auto',
        fontSize: '13px',
        color: T.text,
        // 面板挂在 main 槽位里，宿主给的是一个高度确定的容器；不写 height/overflow
        // 时内容会把容器撑开而不是滚动，插件一多下半个列表就够不到了。
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        boxSizing: 'border-box',
      },
      embedded: { fontSize: '13px', color: T.text, marginTop: '8px' },
      hero: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, color: T.text },
      stat: {
        fontSize: '12px',
        color: T.text,
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + T.border,
        whiteSpace: 'nowrap',
      },
      hint: { color: T.dim, fontSize: '12px', lineHeight: 1.6 },
      mono: { color: T.faint, fontSize: '11px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '12px 0 8px' },
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
      section: { borderRadius: '8px', border: '1px solid ' + T.border, marginBottom: '8px' },
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
      badgeWarn: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        background: 'transparent',
        border: '1px solid ' + T.error,
        color: T.error,
        whiteSpace: 'nowrap',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
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
        // 包名是开关的键，必须完整显示：@a/x 与 @b/x 去掉 scope 后同名，
        // 短名会让人分不清关的是哪一个。长名允许折行，不做省略号。
        wordBreak: 'break-all',
      },
      rowMeta: { color: T.dim, fontSize: '11px', marginTop: '2px' },
      sw: (on, disabled) => ({
        width: '34px',
        height: '18px',
        borderRadius: '999px',
        border: 0,
        boxShadow: 'inset 0 0 0 1px rgba(127, 127, 127, 0.28)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: on ? T.accent : T.idle,
        position: 'relative',
        flex: '0 0 auto',
        transition: 'background 120ms',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '14px',
        height: '14px',
        borderRadius: '999px',
        background: T.onAccent,
        transition: 'left 120ms',
      }),
      reset: { border: 0, background: 'transparent', cursor: 'pointer', color: T.dim, fontSize: '12px', padding: '2px 4px' },
      button: (primary) => ({
        border: primary ? 0 : '1px solid ' + T.border,
        borderRadius: '6px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        background: primary ? T.accent : 'transparent',
        color: primary ? T.onAccent : T.text,
      }),
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
      notice: {
        marginTop: '8px',
        padding: '6px 10px',
        borderRadius: '6px',
        border: '1px solid ' + T.border,
        color: T.dim,
        fontSize: '12px',
      },
      error: { color: T.error, fontSize: '12px', marginTop: '8px' },
      empty: { color: T.faint, padding: '12px 4px', fontSize: '12px' },
      actionBar: {
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 12px',
        marginTop: '12px',
        background: T.surface,
        border: '1px solid ' + T.borderStrong,
        borderRadius: '8px',
        boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
        zIndex: 10,
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
        width: 'min(640px, 92vw)',
        maxHeight: '78vh',
        overflow: 'auto',
        background: T.surface,
        color: T.text,
        border: '1px solid ' + T.borderStrong,
        borderRadius: '12px',
        padding: '16px 18px',
        boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
        fontSize: '13px',
      },
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
    }

    // ---------- 跨槽位状态 ----------

    /**
     * 会话 id 只在会话内的槽位里拿得到，工作区浮层却挂在 shell.overlay 里。
     * 用一个极小的总线把它送出来：插槽组件在 effect 里写入，订阅者据此决定能否读工作区层。
     */
    const bus = {
      sessionId: undefined,
      listeners: new Set(),
      read: () => bus.sessionId,
      subscribe: (listener) => {
        bus.listeners.add(listener)
        return () => {
          bus.listeners.delete(listener)
        }
      },
      setSessionId: (value) => {
        if (bus.sessionId === value) return
        bus.sessionId = value
        for (const listener of bus.listeners) listener()
      },
    }

    /** 工作区浮层的开合。 */
    const overlay = {
      open: false,
      listeners: new Set(),
      read: () => overlay.open,
      subscribe: (listener) => {
        overlay.listeners.add(listener)
        return () => {
          overlay.listeners.delete(listener)
        }
      },
      set: (open) => {
        if (overlay.open === open) return
        overlay.open = open
        for (const listener of overlay.listeners) listener()
      },
    }

    /** 侧栏入口的挂与摘由 apply 持有，设置页只能通过这里通知它。 */
    const env = { onSidebarChange: null }

    function useSessionId(props) {
      const live = useSyncExternalStore(bus.subscribe, bus.read, bus.read)
      return props && props.sessionId ? props.sessionId : live
    }

    // ---------- 求值 ----------

    /**
     * 求值链要读的两层：本层在前，上层在后。全局层没有上层。
     *
     * 工作区视图里 workspace 可能是 null（文件还没写过），这不等于「读失败」：
     * 空层就是没有任何决定，求值继续落到全局层。
     */
    function layerPair(data, layer) {
      const globalLayer = {
        items: (data.policy && data.policy.items) || {},
        groups: (data.policy && data.policy.groups) || {},
      }
      if (layer !== 'workspace') return [globalLayer]
      const own = data.workspace || { items: {}, groups: {} }
      return [{ items: own.items || {}, groups: own.groups || {} }, globalLayer]
    }

    /** 这一项属于哪个组；没有归属（或指向未知组）时返回 null。 */
    function groupIdOf(data, pkg) {
      const assignments = (data.groups && data.groups.assignments) || {}
      const gid = assignments[pkg]
      return typeof gid === 'string' && gid !== '' ? gid : null
    }

    /**
     * 把草稿算进去之后，这一项该显示开还是关。
     *
     * 与 src/policy.ts 的 createResolver 同一条链，只多认一层草稿。少了这一步，
     * 拨动开关后统计与行状态仍是服务端的旧值，看起来像开关没生效。
     *
     * staged 只作用于本层：草稿里的 null 表示「这条键没了」，继续沿链向下找。
     */
    function resolveOpen(data, layer, staged, pkg) {
      const gid = groupIdOf(data, pkg)
      const pair = layerPair(data, layer)
      for (let index = 0; index < pair.length; index += 1) {
        const own = pair[index]
        if (index === 0 && staged !== undefined) {
          if (staged !== null) return staged
        } else if (own.items[pkg] !== undefined) {
          return own.items[pkg]
        }
        if (gid !== null && own.groups[gid] !== undefined) return own.groups[gid]
      }
      return true
    }

    function previewOpen(data, layer, draft, pkg) {
      return resolveOpen(data, layer, draft[pkg], pkg)
    }

    /** 本层有没有这条键——判定「跟随」的唯一依据。 */
    function rowExplicit(layer, draft, row) {
      const staged = draft[row.pkg]
      if (staged !== undefined) return staged !== null
      return layer === 'workspace' ? row.itemWorkspace !== null : row.itemGlobal !== null
    }

    /** 跟随的上层此刻是什么值，只用于提示文案。 */
    function followValue(data, layer, pkg) {
      if (layer !== 'workspace') return true
      return resolveOpen(data, 'global', undefined, pkg)
    }

    /**
     * 停用一个插件省下的 token：工具 schema 的估算值，加上段字符数按 4 字符/token 折算。
     *
     * 两半的口径不同（服务端已在 toolVolume 里除过 4），所以这里只折段字符。
     * sectionKnown === false 时这是下界——认不出的段落一个没算，面板在行上明说。
     */
    function weightOf(row) {
      return Math.round((row.toolVolume || 0) + (row.sectionChars || 0) / 4)
    }

    function formatTokens(value) {
      const n = Math.max(0, Math.round(Number(value) || 0))
      if (n >= 10000) return Math.round(n / 1000) + 'k'
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
      return String(n)
    }

    /**
     * 组内排序：**开着的在上、关着的在下**，同组内再按体积降序。
     *
     * 状态优先于体积，是因为两件事在同一行列表里的用途不同：
     * 「关掉的」是已经做过的决定，是结果，扫一眼确认即可；「开着的」是待评估的候选，
     * 用户来面板就是为了在其中挑最贵的砍。把它们混排会让「已关」沉在体积序里看不见。
     *
     * 再往下按体积降序：要砍就先看最贵的。同体积按包名字节序，保证刷新前后稳定。
     */
    function sortRows(rows, isOpen) {
      return [...rows].sort((a, b) => {
        const openDelta = Number(isOpen(b)) - Number(isOpen(a))
        if (openDelta !== 0) return openDelta
        const delta = weightOf(b) - weightOf(a)
        if (delta !== 0) return delta
        return a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0
      })
    }

    function hiddenStats(data, layer, draft) {
      let count = 0
      let volume = 0
      for (const row of data.plugins || []) {
        if (previewOpen(data, layer, draft, row.pkg)) continue
        count += 1
        volume += weightOf(row)
      }
      return { count: count, volume: Math.round(volume) }
    }

    function sectionOf(row) {
      return row.origin === 'official' ? 'official' : 'profile'
    }

    /** 工作区视图比全局视图多几个字段；用它区分两种响应，避免把 cwd 猜错。 */
    function isWorkspaceView(view) {
      return Boolean(
        view &&
          (Object.prototype.hasOwnProperty.call(view, 'policyPath') ||
            Object.prototype.hasOwnProperty.call(view, 'workspace')),
      )
    }

    // ---------- 基础组件 ----------

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          'aria-pressed': props.on,
          title: props.title || (props.on ? '已开启' : '已停用'),
          disabled: props.disabled,
          style: S.sw(props.on, props.disabled),
          onClick: props.disabled ? undefined : () => props.onChange(!props.on),
        },
        h('span', { style: S.knob(props.on) }),
      )
    }

    function Reset(props) {
      return h('button', { type: 'button', style: S.reset, title: '清除本层决定，回到跟随', onClick: props.onClick }, '↺')
    }

    function Tag(props) {
      const face = props || {}
      return h('span', { style: face.danger ? S.badgeWarn : S.badge, title: face.title }, face.children)
    }

    /**
     * 二次确认弹层。
     *
     * 不用 window.confirm：它列不出包名，也无法把受保护的那几个单独标出来；
     * 而这里的关键正是「先看见名字，再点确定」。
     */
    function ConfirmDialog(props) {
      if (!props.open) return null
      const accept = () => {
        const run = props.onConfirm
        props.onCancel()
        if (run) run()
      }
      const names = props.names || []
      const shown = names.slice(0, 40)
      return h(
        'div',
        { style: S.modalBack, onClick: props.onCancel },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          h('div', { style: S.title }, props.title || '请确认'),
          props.message ? h('div', { style: { ...S.hint, marginTop: '6px' } }, props.message) : null,
          names.length > 0 ? h('div', { style: S.confirmNames }, shown.join('\n')) : null,
          names.length > 40 ? h('div', { style: { ...S.hint, marginTop: '4px' } }, '…等 ' + names.length + ' 项') : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
            h('button', { type: 'button', style: S.button(false), onClick: props.onCancel }, '取消'),
            h('button', { type: 'button', style: S.button(true), onClick: accept }, props.confirmLabel || '确认'),
          ),
        ),
      )
    }

    /**
     * 范围外包名的提示：默认折叠，长到一定程度才给「展开全部」。
     *
     * 判断折叠用字符数而不是条数：包名本来就长（@dreanzy/dsh-plugin-manager 一条就 30 字），
     * 十条平铺会把探针区撑满。
     */
    function OutOfScopeNotice({ names }) {
      const [open, setOpen] = useState(false)
      const all = names || []
      if (all.length === 0) return null
      const collapsed = all.join('、').length > 120
      const shown = open || !collapsed ? all : all.slice(0, 8)
      return h(
        'div',
        { style: S.probeWarn },
        h('div', null, all.length + ' 个包名在策略里、目录里没有，已保留不删（重新装回来时决定还在）：'),
        h(
          'div',
          {
            style: {
              marginTop: '4px',
              fontFamily: 'ui-monospace, monospace',
              wordBreak: 'break-word',
              opacity: 0.85,
            },
          },
          shown.join('、') + (open || !collapsed ? '' : ' …'),
        ),
        collapsed
          ? h(
              'button',
              {
                type: 'button',
                style: { ...S.button(false), marginTop: '6px' },
                onClick: () => setOpen(!open),
              },
              open ? '收起' : '展开全部 ' + all.length + ' 个',
            )
          : null,
      )
    }

    // ---------- 数据 ----------

    function useLayerView(layer, sessionId) {
      const [state, setState] = useState({ loading: true, error: null, data: null })
      const [tick, setTick] = useState(0)

      useEffect(() => {
        let alive = true
        if (layer === 'workspace' && !sessionId) {
          setState({ loading: false, error: null, data: null })
          return () => {
            alive = false
          }
        }
        setState((prev) => ({ loading: prev.data === null, error: null, data: prev.data }))
        ;(async () => {
          try {
            const data = layer === 'global' ? await api.global() : await api.workspace(sessionId)
            if (alive) setState({ loading: false, error: null, data: data })
          } catch (error) {
            if (alive) setState({ loading: false, error: String(error.message || error), data: null })
          }
        })()
        return () => {
          alive = false
        }
      }, [layer, sessionId, tick])

      const reload = useCallback(() => setTick((value) => value + 1), [])
      const setData = useCallback((data) => setState({ loading: false, error: null, data: data }), [])
      return { state: state, reload: reload, setData: setData }
    }

    // ---------- 面板 ----------

    /**
     * 面板。layer 由调用方固定，页面内不提供层切换——同一个挂载点只编辑一层，
     * 否则一个页面上会出现两套视角，用户没法判断自己刚才改的到底是哪一层。
     */
    function Panel(props) {
      const layer = props.layer === 'workspace' ? 'workspace' : 'global'
      const sessionId = useSessionId(props)
      const view = useLayerView(layer, sessionId)

      const [query, setQuery] = useState('')
      const [collapsed, setCollapsed] = useState({})
      // 草稿只有一层：pkg -> boolean | null，与所挂载的那层对应。
      const [draft, setDraft] = useState({})
      const [confirm, setConfirm] = useState(null)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)

      const data = view.state.data
      const needsSession = layer === 'workspace' && !sessionId

      if (needsSession) {
        return h(
          'div',
          { style: props.embedded ? S.embedded : S.page },
          props.embedded ? null : h('div', { style: S.hero }, h('div', { style: S.title }, TITLE)),
          h('div', { style: S.hint }, '本工作区层需要一个会话：先打开一个对话，再点输入框右侧的「Plugins」。'),
        )
      }
      if (view.state.loading && data === null) {
        return h('div', { style: props.embedded ? S.embedded : S.page }, h('div', { style: S.hint }, '加载中…'))
      }
      if (!data) {
        return h(
          'div',
          { style: props.embedded ? S.embedded : S.page },
          props.embedded ? null : h('div', { style: S.title }, TITLE),
          h('div', { style: S.error }, view.state.error || '读取失败'),
        )
      }

      const plugins = data.plugins || []
      const stuck = data.stuck || []
      const support = data.support || {}
      const isGlobal = layer === 'global'
      const stats = hiddenStats(data, layer, draft)
      const dirty = Object.keys(draft).length

      // ---------- 改动 ----------

      const stageItem = (pkg, value) => setDraft((prev) => ({ ...prev, [pkg]: value }))

      const toggleItem = (row, next) => {
        // 一旦再改草稿，「已保存」那条就过期了；留着会让人以为这次改动也落盘了。
        setNotice(null)
        if (next === false && row.protected) {
          setConfirm({
            title: '停用受保护插件',
            message:
              '这个插件关掉之后模型基本失去工作能力，或者本插件自己会失效。停用只影响模型侧（工具与提示词段），不会卸载插件进程。',
            names: [row.pkg],
            confirmLabel: '确认停用',
            onConfirm: () => stageItem(row.pkg, false),
          })
          return
        }
        stageItem(row.pkg, next)
      }

      const save = async () => {
        const commands = Object.keys(draft)
          .sort()
          .map((pkg) => ({ op: 'item', layer: layer, name: pkg, value: draft[pkg] }))
        if (commands.length === 0) return
        if (layer === 'workspace' && !sessionId) {
          setError('工作区层的改动需要先打开一个会话。')
          return
        }
        setError(null)
        setNotice(null)
        try {
          const next = await api.apply(commands, layer === 'workspace' ? sessionId : undefined)
          setDraft({})
          if (next && (isGlobal || isWorkspaceView(next))) view.setData(next)
          else view.reload()
          setNotice('已保存。')
        } catch (failure) {
          // 失败时草稿保留，用户可以直接重试。
          setError(String(failure.message || failure))
        }
      }

      // ---------- 派生 ----------

      // 子串匹配，不做模糊：包名里 dsh 这种片段到处都是，模糊匹配只会让结果更难认。
      const needle = query.trim().toLowerCase()
      // 排序看的是「含草稿的当前生效值」：拨动开关后该行立刻升到顶部或沉下去，
      // 与面板上那个开关显示的状态保持一致。若按落盘值排，会出现「刚关掉但它还在上面」。
      const rows = sortRows(
        plugins.filter((row) => needle === '' || row.pkg.toLowerCase().indexOf(needle) >= 0),
        (row) => previewOpen(data, layer, draft, row.pkg),
      )

      const buckets = SECTION_ORDER.map((section) => ({
        section: section,
        rows: rows.filter((row) => sectionOf(row) === section),
      })).filter((bucket) => bucket.rows.length > 0)

      /**
       * 官方插件一个都没识别到时，几乎总是归属扫描没定位到 app.asar（官方包不在
       * profile 的 node_modules 下，得单独从归档头里读）。这不是错，但会让用户
       * 以为「官方插件本来就该不出现」，所以必须显式说一句。
       *
       * pending 期间不报：那时列表本来就还没成形，识别中的提示已在下一条。
       */
      const officialCount = plugins.filter((row) => row.origin === 'official').length
      const noOfficial = data.pending !== true && officialCount === 0

      const sectionVolume = (section) =>
        plugins.filter((row) => sectionOf(row) === section).reduce((sum, row) => sum + weightOf(row), 0)

      // 设置页里内嵌的那份没有标题，但「停用了多少」始终要看得见。
      const header = h(
        'div',
        { style: S.hero },
        props.embedded ? null : h('div', { style: S.title }, TITLE),
        h('div', { style: S.stat }, '已停用 ' + stats.count + ' 个插件，约省 ' + formatTokens(stats.volume) + ' token'),
      )

      // ---------- 渲染 ----------

      return h(
        'div',
        { style: props.embedded || props.compact ? S.embedded : S.page },

        header,

        h(
          'div',
          { style: { ...S.hint, marginTop: props.embedded ? 0 : '4px' } },
          isGlobal
            ? '全局层是默认值：这里停用的插件在所有工作区默认不可用，工作区可以单独打开。'
            : '本工作区的决定压过全局层；这里改的只影响这一个工作区。',
        ),
        // 只显示策略文件路径：它已经包含工作目录，再单独列一行 cwd 是重复信息。
        !isGlobal && data.policyPath ? h('div', { style: S.mono }, data.policyPath) : null,

        // 探针：宿主能力与「关不掉」的名字必须比任何开关都先被看见。
        support.restrict === false
          ? h('div', { style: S.probeFail }, '当前宿主不支持工具限制，停用只影响提示词')
          : null,
        support.promptFilter === false
          ? h('div', { style: S.probeWarn }, '当前宿主不支持提示词段过滤，停用只影响工具')
          : null,
        stuck.length > 0
          ? h('div', { style: S.probeFail }, '这些工具关不掉（宿主按未知名字整批拒绝后已剔除）：' + stuck.join('、'))
          : null,
        data.pending === true
          ? h('div', { style: S.hint }, '正在识别插件归属（首次约 1 秒，之后读缓存）…')
          : null,
        noOfficial
          ? h(
              'div',
              { style: S.probeWarn },
              '没识别到任何官方插件，归属扫描可能未定位到 app.asar；此时官方插件不会出现在列表里。',
            )
          : null,
        h(OutOfScopeNotice, { names: data.outOfScope }),
        (data.warnings || []).length > 0
          ? h('div', { style: S.probeWarn }, '策略文件有告警：' + data.warnings.slice(0, 4).join('；'))
          : null,
        !isGlobal && data.live === false
          ? h('div', { style: S.notice }, '会话当前不在活跃状态：策略照常保存，等它下次读取时生效。')
          : null,

        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            placeholder: '搜索包名',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
        ),

        // ---------- 分区 ----------
        plugins.length === 0
          ? h('div', { style: S.empty }, data.pending === true ? '正在识别插件归属…' : '没有识别到任何插件。')
          : buckets.length === 0
            ? h('div', { style: S.empty }, '没有匹配的插件。')
            : buckets.map((bucket) => {
                const key = bucket.section
                // 搜索时强制展开：命中的项藏在折叠的分区里，看起来像没搜到。
                // 「官方」默认折叠：那一片是宿主自带的几十个包，用户通常不改；展开在首屏
                // 也会把第三方插件挤到下面，还容易在滚动时误点到官方行的开关。
                const isCollapsed =
                  needle !== ''
                    ? false
                    : collapsed[key] === undefined
                      ? bucket.section === 'official'
                      : collapsed[key] === true
                const sectionRows = plugins.filter((row) => sectionOf(row) === bucket.section)
                return h(
                  'div',
                  { key: key, style: S.section },
                  h(
                    'div',
                    { style: S.groupHead, onClick: () => setCollapsed({ ...collapsed, [key]: !isCollapsed }) },
                    h('span', { style: { opacity: 0.5, width: '12px' } }, isCollapsed ? '▸' : '▾'),
                    h('span', { style: S.groupName }, SECTION_TITLE[bucket.section]),
                    h(Tag, null, sectionRows.length + ' 个'),
                    needle !== '' && bucket.rows.length !== sectionRows.length
                      ? h(Tag, null, '命中 ' + bucket.rows.length)
                      : null,
                    h(
                      Tag,
                      { title: '工具 schema 估读 + 段字符数 / 4' },
                      '≈' + formatTokens(sectionVolume(bucket.section)) + ' token',
                    ),
                  ),
                  isCollapsed
                    ? null
                    : bucket.rows.map((row) => {
                        const open = previewOpen(data, layer, draft, row.pkg)
                        const explicit = rowExplicit(layer, draft, row)
                        return h(
                          'div',
                          { key: row.pkg, style: S.row },
                          h(
                            'div',
                            { style: S.rowMain },
                            h(
                              'div',
                              { style: S.rowName },
                              row.pkg,
                              h(Tag, { title: '按包名作用域判定，不看安装位置' }, SECTION_TITLE[sectionOf(row)]),
                              row.protected ? h(Tag, { title: '停用前要二次确认' }, '受保护') : null,
                              row.sectionKnown === false
                                ? h(
                                    Tag,
                                    { danger: true, title: '段归属没扫全，省下的提示词 token 只是下界' },
                                    '提示词占用未知',
                                  )
                                : null,
                            ),
                            h(
                              'div',
                              { style: S.rowMeta },
                              row.tools + ' 工具 · ' + row.sections + ' 段 · ≈' + formatTokens(weightOf(row)) + ' token',
                            ),
                          ),
                          explicit
                            ? h(Tag, { title: '本层显式写了这条键；值与上层相同也不等于跟随' }, '本层')
                            : h(
                                Tag,
                                {
                                  title:
                                    '本层没有这条键，跟随上一层：' + (followValue(data, layer, row.pkg) ? '开' : '关'),
                                },
                                '跟随',
                              ),
                          explicit ? h(Reset, { onClick: () => stageItem(row.pkg, null) }) : null,
                          h(Switch, {
                            on: open,
                            title: open ? '已开启' : '已停用',
                            onChange: (next) => toggleItem(row, next),
                          }),
                        )
                      }),
                )
              }),

        notice ? h('div', { style: S.notice }, notice) : null,
        error ? h('div', { style: S.error }, error) : null,

        dirty > 0
          ? h(
              'div',
              { style: S.actionBar },
              h('span', { style: { ...S.hint, flex: '0 1 auto', color: T.text } }, dirty + ' 处未保存'),
              h('span', { style: { flex: '1 1 auto' } }),
              h('button', { type: 'button', style: S.button(false), onClick: () => setDraft({}) }, '撤销'),
              h('button', { type: 'button', style: S.button(true), onClick: save }, '保存'),
            )
          : null,

        h(ConfirmDialog, {
          open: confirm !== null,
          title: confirm ? confirm.title : '',
          message: confirm ? confirm.message : '',
          names: confirm ? confirm.names : [],
          confirmLabel: confirm ? confirm.confirmLabel : '确认',
          onConfirm: confirm ? confirm.onConfirm : null,
          onCancel: () => setConfirm(null),
        }),
      )
    }

    // ---------- 弹层 ----------

    function WorkspaceModal() {
      const open = useSyncExternalStore(overlay.subscribe, overlay.read, overlay.read)
      if (!open) return null
      return h(
        'div',
        { style: S.modalBack, onClick: () => overlay.set(false) },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          h(Panel, { layer: 'workspace', compact: true }),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '10px' } },
            h('button', { type: 'button', style: S.button(false), onClick: () => overlay.set(false) }, '关闭'),
          ),
        ),
      )
    }

    function GridIcon(props) {
      return h(
        'svg',
        {
          width: props && props.size ? props.size : 16,
          height: props && props.size ? props.size : 16,
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 2.5,
          y: 2.5,
          width: 4.5,
          height: 4.5,
          rx: 1,
          stroke: 'currentColor',
          strokeWidth: 1.4,
          fill: 'none',
        }),
        h('rect', {
          x: 9,
          y: 2.5,
          width: 4.5,
          height: 4.5,
          rx: 1,
          stroke: 'currentColor',
          strokeWidth: 1.4,
          fill: 'none',
        }),
        h('rect', {
          x: 2.5,
          y: 9,
          width: 4.5,
          height: 4.5,
          rx: 1,
          stroke: 'currentColor',
          strokeWidth: 1.4,
          fill: 'none',
        }),
        h('rect', { x: 9, y: 9, width: 4.5, height: 4.5, rx: 1, fill: 'currentColor' }),
      )
    }

    function PluginChip(props) {
      const id = props && props.sessionId
      useEffect(() => {
        if (typeof id === 'string' && id !== '') bus.setSessionId(id)
      }, [id])
      const open = useSyncExternalStore(overlay.subscribe, overlay.read, overlay.read)
      return h(
        'button',
        {
          type: 'button',
          style: S.chip,
          title: '按本工作区停用插件，省下工具与提示词段的 token',
          onClick: () => overlay.set(!open),
        },
        h(GridIcon, { size: 12 }),
        'Plugins',
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

    function SettingsPanel() {
      const [state, setState] = useState({ loading: true, data: null, error: null })

      useEffect(() => {
        let alive = true
        api.global().then(
          (data) => {
            if (alive) setState({ loading: false, data: data, error: null })
          },
          (failure) => {
            if (alive) setState({ loading: false, data: null, error: String(failure.message || failure) })
          },
        )
        return () => {
          alive = false
        }
      }, [])

      const apply = (commands, after) => {
        api.apply(commands, undefined).then(
          (data) => {
            setState({ loading: false, data: data, error: null })
            if (after) after()
          },
          (failure) => setState((prev) => ({ ...prev, error: String(failure.message || failure) })),
        )
      }

      if (state.loading) return h('div', { style: S.hint }, '加载中…')
      if (!state.data) return h('div', { style: S.error }, state.error || '读取失败')

      const policy = state.data.policy || {}
      return h(
        'div',
        { style: { fontSize: '13px', color: T.text } },
        h('div', { style: S.title }, TITLE),
        h(
          'div',
          { style: { ...S.hint, marginTop: '4px' } },
          '这里只控制界面入口。某个插件是否对模型可见，请用侧栏面板或输入框右侧的「Plugins」。',
        ),
        state.error ? h('div', { style: S.error }, state.error) : null,
        h(
          'div',
          { style: { marginTop: '12px' } },
          h(SettingRow, {
            label: '在侧栏显示入口',
            hint: '关掉后侧栏不再出现「Plugin 管理」。设置页里仍可操作。',
            on: policy.showSidebarEntry !== false,
            onChange: (value) =>
              apply([{ op: 'showSidebarEntry', value: value }], () => {
                // 保存成功后才改本地状态：写失败时侧栏不该消失。
                if (env.onSidebarChange) env.onSidebarChange(value)
              }),
          }),
        ),
        // 关掉侧栏入口后这里就是唯一的操作面，所以把完整面板也嵌进来。
        h(Panel, { layer: 'global', embedded: true }),
      )
    }

    // ---------- 注册 ----------

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'plugin-manager', order: 61, label: () => TITLE },
            SettingsPanel,
          ),
        )

        /**
         * 侧栏入口与主面板一起注册：只注册 sidebar.panellist 而不注册 main，
         * 点进去会落到一个不存在的面板上。
         *
         * 注销用的是 ctx.slots.inject 返回的 disposer，所以要记住它——早先的写法
         * 只读一次配置就注册，之后在设置页把开关拨回去也没有东西触起重挂。
         */
        let panelDisposers = []
        const unmountPanel = () => {
          for (const dispose of panelDisposers) {
            try {
              dispose()
            } catch {
              // 槽位可能已随视图卸载，忽略。
            }
          }
          panelDisposers = []
        }

        const registerPanel = () => {
          if (panelDisposers.length > 0) return
          panelDisposers.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: () => TITLE },
                (props) => h(GridIcon, { size: props && props.size ? props.size : 16 }),
              ),
            ),
          )
          panelDisposers.push(
            ctx.slots.inject('main', () =>
              // 主面板固定全局层，与 Tool 管理一致：工作区的开关走会话里的「Plugins」浮层，
              // 两处各自只做一个层次，避免同一个页面上出现两套视角。
              ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { layer: 'global' })),
            ),
          )
        }

        env.onSidebarChange = (visible) => {
          if (visible) registerPanel()
          else unmountPanel()
        }

        api.global().then(
          (view) => {
            const visible = !(view && view.policy && view.policy.showSidebarEntry === false)
            if (env.onSidebarChange) env.onSidebarChange(visible)
          },
          () => {
            // 读取失败时保持入口可见：面板本身会报错，用户还能看到原因。
            if (env.onSidebarChange) env.onSidebarChange(true)
          },
        )

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: CHIP_ID, order: 41 }, PluginChip),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: MODAL_ID, order: 61 }, () => h(WorkspaceModal)),
        )
      },
    }
  },
})
