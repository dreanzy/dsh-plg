/**
 * 本包的面板业务面：三页的内容、chip 的内容、以及 `apply` 的装配。
 *
 * 组件与工具来自 `panel-base.js`；路径、传输、绑定读取与待保存键在 `client/protocol.js`。
 * 三个组件（Chevron / Picker / TextField）保留本包版本并加 `Model` 前缀——它们比基础层
 * 的多一层行为（开合旋转、禁用项、失焦提交），见 ADR-0017。
 */
    // ---------- 常量 ----------

    const TITLE = 'Model Pack'
    const PANEL_ID = 'model-pack'
    const CHIP_ID = 'model-pack-chip'
    const MODAL_ID = 'model-pack-chip-modal'

    /**
     * 默认 pack 的 id：`packs.json` 里真实存在的一项（见 src/pack.ts 的 DEFAULT_PACK_ID）。
     *
     * 它就是求值链的终点——工作区没绑定、或绑定悬空时落到这里。因此它在本面板里
     * 带「默认」徽章，没有改名与删除入口；但**内容可编辑**（分包页可以选它来改）。
     */
    /** 默认 pack 的固定显示名。服务端落盘时也归一到它，改名命令对它无效。 */
    const DEFAULT_PACK_NAME = '默认'

    /** 档 id 固定四个，顺序即难度顺序；显示名可改，缺省用这里。 */
    const TIER_IDS = ['tier1', 'tier2', 'tier3', 'tier4']
    // 与 src/pack.ts 的 TIER_DEFAULT_NAMES 逐字一致：出厂档名只有一套。
    /** 档的出厂显示名，与 src/pack.ts 的 TIER_DEFAULT_NAMES 逐字一致。 */
    const TIER_NAMES = {
      tier1: 'Scout',
      tier2: 'Quick',
      tier3: 'Deep',
      tier4: 'Heavy',
    }
    /** 提示词覆盖的键：编排段一个，档四个（与 src/pack.ts 的 PROMPT_KEYS 一致）。 */
    const PROMPT_DELEGATION_KEY = 'delegation'
    const PROMPT_TIER_FIELDS = ['label', 'text']
    /** 模型位 pack 名缓存最多读几个工作区：每个工作区要一次 read，不做无界扇出。 */
    /** 模型位标签缓存最多读几个目录。与其余三包的工作区页上限（30）不是一回事。 */
    const LABEL_CWD_LIMIT = 8

    /** 工作区页每页显示几条；绑定表本身不截断，翻页拿全量。 */
    const WORKSPACES_PAGE = 20

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

    const TABS = [
      { value: 'packs', label: '分包' },
      { value: 'workspace', label: '工作区' },
      { value: 'prompts', label: '提示词' },
    ]


    // ---------- 纯函数 ----------

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * 名册：`data.state.packs.packs`，`Record<packId, Pack>`。
     *
     * 不用 `compatState` 塞进来的 `global` / `workspace` 两个旧字段——那是给旧面板
     * 过渡用的投影，语义与 pack 名册不是一回事（`global` 是已删除的一层）。
     */
    function packsOf(data) {
      const book = data && data.state && data.state.packs
      return book && isRecord(book.packs) ? book.packs : {}
    }

    /** 绑定表：`{ bindings: Record<cwd, packId> }`。目录清单由宿主的会话列表提供。 */
    function bindingsOf(data) {
      const bindings = data && data.state && data.state.bindings
      if (!isRecord(bindings)) return { bindings: {} }
      return { bindings: isRecord(bindings.bindings) ? bindings.bindings : {} }
    }

    /**
     * `ui.defaultTab`：缺省 model，与 `EMPTY_UI` 一致。
     *
     * 取值域校验放在这里：文件被手改成别的串时退回 model，而不是让 `Segmented`
     * 一个都不选中。
     */
    function defaultTabOf(data) {
      const ui = data && data.state && data.state.ui
      const value = ui && typeof ui.defaultTab === 'string' ? ui.defaultTab : ''
      return TABS.some((tab) => tab.value === value) ? value : 'packs'
    }

    /**
     * 当前 cwd 的原始绑定 id（可能悬空）。
     *
     * 与 `data.state.packId` 的区别：后者是**生效** id，悬空时已经回落成 `default`。
     */
    function packNameOf(data, id) {
      if (!id) return ''
      // default 的显示名固定：文件里可能是旧名（default / 出厂方案），界面统一成「默认」。
      if (id === DEFAULT_PACK_ID) return DEFAULT_PACK_NAME
      const pack = packsOf(data)[id]
      if (isRecord(pack) && typeof pack.name === 'string' && pack.name !== '') return pack.name
      return id + '（已删除）'
    }

    /**
     * 名册列表：`default` 排第一，其余按名字（`localeCompare(…, 'zh')`）排序。
     *
     * `default` 不参与名字序：它是求值链终点，不是一张普通 pack，混进名字序里用户
     * 找「基线」得先扫一遍列表。重名按 id 兜底——`parsePacks` 在 name 缺失时用 id
     * 代替，手改文件可能造出重名，没有兜底就不是全序。
     *
     * `frozenOrder` 是改动前那份视图的 id 序：待保存期间按它排，名册就不会因为刚落下的
     * 一条命令而重排。凭「改动前的排序键」而不是数组下标——新建的 pack 会插进数组，
     * 下标一挪就重排，而 id 是不变的键。
     *
     * `isDefault` 只标 `default` 那一张——它是求值链终点，不是「当前生效的那张」。
     * 服务端保证 `default` 一定存在（`parsePacks` 会补），这里不做兜底造行：
     * 真缺了就该显示成缺了，而不是画一个磁盘上不存在的 pack。
     */
    /**
     * 冻结排序：改动前那份视图的 id 序 → rank 表。
     *
     * 用 id 而不是数组下标：新建的 pack 会插进数组，下标一挪就重排。表里没有的（新建）
     * 落到 rank.size，同档按 id 比。空表表示「不冻结」，调用方按自己的缺省序排。
     */
    function frozenRank(ids) {
      const rank = new Map()
      if (!Array.isArray(ids)) return rank
      ids.forEach((id, index) => rank.set(id, index))
      return rank
    }
    function packListOf(data, frozenOrder) {
      const packs = packsOf(data)
      const ids = Object.keys(packs)
      const rank = frozenRank(frozenOrder)
      const nameOf = (id) => packNameOf(data, id)
      /** 名字序，重名按 id 兜底：没有兜底就不是全序。 */
      const byName = (a, b) => {
        const order = nameOf(a).localeCompare(nameOf(b), 'zh')
        return order !== 0 ? order : String(a).localeCompare(String(b))
      }
      if (rank.size === 0) {
        ids.sort((a, b) => {
          if (a === b) return 0
          if (a === DEFAULT_PACK_ID) return -1
          if (b === DEFAULT_PACK_ID) return 1
          return byName(a, b)
        })
      } else {
        ids.sort((a, b) => {
          const left = rank.has(a) ? rank.get(a) : rank.size
          const right = rank.has(b) ? rank.get(b) : rank.size
          return left === right ? byName(a, b) : left - right
        })
      }
      const at = ids.indexOf(DEFAULT_PACK_ID)
      if (at > 0) {
        ids.splice(at, 1)
        ids.unshift(DEFAULT_PACK_ID)
      }
      return ids.map((id) => {
        const value = packs[id]
        const fallback = isRecord(value) && typeof value.name === 'string' && value.name !== '' ? value.name : id
        return {
          id: id,
          name: id === DEFAULT_PACK_ID ? DEFAULT_PACK_NAME : fallback,
          pack: isRecord(value) ? value : { name: id, tiers: {} },
          isDefault: id === DEFAULT_PACK_ID,
        }
      })
    }

    /**
     * 一条路由的文本：`provider + separator + model + effort`。
     *
     * 两处调用点只有 `separator` 与 `effortFallback` 不同：设置页用 `a/b · 模型默认`
     * 明示「没指定强度」，摘要弹层用更窄的 `a / b`，缺省就不写。
     */
    function routeTextOf(route, separator, effortFallback) {
      if (!isRecord(route)) return '（未配置）'
      const effort =
        typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
          ? ' · ' + route.reasoningEffort
          : effortFallback
      return String(route.provider || '?') + separator + String(route.model || '?') + effort
    }

    /** 配了几档。缺省的档不暴露给模型，所以这里只数有首选的档。 */
    function tierCount(pack) {
      if (!isRecord(pack) || !isRecord(pack.tiers)) return 0
      let count = 0
      for (const tierId of TIER_IDS) {
        const tier = pack.tiers[tierId]
        if (isRecord(tier) && isRecord(tier.primary)) count += 1
      }
      return count
    }

    /** 从目录取模型条目；目录可能还没加载完，全部按「找不到」处理。 */
    function findModel(catalog, provider, model) {
      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
      for (const group of groups) {
        if (group.id !== provider) continue
        for (const entry of group.models || []) if (entry.id === model) return entry
        return null
      }
      return null
    }

    /** 目录里的第一条可用路由。新档位与「指定会话路由」都从它起步。 */
    function firstRoute(catalog) {
      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
      for (const group of groups) {
        for (const entry of group.models || []) return { provider: group.id, model: entry.id }
      }
      return { provider: '', model: '' }
    }

    /** 该模型的默认强度；没有 defaultEffort 时取公布的第一档。 */
    function pickEffort(catalog, provider, model) {
      const entry = findModel(catalog, provider, model)
      const reasoning = entry && entry.reasoning
      if (!reasoning) return undefined
      if (typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== '') return reasoning.defaultEffort
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      return efforts.length > 0 ? efforts[0].id : undefined
    }

    /** 删键式的路由拷贝：只在真的需要时才带上 reasoningEffort。 */
    function routeWithoutEffort(route) {
      return { provider: route.provider, model: route.model }
    }

    function normalizeRoute(route) {
      const out = { provider: String(route && route.provider ? route.provider : '').trim(), model: String(route && route.model ? route.model : '').trim() }
      if (isRecord(route) && typeof route.reasoningEffort === 'string' && route.reasoningEffort !== '') out.reasoningEffort = route.reasoningEffort
      return out
    }

    /** 一档的落盘形状；没有首选路由返回 null（= 这一档不存在）。 */
    function normalizeTier(tier, tierId) {
      if (!isRecord(tier) || !isRecord(tier.primary)) return null
      return {
        name: String(tier.name || '').trim() || TIER_NAMES[tierId],
        primary: normalizeRoute(tier.primary),
        fallbacks: Array.isArray(tier.fallbacks) ? tier.fallbacks.filter(isRecord).map(normalizeRoute) : [],
      }
    }

    /** 编辑值到落盘形状：只保留协议里的键，空串的 effort 直接丢掉（等于跟随）。 */
    function normalizePack(pack) {
      const out = { name: String(pack && pack.name ? pack.name : '').trim(), tiers: {} }
      if (isRecord(pack) && isRecord(pack.session)) out.session = normalizeRoute(pack.session)
      const tiers = pack && isRecord(pack.tiers) ? pack.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = normalizeTier(tiers[tierId], tierId)
        if (tier !== null) out.tiers[tierId] = tier
      }
      return out
    }

    /**
     * 编辑值 → 命令：只发改过的那几处。
     *
     * 优先细粒度（`renamePack` / `packSession` / `packTier`），不整张 `putPack`：
     * 整张写会把别人在这期间的改动一起写回。只有原 pack 读不到时才退回 `putPack`。
     *
     * `default` 的名字由服务端固定（`putPack` 也会强制改回出厂名），所以对它不发改名。
     */
    function packCommands(packId, original, next) {
      const after = normalizePack(next)
      if (!isRecord(original)) return [{ op: 'putPack', packId: packId, pack: after }]

      const commands = []
      if (packId !== DEFAULT_PACK_ID && after.name !== String(original.name || '')) {
        commands.push({ op: 'renamePack', packId: packId, name: after.name })
      }

      const beforeSession = isRecord(original.session) ? normalizeRoute(original.session) : null
      const afterSession = isRecord(after.session) ? after.session : null
      if (JSON.stringify(beforeSession) !== JSON.stringify(afterSession)) {
        commands.push({ op: 'packSession', packId: packId, session: afterSession })
      }

      const beforeTiers = isRecord(original.tiers) ? original.tiers : {}
      for (const tierId of TIER_IDS) {
        const before = normalizeTier(beforeTiers[tierId], tierId)
        const afterTier = isRecord(after.tiers[tierId]) ? after.tiers[tierId] : null
        if (JSON.stringify(before) !== JSON.stringify(afterTier)) {
          commands.push({ op: 'packTier', packId: packId, tierId: tierId, tier: afterTier })
        }
      }
      return commands
    }

    function validateRoute(route, label) {
      const problems = []
      if (!isRecord(route)) return [label + '不是对象']
      if (String(route.provider || '').trim() === '') problems.push(label + '缺少 provider')
      if (String(route.model || '').trim() === '') problems.push(label + '缺少 model')
      if (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || route.reasoningEffort.trim() === '')) {
        problems.push(label + '的思考等级是空串（要跟随模型默认请删掉这条键）')
      }
      return problems
    }

    /** 保存前的本地校验：名称非空、每条路由完整。后端只校验形状，语义靠这里挡。 */
    function validatePack(pack) {
      if (!isRecord(pack)) return ['pack 内容不是对象']
      const problems = []
      if (String(pack.name || '').trim() === '') problems.push('pack 名称不能为空')
      if (pack.session !== undefined) problems.push.apply(problems, validateRoute(pack.session, '会话路由'))
      const tiers = isRecord(pack.tiers) ? pack.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = tiers[tierId]
        if (tier === undefined) continue
        if (!isRecord(tier) || !isRecord(tier.primary)) {
          problems.push(TIER_NAMES[tierId] + '（' + tierId + '）没有首选路由')
          continue
        }
        problems.push.apply(problems, validateRoute(tier.primary, TIER_NAMES[tierId] + '首选'))
        const fallbacks = Array.isArray(tier.fallbacks) ? tier.fallbacks : []
        fallbacks.forEach((route, index) => {
          problems.push.apply(problems, validateRoute(route, TIER_NAMES[tierId] + '备选 ' + String(index + 1)))
        })
      }
      return problems
    }

    // ---------- 摘要弹层的差异 ----------

    /** `provider/model`，不看思考等级：强度单独比，两者常常只差一个。 */
    function routeCoreOf(route) {
      if (!isRecord(route)) return ''
      return String(route.provider || '') + '/' + String(route.model || '')
    }

    function effortOf(route) {
      if (!isRecord(route)) return ''
      return typeof route.reasoningEffort === 'string' ? route.reasoningEffort : ''
    }

    /**
     * 会话路由的差异。
     *
     * 只报「与默认不同」的那一面：两边都没配、或配得一样，都不算改动。
     * 默认那一层是内置时它根本没有 session 键，显式配一条就是改动。
     */
    function sessionDelta(pack, base) {
      const own = isRecord(pack) ? pack.session : undefined
      const fallback = isRecord(base) ? base.session : undefined
      const hasOwn = isRecord(own)
      const hasBase = isRecord(fallback)
      if (!hasOwn && !hasBase) return null
      if (hasOwn && !hasBase) return { text: '会话：' + routeTextOf(own, '/', '') }
      if (!hasOwn && hasBase) return { text: '会话：跟随系统默认' }
      if (routeCoreOf(own) === routeCoreOf(fallback) && effortOf(own) === effortOf(fallback)) return null
      return { text: '会话：' + routeTextOf(own, '/', '') }
    }

    /**
     * 一档的差异：`tier2：思考等级 high`。
     *
     * 首选路由、思考等级、备选、显示名各比一次，最后拼成一行——一档一行，
     * 拆成四条会让「这一档改了什么」反而看不出来。
     */
    function tierDelta(tierId, own, base) {
      const hasOwn = isRecord(own) && isRecord(own.primary)
      const hasBase = isRecord(base) && isRecord(base.primary)
      if (!hasOwn && !hasBase) return null
      if (hasOwn && !hasBase) return { text: tierId + '：已配置 ' + routeTextOf(own.primary, '/', '') }
      if (!hasOwn && hasBase) return { text: tierId + '：已停用' }
      const parts = []
      if (routeCoreOf(own.primary) !== routeCoreOf(base.primary)) {
        parts.push('首选 ' + routeTextOf(own.primary, '/', ''))
      } else if (effortOf(own.primary) !== effortOf(base.primary)) {
        parts.push('思考等级 ' + (effortOf(own.primary) === '' ? '模型默认' : effortOf(own.primary)))
      }
      const ownFallbacks = Array.isArray(own.fallbacks) ? own.fallbacks : []
      const baseFallbacks = Array.isArray(base.fallbacks) ? base.fallbacks : []
      if (JSON.stringify(ownFallbacks) !== JSON.stringify(baseFallbacks)) {
        parts.push(ownFallbacks.length === 0 ? '无备选' : '备选 ' + String(ownFallbacks.length) + ' 条')
      }
      if (String(own.name || '') !== String(base.name || '')) parts.push('名称 ' + String(own.name || ''))
      if (parts.length === 0) return null
      return { text: tierId + '：' + parts.join(' · ') }
    }

    /**
     * 这张 pack 相对默认 pack 的差异：会话路由一条，四档逐个。
     *
     * 与其余三包同构：只列「与 default 取值不同」的部分，没有键就是没改动。
     * `default` 自己与自己比没有差异，调用点会先排除它。
     */
    function diffOf(data, packId) {
      const packs = packsOf(data)
      const pack = packs[packId]
      const base = packs[DEFAULT_PACK_ID]
      const rows = []
      const session = sessionDelta(pack, base)
      if (session !== null) rows.push({ key: 'session', text: session.text })
      const ownTiers = isRecord(pack) && isRecord(pack.tiers) ? pack.tiers : {}
      const baseTiers = isRecord(base) && isRecord(base.tiers) ? base.tiers : {}
      for (const tierId of TIER_IDS) {
        const delta = tierDelta(tierId, ownTiers[tierId], baseTiers[tierId])
        if (delta !== null) rows.push({ key: tierId, text: delta.text })
      }
      return rows
    }

    // ---------- 提示词覆盖（spec §6.3.1） ----------

    /**
     * 生效值的统一视图：`{ delegation, tiers }`，缺字段一律补空串。
     *
     * 三份数据里只有 effective 参与渲染；builtin 与 overrides 只用来判断
     * 「这个键有没有被覆盖」——只比 effective 与 builtin，在用户恰好抄了内置时分不出来。
     */
    function promptTextOf(prompts) {
      const effective = isRecord(prompts) && isRecord(prompts.effective) ? prompts.effective : {}
      return {
        delegation: typeof effective.delegation === 'string' ? effective.delegation : '',
        tiers: tiersOf(effective),
      }
    }

    /**
     * 生效值里的档集合；没有就返回空对象。
     *
     * 多处解构都写同一句 `isRecord(x.tiers) ? x.tiers : {}`，漏一处就会拿到 undefined
     * 再去取键。收成一句，新增字段时也不用逐个改。
     */
    function tiersOf(value) {
      return isRecord(value) && isRecord(value.tiers) ? value.tiers : {}
    }

    /** 一档的生效值。缺 label / text 时补空串，输入框不会变成非受控组件。 */
    function promptTierBase(text, tierId) {
      const tier = isRecord(text) && isRecord(text.tiers) ? text.tiers[tierId] : null
      return {
        label: isRecord(tier) && typeof tier.label === 'string' ? tier.label : '',
        text: isRecord(tier) && typeof tier.text === 'string' ? tier.text : '',
      }
    }

    /**
     * 覆盖了哪些键：编排段一个，档四个（整档算一个键——resetPrompts 的粒度就是档）。
     *
     * 判据与后端一致：非空字符串才算写过。空串在解析时已被当成没写，
     * 这里再判一次是因为面板可能拿到别的客户端写下的文件。
     */
    function promptOverrideKeys(overrides) {
      const keys = []
      if (!isRecord(overrides)) return keys
      if (typeof overrides.delegation === 'string' && overrides.delegation.trim() !== '') keys.push(PROMPT_DELEGATION_KEY)
      const tiers = tiersOf(overrides)
      for (const tierId of TIER_IDS) {
        const tier = tiers[tierId]
        if (!isRecord(tier)) continue
        const hit = PROMPT_TIER_FIELDS.some((field) => typeof tier[field] === 'string' && tier[field].trim() !== '')
        if (hit) keys.push(tierId)
      }
      return keys
    }

    /** 提示词补丁类命令：一条只带自己那几个键，按绝对状态写入。 */
    function promptDelegationCommand(value) {
      return { op: 'putPrompts', delegation: value }
    }

    function promptTierCommand(tierId, field, value) {
      const patch = {}
      patch[field] = value
      const tiers = {}
      tiers[tierId] = patch
      return { op: 'putPrompts', tiers: tiers }
    }

    /** 「恢复内置」按档整键重置（后端 resetPrompts 的粒度就是档）。 */
    function promptResetCommand(key) {
      return { op: 'resetPrompts', keys: [key] }
    }

    /**
     * 空白字段拦在入队之前。
     *
     * 后端的 readPromptField 会拒空串与纯空白；语义上空串又等于「跟随内置」，
     * 而跟随内置有自己的入口（恢复内置）。就地拦下，报错比让后端回一句
     * 「不能为空串」更接近用户此刻想做的事。
     */
    function isBlankPrompt(value) {
      return typeof value !== 'string' || value.trim() === ''
    }

    /** 形如 `a/b` 的串的样本（spec §6.3.1 第 2 条）。不是校验，只用来提醒。 */
    const ROUTE_LIKE = /[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*/

    /**
     * 取段内第一处像 provider/model 的串。
     *
     * 插件里没有权威的 provider 名单，所以只提示不拦截：路径写法（docs/agents）
     * 也会命中，提示措辞必须容得下这种误报。
     */
    function routeLikeIn(text) {
      if (typeof text !== 'string') return ''
      const hit = text.match(ROUTE_LIKE)
      return hit ? hit[0] : ''
    }

    // ---------- 模型目录 ----------

    /**
     * 目录是宿主状态，不归面板管：一个实例、一份快照、一次加载。
     *
     * 只在 apply 里 start（发请求、订阅事件），组件只订阅快照。
     * 这样刷新页面时不会出现「每个渲染各发一次 modelCatalog」。
     */
    function createCatalog(host) {
      let snapshot = { phase: 'idle', groups: [], error: null }
      const listeners = new Set()

      const emit = () => {
        for (const listener of listeners) listener()
      }
      const set = (phase, groups, error) => {
        snapshot = { phase: phase, groups: groups || [], error: error || null }
        emit()
      }
      const read = () => snapshot
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }

      // 请求序号：llm/adapters-updated 与 connection/reset 可能连发，
      // 慢的先发后到会把新目录覆盖成旧的，用户选到已下线的模型。
      let loadSeq = 0

      const load = () => {
        const session = host.remote && host.remote.session
        if (!session || typeof session.modelCatalog !== 'function') {
          set('unavailable', [], '宿主没有提供模型目录（remote.session.modelCatalog 不存在），模型下拉为空')
          return
        }
        const id = ++loadSeq
        set('loading', snapshot.groups, null)
        let pending
        try {
          pending = session.modelCatalog()
        } catch (error) {
          if (id !== loadSeq) return
          set('error', [], '读取模型目录失败：' + String(error))
          return
        }
        Promise.resolve(pending).then(
          (response) => {
            if (id !== loadSeq) return
            if (!response || response.ok !== true) {
              const message = response && response.error && response.error.message ? response.error.message : '未知原因'
              set('error', [], '读取模型目录失败：' + message)
              return
            }
            const value = response.value || {}
            set('ready', Array.isArray(value.groups) ? value.groups : [], null)
          },
          (failure) => {
            if (id !== loadSeq) return
            set('error', [], '读取模型目录失败：' + String(failure && failure.message ? failure.message : failure))
          },
        )
      }

      return { read: read, subscribe: subscribe, load: load }
    }


    // ---------- 数据 ----------


    async function listWorkspaces(host, sessionId) {
      const session = host && host.remote ? host.remote.session : null
      if (!session || typeof session.list !== 'function') return { currentCwd: null, cwds: [] }
      let result
      try {
        result = await session.list({})
      } catch {
        return { currentCwd: null, cwds: [] }
      }
      if (!result || result.ok !== true) return { currentCwd: null, cwds: [] }
      const items = result.value && Array.isArray(result.value.items) ? result.value.items : []
      const roots = items.filter((item) => item && typeof item.cwd === 'string' && item.cwd !== '' && item.origin !== 'subagent')
      let currentCwd = null
      if (typeof sessionId === 'string' && sessionId !== '') {
        for (const item of roots) {
          const id = item.sessionId ?? item.id ?? (item.session && item.session.id)
          if (id === sessionId) {
            currentCwd = item.cwd
            break
          }
        }
      }
      if (currentCwd === null) {
        let latest = null
        for (const item of roots) {
          if (latest === null || (Number(item.updatedAt) || 0) > (Number(latest.updatedAt) || 0)) latest = item
        }
        currentCwd = latest === null ? null : latest.cwd
      }
      // 不在这里截断：工作区页要能管理全部绑定，截断只属于模型位缓存那一处。
      const cwds = []
      const seen = {}
      for (const item of roots) {
        const key = normalizeCwd(item.cwd)
        if (key === null || seen[key] === true) continue
        seen[key] = true
        cwds.push(item.cwd)
      }
      cwds.sort((a, b) => compareCwd(normalizeCwd(a), normalizeCwd(b)))
      return { currentCwd: currentCwd, cwds: cwds }
    }

    /**
     * 读面板数据：一次 read 就够。
     *
     * 设置页是全局视图：read 不带 cwd，不按任何目录求值。绑定表
     * （`state.bindings`）本来也与 cwd 无关——它读的是同一份 workspaces.json，
     * 一次 read 就带回全部工作区的绑定。
     */
    async function loadPanel(host) {
      const listing = await listWorkspaces(host, env.sessionId)
      const data = await api.read(null)
      return { data: data, cwds: listing.cwds }
    }

    /**
     * 面板视图 + 一批即时写命令。
     *
     * 改动不再一律「点一下即落盘」：路由、档位、提示词、绑定、新建与改名都进待保存队列
     * （见 ADR 0006）。还走这里的只剩当场就该生效的几类——删除 pack、`defaultTab`。
     */
    function useSchemeView(host) {
      const [state, setState] = useState({
        phase: 'loading',
        data: null,
        cwds: [],
        error: null,
      })
      const [tick, setTick] = useState(0)
      const reload = useCallback(() => setTick((value) => value + 1), [])

      useEffect(() => {
        let alive = true
        setState((prev) => ({ ...prev, phase: prev.data ? prev.phase : 'loading', error: null }))
        ;(async () => {
          try {
            const loaded = await loadPanel(host)
            if (!alive) return
            setState({ phase: 'ready', data: loaded.data, cwds: loaded.cwds, error: null })
          } catch (failure) {
            if (!alive) return
            setState((prev) => ({ ...prev, phase: 'error', error: String(failure && failure.message ? failure.message : failure) }))
          }
        })()
        return () => {
          alive = false
        }
      }, [host, tick])

      /**
       * 立即写一批命令，成功就用返回的新状态替换当前快照。
       *
       * 返回新状态而不是再 read 一次：`apply` 的响应就是落盘后重读的完整视图，
       * 多一次 read 既慢又可能读到别人刚写的中间态。调用方拿它反查新建的 pack id。
       *
       * 设置页是全局视图：不带 cwd。命令自带 cwd（bind），回读的
       * `state.binding` 是哪条不参与渲染。
       */
      const run = useCallback(
        async (commands) => {
          try {
            const data = await api.apply(null, commands)
            setState((prev) => ({ ...prev, phase: 'ready', data: data, error: null }))
            // 绑定与名册改动要把 chip 和模型位标签一起更新：两处都在会话页，与设置页
            // 之间没有通道，只能在这里主动重读。模型位那条缓存不失效的话，用户改完
            // 绑定回到 composer 看到的还是旧 pack 名，只能整页刷新。
            if (
              commands.some(
                (command) =>
                  command.op === 'bind' ||
                  command.op === 'deletePack' ||
                  command.op === 'renamePack' ||
                  command.op === 'putPack' ||
                  command.op === 'createPack' ||
                  command.op === 'duplicatePack',
              )
            ) {
              refreshChipName(host, env.sessionId)
              void labelRefresh(host)
            }
            return data
          } catch (failure) {
            setState((prev) => ({ ...prev, error: String(failure && failure.message ? failure.message : failure) }))
            return null
          }
        },
        [host],
      )

      /**
       * 采纳一份新快照。
       *
       * 待保存队列提交后拿到的就是落盘后的整车视图，直接替换当前快照，不再 read 一次：
       * 多一次 read 既慢，又可能读到别人刚写进去的中间态。绑定与名册的改动要把 chip 与
       * 模型位标签一起更新——两处都在会话页，与设置页之间没有通道，只能在这里主动重读。
       */
      const accept = useCallback(
        (data) => {
          setState((prev) => ({ ...prev, phase: 'ready', data: data, error: null }))
          refreshChipName(host, env.sessionId)
          void labelRefresh(host)
        },
        [host],
      )

      return { state: state, reload: reload, run: run, accept: accept }
    }

    function useCatalog(catalog) {
      const [snapshot, setSnapshot] = useState(catalog.read())
      useEffect(() => {
        setSnapshot(catalog.read())
        return catalog.subscribe(() => setSnapshot(catalog.read()))
      }, [catalog])
      return snapshot
    }


    // ---------- 基础组件 ----------

    /**
     * 极小的可观测量。
     *
     * chip 在会话页、设置页在设置弹层里，两者在 React 上没有父子关系；绑定改了要让
     * chip 上的名字跟着变，只能靠一个可订阅的值。一个 set/subscribe 就够，不引状态库。
     */

    function ModelChevron(props) {
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

    function ModelPicker(props) {
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
            // 只降触发器：菜单挂在这个按钮的兄弟节点上，不能跟着一起半透明。
            style: props.dim === true ? { ...S.pickerTrigger, opacity: 0.6 } : S.pickerTrigger,
            title: props.title || label,
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            disabled: props.disabled === true,
            onClick: (event) => {
              event.stopPropagation()
              setOpen(!open)
            },
          },
          h('span', { style: S.pickerLabel }, label),
          h(ModelChevron, { open: open }),
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


    function Tag(props) {
      const face = props || {}
      return h('span', { style: face.danger ? S.badgeWarn : S.badge, title: face.title }, face.children)
    }

    /**
     * 面板按钮。颜色全部在 `PANEL_CSS` 里，这里只给尺寸与语义。
     *
     * 尺寸抄官方设置页的行内操作按钮（28px 高、左右 10px、12px 字、radius-sm），
     * 比原来的裸文字热区大一倍以上——裸文字只有字号那么高，指针要精确压住才点得中。
     */

    function ModelTextField(props) {
      const [buffer, setBuffer] = useState(null)
      const cancelled = useRef(false)
      const value = buffer === null ? String(props.value === undefined ? '' : props.value) : buffer
      const commit = () => {
        const next = cancelled.current ? null : buffer
        cancelled.current = false
        setBuffer(null)
        if (next === null) return
        if (next === String(props.value === undefined ? '' : props.value)) return
        props.onCommit(next)
      }
      const shared = {
        value: value,
        disabled: props.disabled === true,
        placeholder: props.placeholder,
        title: props.title,
        style: props.style,
        autoFocus: props.autoFocus === true,
        onFocus: props.onFocus,
        onClick: (event) => event.stopPropagation(),
        onChange: (event) => setBuffer(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          // 宿主的设置弹层把 Esc 当「关闭面板」，这里必须拦住冒泡。
          if (event.key === 'Escape') {
            event.stopPropagation()
            cancelled.current = true
            setBuffer(null)
            if (props.onCancel) props.onCancel()
            return
          }
          if (event.key === 'Enter' && props.multiline !== true) {
            event.preventDefault()
            event.currentTarget.blur()
          }
        },
      }
      if (props.multiline === true) return h('textarea', { ...shared, rows: props.rows })
      return h('input', shared)
    }

    /** 每条命令命中哪一格状态。同键后写覆盖，队列里永远只有最后一次取值。 */

    // ---------- 路由编辑 ----------

    /**
     * 一条路由：provider / model / 思考等级三个下拉。
     *
     * 思考等级有两条互斥的路径，且**都不是下拉里的空选项**：
     *   - 键存在 → 下拉只列该模型公布的强度，旁边是「跟随模型默认」按钮（点它删键）；
     *   - 键不存在 → 不渲染下拉，显示「跟随模型默认」文本 + 「指定强度」按钮。
     * 换 provider/model 时顺手清掉新模型不支持的强度：留着必然是一条无效路由。
     */
    function RouteFields(props) {
      const value = props.value || { provider: '', model: '' }
      const catalog = props.catalog || { groups: [] }
      const disabled = props.disabled === true
      const onChange = props.onChange
      const groups = Array.isArray(catalog.groups) ? catalog.groups : []
      const group = groups.find((candidate) => candidate.id === value.provider)
      const models = group && Array.isArray(group.models) ? group.models : []
      const entry = models.find((candidate) => candidate.id === value.model)
      // 只有「填了但目录里没有」才标灰。空路由是新建中的正常状态，
      // 一进来就标红「当前不可用」会让用户以为磁盘上已经有一条坏配置。
      const filled = value.provider !== '' && value.model !== ''
      const known = filled && Boolean(group && entry)
      const efforts = entry && entry.reasoning && Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts : []
      const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort : ''

      // 目录里找不到的取值仍要出现在菜单里，否则下拉会显示成空——那会被误读成「没配」。
      //
      // provider 与 model 合成一个下拉：它们是同一条路由的两半，分成两个下拉时
      // 用户要先选 provider 才能看到 model，而实际选择时想的是「哪个模型」。
      // 分隔符用 \u0000：provider 与 model 的 id 里都不会出现它。
      const SEP = '\u0000'
      const routeOptions = []
      for (const candidate of groups) {
        const list = Array.isArray(candidate.models) ? candidate.models : []
        for (const model of list) {
          routeOptions.push({
            value: candidate.id + SEP + model.id,
            label: (candidate.name || candidate.id) + ' · ' + (model.name || model.id),
          })
        }
      }
      const currentKey = value.provider !== '' && value.model !== '' ? value.provider + SEP + value.model : ''
      if (currentKey !== '' && !known) {
        routeOptions.unshift({ value: currentKey, label: value.provider + ' · ' + value.model + '（不在目录中）' })
      }

      const chooseRoute = (key) => {
        const at = key.indexOf(SEP)
        if (at < 0) return
        const provider = key.slice(0, at)
        const model = key.slice(at + 1)
        const nextGroup = groups.find((candidate) => candidate.id === provider)
        const nextModels = nextGroup && Array.isArray(nextGroup.models) ? nextGroup.models : []
        const nextEntry = nextModels.find((candidate) => candidate.id === model)
        const nextEfforts =
          nextEntry && nextEntry.reasoning && Array.isArray(nextEntry.reasoning.efforts)
            ? nextEntry.reasoning.efforts.map((item) => item.id)
            : []
        // 换模型时思考等级只在仍然合法时保留，否则删键回到「跟随模型默认」。
        const keep = effort !== '' && nextEfforts.indexOf(effort) >= 0 ? { reasoningEffort: effort } : {}
        onChange({ provider: provider, model: model, ...keep })
      }

      const knownEfforts = efforts.map((candidate) => ({ value: candidate.id, label: candidate.name || candidate.id }))
      const effortOptions = knownEfforts.some((candidate) => candidate.value === effort)
        ? knownEfforts
        : [{ value: effort, label: effort + '（该模型未公布）' }].concat(knownEfforts)

      // 失效路由的「变淡」只能落在触发器上，不能落在容器上。
      // 容器一旦 opacity < 1，会把整个合成层做半透明，下拉菜单也不例外：
      // 菜单背后的表单文字透出来，就成了一眼看不清的两层字。子元素无法把
      // 父级 opacity 补回来，所以这里把透明度下发给 ModelPicker，由它只装饰触发器。
      const dim = filled && !known

      return h(
        'div',
        { style: { flex: '1 1 320px', minWidth: '240px' } },
        // 一行放下：provider/model 合并下拉 + 思考等级。标签由调用方给（首选 / 备选），
        // 这里不再重复写「首选」——同一块里出现两次同样的词只是噪音。
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap' } },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: '150px' } },
            h(ModelPicker, {
              value: currentKey,
              placeholder: 'provider · model',
              disabled: disabled,
              dim: dim,
              options: routeOptions,
              onChange: chooseRoute,
            }),
          ),
          h(
            'div',
            { style: { flex: '0 0 auto', width: '82px' } },
            effort !== ''
              ? h(ModelPicker, {
                  value: effort,
                  disabled: disabled,
                  dim: dim,
                  // 必须显式压小：ModelPicker 根节点默认 minWidth 120px，套在窄容器里
                  // 会撑出去盖住右边的按钮。
                  minWidth: '60px',
                  options: effortOptions,
                  onChange: (next) => onChange({ ...value, reasoningEffort: next }),
                })
              : h(
                  'button',
                  {
                    type: 'button',
                    disabled: disabled || efforts.length === 0,
                    title:
                      efforts.length === 0
                        ? '该模型不公布思考等级'
                        : '当前跟随模型默认；点一下指定强度',
                    style: {
                      ...S.pickerTrigger,
                      color: T.dim,
                      cursor: disabled || efforts.length === 0 ? 'not-allowed' : 'pointer',
                      opacity: efforts.length === 0 ? 0.5 : 1,
                    },
                    onClick: () =>
                      onChange({ ...value, reasoningEffort: pickEffort(catalog, value.provider, value.model) }),
                  },
                  h('span', { style: S.pickerLabel }, efforts.length === 0 ? '无' : '默认'),
                ),
          ),
          effort !== ''
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: disabled,
                  style: { ...S.reset, flex: '0 0 auto', opacity: dim ? 0.6 : 1 },
                  title: '删掉 reasoningEffort 键，回到跟随模型默认',
                  onClick: () => onChange(routeWithoutEffort(value)),
                },
                '↺',
              )
            : null,
          filled && !known
            ? h(
                Tag,
                { danger: true, title: '目录里找不到这条路由；保存后仍会写入，执行时按「当前不可用」处理' },
                '不可用',
              )
            : null,
        ),
      )
    }

    // ---------- 档位编辑 ----------

    function defaultTier(tierId, catalog) {
      return { name: TIER_NAMES[tierId], primary: firstRoute(catalog), fallbacks: [] }
    }
    /**
     * 一档：名称、首选、有序备选。
     *
     * 「停用此档」= 删掉 tiers[tierId] 这个键（= 模型看不到这一档），
     * 不是把首选清空——空首选会被后端当成坏档丢掉，两者结果一样但意图不同。
     */
    function TierEditor(props) {
      const tierId = props.tierId
      const tier = props.tier
      const catalog = props.catalog
      const disabled = props.disabled === true
      const onChange = props.onChange
      const [renaming, setRenaming] = useState(false)

      if (!isRecord(tier)) {
        return h(
          'div',
          { style: S.row },
          h(
            'div',
            { style: S.rowMain },
            h('div', { style: S.rowName }, TIER_NAMES[tierId], h(Tag, null, tierId), h(Tag, null, '未配置')),
            h('div', { style: S.rowMeta }, '没配置的档不会出现在 subagent_tier 的可选值里。'),
          ),
          h(Button, { variant: 'secondary', disabled: disabled, onClick: () => onChange(defaultTier(tierId, catalog)) }, '启用此档'),
        )
      }

      const fallbacks = Array.isArray(tier.fallbacks) ? tier.fallbacks : []
      // 档名会原样进系统提示词（`tier1 Scout — …`）；形如 provider/model 的串只提醒，不拦截。
      const nameLike = routeLikeIn(String(tier.name || ''))
      const setTier = (next) => onChange({ name: next.name, primary: next.primary, fallbacks: next.fallbacks })

      const moveFallback = (index, delta) => {
        const next = fallbacks.slice()
        const target = index + delta
        if (target < 0 || target >= next.length) return
        const item = next[index]
        next[index] = next[target]
        next[target] = item
        setTier({ ...tier, fallbacks: next })
      }

      return h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.fieldHead },
          h('span', { style: S.groupName }, TIER_NAMES[tierId]),
          h(Tag, null, tierId),
          h(Button, { variant: 'danger', disabled: disabled, onClick: () => onChange(null) }, '停用此档'),
        ),
        // 名称与首选同一行：名称通常就是档名，单独占一行只是把首选挤下去。
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '名称'),
          h(
            'div',
            { style: { flex: '0 1 140px', minWidth: '100px' } },
            // 双击名字即改名：改名的常见入口就是「看见名字想改」，不必先点一个按钮。
            renaming
              ? h(ModelTextField, {
                  autoFocus: true,
                  value: tier.name || '',
                  style: S.input,
                  disabled: disabled,
                  placeholder: TIER_NAMES[tierId],
                  onCommit: (name) => {
                    setRenaming(false)
                    const trimmed = name.trim()
                    if (trimmed === '') return
                    setTier({ ...tier, name: trimmed })
                  },
                  onCancel: () => setRenaming(false),
                })
              : h(
                  'span',
                  {
                    style: { ...S.rowName, cursor: disabled ? 'default' : 'text' },
                    title: disabled ? '' : '双击改名',
                    onDoubleClick: disabled
                      ? undefined
                      : (event) => {
                          event.stopPropagation()
                          setRenaming(true)
                        },
                  },
                  String(tier.name || '') || TIER_NAMES[tierId],
                ),
          ),
          h(RouteFields, {
            value: tier.primary,
            catalog: catalog,
            disabled: disabled,
            onChange: (next) => setTier({ ...tier, primary: next }),
          }),
        ),
        nameLike !== ''
          ? h(
              'div',
              { style: { ...S.notice, color: T.warn, borderColor: T.warn } },
              '档名里出现「' + nameLike + '」——形如 provider/model 的串会原样写进系统提示词，建议改成任务类型名。',
            )
          : null,
        // 备选：一行说明 + 添加按钮，下面每行一条路由，顺序即回退顺序。
        h(
          'div',
          { style: { ...S.fieldRow, paddingTop: '6px' } },
          h('span', { style: S.fieldLabel }, '备选'),
          h(
            'span',
            { style: S.rowMeta },
            fallbacks.length === 0
              ? '首选不可用时直接报错'
              : '首选不可用时按下列顺序依次尝试',
          ),
          h(Button, {
            variant: 'secondary',
            disabled: disabled,
            onClick: () => setTier({ ...tier, fallbacks: fallbacks.concat([firstRoute(catalog)]) }),
          }, '添加'),
        ),
        fallbacks.map((route, index) =>
          h(
            'div',
            { key: String(index), style: S.fallbackRow },
            h(RouteFields, {
              value: route,
              catalog: catalog,
              disabled: disabled,
              onChange: (next) => {
                const list = fallbacks.slice()
                list[index] = next
                setTier({ ...tier, fallbacks: list })
              },
            }),
            h(Button, { variant: 'secondary', disabled: disabled || index === 0, onClick: () => moveFallback(index, -1) }, '↑'),
            h(Button, { variant: 'secondary', disabled: disabled || index === fallbacks.length - 1, onClick: () => moveFallback(index, 1) }, '↓'),
            h(ConfirmButton, {
              disabled: disabled,
              label: '删除',
              confirmLabel: '确认',
              title: '删掉这条备选路由',
              onConfirm: () => {
                const list = fallbacks.slice()
                list.splice(index, 1)
                setTier({ ...tier, fallbacks: list })
              },
            }),
          ),
        ),
      )
    }

    // ---------- pack 内容编辑 ----------

    /**
     * pack 内容编辑器：会话路由 + 四档。
     *
     * 值来自**试算视图**里的那张 pack，改动立刻算成细粒度命令并入队——不再攒一份整包
     * 草稿再一次性提交。两套并存时「哪一份才算数」说不清，所以旧的草稿整套删掉了。
     */
    function SinglePackEditor(props) {
      const packId = props.packId
      const pack = props.pack
      const catalog = props.catalog
      const support = props.support
      const onChange = props.onChange
      const tiers = isRecord(pack.tiers) ? pack.tiers : {}
      const tierDisabled = support.subagents === false
      // `default` 的名字由服务端固定（改名命令会被拒），改不了就不给入口。
      const nameLocked = packId === DEFAULT_PACK_ID

      const setSession = (next) => {
        if (next === null) {
          // 跟随 = 删键。构造新对象而不是 delete，视图才不会被就地改写。
          onChange({ name: pack.name, tiers: pack.tiers })
          return
        }
        onChange({ ...pack, session: next })
      }

      const setTier = (tierId, next) => {
        const nextTiers = { ...tiers }
        if (next === null) delete nextTiers[tierId]
        else nextTiers[tierId] = next
        onChange({ ...pack, tiers: nextTiers })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '名称'),
          h(
            'div',
            { style: { flex: '0 1 200px', minWidth: '120px' } },
            nameLocked
              ? h('span', { style: S.rowName }, DEFAULT_PACK_NAME)
              : h(ModelTextField, {
                  value: pack.name || '',
                  style: S.input,
                  placeholder: '比如：标准',
                  onCommit: (name) => {
                    const trimmed = name.trim()
                    if (trimmed === '' || trimmed === pack.name) return
                    onChange({ ...pack, name: trimmed })
                  },
                }),
          ),
          nameLocked ? h(Tag, { title: '默认 pack 不可改名' }, '固定') : h('span', { style: S.hint }, '改完失焦即入队'),
          h('span', { style: S.mono }, 'id: ' + packId),
        ),
        h(
          'div',
          { style: { ...S.fieldRow, marginTop: '6px' } },
          h('div', { style: S.rowMain },
            h('div', { style: S.rowName }, '会话路由'),
            h('div', { style: S.rowMeta }, '只作用于该工作区里之后新建的会话；已有会话不变。'),
          ),
          isRecord(pack.session)
            ? h(Button, { variant: 'secondary', onClick: () => setSession(null), title: '删掉 session 键，回到官方默认' }, '跟随系统默认')
            : h(Button, { variant: 'secondary', onClick: () => setSession(firstRoute(catalog)) }, '指定会话路由'),
        ),
        isRecord(pack.session)
          ? h(RouteFields, {
              value: pack.session,
              catalog: catalog,
              onChange: (next) => setSession(next),
            })
          : null,
        h(
          'div',
          { style: { ...S.fieldRow, marginTop: '6px' } },
          h('div', { style: S.rowMain },
            h('div', { style: S.rowName }, '档位', h(Tag, null, '子智能体')),
            h('div', { style: S.rowMeta }, '四档按难度固定；每档的首选与备选各自带模型与思考等级。'),
          ),
        ),
        support.subagents === false
          ? h('div', { style: S.probeWarn }, '档位不可用：' + (support.reason ? support.reason : '子智能体插件未启用'))
          : null,
        support.subagents !== false && support.restrict === false
          ? h('div', { style: S.probeFail }, '官方 subagent 工具未被屏蔽（tools.restrict 不可用），模型可能绕过档位直接委派。')
          : null,
        h(
          'div',
          { style: tierDisabled ? S.disabledSection : null },
          TIER_IDS.map((tierId) =>
            h(TierEditor, {
              key: tierId,
              tierId: tierId,
              tier: tiers[tierId],
              catalog: catalog,
              // 不支持子智能体时连键盘也进不去：置灰容器只能挡住鼠标。
              disabled: tierDisabled,
              onChange: (next) => setTier(tierId, next),
            }),
          ),
        ),
      )
    }

    // ---------- 提示词编辑 ----------

    /**
     * 字段级提示：空白与 provider/model 串。
     *
     * 前者在入队前就拦下（后端会拒空串），后者只提醒。两者都不是校验：
     * 面板没有权威的 provider 名单，硬校验只会误杀（spec §6.3.1 第 2 条）。
     */
    function PromptFieldNotice(props) {
      const value = typeof props.value === 'string' ? props.value : ''
      if (value.trim() === '') {
        return h('div', { style: S.fieldRow }, h('div', { style: S.rowMain }, h('div', { style: S.error }, '不能为空。想用内置文本请点「恢复内置」。')))
      }
      const hit = routeLikeIn(value)
      if (hit === '') return null
      return h(
        'div',
        { style: S.fieldRow },
        h(
          'div',
          { style: S.rowMain },
          h(
            'div',
            { style: { ...S.notice, color: T.warn, borderColor: T.warn } },
            '段内出现「' + hit + '」——形如 provider/model 的串。段里出现模型名会让前缀随会话变化，破坏前缀缓存；若这只是路径，可以忽略（这条不阻止保存）。',
          ),
        ),
      )
    }

    /**
     * 一档提示词：名称 + 判据。
     *
     * 「恢复内置」按档整键重置（后端 resetPrompts 的粒度就是档），所以清空输入框不能
     * 等价于恢复内置：空输入框会被拦下，见 PromptFieldNotice。
     */
    function PromptTierEditor(props) {
      const tierId = props.tierId
      const base = props.base || { label: '', text: '' }
      const overridden = props.overridden === true
      const disabled = props.disabled === true
      const onCommit = props.onCommit
      const onReset = props.onReset

      const commit = (field, value) => {
        if (isBlankPrompt(value)) {
          props.notify(TIER_NAMES[tierId] + (field === 'label' ? '的名称' : '的判据') + '不能为空。想用内置文本请点「恢复内置」。')
          return
        }
        if (value === base[field]) return
        onCommit(tierId, field, value)
      }

      return h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.fieldHead },
          h('span', { style: S.groupName }, TIER_NAMES[tierId]),
          h(Tag, null, tierId),
          overridden ? h(Tag, { danger: true, title: '这一档至少有一个字段是你自己填的' }, '已自定义') : h(Tag, null, '内置'),
          h(Button, {
            variant: 'secondary',
            disabled: disabled || !overridden,
            title: overridden ? '删掉该档的覆盖，回到内置' : '当前就是内置',
            onClick: () => onReset(tierId),
          }, '恢复内置'),
        ),
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '名称'),
          h(
            'div',
            { style: S.rowMain },
            h(ModelTextField, {
              value: base.label,
              style: S.input,
              disabled: disabled,
              placeholder: base.label,
              onCommit: (value) => commit('label', value),
            }),
          ),
        ),
        h(PromptFieldNotice, { value: base.label }),
        h(
          'div',
          { style: { ...S.fieldRow, alignItems: 'flex-start' } },
          h('span', { style: S.fieldLabel }, '判据'),
          h(
            'div',
            { style: S.rowMain },
            h(ModelTextField, {
              multiline: true,
              rows: 2,
              value: base.text,
              style: S.textarea,
              disabled: disabled,
              onCommit: (value) => commit('text', value),
            }),
          ),
        ),
        h(PromptFieldNotice, { value: base.text }),
      )
    }

    /**
     * 提示词区：编排段 + 四档判据（spec §6.3.1）。
     *
     * 与 pack 正交：所有 pack 共用同一份覆盖，全局一份。
     * 改动进待保存队列；「恢复内置」也是一条命令（resetPrompts）——它删键，与写入空串
     * 是两件事。
     */
    function PromptSection(props) {
      const prompts = props.prompts
      const disabled = props.disabled === true
      const queue = props.queue
      const notify = props.notify
      if (!isRecord(prompts)) return null

      const effective = promptTextOf(prompts)
      const overridden = promptOverrideKeys(prompts.overrides)
      const delegationOverridden = overridden.indexOf(PROMPT_DELEGATION_KEY) >= 0

      const commitDelegation = (value) => {
        if (isBlankPrompt(value)) {
          notify('编排段不能为空。想用内置文本请点「恢复内置」。')
          return
        }
        if (value === effective.delegation) return
        queue(promptDelegationCommand(value))
      }
      const commitTier = (tierId, field, value) => queue(promptTierCommand(tierId, field, value))
      const reset = (key) => queue(promptResetCommand(key))

      return h(
        'div',
        { style: S.section },
        h(
          'div',
          { style: S.groupHead },
          h('span', { style: S.groupName }, '提示词'),
          h(Tag, { title: '所有 pack 共用这一份，与具体 pack 无关' }, '全局'),
        ),
        h(
          'div',
          { style: S.rowFirst },
          h(
            'div',
            { style: S.rowMain },
            h('div', { style: S.rowMeta }, '这些文字会进入系统提示词。改完失焦即入队，点底部「保存」才写盘；想回到插件自带的文本，点「恢复内置」。输入框留空不算恢复内置。'),
          ),
        ),
        h(
          'div',
          { style: S.field },
          h(
            'div',
            { style: S.fieldHead },
            h('span', { style: S.groupName }, '编排段'),
            h(Tag, { title: '系统提示词里的段名：model-pack.delegation' }, '系统提示词'),
            delegationOverridden ? h(Tag, { danger: true, title: '当前用的是你自己写的文本' }, '已自定义') : h(Tag, null, '内置'),
            h(Button, {
              variant: 'secondary',
              disabled: disabled || !delegationOverridden,
              title: delegationOverridden ? '删掉 delegation 覆盖，回到内置' : '当前就是内置',
              onClick: () => reset(PROMPT_DELEGATION_KEY),
            }, '恢复内置'),
          ),
          h(
            'div',
            { style: { ...S.fieldRow, alignItems: 'flex-start' } },
            h(
              'div',
              { style: S.rowMain },
              h(ModelTextField, {
                multiline: true,
                rows: 8,
                value: effective.delegation,
                style: S.textarea,
                disabled: disabled,
                onCommit: commitDelegation,
              }),
            ),
          ),
          h(PromptFieldNotice, { value: effective.delegation }),
        ),
        TIER_IDS.map((tierId) =>
          h(PromptTierEditor, {
            key: tierId,
            tierId: tierId,
            base: promptTierBase(effective, tierId),
            overridden: overridden.indexOf(tierId) >= 0,
            disabled: disabled,
            notify: notify,
            onCommit: commitTier,
            onReset: reset,
          }),
        ),
      )
    }


    // ---------- 分包页：名册 ----------

    /**
     * pack 名册：新建、改名、删除，点一行展开内容。
     *
     * 不再单列一个「编辑哪张 pack」的下拉：名册里每行都有入口，点了就展开，
     * 两处入口做同一件事只会让人犹豫点哪个。`default` 没有改名与删除入口——它是
     * 求值链的终点，删掉或改名之后「未绑定即默认」就失去指代；但内容可以改。
     */
    function PackRoster(props) {
      const packs = props.packs
      /*
       * 磁盘上真实存在的 pack id。
       *
       * 刚新建、还没保存的 pack 只在试算视图里，磁盘上没有实体：给它删除按钮只会得到
       * 一条「不存在，已忽略」的告警，而那条「新建」命令还留在队列里。这类行改成
       * 禁用删除并说明「用撤销撤回新建」。
       */
      const realIds = props.realIds || new Set()
      const bindings = props.bindings
      const expanded = props.expanded
      const isPending = props.isPending
      const onCreate = props.onCreate
      const onRename = props.onRename
      const onDuplicate = props.onDuplicate
      const notify = props.notify
      const onToggle = props.onToggle
      const onChangePack = props.onChangePack
      const onDelete = props.onDelete
      const [newName, setNewName] = useState('')
      const [renaming, setRenaming] = useState(null)

      const createPack = () => {
        const trimmed = newName.trim()
        if (trimmed === '') return
        // 重名在客户端先拦：只靠服务端拒的话，`packs.json` 这次不会应用，界面上
        // 表现为「点了新建、什么都没出现」。
        if (packs.some((entry) => entry.name === trimmed)) {
          notify('已经有同名的 pack：' + trimmed)
          return
        }
        onCreate(trimmed)
        setNewName('')
      }

      /** 一处配置 = 会话路由或某一档；用来一眼看出这张 pack 改了多少。 */
      const configured = (entry) => {
        const pack = entry.pack
        if (!isRecord(pack)) return 0
        return (isRecord(pack.session) ? 1 : 0) + tierCount(pack)
      }

      /** 绑到这张 pack 的目录。删除前要把它们列出来：删完它们会回落默认。 */
      const boundCwds = (packId) => {
        const list = []
        for (const [cwd, id] of Object.entries(bindings)) {
          if (id === packId) list.push(cwd)
        }
        return list
      }

      return h(
        'div',
        { style: S.block },
        // 新建在最上：它是这一页的入口，放列表底下要滚到底才看得见。
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } },
          // 新建框用普通受控输入：它的值只在本地，不需要走「失焦才入队」那套缓冲。
          h('input', {
            style: { ...S.input, flex: '0 0 200px' },
            placeholder: '新 pack 名',
            value: newName,
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') createPack()
              stopEscape(event)
            },
          }),
          h(Button, { variant: 'secondary', onClick: createPack }, '新建 pack'),
          h('span', { style: S.hint }, '新建也进待保存：点底部「保存」才写盘。'),
        ),
        packs.map((entry) => {
          const open = expanded === entry.id
          const dirty = isPending(entry.id)
          return h(
            'div',
            { key: entry.id },
            h(
              'div',
              {
                className: 'dsh-model-pack-row',
                'data-state': dirty ? 'pending' : undefined,
                style: { ...S.packRow, flexWrap: 'wrap', borderColor: open ? T.borderStrong : T.border },
                onClick: () => onToggle(entry.id),
              },
              h('span', { style: { opacity: 0.5, width: '12px' } }, open ? '▾' : '▸'),
              // 双击名字即改名；`default` 的名字由服务端固定，不给入口。
              renaming === entry.id && !entry.isDefault
                ? h('div', { style: { flex: '1 1 140px', minWidth: '100px' } },
                    h(ModelTextField, {
                      autoFocus: true,
                      value: entry.name,
                      style: S.input,
                      onClick: (event) => event.stopPropagation(),
                      onCommit: (name) => {
                        setRenaming(null)
                        const trimmed = name.trim()
                        if (trimmed === '' || trimmed === entry.name) return
                        if (packs.some((other) => other.id !== entry.id && other.name === trimmed)) {
                          notify('已经有同名的 pack：' + trimmed)
                          return
                        }
                        onRename(entry.id, trimmed)
                      },
                      onCancel: () => setRenaming(null),
                    }),
                  )
                : h(
                    'span',
                    {
                      style: S.groupName,
                      title: entry.isDefault ? '未绑定的工作区按它运行' : '双击改名',
                      onDoubleClick: entry.isDefault
                        ? undefined
                        : (event) => {
                            event.stopPropagation()
                            setRenaming(entry.id)
                          },
                    },
                    entry.name,
                  ),
              h('span', { style: S.badge }, String(configured(entry)) + ' 处配置'),
              dirty ? h(Tag, { title: '这张 pack 有未保存的改动' }, '待保存') : null,
              // 复制对 default 也开放：以默认为底改一套正是这个功能最典型的用法。
              // 还没保存的 pack 不给入口——磁盘上没有实体，复制出来的是试算视图里的幻影。
              realIds.has(entry.id)
                ? h(
                    Button,
                    {
                      title: '以这张 pack 为底复制一份（副本与原 pack 之后各改各的）',
                      onClick: (event) => {
                        event.stopPropagation()
                        onDuplicate(entry.id)
                      },
                    },
                    '复制',
                  )
                : null,
              // 双击也能改名，但按钮要留着：不给入口，用户不知道这张能改名。
              entry.isDefault
                ? null
                : h(
                    Button,
                    {
                      title: '重命名 pack',
                      onClick: (event) => {
                        event.stopPropagation()
                        setRenaming(entry.id)
                      },
                    },
                    '编辑',
                  ),
              entry.isDefault
                ? null
                : realIds.has(entry.id)
                  ? h(ConfirmButton, {
                      confirmLabel: '确认',
                      disabled: false,
                      title:
                        boundCwds(entry.id).length === 0
                          ? '删除 pack（当场写盘，不可撤销）'
                          : '删除 pack（还被 ' + String(boundCwds(entry.id).length) + ' 个工作区绑定，删除后它们回落到默认）',
                      onConfirm: () => onDelete(entry.id, entry.name),
                    })
                  : h(Button, { disabled: true, title: '这张 pack 还没保存，用「撤销」撤回新建' }, '删除'),
            ),
            open
              ? h(
                  'div',
                  { style: { ...S.section, marginLeft: '10px' } },
                  h(SinglePackEditor, {
                    packId: entry.id,
                    pack: entry.pack,
                    catalog: props.catalog,
                    support: props.support,
                    onChange: (next) => onChangePack(entry.id, next),
                  }),
                )
              : null,
          )
        }),
      )
    }

    // ---------- 分包页：工作区绑定 ----------

    /**
     * 工作区绑定：说明 → 列表（每行一个下拉）。
     *
     * 目录清单由宿主提供（开过会话的目录，外加绑定表里已有的键）：本插件不再维护
     * 「手动添加的路径」——那条能力与 `workspaces.json` 的 `extra` 字段一并删掉了，
     * 目录从哪来回宿主，本插件只决定「目录 → pack」。
     *
     * 绑定只影响该目录下的空白会话（还没开过轮次）：创建、恢复、改绑定三个时点都会
     * 重新施加；开了轮次的会话不会被这里改写。
     */
    function WorkspaceBoard(props) {
      const packs = props.packs
      const paths = props.paths
      const bindings = props.bindings
      const pending = props.pending
      const queue = props.queue
      const [limit, setLimit] = useState(WORKSPACES_PAGE)

      /** 绑到 default 与未绑定同义：下拉里只认普通 pack。 */
      const usableBinding = (id) => (typeof id === 'string' && id !== DEFAULT_PACK_ID ? id : null)
      const boundOf = (cwd) => {
        const key = normalizeCwd(cwd)
        if (key === null) return null
        const exact = bindings[key]
        if (typeof exact === 'string') return usableBinding(exact)
        const lower = key.toLowerCase()
        for (const candidate of Object.keys(bindings)) {
          if (candidate.toLowerCase() === lower) return usableBinding(bindings[candidate])
        }
        return null
      }

      // 只列普通 pack：第一项「默认」发 `packId: null` 删键，而绑到 `default`
      // 在服务端被归一成同一个动作（bind 的 packId === 'default' 也删键）。
      const options = [{ value: '', label: '默认' }].concat(
        packs.filter((pack) => !pack.isDefault).map((pack) => ({ value: pack.id, label: pack.name })),
      )

      return h(
        'div',
        { style: S.block },
        h('div', { style: S.blockTitleSticky }, '工作区绑定'),
        h('div', { style: { ...S.hint, marginBottom: '8px' } }, '绑定只影响该目录下还没发出请求的会话；开了轮次的会话不换 pack。未绑定即默认。改动进待保存，点「保存」才写盘。'),
        paths.length === 0
          ? h('div', { style: S.empty }, '还没有可绑定的工作区：打开过一次会话的目录会出现在这里。')
          : paths.slice(0, limit).map((cwd) => {
              const key = normalizeCwd(cwd)
              const dirty = key !== null && pending.keys.has(bindKeyOf(cwd))
              const bound = boundOf(cwd)
              // 悬空引用（pack 已删）显示成「默认」，与服务端读侧的行为一致。
              const value = bound !== null && packs.some((pack) => pack.id === bound) ? bound : ''
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
                  dirty ? h(Tag, { title: '这项改动还没保存' }, '待保存') : null,
                ),
                h(
                  'div',
                  { style: { flex: '0 0 auto', minWidth: '150px' } },
                  h(ModelPicker, {
                    value: value,
                    options: options,
                    onChange: (next) => queue([{ op: 'bind', cwd: cwd, packId: next === '' ? null : next }]),
                  }),
                ),
              )
            }),
        paths.length > limit
          ? h(
              Button,
              {
                variant: 'secondary',
                style: { marginTop: '8px' },
                onClick: () => setLimit(limit + WORKSPACES_PAGE),
              },
              '显示更多（还有 ' + String(paths.length - limit) + ' 个）',
            )
          : null,
      )
    }

    // ---------- 设置页 ----------

    /**
     * 设置 → Model Pack。
     *
     * 三页：分包管名册与 pack 内容（会话路由与四档），工作区管绑定，提示词管全局覆盖。
     * 「当前页」与「默认页」是两件事：切页只改当前页，打开设置时落在哪一页
     * 由顶部那个下拉决定——两者混成一个状态时，「临时看一眼分包」会顺手改掉默认页。
     *
     * 改动先入队（ADR 0006）：点控件只发本地命令，队列非空时每一步都用 `dryRun` 试算，
     * 面板按试算视图渲染；底部停靠区的「保存」是唯一的提交入口。
     */
    function SettingsPanel(props) {
      const host = props.host
      const catalog = useCatalog(host.catalog)
      const view = useSchemeView(host)
      const { state, run, accept } = view
      const [tab, setTab] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      /** 展开编辑的是哪一张 pack。纯界面状态：内容本身在待保存队列里。 */
      const [expanded, setExpanded] = useState(null)
      /**
       * 刚新建或刚复制、等着展开的那张 pack。
       *
       * 记的是「改动前那份视图的 id 集合」：试算视图里多出来的 id 就是它。按 id 差集
       * 而不是按名字反查——名字由服务端生成（副本还要按序号避让），客户端算一遍必然
       * 与服务端漂移，表现就是「复制了但没展开」。
       */
      const wanted = useRef(null)

      const preview = useCallback((commands) => api.apply(null, commands, true), [])
      const apply = useCallback((commands) => api.apply(null, commands), [])
      const pending = usePending({ preview: preview, apply: apply, onApplied: accept })

      const base = state.data
      // 有待保存改动时，面板按「试算视图」渲染；否则就是真实视图。
      const data = pending.preview.data !== null ? pending.preview.data : base
      const frozen = pending.count > 0
      const frozenOrder = useMemo(
        // 排序键取「改动前那份视图正常显示时的 id 序」，不是 `Object.keys(packs)` 的
        // 数组位置：正常显示是按 id 排序的，用原始位置会在一进入待保存状态时重排一次。
        () => (frozen && base !== null ? packListOf(base).map((entry) => entry.id) : null),
        [frozen, base],
      )
      const packs = useMemo(() => packListOf(data, frozenOrder), [data, frozenOrder])
      const bindings = useMemo(() => bindingsOf(data), [data])
      const support = (data && data.support) || {}

      /**
       * 绑定列表：会话来的目录与绑定表里多出来的目录合并，按归一化键去重，
       * 再按路径排序——一页只该有一个顺序。
       *
       * 绑定表里可能有会话已经删掉的目录：不列出来的话，这些绑定既看不见也解不开。
       */
      const paths = useMemo(() => {
        const list = []
        const seen = {}
        const add = (cwd) => {
          const key = normalizeCwd(cwd)
          if (key === null || seen[key] === true) return
          seen[key] = true
          list.push(cwd)
        }
        for (const cwd of state.cwds) add(cwd)
        for (const cwd of Object.keys(bindings.bindings)) add(cwd)
        return list.sort((a, b) => compareCwd(normalizeCwd(a), normalizeCwd(b)))
      }, [state.cwds, bindings.bindings])

      /**
       * 新建或复制后展开新出现的那一张。
       *
       * id 由服务端生成（`p1`、`p2`…），客户端拼不出来，所以按差集找：试算视图里有、
       * 改动前那份视图里没有的 id 就是它。找不到就保持原样，不猜一个 id 出来。
       */
      useEffect(() => {
        const before = wanted.current
        if (before === null) return
        const found = Object.keys(packsOf(data)).find((id) => before.has(id) === false)
        if (found === undefined) return
        wanted.current = null
        setExpanded(found)
      }, [data, base])

      if (state.phase === 'loading' && base === null) {
        return h('div', { style: S.root }, h('div', { style: S.hint }, '加载中…'))
      }
      if (!base) {
        return h(
          'div',
          { style: S.root },
          h('div', { style: S.title }, TITLE),
          h('div', { style: S.error }, state.error || '读取失败'),
        )
      }

      const defaultTab = defaultTabOf(data)
      // 当前页只由分页按钮切；初值取 `ui.defaultTab`，之后不再跟随任何外部请求。
      const current = tab !== null ? tab : defaultTab
      const warnings = data.state && Array.isArray(data.state.warnings) ? data.state.warnings : []

      // ---------- 改动 ----------

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

      /** 当场说一句：用于重名、空白这类「点了但没生效」的情况。 */
      const notify = (text) => setNotice(text)

      /** 这张 pack 有没有未保存改动：改名、会话路由、任一档。 */
      const packPending = (packId) => {
        for (const key of pending.keys) {
          if (key === 'pack:' + packId || key === 'renamePack:' + packId || key === 'packSession:' + packId) return true
          if (key.startsWith('packTier:' + packId + ':')) return true
        }
        return false
      }

      /**
       * pack 内容的改动 → 细粒度命令。
       *
       * 值取自试算视图里的那张 pack，`packCommands` 只把前后差异变成命令，所以每次
       * 改动只发真正变了的那几处（改名 / 会话路由 / 某一档），不会整张覆写。
       */
      const changePack = (packId, next) => {
        const problems = validatePack(next)
        if (problems.length > 0) {
          notify('本地校验未通过：' + problems.join('；'))
          return
        }
        const before = packsOf(data)[packId]
        const name = String(next.name || '').trim()
        if (packId !== DEFAULT_PACK_ID && name !== String((before && before.name) || '')) {
          if (packs.some((entry) => entry.id !== packId && entry.name === name)) {
            notify('已经有同名的 pack：' + name)
            return
          }
        }
        const commands = packCommands(packId, before, next)
        if (commands.length === 0) return
        enqueue(commands)
      }

      /** 新建：进队列，等试算视图出现新 id 后再展开它。 */
      const createPack = (name) => {
        const trimmed = name.trim()
        if (trimmed === '') return
        wanted.current = new Set(Object.keys(packsOf(data)))
        enqueue([{ op: 'createPack', name: trimmed }])
      }

      /**
       * 复制：进队列，与新建同类。
       *
       * 名字由服务端按「原名 + 序号」生成，客户端不传也不猜——命名规则只有一份。
       * 副本不带任何工作区绑定：绑定是目录到 pack 的一对一映射，副本没有目录。
       */
      const duplicatePack = (packId) => {
        wanted.current = new Set(Object.keys(packsOf(data)))
        enqueue([{ op: 'duplicatePack', packId: packId }])
      }

      /**
       * 删除：当场写盘。
       *
       * 队列里引用这张 pack 的命令（改名、会话路由、任一档、绑定）先剔掉再写，
       * 丢掉几条要说出来——无声丢改动比丢改动本身更糟。
       */
      const deletePack = (packId, name) => {
        // 先写盘，成功后再丢队列。反过来做的话，写盘失败时未保存改动已经清空、
        // 提示还说「已删除」，而 pack 其实还在——这是唯一会丢用户改动的一条路径。
        void run([{ op: 'deletePack', packId: packId }]).then((ok) => {
          if (ok === null) return
          // `duplicatePack` 的 packId 是**源**，不是目标：副本一旦生成就与原 pack 无关，
          // 删掉源不该顺手取消「复制它」这条命令。
          const removed = pending.drop((command) => command.op !== 'duplicatePack' && command.packId === packId)
          if (expanded === packId) setExpanded(null)
          setNotice(removed > 0 ? '已删除「' + name + '」，并丢弃对它的 ' + removed + ' 项未保存改动' : null)
          // 写盘换了 base，手里那份试算必然过时：先丢掉，名册立刻回落到新的真实视图，
          // 再按新 base 重算。否则这张 pack 会多留一次往返的时间。
          pending.resetPreview()
          pending.refresh()
        })
      }

      const commit = () => {
        if (busy) return
        setBusy(true)
        pending.commit().then(
          () => setBusy(false),
          () => setBusy(false),
        )
      }

      // ---------- 渲染 ----------

      return h(
        'div',
        { style: S.root },
        // 设置页与 chip 弹层是两个挂载点，样式表各注入一次（ui-baseline 第 13 条）。
        h('style', { key: 'panel-css' }, PANEL_CSS),

        h(
          'div',
          { style: S.hero },
          h('div', { style: S.title }, TITLE),
        ),
        h(
          'div',
          { style: S.hint },
          '一张 pack = 一条会话路由 + 至多四档子智能体路由。工作区绑到哪张 pack，就按哪套生效；未绑定按默认。只作用于该目录里还没发出请求的会话，开了轮次的会话不再改动，也不替代官方「设置 → 模型」。改动先攒着，点底部「保存」才写盘。',
        ),
        data.lastError ? h('div', { style: S.probeFail }, '上一次施加失败：' + data.lastError) : null,
        warnings.length > 0
          ? h('div', { style: S.probeWarn }, '配置有告警：' + warnings.slice(0, 4).join('；') + (warnings.length > 4 ? ' …' : ''))
          : null,

        // 「当前页」只由分页按钮切；「默认页」只由这个下拉写。两者混成一个状态时，
        // 临时看一眼分包会顺手改掉用户的默认页。默认页是当场生效的偏好，不进队列。
        h(
          'div',
          { style: { ...S.bar, marginBottom: '0' } },
          h('span', { style: S.hint }, '打开设置时默认显示'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '120px' } },
            h(ModelPicker, {
              value: defaultTab,
              options: TABS.map((entry) => ({ value: entry.value, label: entry.label })),
              onChange: (next) => run([{ op: 'defaultTab', value: next }]),
            }),
          ),
        ),
        h('div', { style: { margin: '10px 0' } }, h(Segmented, { value: current, onChange: setTab, options: TABS })),
        state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,

        // ---------- 分包页：名册 + 就地编辑 ----------
        current === 'packs'
          ? h(PackRoster, {
              packs: packs,
              // 只把磁盘上真实存在的 id 传下去：新建还没保存的那些不给删除按钮。
              realIds: new Set(base !== null ? Object.keys(packsOf(base)) : []),
              bindings: bindings.bindings,
              expanded: expanded,
              isPending: packPending,
              onCreate: createPack,
              onDuplicate: duplicatePack,
              onRename: (packId, name) => enqueue([{ op: 'renamePack', packId: packId, name: name }]),
              notify: notify,
              onToggle: (packId) => setExpanded(expanded === packId ? null : packId),
              onChangePack: changePack,
              onDelete: deletePack,
              catalog: catalog,
              support: support,
            })
          : null,

        // ---------- 工作区页：绑定 ----------
        current === 'workspace'
          ? h(WorkspaceBoard, {
              packs: packs,
              paths: paths,
              bindings: bindings.bindings,
              pending: pending,
              queue: enqueue,
            })
          : null,

        // ---------- 提示词页 ----------
        current === 'prompts'
          ? h(PromptSection, {
              prompts: data.prompts,
              disabled: busy,
              queue: enqueue,
              notify: notify,
            })
          : null,

        catalog.phase === 'error' || catalog.phase === 'unavailable' ? h('div', { style: S.probeWarn }, catalog.error) : null,
        catalog.phase === 'loading' ? h('div', { style: S.hint }, '正在读取模型目录…') : null,

        /*
         * 底部停靠区：提示在上、待保存条在下，两行一起贴住底边。
         *
         * 提示原先放在标题下面，滚到分包页中段就看不见了——而它讲的正是「删除把你
         * 没保存的改动带走了」这种当场必须知道的事。停靠区两行都常驻。
         */
        notice !== null || pending.count > 0
          ? h(
              'div',
              { style: S.dock },
              notice !== null ? h(NoticeBar, { text: notice, onClose: () => setNotice(null) }) : null,
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



    // ---------- 模型位 pack 名 ----------

    /**
     * 会话 id → cwd、cwd → pack 名。**只在 apply 里写**，slot 组件只读。
     *
     * 为什么不在组件里取数：`conversation.input.model.label` 的渲染一旦抛错，
     * 官方触发按钮会退回默认文字（见 ui-model-selection README「模型名称扩展」）。
     * 所以组件里不请求、不挂交互，取数全部提前到 apply：先 session.list 得到
     * sessionId→cwd，再按 cwd 各 read 一次。
     *
     * 唯一的订阅是缓存版本号（`labelVersion`）：写完缓存要有人通知 composer 重渲染，
     * 否则改完绑定只能整页刷新才看得到新名字。订阅的是本模块自己的 signal，不碰宿主。
     *
     * sessionId 从哪来：这个 slot 是 `scope: 'session'` 的单一内联 slot，
     * 会话绑定把 `sessionId` 作为普通 prop 交给组件（不是 hook，不订阅）。
     */
    const labelCache = {
      session: new Map(), // sessionId -> cwd
      name: new Map(), // cwd -> pack 显示名
      running: null, // 单飞：并发重读只跑一次
      queued: false, // 单飞期间又来了一次整轮重读的请求
    }
    /**
     * 缓存版本号。
     *
     * slot 是纯渲染：缓存更新后没有任何东西会通知 composer 重渲染，用户看到的
     * 就一直是旧名字，直到整页刷新。改绑定、改 pack 名都发生在同一页里，
     * 所以缓存必须自己发信号。
     */
    const labelVersion = createSignal(0)
    function bumpLabel() {
      labelVersion.set(labelVersion.read() + 1)
    }
    /** 两次缓存内容是否相同：只在真变了才发信号，避免每轮轮询都白重渲染一次。 */
    function sameNames(before, after) {
      if (before.size !== after.size) return false
      for (const [cwd, name] of after) {
        if (before.get(cwd) !== name) return false
      }
      return true
    }
    /**
     * 重读间隔。
     *
     * 每轮整轮重读：绑定可能在另一个窗口里改，也可能由别的东西写盘，60 秒内自愈
     * 比要求用户刷新页面强。量级是 session.list 加最多 8 次本地 read，不值得为省它
     * 做增量判断——增量判断漏掉的那一类（已缓存但已过期的 cwd）正是这个 bug。
     */
    const LABEL_REFRESH_MS = 60000
    /** 标签与官方目录名同处一行时的排版；只影响宽度分配，不改变触发器的交互。 */
    const LABEL_STYLE = {
      /*
       * 用 inline-block + 纯文本流，不用 flex。
       *
       * 之前用 inline-flex 放两个子 span，无论怎么钉 `gap: 0` 与 `justify-content`，
       * 宿主的样式总会从某一层渗进来把「默认」和模型名撑开——flex 子项之间可被外部
       * gap / space-between 影响，文本节点不会。这里把分隔符与模型名合成一个文本节点，
       * 间距就只由字符串本身决定。
       */
      root: {
        display: 'inline-block',
        maxWidth: '100%',
        minWidth: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        verticalAlign: 'bottom',
      },
      pack: { color: T.faint },
      model: { display: 'inline-block', maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
    }

    /** read 的信封数据 → 当前生效的 pack 显示名。取不到返回空串（组件据此退回纯模型名）。 */
    function labelPackNameOf(data) {
      const resolved = data && data.resolved
      if (!resolved) return ''
      if (resolved.id === DEFAULT_PACK_ID) return DEFAULT_PACK_NAME
      const pack = resolved.pack
      return pack && typeof pack.name === 'string' ? pack.name.trim() : ''
    }

    /** 同步取 pack 名。组件只调这一个函数；任何一步缺失都返回空串，绝不抛。 */
    function labelNameOf(sessionId) {
      try {
        if (typeof sessionId !== 'string' || sessionId === '') return ''
        const cwd = labelCache.session.get(sessionId)
        if (typeof cwd !== 'string' || cwd === '') return ''
        const name = labelCache.name.get(cwd)
        return typeof name === 'string' ? name : ''
      } catch {
        return ''
      }
    }

    /**
     * 重读 pack 名缓存：整轮重建。
     *
     * 任何异常都吞掉：缓存保留旧值，组件继续按旧值渲染或退回纯模型名——
     * 这条路径失败不允许影响 composer 的任何行为。
     */
    function labelRefresh(host) {
      if (labelCache.running) {
        // 跑着的时候又来一次：记住，等它结束后再跑一遍，不丢这次请求。
        labelCache.queued = true
        return labelCache.running
      }
      const run = (async () => {
        try {
          const session = host.remote && host.remote.session
          if (!session || typeof session.list !== 'function') return
          let listing
          try {
            listing = await session.list({})
          } catch {
            return
          }
          if (!listing || listing.ok !== true) return
          const items = listing.value && Array.isArray(listing.value.items) ? listing.value.items : []
          const nextSession = new Map()
          const cwds = []
          for (const item of items) {
            if (!item || item.origin === 'subagent') continue
            if (typeof item.sessionId !== 'string' || item.sessionId === '') continue
            if (typeof item.cwd !== 'string' || item.cwd === '') continue
            nextSession.set(item.sessionId, item.cwd)
            if (cwds.indexOf(item.cwd) < 0 && cwds.length < LABEL_CWD_LIMIT) cwds.push(item.cwd)
          }
          const names = new Map()
          await Promise.all(
            cwds.map(async (cwd) => {
              try {
                const name = labelPackNameOf(await api.read(cwd))
                if (name === '') names.delete(cwd)
                else names.set(cwd, name)
              } catch {
                // 这个工作区读不到就不缓存：该目录下的会话退回纯模型名。
              }
            }),
          )
          const changed = !sameNames(labelCache.name, names)
          labelCache.session = nextSession
          labelCache.name = names
          if (changed) bumpLabel()
        } catch {
          // 整轮失败保留旧缓存，不把标签打空。
        }
      })()
      labelCache.running = run
      run.then(() => {
        if (labelCache.running === run) labelCache.running = null
        if (labelCache.queued) {
          labelCache.queued = false
          void labelRefresh(host)
        }
      })
      return run
    }

    /**
     * composer 模型位里的「pack 名 · 模型名」。
     *
     * slot 只有一个 key，placement 由 owner 传进来：只有 `'trigger'` 加 pack 名前缀，
     * `'menu'` 与 `'option'` 原样只有模型名——当前值与选项行不归这里管，
     * 也不注册第二个 key。
     *
     * 不渲染 button，不挂 onClick / tabIndex / aria-*：点击、搜索、焦点、禁用状态、
     * 勾选标记、推理强度与触发按钮的无障碍文字全部由官方选择器负责。
     * pack 名拿不到（未读、读失败、会话不属于任何工作区）时退回纯模型名，不留占位符。
     */
    function labelView(props) {
      // 订阅缓存版本：这一处是纯渲染 slot，宿主不会因为我们的缓存变了而重渲染，
      // 不订阅就只能靠整页刷新。订阅函数是本模块自己的 signal，不碰宿主。
      //
      // **不能包 try**：hook 数量必须每次渲染一致。包了之后，某次非渲染期调用
      // （hook 数 0）会让下一次渲染期调用（hook 数 1）触发 React 的
      // 「Rendered more hooks than during the previous render」，把「标签不更新」
      // 升级成「模型选择器崩溃」。宿主稳定在渲染期调用，这里不需要兜底。
      useSyncExternalStore(labelVersion.subscribe, labelVersion.read, labelVersion.read)
      let modelName = ''
      let packName = ''
      try {
        const model = props ? props.model : null
        modelName = model && typeof model.name === 'string' ? model.name : ''
        packName = props && props.placement === 'trigger' ? labelNameOf(props.sessionId) : ''
      } catch {
        packName = ''
      }
      if (modelName === '') return null
      if (packName === '') return h('span', { style: LABEL_STYLE.model }, modelName)
      return h(
        'span',
        { style: LABEL_STYLE.root },
        h('span', { style: LABEL_STYLE.pack }, packName),
        // 分隔符与模型名在同一个文本节点里：前后各一个空格，不依赖任何布局属性。
        ' | ' + modelName,
      )
    }

    // ---------- 会话里的 chip ----------

    /**
     * chip 的图标：12px、viewBox 16、描边 currentColor、fill none——与另外三个包的
     * chip 图标同一套规格，四个并排时线条粗细与视觉重量才一致。
     *
     * 画的是「三条滑轨 + 各一个滑块」：pack 本质上是给不同档位分配路由。
     */
    function ModelIcon(props) {
      const size = props && props.size ? props.size : 12
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M2.5 4h11M2.5 8h11M2.5 12h11',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          fill: 'none',
        }),
        h('circle', { cx: 6, cy: 4, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 10.5, cy: 8, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 7.5, cy: 12, r: 1.5, fill: 'currentColor' }),
      )
    }


    const chipOpen = createSignal(false)

    /** chip 上的名字：绑到哪张 pack 就显示哪个，未绑定是 null（由 `CHIP_LABEL` 补字）。 */
    /** chip 的请求序号：两段串行（列工作区 → 读策略）窗口最大，旧响应必须丢弃。 */
    let chipSeq = 0

    function refreshChipName(host, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        chipName.set(null)
        return
      }
      const id = ++chipSeq
      listWorkspaces(host, sessionId).then(
        (listing) => {
          if (id !== chipSeq) return
          const cwd = listing.currentCwd
          if (cwd === null) {
            chipName.set(null)
            return
          }
          api.read(cwd).then(
            (data) => {
              if (id !== chipSeq) return
              // 悬空绑定（pack 已删）按「默认」显示：服务端求值链已经回落，
              // chip 上写「xxx（已删除）」只会让人以为还在用它。
              const bound = bindingOf(data)
              const known = bound !== null && isRecord(packsOf(data)[bound])
              chipName.set(known ? packNameOf(data, bound) : null)
            },
            () => {
              if (id !== chipSeq) return
              // 读不到就退回默认：chip 本身不能因此消失。
              chipName.set(null)
            },
          )
        },
        () => {
          if (id !== chipSeq) return
          chipName.set(null)
        },
      )
    }
    /**
     * chip 的弹层：这张 pack 与默认差在哪，就地切换。
     *
     * 点一行只把「换成它」放进待保存队列：面板按试算视图显示换过去之后长什么样，
     * 点「保存」才真绑。选「默认」发 `packId: null`（解除绑定），不是写一个 default
     * 的 id——未绑定与悬空引用在服务端是同一种状态。
     */
    function ChipModal(props) {
      const open = props.open === true
      const sessionId = props.sessionId
      const host = props.host
      const [state, setState] = useState({ loading: false, error: null, cwd: null, data: null })
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
        setState((prev) => ({ loading: prev.data === null, error: null, cwd: prev.cwd, data: prev.data }))
        ;(async () => {
          const listing = await listWorkspaces(host, sessionId)
          const cwd = listing.currentCwd
          const data = cwd === null ? null : await api.read(cwd)
          return { cwd: cwd, data: data }
        })().then(
          (result) => {
            if (alive) setState({ loading: false, error: null, cwd: result.cwd, data: result.data })
          },
          (error) => {
            if (alive) {
              setState({ loading: false, error: String(error && error.message ? error.message : error), cwd: null, data: null })
            }
          },
        )
        return () => {
          alive = false
        }
      }, [open, sessionId, host])

      const cwd = state.cwd
      const preview = useCallback((commands) => api.apply(cwd, commands, true), [cwd])
      const apply = useCallback((commands) => api.apply(cwd, commands), [cwd])
      const accept = useCallback(
        (view) => {
          setState((prev) => ({ ...prev, data: view, error: null }))
          const id = bindingOf(view)
          const known = id !== null && isRecord(packsOf(view)[id])
          chipName.set(known ? packNameOf(view, id) : null)
          // 绑定改了，模型位那一行的 pack 名要跟着换：它读的是 apply 之前的缓存。
          void labelRefresh(host)
        },
        [host],
      )
      const pending = usePending({ preview: preview, apply: apply, onApplied: accept })

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
      // 有待保存改动时按试算视图渲染：点一行就先看到「换过去之后长什么样」。
      const data = pending.preview.data !== null ? pending.preview.data : base
      const packs = data === null ? [] : packListOf(data)
      /** 试算后的绑定：点一行就会变成它，但还没保存。 */
      const boundId = bindingOf(data)
      const bound = boundId === null ? DEFAULT_PACK_ID : boundId
      /*
       * 真实绑定另算一份。
       *
       * 「当前」必须标在真正生效的那一张上：如果跟着试算视图走，点一下就会把新选的那张
       * 标成「当前」，而 chip 上的名字还没变——两处说法打架。
       */
      const committedId = bindingOf(base)
      const committed = committedId === null ? DEFAULT_PACK_ID : committedId
      const usingDefault = boundId === null
      const rows = data !== null && !usingDefault ? diffOf(data, boundId) : []

      const bindTo = (packId) => {
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
            h('div', { style: S.title }, data === null ? '读取中' : usingDefault ? '默认' : packNameOf(data, boundId)),
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
                        : rows.map((row) => h('div', { key: row.key, style: S.delta }, row.text)),
                    ),
                h(
                  'div',
                  { style: { ...S.hint, marginTop: '14px', marginBottom: '6px' } },
                  '换一张 pack：点一行就预览它对这个目录的影响，保存后才生效',
                ),
                // 平铺全部 pack 而不是「当前值 + 下拉」：下拉要先展开才看得全，
                // 而这里的选择本来就是「挨个看看别人是什么样」。
                packs.map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.id,
                      className: 'dsh-model-pack-row',
                      'data-state': entry.id === committed ? 'current' : entry.id === bound ? 'pending' : undefined,
                      style: {
                        ...S.packRow,
                        borderColor: entry.id === bound || entry.id === committed ? T.borderStrong : T.border,
                      },
                      onClick: () => bindTo(entry.id),
                    },
                    h('span', { style: S.groupName }, entry.name),
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


    /**
     * 面板与弹层的错误边界。
     *
     * React 在渲染期抛错会卸载整棵子树，用户看到的就是「点进去一片空白」——没有
     * 任何线索，只能去翻 DevTools。这里把异常转成一行可读文本，把「现象」变成
     * 「原因」。这类空白已经出现过一次（删变量时漏改引用）。
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
                  'Model Pack 面板渲染失败：' + message,
                  h('div', { style: { ...S.hint, marginTop: '6px' } }, '这是插件自身的错误，不影响会话与其他插件。'),
                )
              }
              return this.props.children
            }
          }

    // ---------- 注册 ----------

    return {
      // 测试出口：只供 test/ 断言结构与纯逻辑用，运行期不要读它。
      __internals: { pendingKey, createQueue, frozenRank, packListOf, usePending, listWorkspaces, TABS, PackRoster, WorkspaceBoard, SettingsPanel, ChipModal, CHIP_CSS },
      // 依赖声明照抄官方 settings-subagent：remote.session 是独立服务名，
      // 只声明 remote 拿不到它（ctx.remote.session 会是空的，模型目录读不到）。
      // 声明里少一个 → 插件停在 pending → 整个设置分区连入口都不出现。
      // `locale` 只用来判断 chip 的缺省文案该写「默认」还是 Default。
      inject: ['slots', 'remote', 'remote.session'],
      apply(ctx) {
        // 兜底：client 模块的 apply 抛错会把 web boot 判成 entry failed，桌面端整个起不来。
        // 任何意外都只降级成「面板不出来」，绝不连坐宿主。
        try {
          applyPanel(ctx)
        } catch (error) {
          try {
            console.error('[model-pack] 面板挂载失败：', error)
          } catch {
            // console 也不可用时无计可施。
          }
        }
      },
    }

    /** 面板的实际挂载，由 apply 包一层兜底后调用。 */
    function applyPanel(ctx) {
      const host = createHost(ctx)

      /** 目录只在 apply 里加载一次，并在宿主事件上重读：换适配器后下拉必须跟着变。 */
      ctx.effect(() => {
        host.catalog.load()
      }, 'model-pack: 首次读取模型目录')

      if (typeof ctx.on === 'function') {
        ctx.effect(() => ctx.on('llm/adapters-updated', () => host.catalog.load()), 'model-pack: 适配器变化')
        ctx.effect(() => ctx.on('connection/reset', () => host.catalog.load()), 'model-pack: 连接重置')
      }

      // 组件类型必须是稳定的标识符：写成内联箭头函数的话，每次渲染都是新类型，
      // React 会整棵卸载重挂——输入框每敲一个字就失焦。apply 只跑一次，所以在这里
      // 定义成常量既稳定又拿得到闭包里的 host。
      const SettingsSection = () => h(PanelBoundary, null, h(SettingsPanel, { host: host }))
      const ChipOverlay = () => {
        const open = useSyncExternalStore(chipOpen.subscribe, chipOpen.read, chipOpen.read)
        return h(
          PanelBoundary,
          null,
          h(ChipModal, { host: host, open: open, sessionId: env.sessionId, onClose: () => chipOpen.set(false) }),
        )
      }
      const ModelChip = (props) => {
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined
        const name = useSyncExternalStore(chipName.subscribe, chipName.read, chipName.read)
        const open = useSyncExternalStore(chipOpen.subscribe, chipOpen.read, chipOpen.read)
        useEffect(() => {
          // 写 env 必须放在 effect 里：渲染期赋值时，并发渲染下被丢弃的那次
          // 可能后执行，env.sessionId 会停在旧会话，弹层读到错误目录。
          env.sessionId = sessionId
          refreshChipName(host, sessionId)
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
              className: 'dsh-model-pack-chip',
              'data-bound': bound ? 'true' : 'false',
              style: S.chip,
              title: bound ? 'model pack：' + label : 'model pack：未绑定（使用默认）',
              onClick: () => chipOpen.set(!open),
            },
            h(ModelIcon, { size: 14 }),
            h('span', { key: 'chip-text', className: 'dsh-model-pack-chip-text', style: S.chipText }, label),
          ),
        )
      }

      // 入口与另外三个包一致：只挂设置页的 settings.section，不注册 plugins.item 卡片。
      // order 63 排在三者之后，四个领域的分区按 skill → plugin → mcp → model 固定。
      // 每处注册各自包 try：一处失败只丢这一个槽位。不包的话异常会让 applyPanel
      // 中途退出，后面的 label、chip、overlay、定时器全部静默丢失——插件在界面上
      // 完全消失，控制台只有一行笼统错误。
      ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register(
            { name: 'settings.section', id: PANEL_ID, order: 63, label: () => TITLE },
            SettingsSection,
          )
        } catch {
          return () => {}
        }
      })

      /**
       * 只注册 `conversation.input.model.label` 这一处，且只处理 placement 'trigger'。
       * `slots.inject` 会等父 slot `conversation.input.model` 的声明出现后再注册；
       * 注册冲突（别的插件也占了这个 single slot）时静默让位——官方行为原样保留。
       */
      ctx.slots.inject('conversation.input.model.label', () => {
        try {
          return ctx.slots.register({ name: 'conversation.input.model.label', id: 'model-pack-label' }, labelView)
        } catch {
          return () => {}
        }
      })

      // 会话输入框右侧的入口与它的浮层。组件引用必须稳定（apply 只跑一次）。
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register({ name: 'conversation.input.right', id: CHIP_ID, order: 43 }, ModelChip),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: MODAL_ID, order: 63 }, ChipOverlay),
      )

      // 缓存先读一次；连接重置与每 60 秒各整轮重读一次——绑定可能在别处被改。
      ctx.effect(() => {
        labelRefresh(host)
      }, 'model-pack: 读取模型位 pack 名')

      if (typeof ctx.on === 'function') {
        ctx.effect(() => ctx.on('connection/reset', () => labelRefresh(host)), 'model-pack: 模型位 pack 名重读')
      }

      ctx.effect(() => {
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => {
          // 后台标签页不重读：用户看不见触发按钮，读到的也只是缓存。
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          labelRefresh(host)
        }, LABEL_REFRESH_MS)
        return () => clearInterval(timer)
      }, 'model-pack: 模型位 pack 名定时重读')
    }