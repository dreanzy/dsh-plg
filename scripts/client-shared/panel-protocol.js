/**
 * 面板的协议层：路径、传输、待保存键、求值对象。
 *
 * 这一层是各包**本来就不一样**的地方——API 路径、命令集、被管理的条目形状。
 * 四包真正相同的是组件与展示逻辑，那在 `panel-base.js` 里（见 ADR-0017）。
 *
 * 包可以提供自己的 `client/protocol.js` 覆盖这一份；构建器优先用它。
 */

    const PATHS = {
      global: '/api/__PACK__/global',
      workspace: '/api/__PACK__/workspace',
      apply: '/api/__PACK__/apply',
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
      /**
       * `dryRun` 只把命令应用在内存里、返回同一份视图，不写盘——待保存改动靠它渲染。
       */
      apply: (commands, sessionId, dryRun) => {
        const body = { commands: commands }
        if (sessionId) body.sessionId = sessionId
        if (dryRun === true) body.dryRun = true
        return post(PATHS.apply, body)
      },
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

    function pendingKey(command) {
      switch (command.op) {
        case 'packItem':
          return 'packItem:' + command.packId + ':' + command.name
        case 'packGroup':
          return 'packGroup:' + command.packId + ':' + command.groupId
        case 'bind':
          // 与渲染处的查询键同源：服务端按归一化后的 cwd 落盘，渲染也按归一化后的
          // cwd 查。两边各写一遍时 Windows 上必然不等，待保存标记永不出现。
          return bindKeyOf(command.cwd)
        case 'assign':
          return 'assign:' + command.name
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
     * 待保存改动（见 ADR 0006）。
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

    /** 内置 pack 的显示名。数据里仍是 `default`，不写盘，也不参与重名校验。 */

    function packItemOf(pack, name) {
      if (pack === null || pack === undefined || !pack.items) return null
      // hasOwn：`items['toString']` 会拿到原型上的函数，被当成「用户设过这个键」。
      if (!Object.hasOwn(pack.items, name)) return null
      const value = pack.items[name]
      return typeof value === 'boolean' ? value : null
    }

    /** 选中 pack 里这一组的显式值；没有键返回 null（跟随）。 */
    function packGroupOf(pack, groupId) {
      if (pack === null || pack === undefined || !pack.groups || groupId === null || groupId === undefined) return null
      if (!Object.hasOwn(pack.groups, groupId)) return null
      const value = pack.groups[groupId]
      return typeof value === 'boolean' ? value : null
    }

    /**
     * 这一项在选中 pack 里「跟随」时会落到哪。
     *
     * 与 `effective.ts` 的 `landing` 同一条规则，只是把「工作区绑定的 pack」换成
     * 「选中的 pack」：先看这张 pack 的组记录，再走 default 层的项、组，最后内置缺省开。
     */
    function landingOf(pack, defaultPack, name, groupId) {
      const byGroup = packGroupOf(pack, groupId)
      if (byGroup !== null) return byGroup
      const byItem = packItemOf(defaultPack, name)
      if (byItem !== null) return byItem
      const defaultGroup = packGroupOf(defaultPack, groupId)
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

    function uiOf(view) {
      if (!view) return null
      if (view.ui) return view.ui
      return { [SHOW_OFFICIAL_FIELD]: false, ...UI_DEFAULTS }
    }

    /**
     * 工作区清单的比较键：归一化后的路径。大小写不敏感、数字按自然序
     * （`proj2` 在 `proj10` 前），中文目录按拼音。
     *
     * 清单是全局的：排序与当前会话、当前目录无关，同一批目录每次排成同一个序。
     */