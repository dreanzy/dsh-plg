/**

 * mcp 的协议层：五条路径、四字段行模型、以及它们各自的求值。

 *

 * 覆盖共享的 `scripts/client-shared/panel-protocol.js`——mcp 管的不是布尔项，

 * 而是一行四个字段（enabled / mode / tools / description），求值链与待保存键都不同

 * （见 ADR-0017）。组件与展示逻辑仍来自 `panel-base.js`。

 */



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
      /**
       * `dryRun` 只把命令应用在内存里、返回同一份视图，不写盘——待保存改动靠它渲染。
       */
      apply: (commands, sessionId, dryRun) => {
        const body = { commands: commands }
        if (sessionId) body.sessionId = sessionId
        if (dryRun === true) body.dryRun = true
        return post(PATHS.apply, body)
      },
      diag: () => post(PATHS.diag, {}),
      servers: (payload) => post(PATHS.servers, payload),
    }


    function pendingKey(command) {
      switch (command.op) {
        case 'packRow':
          return 'packRow:' + command.packId + ':' + command.rowKey
        case 'packGroup':
          return 'packGroup:' + command.packId + ':' + command.groupId
        case 'bind':
          // 与渲染处的查询键同源：服务端按归一化后的 cwd 落盘，渲染也按归一化后的
          // cwd 查。两边各写一遍时 Windows 上必然不等，待保存标记永不出现。
          return bindKeyOf(command.cwd)
        case 'assign':
          return 'assign:' + command.rowKey
        case 'renamePack':
          return 'renamePack:' + command.packId
        case 'renameGroup':
          return 'renameGroup:' + command.groupId
        default:
          // 新建、复制与删除没有可覆盖的目标：每条都是独立一次决定。
          return null
      }
    }

    /**
     * 待保存改动。
     *
     * 点一下只入队，不发写请求；队列非空时每次变化都用 `dryRun` 试算一次，
     * 拿服务端算好的视图来渲染——浏览器不复制求值链（根术语表「生效视图」）。
     * 点「保存」才把整批命令写盘。
     *
     * 队列活在这一次挂载里：关闭面板即丢。跨面板保留会被「我到底存了没」拖住，
     * 而用户关掉面板再回来时通常已经不记得点过什么了。
     */
    /**
     * 待保存队列的纯部分：只有条目数组与键规则，不碰 React（见 ADR 0006）。
     *
     * `keyOf` 决定「同键后写覆盖」：键不为 null 时先删掉同键的旧条目再追加；新建与
     * 删除这类没有可覆盖目标的命令键为 null，每条都独立存在。
     *
     * 每次变更都换一个新数组：试算 effect 靠引用变化重跑。
     */

    function orderPacks(packs, basePacks, frozen) {
      if (!frozen) return packs
      const rank = new Map()
      for (const pack of basePacks || []) rank.set(pack.id, rank.size)
      if (rank.size === 0) return packs
      const out = packs.slice()
      out.sort((a, b) => {
        const left = rank.has(a.id) ? rank.get(a.id) : rank.size
        const right = rank.has(b.id) ? rank.get(b.id) : rank.size
        return left - right
      })
      return out
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

    /** `bindings` 段兼容读：只有绑定表，旧文件里残留的 `extra` 不再消费。 */
    function bindingsOf(data) {
      const bindings = data && data.bindings ? data.bindings : null
      if (bindings === null || typeof bindings !== 'object') return { bindings: {} }
      return {
        bindings: bindings.bindings && typeof bindings.bindings === 'object' ? bindings.bindings : {},
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

    /** 行描述：宿主求出的描述优先，空时退回定义摘要。 */
    function rowDescriptionOf(row) {
      const description = row && typeof row.description === 'string' ? row.description : ''
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


    /**
     * 这一行属于哪个组。
     *
     * 宿主求值时已校验注册表：悬空引用在那里按未分组处理，这里直接信 `groupId`，
     * 不再读 `assignments` 复核——两套规则必然分叉。
     */

    function groupIdOf(row) {
      const gid = row && row.groupId
      return typeof gid === 'string' && gid !== '' ? gid : null
    }

    function groupNameOf(registry, gid) {
      for (const group of registry || []) {
        if (group.id === gid) return group.name
      }
      return '未分组'
    }

    /**
     * 分包页读的是**选中那张 pack 的原始记录**，不是工作区求值链。
     *
     * 服务端行上的 `itemWorkspace` / `rank` 按**工作区绑定的** pack 算，而分包页让
     * 用户逐张编辑 pack——选中哪张由本地状态决定，服务端不知道。拿绑定 pack 的结论
     * 渲染分包页，结果是每张 pack 都显示成同一份值：默认 pack 里显式关掉的行显示成
     * 「开」，其余 pack 全部显示成「跟随」，排序也退化成按名字。
     *
     * 这里只做「读原始记录 + 算档位」，不碰求值链：链仍由服务端算，行上的 `open` 就是它。
     */

    function packEnabledOf(pack, rowKey) {
      return entryField(policyOf(pack, rowKey), 'enabled')
    }

    /** 选中 pack 里这一组的显式值；没有键返回 null（跟随）。 */
    function packGroupOf(pack, gid) {
      if (pack === null || pack === undefined || !pack.groups || gid === null || gid === undefined) return null
      if (!Object.hasOwn(pack.groups, gid)) return null
      const value = pack.groups[gid]
      return typeof value === 'boolean' ? value : null
    }

    /**
     * 这一行在选中 pack 里「跟随」时会落到哪。
     *
     * 与 `resolveRow` 的 `landing` 同一条规则，只是把「工作区绑定的 pack」换成
     * 「选中的 pack」：先看这张 pack 的组记录，再走 default 层的行、组，最后内置缺省开。
     */
    function landingOf(pack, defaultPack, rowKey, gid) {
      const byGroup = packGroupOf(pack, gid)
      if (byGroup !== null) return byGroup
      const byRow = packEnabledOf(defaultPack, rowKey)
      if (byRow !== null) return byRow
      const defaultGroup = packGroupOf(defaultPack, gid)
      if (defaultGroup !== null) return defaultGroup
      return true
    }

    /**
     * 分包页的排序档位。
     *
     * 与 core 的 `rankOf` 同一条规则，输入换成「选中 pack 的显式记录」。名字带 `pack`
     * 前缀是为了与工作区那条链区分：`scripts/check-panels.mjs` 禁止客户端再写一遍
     * `rankOf`，挡的是工作区求值链回潮，不是这里。
     */