/**
 * 本包的面板业务面：三页的内容、chip 的内容、以及 `apply` 的装配。
 *
 * 它不是可直接加载的文件——构建器把 `scripts/client-shared/panel-core.js` 拼在它前面，
 * 再套上 `window.__ModuleLoader__.load` 的外壳，产出 `client/client.js`（见 ADR-0017）。
 */

    const PANEL_ID = 'skill-pack'
    const CHIP_ID = 'skill-pack-chip'
    const MODAL_ID = 'skill-pack-chip-modal'
    const TITLE = 'Skill Pack'

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

      return {
        state: state,
        run: run,
        reload: load,
        /** 把一次写盘返回的视图直接装进去：保存与试算返回的是同一种视图，不必再读一遍。 */
        accept: useCallback((data) => {
          seq.current += 1
          setState({ loading: false, error: null, data: data })
          refreshChipName(env.sessionId)
        }, []),
      }
    }

    /** 新建分组。组定义跨工作区共享，建一次处处可用。 */
    function GroupCreator(props) {
      const [name, setName] = useState('')
      const existing = Array.isArray(props.existing) ? props.existing : []
      const submit = () => {
        const trimmed = name.trim()
        if (trimmed === '') return
        /*
         * 重名在这里就拦住，而不是交给服务端拒绝。
         * 服务端也会拒（`applyToGroups` 里有校验），但那一步失败意味着整份 groups.json
         * 这次不应用——界面上表现为「点了新建，什么都没出现」，比当场说一句难懂得多。
         */
        if (existing.indexOf(trimmed) >= 0) {
          if (props.onReject) props.onReject('已存在同名分组：' + trimmed)
          return
        }
        props.onCreate(trimmed)
        setName('')
      }
      return h(
        'div',
        { style: { marginTop: '0', marginBottom: '8px' } },
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            style: { ...S.input, flex: '0 0 200px' },
            placeholder: '新分组名',
            value: name,
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              stopEscape(event)
              if (event.key === 'Enter') submit()
            },
          }),
          h(Button, { onClick: submit }, '新建分组'),
        ),
        // 说明单独占一行：与输入框、按钮挤在同一行时，它会被压成两行贴在按钮右边。
        h('div', { style: { ...S.hint, marginTop: '4px' } }, '分组对全部 pack 共享；这里改的是成员归属，不是开关。'),
      )
    }

    // ---------- 弹层 ----------



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
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (!open) return undefined
        // 居中模态只靠点遮罩退出会让人以为卡住了；Esc 是这类弹层的默认手势。
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open, props.onClose])

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

      const preview = useCallback((commands) => api.apply(commands, sessionId, true), [sessionId])
      const applyCommands = useCallback((commands) => api.apply(commands, sessionId), [sessionId])
      const accept = useCallback((view) => {
        setState({ loading: false, error: null, data: view })
        chipName.set(view && view.packId !== DEFAULT_PACK_ID ? view.packName : null)
      }, [])
      const pending = usePending({ preview: preview, apply: applyCommands, onApplied: accept })

      /*
       * 弹层关掉就丢弃待保存改动——它与设置面板一样，只活在「这一次打开」里。
       * 用 ref 记上一次的开合：否则 open 为 false 的每次渲染都会 setEntries([])，
       * 而那个新数组引用会触发下一轮渲染，自己把自己点着。
       */
      const wasOpen = useRef(false)
      useEffect(() => {
        if (wasOpen.current && !open) pending.discard()
        wasOpen.current = open
      }, [open])

      if (!open) return null

      const base = state.data
      // 点一行只是入队：面板按试算视图显示「换过去之后长什么样」，点「保存」才真绑。
      const data = pending.preview.data !== null ? pending.preview.data : base

      // 生效的 pack 就是 default 时没有差异可言：整块只留一句说明。
      const usingDefault = data !== null && (data.binding === null || data.packId === DEFAULT_PACK_ID)
      // 差异由服务端算好：浏览器不再自己走一遍求值链。
      const rows = data !== null && !usingDefault && Array.isArray(data.diff) ? data.diff : []
      /** 试算后的绑定：点一行就会变成它，但还没保存。 */
      const bound =
        data !== null && data.binding !== null && hasPack(data.packs, data.binding) ? data.binding : DEFAULT_PACK_ID
      /*
       * 真实绑定另算一份。
       *
       * 「当前」必须标在真正生效的那一张上：如果跟着试算视图走，点一下就会把新选的那张
       * 标成「当前」，而 chip 上的名字还没变——两处说法打架。
       */
      const committed =
        base !== null && base.binding !== null && hasPack(base.packs, base.binding) ? base.binding : DEFAULT_PACK_ID

      const bindTo = (packId) => {
        const cwd = base !== null ? base.cwd : null
        if (typeof cwd !== 'string' || cwd === '') return
        pending.push([{ op: 'bind', cwd: cwd, packId: packId === DEFAULT_PACK_ID ? null : packId }])
      }

      const commit = () => {
        if (busy) return
        setBusy(true)
        pending.commit().then(
          () => setBusy(false),
          () => setBusy(false),
        )
      }

      return h(
        'div',
        { style: S.modalBack, onClick: props.onClose },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          // 弹层与设置页是两个挂载点：PANEL_CSS 必须在这里再注入一次，
          // 否则按钮只剩内联尺寸，边框与底色落回浏览器默认（看起来就是一条黑框）。
          h('style', { key: 'panel-css' }, PANEL_CSS),
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
          h(Warnings, { warnings: data === null ? null : data.warnings }),
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
                                style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' },
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
                  '换一张 pack：点一行就预览它对这个目录的影响，保存后才生效',
                ),
                // 平铺全部 pack 而不是「当前值 + 下拉」：下拉要先展开才看得全，
                // 而这里的选择本来就是「挨个看看别人是什么样」。
                data.packs.map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.id,
                      className: 'dsh-skill-pack-row',
                      'data-state':
                        entry.id === committed ? 'current' : entry.id === bound ? 'pending' : undefined,
                      style: {
                        ...S.packRow,
                        borderColor: entry.id === bound || entry.id === committed ? T.borderStrong : T.border,
                      },
                      onClick: () => bindTo(entry.id),
                    },
                    h('span', { style: S.groupName }, entry.id === DEFAULT_PACK_ID ? '默认' : entry.name),
                    // 「当前」标在真正生效的那张上；点了一张还没保存的，标「待保存」。
                    entry.id === committed
                      ? h('span', { style: { ...S.hint, marginLeft: 'auto' } }, '当前')
                      : entry.id === bound
                        ? h('span', { style: { ...S.hint, marginLeft: 'auto' } }, '待保存')
                        : null,
                  ),
                ),
                h(
                  'div',
                  { style: { ...S.hint, marginTop: '6px' } },
                  '保存后，这个目录里已开着的会话也会在下一个回合边界重新求值。',
                ),
              ),
          /*
           * 底栏：左「关闭」固定不动，右侧才是待保存信息与「撤销 / 保存」。
           * 关闭按钮的位置不能随待保存状态左右横跳——那等于每次都要重新找它。
           */
          h(
            'div',
            { style: S.bottomBar },
            h(Button, { variant: 'quiet', onClick: props.onClose }, '关闭'),
            h(PendingBar, {
              inline: true,
              count: pending.count,
              error: pending.preview.error,
              busy: busy || pending.preview.loading,
              onUndo: pending.undo,
              onDiscard: pending.discard,
              onCommit: commit,
            }),
          ),
        ),
      )
    }
    /** chip 与设置页共用的图标；`size` 缺省 14（对齐官方 glyph），设置页会传 16。 */
    function ChipIcon(props) {
      const size = props && props.size ? props.size : 14
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
      const view = useGlobalView()
      const { state, run, accept } = view
      // 当前页只由分页按钮切；初值取 `ui.defaultTab`，之后不再跟随任何外部请求。
      const [tab, setTab] = useState(null)
      const [busy, setBusy] = useState(false)

      const preview = useCallback((commands) => api.apply(commands, undefined, true), [])
      const apply = useCallback((commands) => api.apply(commands), [])
      const pending = usePending({ preview: preview, apply: apply, onApplied: accept })
      const [notice, setNotice] = useState(null)

      /**
       * 入队并清掉上一条提示。
       *
       * 提示不自动消失：它是「删除把你没保存的改动带走了」这句唯一交代，
       * 用户可能正切页、正滚列表，4 秒后就看不见等于没说。
       * 下一次真的改动时它自然让位。
       */
      const enqueue = (commands) => {
        setNotice(null)
        pending.push(commands)
      }

      /** 当场说一句：用于重名这类「点了但没生效」的情况。 */
      const notify = (text) => setNotice(text)

      /**
       * 删除是当场写盘的：队列里引用被删对象的命令先剔掉，再写。
       * 丢掉条数要说出来——无声丢改动比丢改动本身更糟。
       */
      /**
       * 删除：当场写盘，并把队列里引用它的命令剔掉。
       *
       * 只对**磁盘上真实存在**的对象调用——刚新建还没保存的那些，行上不给删除按钮：
       * 它们在磁盘上没有实体，删掉没有意义，真发一条 delete 过去服务端只会回
       * 「不存在，已忽略」，一条用户看不懂的告警，而那条「新建」命令还留在队列里，
       * 对象过一会儿又冒出来。想反悔，用「撤销」。
       */
      const deleteWith = (what, predicate, commands) => {
        const removed = pending.drop(predicate)
        run(commands).then(() => {
          // 写盘换了 base，手里那份试算必然过时：先丢掉，面板立刻回落到新的真实视图，
          // 再按新 base 重算。否则被删的对象会多留一次往返的时间，看起来就是「点了没反应」。
          pending.resetPreview()
          pending.refresh()
        })
        setNotice(removed > 0 ? '已删除「' + what + '」，并丢弃对它的 ' + removed + ' 项未保存改动' : null)
      }

      /** 引用某个分组的待保存命令：改它的名、给它设组级开关、把项归到它。 */
      const groupDeps = (groupId) => (command) => {
        if (command.op === 'packGroup' || command.op === 'renameGroup') return command.groupId === groupId
        if (command.op === 'assign') return command.groupId === groupId
        return false
      }

      /**
       * 引用某张 pack 的待保存命令：改名、项级/组级开关、绑定到它。
       *
       * `duplicatePack` 的 packId 是**源**，不是目标：副本一旦生成就与原 pack 无关，
       * 删掉源不该顺手取消「复制它」这条命令。
       */
      const packDeps = (packId) => (command) => command.op !== 'duplicatePack' && command.packId === packId

      const base = state.data
      // 有待保存改动时，面板按「试算视图」渲染；否则就是真实视图。
      const data = pending.preview.data !== null ? pending.preview.data : base
      const ui = uiOf(data)
      const defaultTab = ui ? ui.defaultTab : 'groups'
      const current = tab !== null ? tab : defaultTab

      if (state.loading) return h('div', { style: S.hint }, '加载中…')
      if (!data) return h('div', { style: S.error }, state.error || '读取失败')

      const commit = () => {
        if (busy) return
        setBusy(true)
        pending.commit().then(
          () => setBusy(false),
          () => setBusy(false),
        )
      }

      return h(
        'div',
        { style: { fontSize: '13px', color: T.text } },
        h('style', { key: 'panel-css' }, PANEL_CSS),
        h('div', { style: S.title }, TITLE),
        h(
          'div',
          { style: { ...S.hint, marginTop: '4px' } },
          '一张 pack 是一套具名策略：工作区绑到哪个 pack，就按哪套开关生效；未绑定按默认。改动先攒着，点「保存」才写盘。',
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
        h(Warnings, { warnings: data.warnings }),
        h(StaleKeys, {
          entries: Array.isArray(data.stale) ? data.stale : [],
          onClear: (commands) => enqueue(commands),
        }),
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
              h(GroupsPage, {
                data: data,
                base: base,
                run: run,
                queue: enqueue,
                pending: pending,
                notify: notify,
                onDeleteGroup: (groupId, name) =>
                  deleteWith(name, groupDeps(groupId), [{ op: 'deleteGroup', groupId: groupId }]),
              }),
            )
          : null,
        current === 'packs'
          ? h(PackSettings, {
              data: data,
              base: base,
              run: run,
              queue: enqueue,
              pending: pending,
              notify: notify,
              onDeletePack: (packId, name) =>
                deleteWith(name, packDeps(packId), [{ op: 'deletePack', packId: packId }]),
            })
          : null,
        current === 'workspace'
          ? h(WorkspacePage, {
              data: data,
              base: base,
              run: run,
              queue: enqueue,
              pending: pending,
              host: host,
            })
          : null,
        /*
         * 底部停靠区：提示在上、待保存条在下，两行一起贴住底边。
         *
         * 提示原先放在标题下面，滚到分包页中段就看不见了——而它讲的正是「删除把你
         * 没保存的改动带走了」这种当场必须知道的事。停靠区两行都常驻，谁在谁在。
         */
        notice !== null || pending.count > 0
          ? h(
              'div',
              { style: S.dock },
              notice !== null
                ? h(NoticeBar, { text: notice, onClose: () => setNotice(null) })
                : null,
              h(PendingBar, {
                count: pending.count,
                error: pending.preview.error,
                busy: busy || pending.preview.loading,
                onUndo: pending.undo,
                onDiscard: pending.discard,
                onCommit: commit,
              }),
            )
          : null,
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
      const base = props.base || props.data
      const run = props.run
      const queue = props.queue
      const frozen = props.pending ? props.pending.count > 0 : false
      const [query, setQuery] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const [editing, setEditing] = useState(null)
      /** 批量归组的目标分组；`''` 表示未分组。 */
      const [bulkGroup, setBulkGroup] = useState('')

      const groups = data.groups.groups
      const needle = query.trim().toLowerCase()
      /*
       * 磁盘上真实存在的分组 id。
       *
       * 刚新建、还没保存的分组只在试算视图里，磁盘上没有实体：给它删除按钮只会得到
       * 一条「不存在，已忽略」的告警，而那条「新建」命令还留在队列里。这类行改成
       * 禁用删除并说明「用撤销撤回新建」。
       */
      const realGroupIds = new Set((base.groups ? base.groups.groups : []).map((group) => group.id))

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
        /*
         * 待保存期间冻结排序：分组按**改动前**的名字排。
         *
         * 不能直接按新名字排：改完名的那一组会立刻跳到新位置，下一次点击就落在别的组上。
         * 也不能按 `base` 数组的原始位置排——列表平时是按名字排的，两者顺序本来就不同，
         * 那样一进入待保存状态反而会重排一次（第一版就是这么错的）。
         * 正确的冻结是「沿用改动前的排序键」：组 id 与技能名都不变，只有分组名要回溯。
         */
        const baseGroupName = frozenGroupNames(base, frozen)
        const byName = (a, b) => a.name.localeCompare(b.name, 'zh')
        // 技能名不可改，组内成员按名字排在任何状态下都稳定。
        const sortRows = (rows) => rows.slice().sort(byName)
        const sortGroups = (list) =>
          list.slice().sort((a, b) => {
            const left = frozen && baseGroupName.has(a.id) ? baseGroupName.get(a.id) : a.name
            const right = frozen && baseGroupName.has(b.id) ? baseGroupName.get(b.id) : b.name
            return String(left).localeCompare(String(right), 'zh')
          })
        // 未分组恒在最上：新装的项先落这里，用户第一眼要看到的就是它。
        const out = [{ id: null, name: '未分组', rows: sortRows(loose) }]
        for (const group of sortGroups([...groups])) {
          const members = byId.get(group.id) || []
          const groupHit = needle !== '' && group.name.toLowerCase().indexOf(needle) >= 0
          out.push({
            id: group.id,
            name: group.name,
            rows: sortRows(groupHit ? members : members.filter(matchRow)),
          })
        }
        return out
      }, [data.skills, groups, needle, base, frozen])

      const searching = needle !== ''
      const total = buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0)
      /** 当前筛选命中的项（跨分组拍平），批量归组的对象。 */
      const matched = buckets.reduce((list, bucket) => list.concat(bucket.rows), [])
      const assignTo = (row, groupId) =>
        queue([{ op: 'assign', name: row.name, groupId: groupId === '' ? null : groupId }])

      /**
       * 改名：撞上已有名字时当场说一句，不入队。
       *
       * 交给服务端拒也行，但那一步会让整份 groups.json 这次不应用——保存后队列清空、
       * 名字悄悄没改，用户只会觉得「点了没反应」。
       */
      const renameGroup = (groupId, current, next) => {
        const trimmed = String(next || '').trim()
        if (trimmed === '' || trimmed === current) return
        if (groups.some((group) => group.id !== groupId && group.name === trimmed)) {
          if (props.notify) props.notify('已存在同名分组：' + trimmed)
          return
        }
        queue([{ op: 'renameGroup', groupId: groupId, name: trimmed }])
      }
      // 一批 assign 走同一次请求：逐个发在几十项时会被乱序返回的响应来回覆盖。
      const assignAll = () => {
        if (matched.length === 0) return
        queue(
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
        h(GroupCreator, {
          onCreate: (name) => queue([{ op: 'createGroup', name: name }]),
          existing: groups.map((group) => group.name),
          onReject: props.notify,
        }),
        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            placeholder: '搜索名字、描述或分组名',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: stopEscape,
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
            Button,
            {
              onClick: assignAll,
              disabled: matched.length === 0,
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
              {
                style: S.groupHead,
                className: 'dsh-skill-pack-row',
                'data-state':
                  bucket.id !== null && props.pending && props.pending.keys.has('renameGroup:' + bucket.id)
                    ? 'pending'
                    : undefined,
                onClick: () => setCollapsed({ ...collapsed, [key]: !isCollapsed }),
              },
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
                      setEditing(null)
                      renameGroup(bucket.id, bucket.name, event.target.value)
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.target.blur()
                      if (event.key === 'Escape') {
                        // 不拦住冒泡，宿主的设置弹层会把这次 Esc 当成「关闭面板」。
                        event.stopPropagation()
                        event.target.value = bucket.name
                        event.target.blur()
                      }
                    },
                  })
                : h(
                    'span',
                    {
                      style: S.groupName,
                      title: bucket.id !== null ? '双击改名' : '',
                      // 双击即改名：改名的常见入口就是「看见名字想改」，不必先去点按钮。
                      onDoubleClick:
                        bucket.id !== null
                          ? (event) => {
                              event.stopPropagation()
                              setEditing(bucket.id)
                            }
                          : undefined,
                    },
                    bucket.name,
                  ),
              h('span', { style: S.badge }, bucket.rows.length + ' 项'),
              bucket.id !== null && editing !== bucket.id
                ? h(
                    Button,
                    {
                      title: '重命名分组',
                      onClick: (event) => {
                        event.stopPropagation()
                        setEditing(bucket.id)
                      },
                    },
                    '编辑',
                  )
                : null,
              bucket.id !== null
                ? realGroupIds.has(bucket.id)
                  ? h(ConfirmButton, {
                      title: '删除分组（成员回到未分组，不可撤销）',
                      onConfirm: () => props.onDeleteGroup(bucket.id, bucket.name),
                    })
                  : h(Button, { disabled: true, title: '这张分组还没保存，用「撤销」撤回新建' }, '删除')
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
      const base = props.base || props.data
      const run = props.run
      const queue = props.queue
      const pending = props.pending || { count: 0, keys: new Set() }
      const frozen = pending.count > 0
      const packs = orderPacks(data.packs, base.packs, frozen)
      /** 磁盘上真实存在的 pack id；刚新建还没保存的那些不在里面。 */
      const realPackIds = new Set((base.packs || []).map((entry) => entry.id))
      const defaultPack = defaultPackOf(packs)
      const [selected, setSelected] = useState(DEFAULT_PACK_ID)
      const [query, setQuery] = useState('')
      const [newName, setNewName] = useState('')
      const [editing, setEditing] = useState(null)
      /**
       * 刚复制、等着选中的那张 pack。
       *
       * 记的是「复制前那份视图的 id 集合」：试算视图里多出来的 id 就是它。按 id 差集
       * 而不是按名字反查——名字由服务端生成（还要按序号避让），客户端算一遍必然漂移。
       */
      const wanted = useRef(null)
      const pack = packById(packs, selected)
      /** `default` 没有上一层，未记录直接显示成「开」，排序也按开算。 */
      const isDefault = pack === null || pack.id === DEFAULT_PACK_ID
      /** 已注册遮蔽但复验仍可见：同层被别的插件先占了，这条关不掉。 */
      const stuck = new Set(Array.isArray(data.stuck) ? data.stuck : [])

      /*
       * 排序键的来源：待保存期间用改动前的 pack（`sortPack`），位置因此不会跟着
       * 未保存的值乱跳；保存之后才按新值重排。
       */
      const basePack = frozen ? packById(base.packs, selected) : pack
      const sortPack = basePack !== null ? basePack : pack
      const sortDefault = frozen ? defaultPackOf(base.packs) : defaultPack

      /** 分组在改动前的名字：冻结排序时用它当键，否则改名的组会立刻跳位。 */
      const baseGroupName = useMemo(() => {
        const map = new Map()
        for (const group of base.groups ? base.groups.groups : []) map.set(group.id, group.name)
        return map
      }, [base])
      /**
       * 新建或复制后选中新出现的那一张。
       *
       * 两者都要选中：不选中的话，用户接着改开关时改的是**上一张** pack，新包保存
       * 下来是空的——看起来就是「新建的包丢了」。
       */
      useEffect(() => {
        const before = wanted.current
        if (before === null) return
        const found = packs.find((entry) => before.has(entry.id) === false)
        if (found === undefined) return
        wanted.current = null
        setSelected(found.id)
      }, [packs])

      /** 这张 pack 有没有未保存的改动：改名、项级或组级开关任一命中即算。 */      const dirtyOf = (packId) => {
        const itemPrefix = 'packItem:' + packId + ':'
        const groupPrefix = 'packGroup:' + packId + ':'
        for (const key of pending.keys) {
          if (key === 'renamePack:' + packId) return true
          if (key.indexOf(itemPrefix) === 0 || key.indexOf(groupPrefix) === 0) return true
        }
        return false
      }

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
        //
        // 档位按**选中那张 pack** 算，不按工作区绑定的那张：分包页编辑的是前者。
        // 待保存期间用改动前那份视图（`sortPack`）：否则拨一个开关就把行挪到另一档，
        // 下一次点击会落在别的行上。
        const rankOfRow = (row) => {
          const gid = groupIdOf(row)
          return RANK_ORDER[
            packRankOf(packItemOf(sortPack, row.name), isDefault, landingOf(sortPack, sortDefault, row.name, gid))
          ]
        }
        return visible.sort((a, b) => {
          const left = rankOfRow(a)
          const right = rankOfRow(b)
          if (left !== right) return left - right
          return a.name.localeCompare(b.name, 'zh')
        })
      }, [data.skills, data.groups.groups, data.groups.assignments, query, pack, defaultPack, isDefault, sortPack, sortDefault])

      /** 分组同样「开 > 关 > 跟随(开) > 跟随(关)」，同样按选中那张 pack 算。 */
      const groupRanks = useMemo(() => {
        const out = {}
        for (const group of data.groups.groups) {
          const own = packGroupOf(sortPack, group.id)
          const landing = packGroupOf(sortDefault, group.id) ?? true
          out[group.id] = packRankOf(own, isDefault, landing)
        }
        return out
      }, [data.groups.groups, sortPack, sortDefault])
      const orderedGroups = useMemo(() => {
        return [...data.groups.groups].sort((a, b) => {
          // 组级档位与行的档位用同一条规则，同样按选中那张 pack 算。
          const left = RANK_ORDER[groupRanks[a.id]] ?? RANK_ORDER['follow-on']
          const right = RANK_ORDER[groupRanks[b.id]] ?? RANK_ORDER['follow-on']
          if (left !== right) return left - right
          // 兜底按「改动前」的名字：否则改个组名，这一组就跳到新位置。
          const leftName = frozen && baseGroupName.has(a.id) ? baseGroupName.get(a.id) : a.name
          const rightName = frozen && baseGroupName.has(b.id) ? baseGroupName.get(b.id) : b.name
          return String(leftName).localeCompare(String(rightName), 'zh')
        })
      }, [data.groups.groups, sortPack, isDefault, sortDefault, frozen, baseGroupName])

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

      /** 改名：与新建同样先在本地查重，别让服务端拒掉整份 packs.json。 */
      const renamePack = (packId, current, next) => {
        const trimmed = String(next || '').trim()
        if (trimmed === '' || trimmed === current) return
        if (packs.some((entry) => entry.id !== packId && entry.name === trimmed)) {
          if (props.notify) props.notify('已存在同名 pack：' + trimmed)
          return
        }
        queue([{ op: 'renamePack', packId: packId, name: trimmed }])
      }

      const createPack = () => {
        const trimmed = newName.trim()
        if (trimmed === '') return
        // 与分组同理：重名在这里就说清楚，别留给服务端拒掉整份文件。
        if (packs.some((entry) => entry.name === trimmed)) {
          if (props.notify) props.notify('已存在同名 pack：' + trimmed)
          return
        }
        // 新建后立刻选中它：不选中的话，用户接着改开关时改的是**上一张** pack，
        // 新包保存下来是空的——看起来就是「新建的包丢了」。
        // 与复制同一条规则：记下改动前的 id 集合，试算视图里多出来的那张就是它。
        wanted.current = new Set(packs.map((entry) => entry.id))
        queue([{ op: 'createPack', name: trimmed }])
        setNewName('')
      }

      /**
       * 复制：进队列，与新建同类。
       *
       * 名字由服务端按「原名 + 序号」生成，客户端不传也不猜——命名规则只有一份。
       * 副本不带任何工作区绑定：绑定是目录到 pack 的一对一映射，副本没有目录。
       */
      const duplicatePack = (packId) => {
        wanted.current = new Set(packs.map((entry) => entry.id))
        queue([{ op: 'duplicatePack', packId: packId }])
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
                className: 'dsh-skill-pack-row',
                // 待保存优先于「当前选中」：这一行更重要的是「还没保存」。
                'data-state': dirtyOf(entry.id) ? 'pending' : entry.id === pack.id ? 'current' : undefined,
                style: {
                  ...S.packRow,
                  borderColor: entry.id === pack.id ? T.borderStrong : T.border,
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
                      setEditing(null)
                      renamePack(entry.id, entry.name, event.target.value)
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.target.blur()
                      if (event.key === 'Escape') {
                        // 不拦住冒泡，宿主的设置弹层会把这次 Esc 当成「关闭面板」。
                        event.stopPropagation()
                        event.target.value = entry.name
                        event.target.blur()
                      }
                    },
                  })
                : h(
                    'span',
                    {
                      style: S.groupName,
                      title: entry.builtin ? '' : '双击改名',
                      onDoubleClick: entry.builtin
                        ? undefined
                        : (event) => {
                            event.stopPropagation()
                            setEditing(entry.id)
                          },
                    },
                    packLabel(entry),
                  ),
              h('span', { style: S.badge }, overrides(entry) + ' 条覆盖'),
              // 复制对 default 也开放：以默认为底改一套正是这个功能最典型的用法。
              // 还没保存的 pack 不给入口——磁盘上没有实体，复制出来的是试算视图里的幻影。
              realPackIds.has(entry.id)
                ? h(
                    Button,
                    {
                      title: '以这张 pack 为底复制一份（副本与原 pack 之后各改各的）',
                      onClick: (event) => {
                        event.stopPropagation()
                        duplicatePack(entry.id)
                      },
                    },
                    '复制',
                  )
                : null,
              // `default` 没有改名与删除入口：它是求值链终点，删掉或改个名都会让
              // 「未绑定即默认」失去指代。
              entry.builtin
                ? null
                : h(
                    Button,
                    {
                      title: '重命名 pack',
                      onClick: (event) => {
                        event.stopPropagation()
                        setEditing(entry.id)
                      },
                    },
                    '编辑',
                  ),
              entry.builtin
                ? null
                : realPackIds.has(entry.id)
                  ? h(ConfirmButton, {
                      title: '删除 pack（指向它的绑定会变成悬空引用，按默认求值；不可撤销）',
                      onConfirm: () => {
                        props.onDeletePack(entry.id, entry.name)
                        if (entry.id === selected) setSelected(DEFAULT_PACK_ID)
                      },
                    })
                  : h(Button, { disabled: true, title: '这张 pack 还没保存，用「撤销」撤回新建' }, '删除'),
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
            h(Button, { onClick: createPack }, '新建 pack'),
          ),
        ),

        // 2. 包内开关
        h(
          'div',
          { style: S.block },
          h('div', { style: S.blockTitleSticky }, '包内开关：' + packLabel(pack)),
          h(
            'div',
            { style: { ...S.hint, marginBottom: '8px' } },
            '每个开关三态：开 / 关 / 跟随。「跟随」是独立的第三个选项——显式关掉与「这张 pack 不表态」是两件事。',
          ),
          data.groups.groups.length === 0
            ? h('div', { style: S.hint }, '还没有分组。到「分组」页新建，或直接在下面逐项设置。')
            : orderedGroups.map((group) => {
                // 显示值读**试算后**的 pack（`pack`），不读冻结的 `sortPack`：
                // 后者只用来定排序位置，拿它渲染会让未保存的改动看不见。
                const value = packGroupOf(pack, group.id)
                const inherited = packGroupOf(defaultPack, group.id) ?? true
                return h(
                  'div',
                  {
                    key: group.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 8px',
                      borderTop: '1px solid ' + T.border,
                      background: pending.keys.has('packGroup:' + pack.id + ':' + group.id)
                        ? T.pendingBg
                        : undefined,
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
                    onChange: (next) => queue([{ op: 'packGroup', packId: pack.id, groupId: group.id, value: next }]),
                  }),
                )
              }),
          h('div', { style: { ...S.bar, marginTop: '10px' } },
            h('input', {
              style: S.input,
              placeholder: '搜索名字或描述',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: stopEscape,
            }),
            h('span', { style: S.hint }, items.length + ' 项'),
          ),
          items.length === 0
            ? h('div', { style: S.empty }, '没有匹配的项')
            : items.map((row) => {
                // 读选中那张 pack 的原始记录：`row.itemWorkspace` 是工作区绑定的那张。
                const value = packItemOf(pack, row.name)
                const gid = groupIdOf(row)
                const inherited = landingOf(pack, defaultPack, row.name, gid)
                return h(
                  'div',
                  {
                    key: row.name,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 8px',
                      borderTop: '1px solid ' + T.border,
                      background: pending.keys.has('packItem:' + pack.id + ':' + row.name)
                        ? T.pendingBg
                        : undefined,
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
                    onChange: (next) => queue([{ op: 'packItem', packId: pack.id, name: row.name, value: next }]),
                  }),
                )
              }),
        ),
      )
    }

    /**
     * 「工作区」页：只把「目录 → pack」这一层暴露出去。
     *
     * 目录从哪来不归本插件管：会话里出现过的目录由宿主提供，手动添加/移除整套已砍掉。
     * 那一层原本多出一条独立数据通路（`extra`），路径形态与去重规则都跟会话来的不一致
     * （一条是 `D:\...`，一条是原样输入的 `d:/...`）——为一个本可以由宿主负责的动作
     * 引入两套规则不值得。
     *
     * 绑定保存时会对所有 live 会话重新求值（`reapply`），不是只影响新会话：
     * 每个 Agent 按自己的 cwd 重新读绑定，改动落在下一个回合边界。
     */
    function WorkspacePage(props) {
      const data = props.data
      const run = props.run
      const queue = props.queue
      const host = props.host
      const [cwds, setCwds] = useState([])
      const [settled, setSettled] = useState(false)

      useEffect(() => {
        let alive = true
        setSettled(false)
        listWorkspaceCwds(host).then(
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

      // 目录只来自宿主（开过会话的目录）。早期版本手动添加的路径不再出现：
      // 那个能力整个移除了，旧数据在下次写盘时由服务端清掉。
      const paths = []
      const seen = {}
      for (const cwd of cwds) {
        if (typeof cwd !== 'string' || cwd === '') continue
        const key = normalizeCwd(cwd)
        if (key === null || seen[key] === true) continue
        seen[key] = true
        paths.push(cwd)
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
          { style: S.hint },
          '目录由宿主提供（开过会话的目录）。本页只决定它绑哪张 pack，不新增或移除目录。',
        ),
        h(
          'div',
          { style: S.hint },
          '切换会话或重新启用插件后，输入框的 / 候选可能还是旧的：宿主按会话缓存 skill 清单。刷新页面即可。',
        ),
        !settled
          ? h('div', { style: S.hint }, '读取会话列表…')
          : paths.length === 0
            ? h('div', { style: S.empty }, '还没有开过会话的目录。开一个会话后这里就会出现。')
            : paths.map((cwd) => {
                const bound = bindingOf(data.bindings, cwd)
                // 内置 default 与「未绑定」等价（服务端把 bind default 当解绑）：两者都显示成
                // 「默认」，否则下拉里会出现两个同名的默认项。悬空引用同样落到「默认」。
                const value =
                  bound === null || bound === DEFAULT_PACK_ID || !hasPack(data.packs, bound) ? '' : bound
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
                      onChange: (next) => queue([{ op: 'bind', cwd: cwd, packId: next === '' ? null : next }]),
                    }),
                  ),
                )
              }),
      )
    }

    // ---------- 注册 ----------

    /**
     * chip 上的 pack 名：绑到哪个 pack 就显示哪个，未绑定是 null（由 `CHIP_LABEL` 补字）。
     *
     * 判据用 `packId` 而不是 `binding`：`binding` 是原始记录，用户显式绑 `default`
     * 时它是 `'default'` 而非 null，拿它判断会把「显式绑默认」误认成「绑了别的 pack」。
     */
    /** chip 的请求序号：快速切会话时丢弃旧响应，避免显示上一个会话的 pack 名。 */
    let chipSeq = 0

    function refreshChipName(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        chipName.set(null)
        return
      }
      const id = ++chipSeq
      api.workspace(sessionId).then(
        (view) => {
          if (id !== chipSeq) return
          chipName.set(view && view.packId !== DEFAULT_PACK_ID ? view.packName : null)
        },
        () => {
          if (id !== chipSeq) return
          // 读不到就退回 Default：chip 本身不能因此消失。
          chipName.set(null)
        },
      )
    }

    return {
      // 测试出口：只供 test/ 断言结构与纯逻辑用，运行期不要读它。
      __internals: { pendingKey, createQueue, frozenGroupNames, usePending, orderPacks, listWorkspaceCwds, TABS, GroupsPage, PackSettings, WorkspacePage, PendingBar, CHIP_CSS },
      // `remote` 与 `remote.session` 都是独立服务名：只声明 `remote` 拿不到 session。
      // 声明是「服务在不在 ctx 上」的唯一开关；取用仍要 try/catch（ctx.get 对取不到的
      // 已声明服务会抛错）。缺了这两个，工作区页会空着。
      inject: ['slots', 'remote', 'remote.session'],
      apply(ctx) {
        // 兜底：client 模块的 apply 抛错会把 web boot 判成 entry failed，桌面端整个起不来。
        // 任何意外都只降级成「面板不出来」，绝不连坐宿主。
        try {
          const host = createHost(ctx)

          // 组件必须是稳定标识符：内联箭头每次渲染都是新类型，React 会整棵卸载重挂
          // （AGENTS.md 客户端红线 4）。apply 只跑一次，闭包里拿 host 是安全的。
    
    /**
     * 面板的错误边界。
     *
     * React 在渲染期抛错会卸载整棵子树，用户看到的就是「点进去一片空白」——没有
     * 任何线索，只能去翻 DevTools。这里把异常转成一行可读文本，把「现象」变成
     * 「原因」。apply 的 try 只兜注册期，兜不住渲染期。
     */
    /** 静态检查用的替身 React 没有 Component：没有它就退化成透传，不能在这里抛。 */
    const BoundaryBase = typeof React.Component === 'function' ? React.Component : null

    const PanelBoundary =
      BoundaryBase === null
        ? function PanelBoundaryPassThrough(props) {
            return props.children
          }
        : class extends BoundaryBase {
            constructor(props) {
              super(props)
              this.state = { error: null }
            }

            static getDerivedStateFromError(error) {
              return { error: error }
            }

            render() {
              if (this.state.error) {
                const message =
                  this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
                return h(
                  'div',
                  { style: S.error },
                  '面板渲染失败：' + message,
                  h('div', { style: { ...S.hint, marginTop: '6px' } }, '这是插件自身的错误，不影响会话与其他插件。'),
                )
              }
              return this.props.children
            }
          }

      const SettingsSection = () => h(PanelBoundary, null, h(SettingsPanel, { host: host }))
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
            const name = useSyncExternalStore(chipName.subscribe, chipName.read, chipName.read)
            const isOpen = useSyncExternalStore(subscribeChip, readChipOpen, readChipOpen)
            useEffect(() => {
              // 写 env 必须放在 effect 里：渲染期赋值时，并发渲染下被丢弃的那次
              // 可能后执行，env.sessionId 会停在旧会话。
              env.sessionId = sessionId
              refreshChipName(sessionId)
            }, [sessionId])
            const bound = name !== null
            const label = bound ? name : CHIP_LABEL
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
                  className: 'dsh-skill-pack-chip',
                  'data-bound': bound ? 'true' : 'false',
                  style: S.chip,
                  title: bound ? 'skill pack：' + label : 'skill pack：未绑定（使用默认）',
                  onClick: () => {
                    chipOpen = !isOpen
                    notifyChip()
                  },
                },
                h(ChipIcon),
                h('span', { key: 'chip-text', className: 'dsh-skill-pack-chip-text', style: S.chipText }, label),
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