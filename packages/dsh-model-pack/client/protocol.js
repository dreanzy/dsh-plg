/**

 * model 的协议层：读写接口、绑定读取、宿主接线、待保存键。

 *

 * 覆盖共享的 `panel-protocol.js`——model 管的不是「模型可见性」而是会话路由，

 * 路径、命令集与待保存键都不同（见 ADR-0017）。

 */



    const PATHS = {
      read: '/api/model-pack/read',
      apply: '/api/model-pack/apply',
    }

    /**
     * 两条路由共用一套信封：{ ok: true, value } 或 { ok: false, error }。
     * HTTP 恒 200（见 src/routes.ts），所以判定只能看 ok 字段，不能看 response.ok。
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
      read: (cwd, sessionId) =>
        post(PATHS.read, {
          ...(cwd ? { cwd: cwd } : {}),
          ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId: sessionId } : {}),
        }),
      /**
       * `dryRun` 只把命令应用在内存里、返回同一份视图，不写盘——待保存改动靠它渲染。
       */
      apply: (cwd, commands, dryRun) => {
        const body = {}
        if (cwd) body.cwd = cwd
        body.commands = commands
        if (dryRun === true) body.dryRun = true
        return post(PATHS.apply, body)
      },
    }


    function bindingOf(data) {
      const id = data && data.state ? data.state.binding : null
      if (typeof id !== 'string' || id === '') return null
      // 绑到 default 与服务端求值同义（bind 命令会把它归一成删键）：按未绑定处理。
      return id === DEFAULT_PACK_ID ? null : id
    }



    function createHost(ctx) {
      // remote 在文件末尾的 inject 里声明了：想用某个服务必须声明它。从 inject 里
      // 去掉只会让面板静默变空（模型目录读不到 → 所有下拉为空），不是优雅降级。
      //
      // 取用仍要兜底：ctx.get 在服务不存在时**抛错**，不返回 undefined；少了这个 try，
      // 这一行会让整个 client 模块加载失败，进而把 web boot 判成 entry failed、
      // 桌面端起不来。
      let remote = null
      try {
        remote = (ctx && ctx.remote) || null
      } catch {
        remote = null
      }
      // 退一步再取一次：某些作用域只挂了子命名空间本身，没有外层 remote。
      if (remote === null || !remote.session) {
        try {
          const session = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined
          if (session) remote = { session: session }
        } catch {
          // 取不到就保持 null，面板会显示「没有模型目录」而不是崩。
        }
      }
      const host = { ctx: ctx, remote: remote }
      host.catalog = createCatalog(host)
      return host
    }


    function pendingKey(command) {
      switch (command.op) {
        case 'packSession':
          return 'packSession:' + command.packId
        case 'packTier':
          return 'packTier:' + command.packId + ':' + command.tierId
        case 'putPack':
          return 'pack:' + command.packId
        case 'renamePack':
          return 'renamePack:' + command.packId
        case 'bind':
          // 与渲染处的查询键同源：服务端按归一化后的 cwd 落盘，渲染也按归一化后的
          // cwd 查。两边各写一遍时 Windows 上必然不等（`C:\x` vs `c:/x`），
          // 待保存标记永不出现。
          return bindKeyOf(command.cwd)
        default:
          // 新建、复制与提示词补丁没有可覆盖的目标：前两者每条都是独立一次决定，
          // 后者的每条只带自己那几个键（按单键去重会丢掉别的键）。
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