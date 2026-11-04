/**
 * 浏览器半边。手写单文件：宿主用 `require('react')` 提供 React，
 * 因此不引入 JSX、CSS Modules 或打包器，避免给这个仓库加第二套构建链。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-skill-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const PANEL_ID = 'skill-manager'
    const CHIP_ID = 'skill-manager-workspace'
    const MODAL_ID = 'skill-manager-workspace-modal'
    const TITLE = 'Skill 管理'

    // ---------- 传输 ----------

    const PATHS = {
      global: '/api/skill-manager/global',
      workspace: '/api/skill-manager/workspace',
      apply: '/api/skill-manager/apply',
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
      global: () => post(PATHS.global, {}),
      workspace: (sessionId) => post(PATHS.workspace, { sessionId: sessionId }),
      apply: (commands, sessionId) =>
        post(PATHS.apply, sessionId ? { sessionId: sessionId, commands: commands } : { commands: commands }),
    }

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token。
     *
     * 宿主的真实前缀是 `--dsw-`（不是 `--dsh-`），且全部 token 都要求浅色与深色两套取值，
     * 所以这里只引用变量、不写死颜色。dream-skin 另外注册了 `--dsh-dream-skin-popup-fill`，
     * 弹窗优先用它，弹层才与它自绘的浮层同色。
     */
    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface:
        'var(--dsh-dream-skin-popup-fill, var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, Canvas)))',
      page: 'var(--dsw-alias-bg-base, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      accent: 'var(--dsw-alias-brand-primary, #2f6fed)',
      idle: 'var(--dsw-alias-state-idle-primary, rgba(127,127,127,0.45))',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      onAccent: 'var(--dsw-alias-brand-text, #fff)',
    }

    const S = {
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
      embedded: { fontSize: '13px', color: T.text, marginTop: '8px' },
      page: {
        padding: '24px 32px',
        maxWidth: '880px',
        margin: '0 auto',
        fontSize: '13px',
        color: T.text,
        // 面板挂在 main 槽位里，宿主给的是一个高度确定的容器；不写 height/overflow
        // 时内容会把容器撑开而不是滚动，技能一多下半个列表就够不到了。
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        boxSizing: 'border-box',
      },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '4px' },
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
      segment: { display: 'flex', gap: '2px', borderRadius: '6px', overflow: 'hidden', border: '1px solid ' + T.border },
      segItem: (active) => ({
        padding: '5px 10px',
        cursor: 'pointer',
        border: 0,
        background: active ? T.accent : 'transparent',
        color: active ? T.onAccent : T.text,
        fontSize: '12px',
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
        width: '34px',
        height: '18px',
        borderRadius: '999px',
        border: 0,
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
      // 选项用系统色而不是主题 token：弹出列表由浏览器原生绘制，
      // `Canvas`/`CanvasText` 会按当前 `color-scheme` 解析成一对高对比度配色，
      // 而主题 token 在原生弹层里不一定生效。
      option: { color: 'CanvasText', background: 'Canvas' },
      select: {
        fontSize: '11px',
        padding: '2px 4px',
        borderRadius: '4px',
        border: '1px solid ' + T.border,
        background: 'transparent',
        color: T.text,
        // 弹出的选项列表由浏览器原生绘制，不跟随页面配色。不声明 color-scheme 时，
        // 选项会继承这里的浅色文字，却铺在系统默认的浅色底上——浅字浅底。
        colorScheme: 'light dark',
      },
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
        overflow: 'auto',
        background: T.surface,
        color: T.text,
        border: '1px solid ' + T.borderStrong,
        borderRadius: '12px',
        padding: '16px 18px',
        boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
        fontSize: '13px',
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
    }

    /**
     * 跨组件共享的界面状态。
     *
     * 设置页改的是持久化配置，侧栏槽位的注册却发生在 `apply` 里，两者在 React
     * 上没有父子关系，改完不会自动重挂。所以用一个极小的总线把「刚拨的值」
     * 送回去，让 `apply` 决定挂上还是摘下侧栏入口。
     */
    const env = {
      showSidebar: true,
      onSidebarChange: null,
    }

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

    function Reset(props) {
      return h('button', { type: 'button', style: S.reset, title: '清除本层决定，回到跟随', onClick: props.onClick }, '↺')
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

    // ---------- 面板 ----------

    const VIEWS = [
      { value: 'all', label: '全部' },
      { value: 'on', label: '已启用' },
      { value: 'off', label: '已禁用' },
      { value: 'changed', label: '已覆盖' },
    ]

    function usePanelData(layer, sessionId) {
      const [state, setState] = useState({ loading: true, error: null, data: null })

      const load = useCallback(async () => {
        try {
          const data = layer === 'global' ? await api.global() : await api.workspace(sessionId)
          setState({ loading: false, error: null, data: data })
        } catch (error) {
          setState({ loading: false, error: String(error.message || error), data: null })
        }
      }, [layer, sessionId])

      useEffect(() => {
        let alive = true
        setState((prev) => ({ loading: prev.data === null, error: null, data: prev.data }))
        // 面板可能被渲染在任意路由下，但这是一次显式的全量读取，不需要防抖。
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
      }, [load])

      const run = useCallback(
        async (commands) => {
          try {
            const data = await api.apply(commands, layer === 'workspace' ? sessionId : undefined)
            setState({ loading: false, error: null, data: data })
            return true
          } catch (error) {
            setState((prev) => ({ ...prev, error: String(error.message || error) }))
            await load()
            return false
          }
        },
        [layer, sessionId, load],
      )

      return { state, run, reload: load }
    }

    function groupIdOf(row) {
      return row.groupId || null
    }

    function Panel(props) {
      const layer = props.layer
      const isGlobal = layer === 'global'
      const { state, run } = usePanelData(layer, props.sessionId)
      const [query, setQuery] = useState('')
      const [view, setView] = useState('all')

      const data = state.data
      const rows = useMemo(() => {
        if (!data) return []
        const needle = query.trim().toLowerCase()
        return data.skills
          .filter((row) => {
            if (needle) {
              const hay = (row.name + ' ' + row.description).toLowerCase()
              if (hay.indexOf(needle) < 0) return false
            }
            const open = isGlobal ? row.openGlobal : row.open
            const overridden = isGlobal ? row.itemGlobal !== null : row.itemWorkspace !== null
            if (view === 'on') return open
            if (view === 'off') return !open
            if (view === 'changed') return overridden
            return true
          })
          // 名字排序在服务端做过一次，但合并 global 与 scoped 两份清单后顺序会乱，
          // 所以这里按最终清单再排一遍；组内的项因此也天然有序。
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      }, [data, query, view, isGlobal])

      const buckets = useMemo(() => {
        if (!data) return []
        const byId = new Map()
        const loose = []
        for (const row of rows) {
          const gid = groupIdOf(row)
          if (gid === null || !data.groups.groups.some((group) => group.id === gid)) {
            loose.push(row)
            continue
          }
          if (!byId.has(gid)) byId.set(gid, [])
          byId.get(gid).push(row)
        }
        // 排序规则（用户在用的分组可能会很多，顺序本身就是信息）：
        // 1. 未分组恒在最上；2. 分组按「本层生效值」开在前、关在后；
        // 3. 组内同样开在前、关在后；4. 状态相同的按名字排。
        // 生效值的算法与下面 groupEffective 同一套，这里必须在 useMemo 内重写一份：
        // groupEffective 定义在 hooks 之后，不能反向引用。
        const openOf = (row) => (isGlobal ? row.openGlobal : row.open)
        const byOpen = (a, b) => {
          const left = openOf(a)
          const right = openOf(b)
          if (left !== right) return left ? -1 : 1
          return a.name.localeCompare(b.name, 'zh')
        }
        const groupValue = (groupId) => {
          const own = isGlobal
            ? data.policy.groups[groupId]
            : data.workspace
              ? data.workspace.groups[groupId]
              : undefined
          if (own !== undefined) return own
          const upper = data.policy.groups[groupId]
          if (!isGlobal && upper !== undefined) return upper
          return true
        }
        const out = [{ id: null, name: '未分组', rows: loose.sort(byOpen) }]
        const ordered = [...data.groups.groups].sort((a, b) => {
          const left = groupValue(a.id)
          const right = groupValue(b.id)
          if (left !== right) return left ? -1 : 1
          return a.name.localeCompare(b.name, 'zh')
        })
        for (const group of ordered) {
          out.push({ id: group.id, name: group.name, rows: (byId.get(group.id) || []).sort(byOpen) })
        }
        return out
      }, [data, rows, isGlobal])

      const [collapsed, setCollapsed] = useState({})
      /** 正在重命名的分组 id；`null` 表示没有。 */
      const [editingGroup, setEditingGroup] = useState(null)
      /**
       * 未保存的开关改动。
       *
       * 键不存在 = 没改过；`true` / `false` = 改成这个值；`null` = 删掉本层覆盖、回到跟随。
       * 每次拨动只改这里，点「保存」才一次提交：快速连点时逐次发请求会让界面被乱序
       * 返回的响应来回覆盖，攒起来一次性写入则连请求都只有一条。
       */
      const [draft, setDraft] = useState({ items: {}, groups: {} })

      if (state.loading) return h('div', { style: S.page }, h('div', { style: S.hint }, '加载中…'))
      if (!data) {
        return h(
          'div',
          { style: S.page },
          h('div', { style: S.title }, TITLE),
          h('div', { style: S.error }, state.error || '读取失败'),
        )
      }

      const layerItems = isGlobal ? data.policy.items : (data.workspace ? data.workspace.items : {})
      const layerGroups = isGlobal ? data.policy.groups : (data.workspace ? data.workspace.groups : {})
      const showOfficial = data.policy.showOfficialSkills === true

      // 拨动只落草稿；点保存才写盘。这样连点十次也只发一条请求。
      const stageItem = (name, value) => {
        setDraft((prev) => ({ ...prev, items: { ...prev.items, [name]: value } }))
      }
      const stageGroup = (groupId, value) => {
        setDraft((prev) => ({ ...prev, groups: { ...prev.groups, [groupId]: value } }))
      }
      const dirtyCount = Object.keys(draft.items).length + Object.keys(draft.groups).length
      const discard = () => setDraft({ items: {}, groups: {} })
      const save = async () => {
        const commands = []
        for (const [name, value] of Object.entries(draft.items)) {
          commands.push({ op: 'item', layer: layer, name: name, value: value })
        }
        for (const [groupId, value] of Object.entries(draft.groups)) {
          commands.push({ op: 'group', layer: layer, groupId: groupId, value: value })
        }
        if (commands.length === 0) return
        // 写成功才清草稿：失败时保留，让用户能直接重试。
        if (await run(commands)) discard()
      }

      /**
       * 预览：把草稿算进去之后，这一项应该显示成什么。
       *
       * 求值链与后端逐段一致——本层项级、本层组级、上层项级、上层组级、默认开——
       * 只在这里多认一份草稿。少了这一步，打开一个分组的开关后组内成员仍显示
       * 服务端的旧值，看起来就像开关没生效。
       */
      const previewItem = (row) => {
        const groupId = row.groupId || null
        const stagedItem = draft.items[row.name]

        // 1. 本层项级：草稿优先；草稿为 null 表示「删掉这条覆盖」，继续往下走。
        if (stagedItem !== undefined) {
          if (stagedItem !== null) return stagedItem
        } else {
          const ownItem = layerItems[row.name]
          if (ownItem !== undefined) return ownItem
        }

        // 2. 本层组级（含草稿）。
        if (groupId !== null) {
          const stagedGroup = draft.groups[groupId]
          const byGroup =
            stagedGroup === null ? undefined : stagedGroup !== undefined ? stagedGroup : layerGroups[groupId]
          if (byGroup !== undefined) return byGroup
        }

        // 3. 上一层项级。全局层没有上一层。
        if (!isGlobal) {
          const upperItem = data.policy.items[row.name]
          if (upperItem !== undefined) return upperItem
        }

        // 4. 上一层组级。
        if (groupId !== null) {
          const upperGroup = data.policy.groups[groupId]
          if (upperGroup !== undefined) return upperGroup
        }

        return true
      }
      const itemOverridden = (row) => {
        const staged = draft.items[row.name]
        if (staged !== undefined) return staged !== null
        return isGlobal ? row.itemGlobal !== null : row.itemWorkspace !== null
      }
      const assign = (row, groupId) => {
        run([{ op: 'assign', name: row.name, groupId: groupId === '' ? null : groupId }])
      }

      /** 去掉本层组决定后该落到什么值。 */
      const followGroup = (groupId) => {
        if (isGlobal) return true
        const upper = data.policy.groups[groupId]
        return upper === undefined ? true : upper
      }
      const groupEffective = (groupId) => {
        const staged = draft.groups[groupId]
        if (staged !== undefined) {
          return staged === null
            ? { value: followGroup(groupId), explicit: false }
            : { value: staged, explicit: true }
        }
        const own = layerGroups[groupId]
        if (own !== undefined) return { value: own, explicit: true }
        const upper = data.policy.groups[groupId]
        if (!isGlobal && upper !== undefined) return { value: upper, explicit: false }
        return { value: true, explicit: false }
      }

      const sticky = data.stuck || []

      const embedded = props.embedded === true
      // compact：不接管高度与滚动（由外层弹层自己滚），但保留标题。
      const flush = embedded || props.compact === true
      return h(
        'div',
        { style: flush ? S.embedded : S.page },
        embedded
          ? null
          : h(
              'div',
              { style: S.head },
              h('div', { style: S.title }, TITLE),
              h('div', { style: S.hint }, data.complete === false ? '清单不完整，本轮不会改变遮蔽' : rows.length + ' 项'),
            ),
        h(
          'div',
          { style: S.hint },
          isGlobal
            ? '全局层是默认值：这里关掉的 skill 在任何工作区都默认不可见，工作区可以单独打开。'
            : '本工程的决定压过全局层；组开关只影响当前这一层。',
        ),
        props.cwd ? h('div', { style: { ...S.hint, marginTop: '4px', fontFamily: 'ui-monospace, monospace' } }, props.cwd) : null,
        state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,
        sticky.length > 0
          ? h('div', { style: { ...S.error, marginTop: '8px' } }, '关不掉（同层已被别的插件注册）：' + sticky.join(', '))
          : null,

        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            placeholder: '搜索名字或描述',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(Segmented, { value: view, onChange: setView, options: VIEWS }),
          h(
            'label',
            { style: { ...S.hint, display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
            h(Switch, {
              on: showOfficial,
              onChange: (next) => run([{ op: 'showOfficialSkills', value: next }]),
            }),
            '显示官方技能',
          ),
        ),

        buckets.map((bucket) => {
          const key = bucket.id === null ? '__loose' : bucket.id
          const isCollapsed = collapsed[key] === true
          const covered = bucket.rows.filter((row) => itemOverridden(row)).length
          const groupState = bucket.id === null ? null : groupEffective(bucket.id)
          return h(
            'div',
            { key: key, style: S.group },
            h(
              'div',
              { style: S.groupHead, onClick: () => setCollapsed({ ...collapsed, [key]: !isCollapsed }) },
              h('span', { style: { opacity: 0.5, width: '12px' } }, isCollapsed ? '▸' : '▾'),
              // `bucket.id !== null` 是承重的：未分组的 id 就是 null，而「没有正在编辑」
              // 也记作 null，少了这一半判定，未分组一进来就会被渲染成输入框。
              bucket.id !== null && editingGroup === bucket.id
                ? h('input', {
                    autoFocus: true,
                    defaultValue: bucket.name,
                    style: S.groupInput,
                    onClick: (event) => event.stopPropagation(),
                    onBlur: (event) => {
                      const trimmed = String(event.target.value || '').trim()
                      setEditingGroup(null)
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
              bucket.id !== null && isGlobal && editingGroup !== bucket.id
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.reset,
                      title: '重命名分组',
                      onClick: (event) => {
                        event.stopPropagation()
                        setEditingGroup(bucket.id)
                      },
                    },
                    '✎',
                  )
                : null,
              h('span', { style: S.badge }, bucket.rows.length + ' 项'),
              covered > 0 ? h('span', { style: S.badge }, covered + ' 项单独覆盖') : null,
              bucket.id !== null && isGlobal
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.reset,
                      title: '删除分组（成员回到未分组）',
                      onClick: (event) => {
                        event.stopPropagation()
                        run([{ op: 'deleteGroup', groupId: bucket.id }])
                      },
                    },
                    '✕',
                  )
                : null,
              groupState
                ? h(
                    'span',
                    {
                      style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
                      onClick: (event) => event.stopPropagation(),
                    },
                    groupState.explicit ? h(Reset, { onClick: () => stageGroup(bucket.id, null) }) : null,
                    h(Switch, {
                      on: groupState.value,
                      title: groupState.explicit ? '本层已设置' : '跟随上一层',
                      onChange: (next) => stageGroup(bucket.id, next),
                    }),
                  )
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
                        h('div', { style: S.rowName }, row.name, row.origin
                          ? h('span', { style: S.origin }, row.origin)
                          : null),
                        h('div', { style: S.rowDesc, title: row.description }, row.description),
                      ),
                      row.official ? h('span', { style: S.badge }, '官方') : null,
                      sticky.indexOf(row.name) >= 0 ? h('span', { style: S.badge }, '关不掉') : null,
                      h(
                        'select',
                        {
                          style: S.select,
                          value: row.groupId || '',
                          onChange: (event) => assign(row, event.target.value),
                          title: '移动到分组（对所有工作区生效）',
                        },
                        h('option', { value: '', style: S.option }, '未分组'),
                        [...data.groups.groups]
                          .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
                          .map((group) =>
                            h('option', { key: group.id, value: group.id, style: S.option }, group.name),
                          ),
                      ),
                      itemOverridden(row)
                        ? h(Reset, { onClick: () => stageItem(row.name, null) })
                        : null,
                      h(Switch, {
                        on: previewItem(row),
                        disabled: sticky.indexOf(row.name) >= 0,
                        onChange: (next) => stageItem(row.name, next),
                      }),
                    ),
                  ),
          )
        }),

        // 分组的增删改只出现在全局面板与设置页：工作区层管的是「这个工程要不要」，
        // 在那里建组会顺手改掉所有工程的组定义。
        isGlobal
          ? h(GroupCreator, {
              onCreate: (name) => run([{ op: 'createGroup', name: name }]),
            })
          : null,

        dirtyCount > 0
          ? h(
              'div',
              { style: S.actionBar },
              h('span', { style: { ...S.hint, flex: '1 1 auto', color: T.text } }, dirtyCount + ' 处未保存'),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...S.segItem(false), border: '1px solid ' + T.border, borderRadius: '6px' },
                  onClick: discard,
                },
                '撤销',
              ),
              h('button', { type: 'button', style: { ...S.segItem(true), borderRadius: '6px' }, onClick: save }, '保存'),
            )
          : null,
      )
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
        { style: { marginTop: '16px', display: 'flex', gap: '8px', alignItems: 'center' } },
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
        h('span', { style: S.hint }, '分组对所有工作区共享；开关才分两层。'),
      )
    }

    // ---------- 弹层 ----------

    function WorkspaceModal(props) {
      if (!props.open) return null
      return h(
        'div',
        { style: S.modalBack, onClick: props.onClose },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          h(Panel, { layer: 'workspace', sessionId: props.sessionId, cwd: props.cwd, compact: true }),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '10px' } },
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

    function ChipIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
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

    /** 设置 → Skill 管理。这里的开关只影响界面，不改变任何 skill 的可见性。 */
    function SettingsPanel() {
      const [state, setState] = useState({ loading: true, data: null, error: null })

      useEffect(() => {
        let alive = true
        api.global().then(
          (data) => {
            if (alive) setState({ loading: false, data: data, error: null })
          },
          (error) => {
            if (alive) setState({ loading: false, data: null, error: String(error.message || error) })
          },
        )
        return () => {
          alive = false
        }
      }, [])

      const apply = (commands, after) => {
        api.apply(commands).then(
          (data) => {
            setState({ loading: false, data: data, error: null })
            if (after) after()
          },
          (error) => setState((prev) => ({ ...prev, error: String(error.message || error) })),
        )
      }

      if (state.loading) return h('div', { style: S.hint }, '加载中…')
      if (!state.data) return h('div', { style: S.error }, state.error || '读取失败')

      const policy = state.data.policy
      return h(
        'div',
        { style: { fontSize: '13px', color: T.text } },
        h('div', { style: S.title }, TITLE),
        h(
          'div',
          { style: { ...S.hint, marginTop: '4px' } },
          '这里只控制界面显示。某个 skill 是否对模型可见，请用侧栏面板或输入框右侧的「Skills」。',
        ),
        state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,
        h(
          'div',
          { style: { marginTop: '12px' } },
          h(SettingRow, {
            label: '在侧栏显示入口',
            hint: '关掉后侧栏不再出现「Skill 管理」，主面板一并隐藏；刷新页面生效。',
            on: policy.showSidebarEntry !== false,
            onChange: (value) =>
              apply([{ op: 'showSidebarEntry', value: value }], () => {
                // 保存成功后才改本地状态：写失败时侧栏不该消失。
                env.showSidebar = value
                if (env.onSidebarChange) env.onSidebarChange(value)
              }),
          }),
          h(SettingRow, {
            label: '显示官方技能',
            hint: '官方 @deepseek-ai 技能默认不上面板，但模型仍可调用；打开后可逐项关闭。',
            on: policy.showOfficialSkills === true,
            onChange: (value) => apply([{ op: 'showOfficialSkills', value: value }]),
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
        let open = false
        let sessionId = undefined
        const listeners = new Set()
        const notify = () => {
          for (const listener of listeners) listener()
        }
        const subscribe = (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
        const readOpen = () => open

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'skill-manager', order: 60, label: () => TITLE },
            SettingsPanel,
          ),
        )

        /**
         * 侧栏入口与主面板一起注册：只注册 `sidebar.panellist` 而不注册 `main`，
         * 点进去会落到一个不存在的面板上。
         *
         * 注销用的是 `ctx.slots.inject` 返回的 disposer，所以这里必须记住它——
         * 早先的写法只读一次配置就注册，之后在设置页把开关拨回去也没有任何东西
         * 触发重挂，表现就是「关了没用」。
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
                { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => TITLE },
                (props) =>
                  h(
                    'svg',
                    {
                      width: props && props.size ? props.size : 16,
                      height: props && props.size ? props.size : 16,
                      viewBox: '0 0 16 16',
                      'aria-hidden': true,
                      style: { display: 'block' },
                    },
                    h('path', {
                      d: 'M2 5.5h12M2 10.5h12',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                    }),
                    h('circle', { cx: 5.5, cy: 5.5, r: 2.1, fill: 'currentColor' }),
                    h('circle', { cx: 10.5, cy: 10.5, r: 2.1, fill: 'currentColor' }),
                  ),
              ),
            ),
          )
          panelDisposers.push(
            ctx.slots.inject('main', () =>
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
            env.showSidebar = visible
            env.onSidebarChange(visible)
          },
          () => {
            env.showSidebar = true
            env.onSidebarChange(true)
          },
        )

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: CHIP_ID, order: 40 }, (props) => {
            sessionId = props && props.sessionId ? props.sessionId : undefined
            const isOpen = useSyncExternalStore(subscribe, readOpen, readOpen)
            return h(
              'button',
              {
                type: 'button',
                style: S.chip,
                title: '按本工程调整 skill 可见性',
                onClick: () => {
                  open = !isOpen
                  notify()
                },
              },
              h(ChipIcon),
              'Skills',
            )
          }),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: MODAL_ID, order: 60 }, () => {
            const isOpen = useSyncExternalStore(subscribe, readOpen, readOpen)
            return h(WorkspaceModal, {
              open: isOpen,
              sessionId: sessionId,
              onClose: () => {
                open = false
                notify()
              },
            })
          }),
        )
      },
    }
  },
})
