/**
 * 浏览器半边。手写单文件：宿主用 `require('react')` 提供 React，
 * 因此不引入 JSX、CSS Modules 或打包器。
 *
 * 首版只挂 `settings.section`：操作**全局层**（所有工作区的默认值）。
 * 工作区层要 sessionId，等面板接上 `conversation.input.right` 再加。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-mcp-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const TITLE = 'MCP 管理'

    /** 面板与槽位之间的小约定：开关一改就让侧栏跟着挂/摘，不用刷新页面。 */
    const env = { onSidebarChange: () => {} }

    /** 弹层开合状态。`useSyncExternalStore` 要一个可订阅的源。 */
    const overlay = { open: false, listeners: new Set() }
    const readOverlay = () => overlay.open
    const subscribeOverlay = (listener) => {
      overlay.listeners.add(listener)
      return () => overlay.listeners.delete(listener)
    }
    const setOverlay = (next) => {
      overlay.open = next
      for (const listener of overlay.listeners) listener()
    }
    const MODES = ['eager', 'dynamic', 'lazy']
    const MODE_LABELS = { eager: '全部加载', dynamic: '动态插入', lazy: '延迟加载' }

    /** 三档的一句话说明。面板顶部常驻，用户不必猜这三颗按钮的差别。 */
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

    const PATHS = {
      global: '/api/mcp-manager/global',
      apply: '/api/mcp-manager/apply',
      workspace: '/api/mcp-manager/workspace',
      diag: '/api/mcp-manager/diag',
      servers: '/api/mcp-manager/servers',
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
      workspace: (sessionId) => post(PATHS.workspace, { sessionId }),
      apply: (commands, sessionId) => post(PATHS.apply, sessionId ? { sessionId, commands } : { commands }),
      diag: () => post(PATHS.diag, {}),
      servers: (payload) => post(PATHS.servers, payload),
    }

    /** 颜色一律取宿主主题 token。不用 `--dsh-`（第三方插件变量）、不用品牌色做实心块。 */
    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      track: 'var(--dsw-alias-label-primary, #e6e6e6)',
      trackOff: 'rgba(127, 127, 127, 0.30)',
      knob: 'var(--dsw-alias-bg-layer-1, #111111)',
      knobOff: 'rgba(255, 255, 255, 0.92)',
    }

    const S = {
      root: { padding: '20px 24px', maxWidth: '880px', margin: '0 auto', fontSize: '13px', color: T.text },
      header: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      hint: { color: T.dim, fontSize: '12px', margin: '0 0 14px' },
      card: {
        border: '1px solid ' + T.border,
        borderRadius: '8px',
        background: T.surface,
        padding: '12px 14px',
        marginBottom: '10px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      name: { fontWeight: 600, fontSize: '13px' },
      meta: { color: T.faint, fontSize: '11.5px' },
      spacer: { flex: 1 },
      seg: { display: 'inline-flex', border: '1px solid ' + T.border, borderRadius: '6px', overflow: 'hidden' },
      segButton: {
        border: 0,
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        color: T.text,
        background: 'transparent',
      },
      segActive: { background: 'rgba(127,127,127,0.22)', color: T.text, fontWeight: 600 },
      input: {
        width: '100%',
        marginTop: '8px',
        padding: '5px 8px',
        fontSize: '12px',
        color: T.text,
        background: 'transparent',
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        colorScheme: 'light dark',
      },
      bar: {
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
      },
      /** 逐字对照 dsh-skill-manager / dsh-plugin-manager 的 chip：有边框、透明底。 */
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
      button: {
        padding: '5px 12px',
        fontSize: '12px',
        borderRadius: '6px',
        border: '1px solid ' + T.borderStrong,
        background: 'transparent',
        color: T.text,
        cursor: 'pointer',
      },
      error: { color: T.error, fontSize: '12px', marginTop: '8px' },
    }

    function Switch({ on, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': label,
          onClick: onChange,
          style: {
            width: '34px',
            height: '20px',
            borderRadius: '10px',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            position: 'relative',
            background: on ? T.track : T.trackOff,
            boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.35)',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: on ? '16px' : '2px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: on ? T.knob : T.knobOff,
          },
        }),
      )
    }

    function Segmented({ value, onChange }) {
      return h(
        'div',
        { style: S.seg, role: 'group' },
        MODES.map((mode) =>
          h(
            'button',
            {
              key: mode,
              type: 'button',
              'aria-pressed': value === mode ? 'true' : 'false',
              onClick: () => onChange(mode),
              style: value === mode ? { ...S.segButton, ...S.segActive } : S.segButton,
            },
            MODE_LABELS[mode],
          ),
        ),
      )
    }

    /**
     * 一行在草稿里的当前值。
     *
     * `mode` 可以是 `null`：那表示「本层没有覆盖，跟随上一层」。它不等于
     * `dynamic`——把两者混为一谈会让用户无法在工作区层显式指定 dynamic
     * （点了等于删覆盖，然后被全局值顶回来，看起来像没保存）。
     */
    function draftOf(row, draft, layer) {
      const patch = draft[row.rowKey] || {}
      const ownEntry = layer === 'workspace' ? row.workspaceEntry : row.globalEntry
      // 只有工作区层才有「跟随」：全局层是最底层，没写就是取默认值，不是跟随谁。
      const ownMode = ownEntry && ownEntry.mode ? ownEntry.mode : null
      return {
        enabled: 'enabled' in patch ? patch.enabled : row.resolved.enabled,
        mode: 'mode' in patch ? patch.mode : (layer === 'workspace' ? ownMode : (ownMode ?? row.resolved.mode)),
        description: 'description' in patch ? patch.description : row.resolved.description,
        // 工具规则以数组存盘，界面上用逗号分隔的字符串编辑。
        tools: 'tools' in patch
          ? patch.tools
          : ((ownEntry && Array.isArray(ownEntry.tools) ? ownEntry.tools : row.resolved.tools) || []).join(', '),
      }
    }

    function Row({ row, draft, onPatch, layer, onRemove }) {
      const value = draftOf(row, draft, layer)
      const from = row.resolved.from === 'workspace' ? '工作区' : row.resolved.from === 'global' ? '全局' : '默认'
      return h(
        'div',
        { style: S.card },
        // 第一行只放元信息：名字长短不同也不会把控件挤到下一行。
        h(
          'div',
          { style: { ...S.row, gap: '8px' } },
          h('span', { style: S.name }, row.serverName),
          h('span', { style: S.meta }, row.transport === 'stdio' ? 'stdio' : 'HTTP'),
          h('span', { style: S.meta }, (row.source === 'managed' ? '托管' : row.source) + ' · ' + from),
          h(
            'span',
            { style: S.meta },
            layer === 'workspace'
              ? (row.workspaceEntry ? '本层已覆盖' : '本层跟随')
              : (row.globalEntry ? '全局已覆盖' : '全局默认'),
          ),
          row.owned ? h('span', { style: S.meta }, '可写') : h('span', { style: S.meta }, '只读定义'),
        ),
        // 第二行固定是控件，所有卡片在同一位置对齐。
        h(
          'div',
          { style: { ...S.row, marginTop: '8px', gap: '6px' } },
          h(Segmented, { value: value.mode, onChange: (mode) => onPatch(row.rowKey, { mode }) }),
          layer === 'workspace'
            ? h(
                'button',
                {
                  type: 'button',
                  title: '删除本层的覆盖，跟随上一层',
                  onClick: () => onPatch(row.rowKey, { mode: null }),
                  style: value.mode === null
                    ? { ...S.segButton, ...S.segActive, border: '1px solid ' + T.border, borderRadius: '6px' }
                    : S.segButton,
                },
                '跟随',
              )
            : null,
          row.source === 'managed'
            ? h(
                'button',
                {
                  type: 'button',
                  title: '删除这台托管 server 的定义',
                  onClick: () => onRemove(row.serverName),
                  style: { ...S.button, color: T.error },
                },
                '删除',
              )
            : null,
          h('span', { style: S.spacer }),
          h(Switch, { on: value.enabled, onChange: () => onPatch(row.rowKey, { enabled: !value.enabled }), label: row.serverName }),
        ),
        h('input', {
          style: S.input,
          value: value.description,
          placeholder: '名册里显示的描述（留空则只显示名字）',
          onChange: (event) => onPatch(row.rowKey, { description: event.target.value }),
        }),
        h('input', {
          style: S.input,
          value: value.tools,
          placeholder: '工具规则，逗号分隔：read_* 表示只留这些，!delete_* 表示排除这些（留空则不筛）',
          onChange: (event) => onPatch(row.rowKey, { tools: event.target.value }),
        }),
      )
    }

    function SettingsPanel({ sessionId }) {
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState({})
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const [diag, setDiag] = useState(null)
      const [adding, setAdding] = useState(false)
      const [name, setName] = useState('')
      const [transport, setTransport] = useState('stdio')
      const [command, setCommand] = useState('')
      const [args, setArgs] = useState('')
      const [url, setUrl] = useState('')

      useEffect(() => {
        api.diag().then(setDiag).catch(() => setDiag(null))
      }, [])

      // 带 sessionId 时读工作区层，否则读全局层。
      const scoped = typeof sessionId === 'string' && sessionId !== ''
      const reload = useCallback(() => {
        const request = scoped ? api.workspace(sessionId) : api.global()
        request.then(setView).catch((cause) => setError(String(cause.message || cause)))
      }, [scoped, sessionId])

      useEffect(() => { reload() }, [reload])

      const onPatch = useCallback((rowKey, patch) => {
        setDraft((current) => ({ ...current, [rowKey]: { ...(current[rowKey] || {}), ...patch } }))
      }, [])

      const dirty = useMemo(() => Object.keys(draft).length, [draft])
      // 自检快照含工具清单，序列化不便宜；它只随 diag 变化，不该每次渲染重做一遍。
      const diagText = useMemo(() => (diag === null ? '' : JSON.stringify(diag, null, 2)), [diag])

      const save = useCallback(async () => {
        const layer = scoped ? 'workspace' : 'global'
        const commands = []
        for (const [rowKey, patch] of Object.entries(draft)) {
          // 值必须确定：`undefined` 经 JSON.stringify 会整个丢掉，后端读到的是缺字段，
          // 然后按"非法"跳过——看起来就像保存没发生。
          if ('enabled' in patch && typeof patch.enabled === 'boolean') {
            // 开关只有两态，发确定值：发 null 会让"工作区想打开、全局关着"永远打不开。
            commands.push({ op: 'enabled', layer, rowKey, value: patch.enabled })
          }
          if ('mode' in patch && (patch.mode === null || (typeof patch.mode === 'string' && patch.mode !== ''))) {
            // null = 跟随上层；三个值原样落盘，不再把 dynamic 当"跟随"。
            commands.push({ op: 'mode', layer, rowKey, value: patch.mode })
          }
          if ('description' in patch && typeof patch.description === 'string') {
            commands.push({ op: 'description', layer, rowKey, value: patch.description === '' ? null : patch.description })
          }
          if ('tools' in patch && typeof patch.tools === 'string') {
            const rules = patch.tools.split(',').map((item) => item.trim()).filter((item) => item !== '')
            commands.push({ op: 'tools', layer, rowKey, value: rules.length === 0 ? null : rules })
          }
        }
        if (commands.length === 0) return
        setSaving(true)
        setError('')
        try {
          const next = await api.apply(commands, scoped ? sessionId : undefined)
          setView(next)
          setDraft({})
        } catch (cause) {
          setError(String(cause.message || cause))
        } finally {
          setSaving(false)
        }
      }, [draft])

      const submitServer = useCallback(async () => {
        const def = transport === 'stdio'
          ? { transport: 'stdio', command: command.trim(), args: args.split(/\s+/).filter(Boolean) }
          : { transport: 'streamable-http', url: url.trim() }
        setSaving(true)
        setError('')
        try {
          await api.servers({ op: 'upsert', name: name.trim(), def })
          setAdding(false)
          setName('')
          setCommand('')
          setArgs('')
          setUrl('')
          reload()
        } catch (cause) {
          setError(String(cause.message || cause))
        } finally {
          setSaving(false)
        }
      }, [transport, name, command, args, url, reload])

      const removeServer = useCallback(async (serverName) => {
        setSaving(true)
        setError('')
        try {
          await api.servers({ op: 'remove', name: serverName })
          setDraft({})
          reload()
        } catch (cause) {
          setError(String(cause.message || cause))
        } finally {
          setSaving(false)
        }
      }, [reload])

      const showSidebar = !(view && view.settings && view.settings.showSidebarEntry === false)
      const toggleSidebar = useCallback(async () => {
        try {
          const next = await api.apply([{ op: 'showSidebarEntry', layer: 'global', value: !showSidebar }])
          setView(next)
          env.onSidebarChange(!showSidebar)
        } catch (cause) {
          setError(String(cause.message || cause))
        }
      }, [showSidebar])

      const rows = view && Array.isArray(view.rows) ? view.rows : []
      const warnings = view && Array.isArray(view.warnings) ? view.warnings : []

      return h(
        'div',
        { style: S.root },
        h('div', { style: S.header }, h('h3', { style: S.title }, TITLE)),
        h('p', { style: S.hint },
          scoped
            ? '工作区层：' + ((view && view.cwd) || sessionId || '未知目录') + '。三档模式是明确取值；点「跟随」才会删掉本层覆盖、回到上一层。'
            : '这里是全局层，所有工作区的默认值。某一行的模式决定它的工具怎么进入上下文。'),
        h('ul', { style: { margin: '0 0 14px', padding: '0', listStyle: 'none', display: 'grid', gap: '4px' } },
          MODE_HELP.map((item) =>
            h('li', { key: item.mode, style: { fontSize: '12px', color: T.dim } },
              h('span', { style: { color: T.text, fontWeight: 600 } }, item.label),
              '：',
              item.text,
            ),
          ),
        ),
        scoped
          ? null
          : h('div', { style: { ...S.row, marginBottom: '12px' } },
              h('span', { style: S.meta }, '在左侧栏显示入口'),
              h(Switch, { on: showSidebar, onChange: toggleSidebar, label: '侧栏入口' }),
            ),
        error ? h('div', { style: S.error }, error) : null,
        adding
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.row },
                h('input', { style: { ...S.input, marginTop: 0, flex: '1 1 140px' }, placeholder: 'serverName（字母数字_-，≤32）', value: name, onChange: (e) => setName(e.target.value) }),
                h('select', {
                  style: { ...S.input, marginTop: 0, width: '150px', colorScheme: 'light dark' },
                  value: transport,
                  onChange: (e) => setTransport(e.target.value),
                },
                  h('option', { value: 'stdio', style: { color: 'CanvasText', background: 'Canvas' } }, 'stdio'),
                  h('option', { value: 'streamable-http', style: { color: 'CanvasText', background: 'Canvas' } }, 'HTTP'),
                ),
              ),
              transport === 'stdio'
                ? h('div', null,
                    h('input', { style: S.input, placeholder: 'command，例如 npx', value: command, onChange: (e) => setCommand(e.target.value) }),
                    h('input', { style: S.input, placeholder: '参数，空格分隔', value: args, onChange: (e) => setArgs(e.target.value) }),
                  )
                : h('input', { style: S.input, placeholder: 'url，例如 http://127.0.0.1:8080/mcp', value: url, onChange: (e) => setUrl(e.target.value) }),
              h('div', { style: { ...S.row, marginTop: '8px' } },
                h('span', { style: S.spacer }),
                h('button', { type: 'button', style: S.button, onClick: () => setAdding(false) }, '取消'),
                h('button', { type: 'button', style: S.button, onClick: submitServer, disabled: saving }, saving ? '保存中…' : '保存'),
              ),
            )
          : h('div', { style: { ...S.row, marginBottom: '10px' } },
              h('span', { style: S.spacer }),
              h('button', { type: 'button', style: S.button, onClick: () => setAdding(true) }, '新增服务器'),
            ),
        rows.length === 0
          ? h('p', { style: S.hint }, '没有发现 MCP 服务器。在 profile 的 cordis 配置里声明 @deepseek-ai/dsh-mcp-client 行后刷新。')
          : rows.map((row) => h(Row, { key: row.rowKey, row, draft, onPatch, onRemove: removeServer, layer: scoped ? 'workspace' : 'global' })),
        warnings.length > 0 ? h('p', { style: S.hint }, warnings.join('；')) : null,
        diag
          ? h(
              'details',
              { style: { marginTop: '10px' } },
              h('summary', { style: S.meta }, '运行期自检（' + (diag.toolsRegistered ? '按需工具已注册' : '按需工具未注册') + '）'),
              h('pre', {
                style: {
                  fontSize: '11px',
                  color: T.dim,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  marginTop: '6px',
                },
              }, diagText),
            )
          : null,
        dirty > 0
          ? h(
              'div',
              { style: S.bar },
              h('span', { style: S.meta }, dirty + ' 处未保存'),
              h('span', { style: S.spacer }),
              h('button', { type: 'button', style: S.button, onClick: () => setDraft({}) }, '撤销'),
              h('button', { type: 'button', style: S.button, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
            )
          : null,
      )
    }

    /** 弹层：只做容器，内容仍是同一个面板，只是带上 sessionId 走工作区层。 */
    function Overlay({ sessionId }) {
      const open = useSyncExternalStore(subscribeOverlay, readOverlay, readOverlay)
      if (!open) return null
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 90,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          },
          onClick: () => setOverlay(false),
        },
        h(
          'div',
          {
            style: {
              background: T.surface,
              border: '1px solid ' + T.borderStrong,
              borderRadius: '10px',
              maxWidth: '880px',
              width: '100%',
              maxHeight: '82vh',
              overflowY: 'auto',
            },
            onClick: (event) => event.stopPropagation(),
          },
          h(SettingsPanel, { sessionId }),
          // 与另两个面板一致：底部固定一个关闭入口，不必去点遮罩。
          h(
            'div',
            {
              style: {
                position: 'sticky',
                bottom: 0,
                display: 'flex',
                justifyContent: 'flex-end',
                padding: '10px 14px',
                borderTop: '1px solid ' + T.border,
                background: T.surface,
              },
            },
            h('button', { type: 'button', style: S.button, onClick: () => setOverlay(false) }, '关闭'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-mcp-manager-settings', order: 62, label: () => TITLE },
            (props) => h(SettingsPanel, { sessionId: props && props.sessionId }),
          ),
        )

        /** 侧栏入口与主面板一起挂/摘：只注册其一，点进去会落到不存在的面板。 */
        let panelDisposers = []
        const mountPanel = () => {
          if (panelDisposers.length > 0) return
          panelDisposers.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: 'dsh-mcp-manager', order: 42, label: () => TITLE },
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
                    h('rect', { x: 2, y: 2.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
                    h('rect', { x: 2, y: 9.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
                    h('circle', { cx: 4.6, cy: 4.5, r: 1, fill: 'currentColor' }),
                    h('circle', { cx: 4.6, cy: 11.5, r: 1, fill: 'currentColor' }),
                  ),
              ),
            ),
          )
          panelDisposers.push(
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: 'dsh-mcp-manager' }, () => h(SettingsPanel, {})),
            ),
          )
        }
        const unmountPanel = () => {
          for (const dispose of panelDisposers) {
            try {
              dispose()
            } catch {
              // 槽位可能已随视图卸载。
            }
          }
          panelDisposers = []
        }
        env.onSidebarChange = (visible) => {
          if (visible) mountPanel()
          else unmountPanel()
        }

        // 首次读全局层：决定要不要挂侧栏入口。读不到就按显示处理。
        api.global().then(
          (view) => env.onSidebarChange(!(view && view.settings && view.settings.showSidebarEntry === false)),
          () => env.onSidebarChange(true),
        )

        let sessionId
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-mcp-manager-chip', order: 42 },
            (props) => {
              sessionId = props && props.sessionId ? props.sessionId : undefined
              const open = useSyncExternalStore(subscribeOverlay, readOverlay, readOverlay)
              return h(
                'button',
                {
                  type: 'button',
                  style: S.chip,
                  'aria-pressed': open ? 'true' : 'false',
                  title: '按本工程调整 MCP 可见性与加载方式',
                  onClick: () => setOverlay(!open),
                },
                h(
                  'svg',
                  { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
                  h('rect', { x: 2, y: 2.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' }),
                  h('rect', { x: 2, y: 9.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' }),
                ),
                'MCP',
              )
            },
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-mcp-manager-overlay', order: 62 }, () =>
            h(Overlay, { sessionId }),
          ),
        )
      },
    }
  },
})