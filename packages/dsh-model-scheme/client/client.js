/**
 * 浏览器半边：插件页里的「模型方案」条目（ticket 07）。
 *
 * 面板做四件事：列方案、编辑方案、把方案绑到当前工作区、覆盖提示词段（spec §6.3.1）。
 * 数据来自本插件的三条路由（read / apply / support）；模型目录来自宿主的
 * remote.session.modelCatalog()，那是唯一能回答「这个模型公布了哪些思考强度」的地方
 * ——不猜、不硬编码。
 *
 * 不引 JSX、不引打包器：宿主用 require('react') 提供 React。工厂必须惰性，
 * 所有订阅与请求都在 apply 里用 ctx.effect 注册并返回清理函数。
 *
 * 一条约定贯穿全文件：**「跟随」是键不存在，不是空值**。
 *   会话路由的 reasoningEffort、方案的 session、档位本身、工作区绑定，
 * 四处的「跟随」都表现为删键。因此每处都有一个独立的「跟随」按钮，
 * 而不是下拉里的一个空选项——空选项会让人以为「选了空 = 跟随」，
 * 实际写下去的是空串，落盘后是坏输入。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-model-scheme',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    // ---------- 常量 ----------

    const TITLE = '模型方案'
    const PANEL_ID = 'model-scheme'
    /** 出厂方案 id：不落盘、不可覆盖、不可删除（见 src/scheme.ts）。 */
    const BUILTIN_ID = 'builtin'
    const BUILTIN_NAME = '出厂方案'
    /** 档 id 固定四个，顺序即难度顺序；显示名可改，缺省用这里。 */
    const TIER_IDS = ['tier1', 'tier2', 'tier3', 'tier4']
    // 与 src/scheme.ts 的 TIER_DEFAULT_NAMES 逐字一致：出厂档名只有一套。
    const TIER_NAMES = {
      tier1: '侦察',
      tier2: '速办',
      tier3: '攻坚',
      tier4: '深算',
    }
    /** 提示词覆盖的键：编排段一个，档四个（与 src/scheme.ts 的 PROMPT_KEYS 一致）。 */
    const PROMPT_DELEGATION_KEY = 'delegation'
    const PROMPT_TIER_FIELDS = ['label', 'text']
    /** 一次最多统计几个已知工作区：每个工作区要一次 read，不做无界扇出。 */
    const MAX_WORKSPACES = 8
    /**
     * 空草稿。冻结：它会被 useState 直接持有，任何就地写入都会变成跨实例的脏数据。
     *
     * `prompts` 是提示词覆盖的稀疏 patch：undefined = 没改过；键不存在 = 该字段没改；
     * 键存在且是字符串 = 待提交的新值。空串不进 patch（空 = 跟随内置，见 spec §6.3.1）。
     */
    const EMPTY_DRAFT = Object.freeze({
      editing: null,
      deleted: Object.freeze([]),
      // undefined = 这条键没改过；null = 显式删键（跟随出厂方案 / 跟随全局默认）。
      defaultId: undefined,
      binding: undefined,
      prompts: undefined,
    })

    // ---------- 传输 ----------

    const PATHS = {
      read: '/api/model-scheme/read',
      apply: '/api/model-scheme/apply',
      support: '/api/model-scheme/support',
    }

    /**
     * 三条路由共用一套信封：{ ok: true, data } 或 { ok: false, error }。
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
      if (payload && payload.ok === true) return payload.data
      const message = payload && payload.error && payload.error.message ? payload.error.message : '请求失败'
      throw new Error(message)
    }

    const api = {
      read: (cwd) => post(PATHS.read, cwd ? { cwd: cwd } : {}),
      apply: (cwd, commands) => post(PATHS.apply, cwd ? { cwd: cwd, commands: commands } : { commands: commands }),
    }

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token（--dsw-*，不是 --dsh-*），见 docs/ui-baseline.md。
     * 卡片底用 bg-layer-1 而不是 bg-overlay：后者在暗色主题下是中灰浮层，当卡片底会发亮。
     * 开态/主按钮的反色规则同理：不按变量名猜语义，品牌色只用于主按钮的实心块。
     */
    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      accent: '#2f6fed',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
      onAccent: '#ffffff',
    }

    const S = {
      // 设置页的 section 自带滚动容器，面板不自己滚高度。
      embedded: { fontSize: '13px', color: T.text },
      hide: { display: 'none' },
      // 会话里的 chip 与浮层：照抄 dsh-plugin-manager 的 chip / modal 尺寸与配色，
      // 三个 manager 那一排并排出现时不能有两种观感。
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
      // 下划线式分页，与官方「插件列表 / 插件市场」同一套观感：无底色，靠字重与
      // 底部 2px 描边表达选中，未选中用次要色。
      tabs: { display: 'flex', gap: '18px', borderBottom: '1px solid ' + T.border, margin: '10px 0 12px' },
      tab: (active) => ({
        background: 'transparent',
        border: 'none',
        borderBottom: '2px solid ' + (active ? T.text : 'transparent'),
        color: active ? T.text : T.dim,
        fontSize: '13px',
        fontWeight: active ? 600 : 400,
        padding: '6px 2px',
        marginBottom: '-1px',
        cursor: 'pointer',
      }),
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
      mono: { color: T.faint, fontSize: '11px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
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
      // 多行提示词框：边框、圆角、底色都跟 S.input 走，只加高度与换行行为。
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '88px',
        padding: '6px 8px',
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        background: 'transparent',
        color: T.text,
        fontSize: '12px',
        lineHeight: 1.6,
        fontFamily: 'inherit',
        resize: 'vertical',
      },
      // 原生弹层由浏览器绘制，不跟随页面配色；不声明 color-scheme 时选项是浅字浅底。
      option: { color: 'CanvasText', background: 'Canvas' },
      select: {
        fontSize: '12px',
        padding: '3px 4px',
        borderRadius: '4px',
        border: '1px solid ' + T.border,
        background: 'transparent',
        color: T.text,
        colorScheme: 'light dark',
        maxWidth: '260px',
      },
      section: { borderRadius: '8px', border: '1px solid ' + T.border, marginBottom: '8px' },
      groupHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderBottom: '1px solid ' + T.border },
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
      row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderTop: '1px solid ' + T.border },
      rowFirst: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px' },
      rowMain: { flex: '1 1 auto', minWidth: 0 },
      rowName: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', color: T.text, fontWeight: 600 },
      rowMeta: { color: T.dim, fontSize: '11px', marginTop: '3px', lineHeight: 1.5 },
      field: { padding: '6px 0 10px', borderTop: '1px solid ' + T.border },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', marginTop: '8px' },
      fieldRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '4px 10px' },
      fieldLabel: { color: T.dim, fontSize: '11px', minWidth: '64px' },
      fallbackRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '4px 10px 4px 22px' },
      disabledSection: { opacity: 0.5, pointerEvents: 'none', userSelect: 'none' },
      button: (primary, danger) => ({
        border: primary ? 0 : '1px solid ' + (danger ? T.error : T.border),
        borderRadius: '6px',
        padding: '4px 9px',
        fontSize: '12px',
        cursor: 'pointer',
        background: primary ? T.accent : 'transparent',
        color: primary ? T.onAccent : danger ? T.error : T.text,
        whiteSpace: 'nowrap',
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
      notice: { marginTop: '8px', padding: '6px 10px', borderRadius: '6px', border: '1px solid ' + T.border, color: T.dim, fontSize: '12px' },
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
      confirmNames: {
        marginTop: '8px',
        maxHeight: '160px',
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
    }

    // ---------- 纯函数 ----------

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function schemesOf(data) {
      const global = data && data.state && data.state.global
      return global && isRecord(global.schemes) ? global.schemes : {}
    }

    function defaultIdOf(data) {
      const global = data && data.state && data.state.global
      const id = global && global.defaultSchemeId
      return typeof id === 'string' && id !== '' ? id : null
    }

    function workspaceIdOf(data) {
      const workspace = data && data.state && data.state.workspace
      const id = workspace && workspace.schemeId
      return typeof id === 'string' && id !== '' ? id : null
    }

    /** 路由的一行文本。省略 reasoningEffort 时明说「模型默认」，不要留空。 */
    function routeText(route) {
      if (!isRecord(route)) return '（未配置）'
      const effort = typeof route.reasoningEffort === 'string' && route.reasoningEffort !== '' ? ' · ' + route.reasoningEffort : ' · 模型默认'
      return String(route.provider || '?') + '/' + String(route.model || '?') + effort
    }

    /** 会话路由摘要；没有 session 键 = 跟随官方默认。 */
    function sessionText(scheme) {
      if (!isRecord(scheme) || !isRecord(scheme.session)) return '跟随系统默认'
      return routeText(scheme.session)
    }

    /** 配了几档。缺省的档不暴露给模型，所以这里只数有首选的档。 */
    function tierCount(scheme) {
      if (!isRecord(scheme) || !isRecord(scheme.tiers)) return 0
      let count = 0
      for (const tierId of TIER_IDS) {
        const tier = scheme.tiers[tierId]
        if (isRecord(tier) && isRecord(tier.primary)) count += 1
      }
      return count
    }

    function cloneScheme(scheme) {
      return JSON.parse(JSON.stringify(isRecord(scheme) ? scheme : { name: '', tiers: {} }))
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

    /** 草稿到落盘形状：只保留协议里的键，空串的 effort 直接丢掉（等于跟随）。 */
    function normalizeScheme(scheme) {
      const out = { name: String(scheme && scheme.name ? scheme.name : '').trim(), tiers: {} }
      if (isRecord(scheme) && isRecord(scheme.session)) out.session = normalizeRoute(scheme.session)
      const tiers = scheme && isRecord(scheme.tiers) ? scheme.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = tiers[tierId]
        if (!isRecord(tier) || !isRecord(tier.primary)) continue
        out.tiers[tierId] = {
          name: String(tier.name || '').trim() || TIER_NAMES[tierId],
          primary: normalizeRoute(tier.primary),
          fallbacks: Array.isArray(tier.fallbacks) ? tier.fallbacks.filter(isRecord).map(normalizeRoute) : [],
        }
      }
      return out
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
    function validateScheme(scheme) {
      if (!isRecord(scheme)) return ['方案内容不是对象']
      const problems = []
      if (String(scheme.name || '').trim() === '') problems.push('方案名称不能为空')
      if (scheme.session !== undefined) problems.push.apply(problems, validateRoute(scheme.session, '会话路由'))
      const tiers = isRecord(scheme.tiers) ? scheme.tiers : {}
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

    function schemeNameOf(data, id) {
      if (!id) return ''
      if (id === BUILTIN_ID) return BUILTIN_NAME
      const scheme = schemesOf(data)[id]
      return scheme && scheme.name ? scheme.name : id + '（已删除）'
    }

    function newSchemeId() {
      return 'scheme-' + Date.now().toString(36)
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
        tiers: isRecord(effective.tiers) ? effective.tiers : {},
      }
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
      const tiers = isRecord(overrides.tiers) ? overrides.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = tiers[tierId]
        if (!isRecord(tier)) continue
        const hit = PROMPT_TIER_FIELDS.some((field) => typeof tier[field] === 'string' && tier[field].trim() !== '')
        if (hit) keys.push(tierId)
      }
      return keys
    }

    /** 深拷贝一份稀疏 patch：草稿只读不就地改，跨渲染才不会串。 */
    function clonePromptPatch(patch) {
      const next = {}
      if (!isRecord(patch)) return next
      if (typeof patch.delegation === 'string') next.delegation = patch.delegation
      const tiers = {}
      const source = isRecord(patch.tiers) ? patch.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = source[tierId]
        if (!isRecord(tier)) continue
        const copy = {}
        for (const field of PROMPT_TIER_FIELDS) {
          if (typeof tier[field] === 'string') copy[field] = tier[field]
        }
        if (Object.keys(copy).length > 0) tiers[tierId] = copy
      }
      if (Object.keys(tiers).length > 0) next.tiers = tiers
      return next
    }

    /**
     * 写一个提示词字段到草稿。
     *
     * 与生效值相同就删键：改回原值等于没改，保存时不该多写一条覆盖。
     * `tierId === null` 表示编排段；档的键按整档存放，label 与 text 各自独立。
     */
    function setPromptField(patch, tierId, field, raw, base) {
      const next = clonePromptPatch(patch)
      if (tierId === null) {
        if (raw === base) delete next.delegation
        else next.delegation = raw
        return next
      }
      const tiers = isRecord(next.tiers) ? next.tiers : {}
      const tier = isRecord(tiers[tierId]) ? tiers[tierId] : {}
      if (raw === base) delete tier[field]
      else tier[field] = raw
      if (Object.keys(tier).length > 0) tiers[tierId] = tier
      else delete tiers[tierId]
      if (Object.keys(tiers).length > 0) next.tiers = tiers
      else delete next.tiers
      return next
    }

    /** 当前输入值：草稿优先，没有草稿就用生效值。空输入框因此不会把值变成 undefined。 */
    function promptFieldValue(patch, tierId, field, base) {
      if (!isRecord(patch)) return base
      if (tierId === null) return typeof patch.delegation === 'string' ? patch.delegation : base
      const tiers = isRecord(patch.tiers) ? patch.tiers : {}
      const tier = tiers[tierId]
      if (isRecord(tier) && typeof tier[field] === 'string') return tier[field]
      return base
    }

    /** 「恢复内置」成功后把该键从草稿里摘掉；其余键的未保存改动保留。 */
    function withoutPromptKey(patch, key) {
      const next = clonePromptPatch(patch)
      if (key === PROMPT_DELEGATION_KEY) {
        delete next.delegation
        return next
      }
      const tiers = isRecord(next.tiers) ? next.tiers : {}
      delete tiers[key]
      if (Object.keys(tiers).length > 0) next.tiers = tiers
      else delete next.tiers
      return next
    }

    /** 草稿里有没有实质改动。空 patch 与 undefined 都是「没有」。 */
    function hasPromptPatch(patch) {
      if (!isRecord(patch)) return false
      if (typeof patch.delegation === 'string') return true
      const tiers = isRecord(patch.tiers) ? patch.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = tiers[tierId]
        if (isRecord(tier) && Object.keys(tier).length > 0) return true
      }
      return false
    }

    /**
     * 空白字段的位置：保存前拦一层，连请求都不发。
     *
     * 后端的 readPromptField 会拒空串与纯空白；语义上空串又等于「跟随内置」，
     * 而跟随内置有自己的入口（恢复内置）。就地拦下，报错比让后端回一句
     * 「不能为空串」更接近用户此刻想做的事。
     */
    function blankPromptFields(patch) {
      const problems = []
      if (!isRecord(patch)) return problems
      if (typeof patch.delegation === 'string' && patch.delegation.trim() === '') problems.push('编排段')
      const tiers = isRecord(patch.tiers) ? patch.tiers : {}
      for (const tierId of TIER_IDS) {
        const tier = tiers[tierId]
        if (!isRecord(tier)) continue
        for (const field of PROMPT_TIER_FIELDS) {
          if (typeof tier[field] === 'string' && tier[field].trim() === '') {
            problems.push(TIER_NAMES[tierId] + (field === 'label' ? '的名称' : '的判据'))
          }
        }
      }
      return problems
    }

    /**
     * 草稿 → `putPrompts` 命令；没有实质改动时返回 null。
     *
     * 只带自己的键：编排段改了才带 delegation，某档改了才带 tiers[tierId]，
     * 档内再只带改过的 label / text。空白值与等于生效值的值都不进命令。
     */
    function promptsCommand(prompts, patch) {
      if (!isRecord(patch)) return null
      const effective = promptTextOf(prompts)
      const command = { op: 'putPrompts' }
      let touched = false
      if (typeof patch.delegation === 'string' && patch.delegation.trim() !== '' && patch.delegation !== effective.delegation) {
        command.delegation = patch.delegation
        touched = true
      }
      const source = isRecord(patch.tiers) ? patch.tiers : {}
      const tierPayload = {}
      for (const tierId of TIER_IDS) {
        const tier = source[tierId]
        if (!isRecord(tier)) continue
        const base = promptTierBase(effective, tierId)
        const fields = {}
        for (const field of PROMPT_TIER_FIELDS) {
          const value = tier[field]
          if (typeof value !== 'string' || value.trim() === '') continue
          if (value === base[field]) continue
          fields[field] = value
          touched = true
        }
        if (Object.keys(fields).length > 0) tierPayload[tierId] = fields
      }
      if (Object.keys(tierPayload).length > 0) command.tiers = tierPayload
      return touched ? command : null
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

      const load = () => {
        const session = host.remote && host.remote.session
        if (!session || typeof session.modelCatalog !== 'function') {
          set('unavailable', [], '宿主没有提供模型目录（remote.session.modelCatalog 不存在），模型下拉为空')
          return
        }
        set('loading', snapshot.groups, null)
        let pending
        try {
          pending = session.modelCatalog()
        } catch (error) {
          set('error', [], '读取模型目录失败：' + String(error))
          return
        }
        Promise.resolve(pending).then(
          (response) => {
            if (!response || response.ok !== true) {
              const message = response && response.error && response.error.message ? response.error.message : '未知原因'
              set('error', [], '读取模型目录失败：' + message)
              return
            }
            const value = response.value || {}
            set('ready', Array.isArray(value.groups) ? value.groups : [], null)
          },
          (failure) => {
            set('error', [], '读取模型目录失败：' + String(failure && failure.message ? failure.message : failure))
          },
        )
      }

      return { read: read, subscribe: subscribe, load: load }
    }

    /** apply 里创建一次，组件通过闭包拿到同一个实例。 */
    function createHost(ctx) {
      // remote 是软依赖：inject 只声明 slots，remote 从 ctx 上探测。
      // 缺了它面板照常打开——只是模型下拉为空、绑定工作区不可用，而不是整个插件不加载。
      //
      // ctx.get 在服务不存在时**抛错**，不返回 undefined：少了这个 try，这一行
      // 会让整个 client 模块加载失败，进而把 web boot 判成 entry failed、桌面端起不来。
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

    // ---------- 数据 ----------

    /**
     * 已知工作区：从会话列表里取 cwd，去重、按最近更新排序。
     *
     * 这是「当前工作区」的唯一来源——插件页是全局页面，没有会话上下文；
     * 最近更新的根会话所在目录就是用户正在看的那一个。
     * 拿不到会话时返回空列表：面板仍能编辑全局层，只是不能绑定。
     */
    async function listWorkspaces(host, sessionId) {
      const session = host.remote && host.remote.session
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
      // 当前会话的目录优先。只看「最近更新」会绑错：切到新工作区后，旧会话可能
      // 仍是最新更新的那一个，用户看到的就是上一个目录。
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
      // 其余按最近更新排序：用户刚在哪个目录里干活，哪个就排在后面。
      roots.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const cwds = []
      if (pinned !== null) cwds.push(pinned)
      for (const item of roots) {
        if (cwds.indexOf(item.cwd) < 0) cwds.push(item.cwd)
        if (cwds.length >= MAX_WORKSPACES) break
      }
      return { currentCwd: cwds.length > 0 ? cwds[0] : null, cwds: cwds }
    }

    /**
     * 读面板数据：先取已知工作区，再逐个 read（每个工作区一次，最多 MAX_WORKSPACES 次）。
     *
     * 主视图取当前 cwd 的那次 read；其余 read 只用来统计「这个方案被几个工作区绑了」。
     * 一个工作区的 read 失败不拖垮整块：失败项不进统计，错误留给主视图。
     */
    async function loadPanel(host) {
      const listing = await listWorkspaces(host)
      const reads = await Promise.all(
        listing.cwds.map(async (cwd) => {
          try {
            return { cwd: cwd, data: await api.read(cwd) }
          } catch (failure) {
            return { cwd: cwd, error: String(failure && failure.message ? failure.message : failure) }
          }
        }),
      )
      const ok = reads.filter((entry) => entry.data)
      let data = null
      if (listing.currentCwd !== null) {
        const current = ok.find((entry) => entry.cwd === listing.currentCwd)
        if (current) data = current.data
      }
      if (data === null && ok.length > 0) data = ok[0].data
      if (data === null) data = await api.read(null)
      const workspaces = ok.map((entry) => ({ cwd: entry.cwd, schemeId: workspaceIdOf(entry.data) }))
      return { data: data, workspaces: workspaces, currentCwd: listing.currentCwd }
    }

    function useSchemeView(host) {
      const [state, setState] = useState({ phase: 'loading', data: null, workspaces: [], currentCwd: null, error: null })
      const [tick, setTick] = useState(0)
      const reload = useCallback(() => setTick((value) => value + 1), [])

      useEffect(() => {
        let alive = true
        setState((prev) => ({ ...prev, phase: prev.data ? prev.phase : 'loading', error: null }))
        ;(async () => {
          try {
            const loaded = await loadPanel(host)
            if (!alive) return
            setState({ phase: 'ready', data: loaded.data, workspaces: loaded.workspaces, currentCwd: loaded.currentCwd, error: null })
          } catch (failure) {
            if (!alive) return
            setState((prev) => ({ ...prev, phase: 'error', error: String(failure && failure.message ? failure.message : failure) }))
          }
        })()
        return () => {
          alive = false
        }
      }, [host, tick])

      return { state: state, reload: reload }
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

    function Tag(props) {
      const face = props || {}
      return h('span', { style: face.danger ? S.badgeWarn : S.badge, title: face.title }, face.children)
    }

    function Button(props) {
      const face = props || {}
      return h(
        'button',
        {
          type: 'button',
          style: S.button(face.primary === true, face.danger === true),
          title: face.title,
          disabled: face.disabled === true,
          onClick: face.disabled === true ? undefined : face.onClick,
        },
        face.children,
      )
    }

    /**
     * 二次确认。不用 window.confirm：它列不出受影响的那几个目录，
     * 而这里的关键正是「先看见哪些工作区会回落，再点确定」。
     */
    function ConfirmDialog(props) {
      if (!props.open) return null
      const names = props.names || []
      return h(
        'div',
        { style: S.modalBack, onClick: props.onCancel },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          h('div', { style: S.title }, props.title || '请确认'),
          props.message ? h('div', { style: { ...S.hint, marginTop: '6px' } }, props.message) : null,
          names.length > 0 ? h('div', { style: S.confirmNames }, names.join('\n')) : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
            h(Button, { onClick: props.onCancel }, '取消'),
            h(Button, { primary: true, danger: true, onClick: props.onConfirm }, props.confirmLabel || '确认'),
          ),
        ),
      )
    }

    /** 原生 select；选项色用系统色，理由见 S.select 的注释。 */
    function Select(props) {
      return h(
        'select',
        {
          style: { ...S.select, ...(props.style || {}) },
          value: props.value,
          disabled: props.disabled === true,
          title: props.title,
          onChange: props.onChange,
        },
        props.children,
      )
    }

    function Option(props) {
      return h('option', { value: props.value, style: S.option, disabled: props.disabled === true }, props.children)
    }

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
      const effortKnown = effort === '' || efforts.some((candidate) => candidate.id === effort)

      const chooseProvider = (provider) => {
        const nextGroup = groups.find((candidate) => candidate.id === provider)
        const nextModels = nextGroup && Array.isArray(nextGroup.models) ? nextGroup.models : []
        const nextModel = nextModels.length > 0 ? nextModels[0].id : ''
        const nextEfforts = nextModels.length > 0 && nextModels[0].reasoning && Array.isArray(nextModels[0].reasoning.efforts)
          ? nextModels[0].reasoning.efforts.map((item) => item.id)
          : []
        const keep = effort !== '' && nextEfforts.indexOf(effort) >= 0 ? { reasoningEffort: effort } : {}
        onChange({ provider: provider, model: nextModel, ...keep })
      }

      const chooseModel = (model) => {
        const nextEntry = models.find((candidate) => candidate.id === model)
        const nextEfforts = nextEntry && nextEntry.reasoning && Array.isArray(nextEntry.reasoning.efforts)
          ? nextEntry.reasoning.efforts.map((item) => item.id)
          : []
        const keep = effort !== '' && nextEfforts.indexOf(effort) >= 0 ? { reasoningEffort: effort } : {}
        onChange({ provider: value.provider, model: model, ...keep })
      }

      return h(
        'div',
        { style: { opacity: filled && !known ? 0.6 : 1 } },
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, 'provider'),
          h(
            Select,
            { value: value.provider || '', disabled: disabled, onChange: (event) => chooseProvider(event.target.value) },
            h(Option, { value: '' }, '选择 provider'),
            value.provider !== '' && !group ? h(Option, { value: value.provider, disabled: true }, value.provider + '（不在目录中）') : null,
            groups.map((candidate) => h(Option, { key: candidate.id, value: candidate.id }, candidate.name || candidate.id)),
          ),
          h('span', { style: S.fieldLabel }, 'model'),
          h(
            Select,
            { value: value.model || '', disabled: disabled || !group, onChange: (event) => chooseModel(event.target.value) },
            h(Option, { value: '' }, group ? '选择 model' : '先选 provider'),
            value.model !== '' && !entry ? h(Option, { value: value.model, disabled: true }, value.model + '（不在目录中）') : null,
            models.map((candidate) => h(Option, { key: candidate.id, value: candidate.id }, candidate.name || candidate.id)),
          ),
          filled && !known ? h(Tag, { danger: true, title: '目录里找不到这条路由；保存后仍会写入，执行时按「当前不可用」处理' }, '当前不可用') : null,
        ),
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '思考等级'),
          effort !== ''
            ? h(
                Select,
                { value: effort, disabled: disabled, onChange: (event) => onChange({ ...value, reasoningEffort: event.target.value }) },
                effortKnown ? null : h(Option, { value: effort, disabled: true }, effort + '（该模型未公布）'),
                efforts.map((candidate) => h(Option, { key: candidate.id, value: candidate.id }, candidate.name || candidate.id)),
              )
            : h('span', { style: S.rowMeta }, efforts.length > 0 ? '跟随模型默认（不写 reasoningEffort）' : '该模型不公布思考等级'),
          effort !== ''
            ? h(Button, { disabled: disabled, title: '删掉 reasoningEffort 键', onClick: () => onChange(routeWithoutEffort(value)) }, '跟随模型默认')
            : efforts.length > 0
              ? h(Button, { disabled: disabled, onClick: () => onChange({ ...value, reasoningEffort: pickEffort(catalog, value.provider, value.model) }) }, '指定强度')
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

      if (!isRecord(tier)) {
        return h(
          'div',
          { style: S.row },
          h(
            'div',
            { style: S.rowMain },
            h('div', { style: S.rowName }, TIER_NAMES[tierId], h(Tag, null, tierId), h(Tag, null, '未配置')),
            h('div', { style: S.rowMeta }, '未配置的档不暴露给模型；启用后才出现在 subagent_tier 的枚举里。'),
          ),
          h(Button, { disabled: disabled, onClick: () => onChange(defaultTier(tierId, catalog)) }, '启用此档'),
        )
      }

      const fallbacks = Array.isArray(tier.fallbacks) ? tier.fallbacks : []
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
          h(Button, { disabled: disabled, danger: true, onClick: () => onChange(null) }, '停用此档'),
        ),
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '名称'),
          h('input', {
            style: S.input,
            value: tier.name || '',
            disabled: disabled,
            placeholder: TIER_NAMES[tierId],
            onChange: (event) => setTier({ ...tier, name: event.target.value }),
          }),
        ),
        h('div', { style: S.fieldRow }, h('span', { style: S.fieldLabel }, '首选')),
        h(RouteFields, {
          value: tier.primary,
          catalog: catalog,
          disabled: disabled,
          onChange: (next) => setTier({ ...tier, primary: next }),
        }),
        h(
          'div',
          { style: { ...S.fieldRow, paddingTop: '8px' } },
          h('span', { style: S.fieldLabel }, '备选'),
          h('span', { style: S.rowMeta }, fallbacks.length === 0 ? '首选不可用时不换模型，直接报错' : '按顺序前进，只换确定性失败的那一条'),
          h(Button, {
            disabled: disabled,
            onClick: () => setTier({ ...tier, fallbacks: fallbacks.concat([firstRoute(catalog)]) }),
          }, '添加备选'),
        ),
        fallbacks.map((route, index) =>
          h(
            'div',
            { key: String(index), style: S.fallbackRow },
            h('span', { style: S.fieldLabel }, '#' + String(index + 1)),
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
            h(Button, { disabled: disabled || index === 0, onClick: () => moveFallback(index, -1) }, '↑'),
            h(Button, { disabled: disabled || index === fallbacks.length - 1, onClick: () => moveFallback(index, 1) }, '↓'),
            h(Button, {
              disabled: disabled,
              danger: true,
              onClick: () => {
                const list = fallbacks.slice()
                list.splice(index, 1)
                setTier({ ...tier, fallbacks: list })
              },
            }, '删除'),
          ),
        ),
      )
    }

    // ---------- 方案编辑 ----------

    function SingleSchemeEditor(props) {
      const { editing, catalog, support } = props
      const scheme = editing.value
      const tiers = isRecord(scheme.tiers) ? scheme.tiers : {}
      const tierDisabled = support.subagents === false
      const setScheme = props.onChange

      const setSession = (next) => {
        if (next === null) {
          // 跟随 = 删键。构造新对象而不是 delete，草稿才不会被就地改写。
          setScheme({ name: scheme.name, tiers: scheme.tiers })
          return
        }
        setScheme({ ...scheme, session: next })
      }

      const setTier = (tierId, next) => {
        const nextTiers = { ...tiers }
        if (next === null) delete nextTiers[tierId]
        else nextTiers[tierId] = next
        setScheme({ ...scheme, tiers: nextTiers })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '名称'),
          h('input', {
            style: S.input,
            value: scheme.name || '',
            placeholder: '比如：标准',
            // 进入编辑态就把光标放进名称框：点「新建方案」后若什么都没发生，
            // 用户至少能立刻看出是「编辑器没出现」还是「输入没反应」。
            autoFocus: true,
            onChange: (event) => setScheme({ ...scheme, name: event.target.value }),
          }),
          h('span', { style: S.mono }, 'id: ' + editing.id),
        ),
        h(
          'div',
          { style: { ...S.fieldRow, marginTop: '6px' } },
          h('div', { style: S.rowMain },
            h('div', { style: S.rowName }, '会话路由'),
            h('div', { style: S.rowMeta }, '只作用于该工作区里之后新建的会话；已有会话不变。'),
          ),
          isRecord(scheme.session)
            ? h(Button, { onClick: () => setSession(null), title: '删掉 session 键，回到官方默认' }, '跟随系统默认')
            : h(Button, { onClick: () => setSession(firstRoute(catalog)) }, '指定会话路由'),
        ),
        isRecord(scheme.session)
          ? h(RouteFields, {
              value: scheme.session,
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

    // ---------- 列表与绑定 ----------

    function SchemeRow(props) {
      const row = props.row
      const scheme = isRecord(row.scheme) ? row.scheme : {}
      const bound = props.bound || []
      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.rowMain },
          h(
            'div',
            { style: S.rowName },
            row.name,
            row.builtin ? h(Tag, { title: '不落盘、不可覆盖、不可删除' }, '出厂') : null,
            row.dirty ? h(Tag, null, '未保存') : null,
            props.active ? h(Tag, { title: '当前工作区求值链的结果' }, '生效中') : null,
            props.isDefault ? h(Tag, { title: '全局层 defaultSchemeId 指向它' }, '全局默认') : null,
            props.boundHere ? h(Tag, { title: '当前工作区绑定了它' }, '本工作区') : null,
          ),
          h(
            'div',
            { style: S.rowMeta },
            '会话：' + sessionText(scheme) + ' · 已配 ' + tierCount(scheme) + '/4 档 · ' + (bound.length > 0 ? bound.length + ' 个工作区绑定' : '未被任何工作区绑定'),
          ),
          bound.length > 0 ? h('div', { style: S.mono }, bound.map((item) => item.cwd).join('\n')) : null,
        ),
        row.builtin ? null : h(Button, { onClick: props.onEdit }, '编辑'),
        row.builtin ? null : h(Button, { onClick: props.onDelete, danger: true }, '删除'),
        h(Button, { disabled: props.isDefault, onClick: props.onSetDefault }, props.isDefault ? '已是默认' : '设为全局默认'),
      )
    }

    /**
     * 工作区绑定：当前 cwd、它绑的方案、「跟随全局默认」。
     *
     * 跟随 = 删掉 schemeId 键（bindWorkspace / null），不是写 null 值。
     * 下拉里只列方案，不列「跟随」——跟随是独立按钮，两种状态一眼分得开。
     */
    function WorkspaceSection(props) {
      const { data, workspaces, currentCwd, draft, onBinding } = props
      const current = draft.binding !== undefined ? draft.binding : workspaceIdOf(data)
      const options = []
      options.push(h(Option, { key: BUILTIN_ID, value: BUILTIN_ID }, BUILTIN_NAME))
      for (const id of Object.keys(schemesOf(data)).sort()) {
        options.push(h(Option, { key: id, value: id }, schemeNameOf(data, id)))
      }
      return h(
        'div',
        { style: S.section },
        h(
          'div',
          { style: S.groupHead },
          h('span', { style: S.groupName }, '工作区绑定'),
          h(Tag, { title: '绑定只作用于该目录下之后新建的会话' }, '新建会话生效'),
        ),
        h(
          'div',
          { style: S.rowFirst },
          h(
            'div',
            { style: S.rowMain },
            h('div', { style: S.rowMeta }, '当前工作目录'),
            h('div', { style: S.mono }, currentCwd || '（没有可用的会话目录：先打开一个会话）'),
            h(
              'div',
              { style: S.rowMeta },
              '本目录绑定：' + (current ? schemeNameOf(data, current) : '跟随全局默认') +
                (workspaces.length > 1 ? ' · 已统计 ' + String(workspaces.length) + ' 个已知工作区' : ''),
            ),
          ),
          current ? h(Button, { disabled: currentCwd === null, onClick: () => onBinding(null) }, '跟随全局默认') : null,
          h(
            Select,
            {
              value: current || '',
              disabled: currentCwd === null,
              title: currentCwd === null ? '没有工作目录就不能绑定' : '把这个方案绑到当前目录',
              onChange: (event) => onBinding(event.target.value === '' ? null : event.target.value),
            },
            h(Option, { value: '', disabled: true }, current ? '（已绑定）' : '跟随全局默认'),
            options,
          ),
        ),
      )
    }


    // ---------- 提示词编辑 ----------

    /**
     * 字段级提示：空白与 provider/model 串。
     *
     * 前者阻断保存（`Panel.save` 也拦一次），后者只提醒。两者都不是校验：
     * 面板没有权威的 provider 名单，硬校验只会误杀（spec §6.3.1 第 2 条）。
     */
    function PromptFieldNotice(props) {
      const value = typeof props.value === 'string' ? props.value : ''
      let inner = null
      if (value.trim() === '') {
        inner = h('div', { style: S.error }, '空白不保存：空串等于跟随内置，请点「恢复内置」。')
      } else {
        const hit = routeLikeIn(value)
        if (hit !== '') {
          inner = h(
            'div',
            { style: { ...S.notice, color: T.warn, borderColor: T.warn } },
            '段内出现「' + hit + '」——形如 provider/model 的串。段里出现模型名会让前缀随会话变化，破坏前缀缓存；若这只是路径，可以忽略（这条不阻止保存）。',
          )
        }
      }
      if (inner === null) return null
      return h('div', { style: S.fieldRow }, h('div', { style: S.rowMain }, inner))
    }

    /**
     * 一档提示词：名称 + 判据。
     *
     * 「恢复内置」按档整键重置（后端 resetPrompts 的粒度就是档），
     * 所以清空输入框不能等价于恢复内置：空输入框会被拦下，见 PromptFieldNotice。
     */
    function PromptTierEditor(props) {
      const tierId = props.tierId
      const base = props.base || { label: '', text: '' }
      const patch = props.patch
      const overridden = props.overridden === true
      const disabled = props.disabled === true
      const onChange = props.onChange
      const onReset = props.onReset
      const labelValue = promptFieldValue(patch, tierId, 'label', base.label)
      const textValue = promptFieldValue(patch, tierId, 'text', base.text)

      return h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.fieldHead },
          h('span', { style: S.groupName }, TIER_NAMES[tierId]),
          h(Tag, null, tierId),
          overridden ? h(Tag, { danger: true, title: '该档至少有一个字段来自用户覆盖' }, '已覆盖') : h(Tag, null, '内置'),
          h(Button, {
            disabled: disabled || !overridden,
            title: overridden ? '删掉该档的覆盖，回到内置' : '当前就是内置',
            onClick: () => onReset(tierId),
          }, '恢复内置'),
        ),
        h(
          'div',
          { style: S.fieldRow },
          h('span', { style: S.fieldLabel }, '名称'),
          h('input', {
            style: S.input,
            value: labelValue,
            disabled: disabled,
            placeholder: base.label,
            onChange: (event) => onChange(setPromptField(patch, tierId, 'label', event.target.value, base.label)),
          }),
        ),
        h(PromptFieldNotice, { value: labelValue }),
        h(
          'div',
          { style: { ...S.fieldRow, alignItems: 'flex-start' } },
          h('span', { style: S.fieldLabel }, '判据'),
          h(
            'div',
            { style: S.rowMain },
            h('textarea', {
              style: S.textarea,
              value: textValue,
              disabled: disabled,
              rows: 2,
              onChange: (event) => onChange(setPromptField(patch, tierId, 'text', event.target.value, base.text)),
            }),
          ),
        ),
        h(PromptFieldNotice, { value: textValue }),
      )
    }

    /**
     * 提示词区：编排段 + 四档判据（spec §6.3.1）。
     *
     * 与方案正交：所有方案共用同一份覆盖，落盘在 `$DSH_HOME/model-scheme/prompts.json`。
     * 面板只提交改过的键；空串不提交；像 provider/model 的串只提醒。
     * 独立成第二页：提示词是全局覆盖，与具体方案的绑定无关，混在方案页里太挤。
     */
    function PromptSection(props) {
      const prompts = props.prompts
      const patch = props.patch
      const disabled = props.disabled === true
      const onChange = props.onChange
      const onReset = props.onReset
      if (!isRecord(prompts)) return null

      const effective = promptTextOf(prompts)
      const overridden = promptOverrideKeys(prompts.overrides)
      const delegationValue = promptFieldValue(patch, null, 'delegation', effective.delegation)
      const delegationOverridden = overridden.indexOf(PROMPT_DELEGATION_KEY) >= 0

      return h(
        'div',
        { style: S.section },
        h(
          'div',
          { style: S.groupHead },
          h('span', { style: S.groupName }, '提示词'),
          h(Tag, { title: '所有方案共用同一份覆盖，与方案正交' }, '全局'),
        ),
        h(
          'div',
          { style: S.rowFirst },
          h(
            'div',
            { style: S.rowMain },
            h('div', { style: S.rowMeta }, '编排段与四档判据会写进系统提示词；改完点面板底部保存。「恢复内置」立即生效。空输入框不等于恢复内置，请用那个按钮。'),
          ),
        ),
        h(
          'div',
          { style: S.field },
          h(
            'div',
            { style: S.fieldHead },
            h('span', { style: S.groupName }, '编排段'),
            h(Tag, { title: '系统提示词段名' }, 'model-scheme.delegation'),
            delegationOverridden ? h(Tag, { danger: true, title: '当前用的是用户覆盖' }, '已覆盖') : h(Tag, null, '内置'),
            h(Button, {
              disabled: disabled || !delegationOverridden,
              title: delegationOverridden ? '删掉 delegation 覆盖，回到内置' : '当前就是内置',
              onClick: () => onReset(PROMPT_DELEGATION_KEY),
            }, '恢复内置'),
          ),
          h(
            'div',
            { style: { ...S.fieldRow, alignItems: 'flex-start' } },
            h(
              'div',
              { style: S.rowMain },
              h('textarea', {
                style: S.textarea,
                value: delegationValue,
                disabled: disabled,
                rows: 8,
                onChange: (event) => onChange(setPromptField(patch, null, 'delegation', event.target.value, effective.delegation)),
              }),
            ),
          ),
          h(PromptFieldNotice, { value: delegationValue }),
        ),
        TIER_IDS.map((tierId) =>
          h(PromptTierEditor, {
            key: tierId,
            tierId: tierId,
            base: promptTierBase(effective, tierId),
            patch: patch,
            overridden: overridden.indexOf(tierId) >= 0,
            disabled: disabled,
            onChange: onChange,
            onReset: onReset,
          }),
        ),
      )
    }

    // ---------- 面板 ----------

    function Panel(props) {
      const host = props.host
      const catalog = useCatalog(host.catalog)
      const view = useSchemeView(host)
      const [draft, setDraft] = useState(EMPTY_DRAFT)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [confirm, setConfirm] = useState(null)
      /** 分页：模型（方案与绑定）｜提示词。用显示切换而不是条件渲染，切页不丢草稿。 */
      const [tab, setTab] = useState('model')

      const state = view.state
      const data = state.data
      const support = (data && data.support) || {}

      const rows = useMemo(() => {
        if (!data) return []
        const schemes = schemesOf(data)
        const draftId = draft.editing ? draft.editing.id : null
        const list = [{ id: BUILTIN_ID, name: BUILTIN_NAME, scheme: { name: BUILTIN_NAME, tiers: {} }, builtin: true }]
        for (const id of Object.keys(schemes).sort()) {
          if (draft.deleted.indexOf(id) >= 0) continue
          const value = id === draftId ? draft.editing.value : schemes[id]
          list.push({ id: id, name: isRecord(value) && value.name ? value.name : id, scheme: value, builtin: false, dirty: id === draftId })
        }
        if (draftId !== null && !Object.prototype.hasOwnProperty.call(schemes, draftId) && draft.deleted.indexOf(draftId) < 0) {
          list.push({ id: draftId, name: draft.editing.value.name || '（未命名）', scheme: draft.editing.value, builtin: false, dirty: true })
        }
        return list
      }, [data, draft])

      if (state.phase === 'loading' && data === null) {
        return h('div', { style: S.embedded }, h('div', { style: S.hint }, '加载中…'))
      }
      if (!data) {
        return h(
          'div',
          { style: S.embedded },
          h('div', { style: S.title }, TITLE),
          h('div', { style: S.error }, state.error || '读取失败'),
        )
      }

      const workspaces = state.workspaces
      const currentCwd = state.currentCwd
      const defaultId = draft.defaultId !== undefined ? draft.defaultId : defaultIdOf(data)
      const currentBinding = draft.binding !== undefined ? draft.binding : workspaceIdOf(data)
      const activeId = data.resolved && data.resolved.id ? data.resolved.id : null
      const warnings = data.state && Array.isArray(data.state.warnings) ? data.state.warnings : []
      const dirtyCount =
        (draft.editing ? 1 : 0) +
        draft.deleted.length +
        (draft.defaultId !== undefined ? 1 : 0) +
        (draft.binding !== undefined ? 1 : 0) +
        (hasPromptPatch(draft.prompts) ? 1 : 0)

      // ---------- 改动 ----------

      const startEdit = (row) => {
        setNotice(null)
        setError(null)
        setDraft((prev) => ({ ...prev, editing: { id: row.id, value: cloneScheme(row.scheme) } }))
      }

      const startCreate = () => {
        setNotice(null)
        setError(null)
        setDraft((prev) => ({ ...prev, editing: { id: newSchemeId(), value: { name: '', tiers: {} } } }))
      }

      const cancelEdit = () => setDraft((prev) => ({ ...prev, editing: null }))

      const requestDelete = (row) => {
        const bound = workspaces.filter((item) => item.schemeId === row.id)
        if (bound.length === 0) {
          setDraft((prev) => ({
            ...prev,
            deleted: prev.deleted.concat([row.id]),
            editing: prev.editing && prev.editing.id === row.id ? null : prev.editing,
          }))
          return
        }
        // 仍被绑定的方案：先把受影响的目录列出来再确认。删除后绑定不会被改写，
        // 求值链回落全局层并在面板标「绑定失效」（见 spec §4）。
        setConfirm({
          title: '删除仍被绑定的方案',
          message: '这个方案还被 ' + String(bound.length) + ' 个工作区绑定。删除后它们会回落全局默认，绑定记录保留并标为「绑定失效」。要先解绑请先到工作区绑定处选「跟随全局默认」。',
          names: bound.map((item) => item.cwd),
          confirmLabel: '仍然删除',
          onConfirm: () => {
            setDraft((prev) => ({
              ...prev,
              deleted: prev.deleted.concat([row.id]),
              editing: prev.editing && prev.editing.id === row.id ? null : prev.editing,
            }))
          },
        })
      }

      const setDefault = (id) => {
        setNotice(null)
        setDraft((prev) => ({ ...prev, defaultId: id }))
      }

      const setBinding = (id) => {
        setNotice(null)
        setDraft((prev) => ({ ...prev, binding: id }))
      }

      /** 提示词草稿：整份替换（setPromptField 已返回新对象，这里不就地改）。 */
      const setPromptDraft = (next) => {
        setNotice(null)
        setError(null)
        setDraft((prev) => ({ ...prev, prompts: next }))
      }

      /**
       * 「恢复内置」：立刻发 resetPrompts，不等保存按钮。
       *
       * 重置是删键，与「保存草稿」是两回事：混在保存里会让用户以为取消保存就能取消重置。
       * 只传该键（单段粒度的 keys 数组）；不带 cwd——提示词覆盖在全局层，与目录无关。
       */
      const resetPrompt = async (key) => {
        setError(null)
        setNotice(null)
        setSaving(true)
        try {
          await api.apply(null, [{ op: 'resetPrompts', keys: [key] }])
          setDraft((prev) => ({ ...prev, prompts: withoutPromptKey(prev.prompts, key) }))
          setNotice('已恢复内置：' + (key === PROMPT_DELEGATION_KEY ? '编排段' : TIER_NAMES[key] || key))
          view.reload()
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setSaving(false)
        }
      }

      const save = async () => {
        setError(null)
        setNotice(null)
        // 空白的提示词段先拦下：后端会拒空串，而这里能给出一句更接近意图的话。
        const blank = blankPromptFields(draft.prompts)
        if (blank.length > 0) {
          setError('提示词有空白段：' + blank.join('；') + '。空串等于跟随内置，请点「恢复内置」。')
          return
        }
        const commands = []
        if (draft.editing) {
          const problems = validateScheme(draft.editing.value)
          if (problems.length > 0) {
            setError('本地校验未通过：' + problems.join('；'))
            return
          }
          commands.push({ op: 'putScheme', schemeId: draft.editing.id, scheme: normalizeScheme(draft.editing.value) })
        }
        for (const id of draft.deleted) commands.push({ op: 'deleteScheme', schemeId: id })
        if (draft.defaultId !== undefined) commands.push({ op: 'setDefaultScheme', schemeId: draft.defaultId })
        if (draft.binding !== undefined) {
          if (currentCwd === null) {
            setError('没有可用的工作目录：工作区绑定需要先打开一个会话。')
            return
          }
          commands.push({ op: 'bindWorkspace', schemeId: draft.binding })
        }
        // 只带改过的键；promptsCommand 自己在没有实质改动时返回 null。
        const promptCommand = promptsCommand(data.prompts, draft.prompts)
        if (promptCommand !== null) commands.push(promptCommand)
        if (commands.length === 0) return

        setSaving(true)
        try {
          await api.apply(currentCwd, commands)
          setDraft(EMPTY_DRAFT)
          setNotice('已保存。新会话生效；已有会话不变。')
          view.reload()
        } catch (failure) {
          // 失败时草稿保留：用户改完可以再存，不用从零重来。
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setSaving(false)
        }
      }

      // ---------- 渲染 ----------

      return h(
        'div',
        { style: S.embedded },

        h(
          'div',
          { style: S.hero },
          h('div', { style: S.title }, TITLE),
          h('div', { style: S.stat }, '当前生效：' + schemeNameOf(data, activeId) + (data.resolved && data.resolved.source ? '（' + (data.resolved.source === 'workspace' ? '工作区' : data.resolved.source === 'global' ? '全局默认' : '出厂') + '）' : '')),
        ),
        h(
          'div',
          { style: S.hint },
          '方案 = 一条会话路由 + 至多四档子智能体路由。只作用于该工作区里之后新建的会话；不改动已有会话，也不替代官方「设置 → 模型」。',
        ),

        h(
          'div',
          { style: S.tabs },
          h('button', { type: 'button', style: S.tab(tab === 'model'), onClick: () => setTab('model') }, '模型'),
          h('button', { type: 'button', style: S.tab(tab === 'prompt'), onClick: () => setTab('prompt') }, '提示词'),
        ),

        // 模型页：方案列表、全局默认、工作区绑定、编辑区。切到提示词页时整块隐藏，
        // 但保持挂载——草稿与编辑态都不丢。
        h(
          'div',
          { style: tab === 'model' ? null : S.hide },

        data.lastError ? h('div', { style: S.probeFail }, '上一次施加失败：' + data.lastError) : null,
        data.resolved && data.resolved.brokenBinding
          ? h('div', { style: S.probeWarn }, '当前工作区绑定的方案已不存在，已回落全局默认（绑定记录仍在，重建同名方案即可恢复）。')
          : null,
        warnings.length > 0
          ? h('div', { style: S.probeWarn }, '配置有告警：' + warnings.slice(0, 4).join('；') + (warnings.length > 4 ? ' …' : ''))
          : null,

        // ---------- 方案列表 ----------
        h(
          'div',
          { style: { ...S.bar, marginBottom: '4px' } },
          h('span', { style: { ...S.title, fontSize: '13px' } }, '方案'),
          h('span', { style: S.rowMeta }, '出厂方案不落盘，也没有删除按钮。'),
          h('span', { style: { flex: '1 1 auto' } }),
          draft.editing ? h(Tag, null, '编辑中') : null,
          h(Button, { primary: true, onClick: startCreate }, '新建方案'),
        ),
        h(
          'div',
          { style: S.section },
          rows.map((row) =>
            h(SchemeRow, {
              key: row.id,
              row: row,
              bound: workspaces.filter((item) => item.schemeId === row.id),
              active: activeId === row.id,
              isDefault: defaultId === row.id,
              boundHere: currentBinding === row.id,
              onEdit: () => startEdit(row),
              onDelete: () => requestDelete(row),
              onSetDefault: () => setDefault(row.id),
            }),
          ),
          // 出厂方案那一行始终在；空态只补一句解释，不把整块换成提示。
          rows.length === 1 && !draft.editing
            ? h('div', { style: S.empty }, '还没有自定义方案。新建一个，或直接编辑全局默认与工作区绑定。')
            : null,
        ),

        // ---------- 全局默认 ----------
        h(
          'div',
          { style: S.section },
          h(
            'div',
            { style: S.groupHead },
            h('span', { style: S.groupName }, '全局默认'),
            h(Tag, { title: '全局层 defaultSchemeId；工作区没绑定时用它' }, '求值链第二段'),
          ),
          h(
            'div',
            { style: S.rowFirst },
            h(
              'div',
              { style: S.rowMain },
              h('div', { style: S.rowMeta }, defaultId ? '全局默认：' + schemeNameOf(data, defaultId) : '跟随出厂方案'),
              h('div', { style: S.rowMeta }, '工作区层没有 schemeId 时落到这一层；它也没有时用出厂方案。'),
            ),
            defaultId ? h(Button, { onClick: () => setDefault(null) }, '跟随出厂方案') : null,
            h(
              Select,
              {
                value: defaultId || '',
                onChange: (event) => setDefault(event.target.value === '' ? null : event.target.value),
              },
              h(Option, { value: '', disabled: true }, '跟随出厂方案'),
              h(Option, { value: BUILTIN_ID }, BUILTIN_NAME),
              Object.keys(schemesOf(data)).sort().map((id) => h(Option, { key: id, value: id }, schemeNameOf(data, id))),
            ),
          ),
        ),

        // ---------- 工作区绑定 ----------
        h(WorkspaceSection, {
          data: data,
          workspaces: workspaces,
          currentCwd: currentCwd,
          draft: draft,
          onBinding: setBinding,
        }),

        // ---------- 编辑 ----------
        draft.editing
          ? h(
              'div',
              { style: S.section },
              h(
                'div',
                { style: S.groupHead },
                h('span', { style: S.groupName }, '编辑方案'),
                h(Tag, null, draft.editing.id),
                h(Button, { onClick: cancelEdit }, '取消编辑'),
              ),
              h(SingleSchemeEditor, {
                editing: draft.editing,
                catalog: catalog,
                support: support,
                onChange: (value) => setDraft((prev) => (prev.editing ? { ...prev, editing: { ...prev.editing, value: value } } : prev)),
              }),
            )
          : null,
        ),

        // ---------- 提示与操作 ----------
        catalog.phase === 'error' || catalog.phase === 'unavailable' ? h('div', { style: S.probeWarn }, catalog.error) : null,
        catalog.phase === 'loading' ? h('div', { style: S.hint }, '正在读取模型目录…') : null,
        notice ? h('div', { style: S.notice }, notice) : null,
        error ? h('div', { style: S.error }, error) : null,

        dirtyCount > 0
          ? h(
              'div',
              { style: S.actionBar },
              h('span', { style: { ...S.hint, flex: '0 1 auto', color: T.text } }, String(dirtyCount) + ' 处未保存'),
              h('span', { style: { flex: '1 1 auto' } }),
              h(Button, { disabled: saving, onClick: () => setDraft(EMPTY_DRAFT) }, '撤销'),
              h(Button, { primary: true, disabled: saving, onClick: save }, saving ? '保存中…' : '保存'),
            )
          : null,

        // ---------- 提示词页 ----------
        tab === 'prompt'
          ? h(PromptSection, {
              prompts: data.prompts,
              patch: draft.prompts,
              disabled: saving,
              onChange: setPromptDraft,
              onReset: resetPrompt,
            })
          : null,

        h(ConfirmDialog, {
          open: confirm !== null,
          title: confirm ? confirm.title : '',
          message: confirm ? confirm.message : '',
          names: confirm ? confirm.names : [],
          confirmLabel: confirm ? confirm.confirmLabel : '确认',
          onConfirm: () => {
            const run = confirm ? confirm.onConfirm : null
            setConfirm(null)
            if (run) run()
          },
          onCancel: () => setConfirm(null),
        }),
      )
    }

    /**
     * 卡片头的摘要视图。
     *
     * 不发请求：卡片列表里每一行都会挂一次 summary，逐个 read 会把插件页拖慢。
     * 真实数据在详情页（view === 'page'）里读。
     */
    function Summary() {
      return h(
        'div',
        { style: S.hint },
        '按工作区给新会话指定会话路由与四档子智能体路由。点开配置方案、编辑档位与工作区绑定。',
      )
    }

    // ---------- 模型位方案名（ticket 08） ----------

    /**
     * 会话 id → cwd、cwd → 方案名。**只在 apply 里写**，slot 组件只读。
     *
     * 为什么不在组件里取数：`conversation.input.model.label` 的渲染一旦抛错，
     * 官方触发按钮会退回默认文字（见 ui-model-selection README「模型名称扩展」）。
     * 所以组件必须是对异常零敏感的纯函数式渲染——不请求、不订阅、不挂交互；
     * 取数全部提前到 apply：先 session.list 得到 sessionId→cwd，再按 cwd 各 read 一次。
     *
     * sessionId 从哪来：这个 slot 是 `scope: 'session'` 的单一内联 slot，
     * 会话绑定把 `sessionId` 作为普通 prop 交给组件（不是 hook，不订阅）。
     */
    const labelCache = {
      session: new Map(), // sessionId -> cwd
      name: new Map(), // cwd -> 方案显示名
      running: null, // 单飞：并发重读只跑一次
    }
    /** 增量重读间隔：只为还没缓存过的工作区发 read，新会话不用等整页刷新。 */
    const LABEL_REFRESH_MS = 15000
    /** 标签与官方目录名同处一行时的排版；只影响宽度分配，不改变触发器的交互。 */
    const LABEL_STYLE = {
      root: { display: 'inline-flex', alignItems: 'baseline', minWidth: 0, overflow: 'hidden' },
      scheme: {
        color: T.faint,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: '0 1 auto',
      },
      model: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' },
    }

    /** read 的信封数据 → 当前生效的方案显示名。取不到返回空串（组件据此退回纯模型名）。 */
    function labelSchemeNameOf(data) {
      const resolved = data && data.resolved
      const scheme = resolved && resolved.scheme
      const name = scheme && typeof scheme.name === 'string' ? scheme.name.trim() : ''
      return name
    }

    /** 同步取方案名。组件只调这一个函数；任何一步缺失都返回空串，绝不抛。 */
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
     * 重读方案名缓存。
     *
     * `full` 为真时整轮重建（启动、连接重置）；为假时只读还没缓存的 cwd（新会话）。
     * 任何异常都吞掉：缓存保留旧值，组件继续按旧值渲染或退回纯模型名——
     * 这条路径失败不允许影响 composer 的任何行为。
     */
    function labelRefresh(host, full) {
      if (labelCache.running) return labelCache.running
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
            if (cwds.indexOf(item.cwd) < 0 && cwds.length < MAX_WORKSPACES) cwds.push(item.cwd)
          }
          const names = full ? new Map() : labelCache.name
          await Promise.all(
            cwds.map(async (cwd) => {
              if (!full && names.has(cwd)) return
              try {
                const name = labelSchemeNameOf(await api.read(cwd))
                if (name !== '') names.set(cwd, name)
              } catch {
                // 这个工作区读不到就不缓存：该目录下的会话退回纯模型名。
              }
            }),
          )
          labelCache.session = nextSession
          labelCache.name = names
        } catch {
          // 整轮失败保留旧缓存，不把标签打空。
        }
      })()
      labelCache.running = run
      run.then(() => {
        if (labelCache.running === run) labelCache.running = null
      })
      return run
    }

    /**
     * composer 模型位里的「方案名 · 模型名」。
     *
     * slot 只有一个 key，placement 由 owner 传进来：只有 `'trigger'` 加方案名前缀，
     * `'menu'` 与 `'option'` 原样只有模型名——当前值与选项行不归这里管，
     * 也不注册第二个 key。
     *
     * 不渲染 button，不挂 onClick / tabIndex / aria-*：点击、搜索、焦点、禁用状态、
     * 勾选标记、推理强度与触发按钮的无障碍文字全部由官方选择器负责。
     * 方案名拿不到（未读、读失败、会话不属于任何工作区）时退回纯模型名，不留占位符。
     */
    function labelView(props) {
      let modelName = ''
      let schemeName = ''
      try {
        const model = props ? props.model : null
        modelName = model && typeof model.name === 'string' ? model.name : ''
        schemeName = props && props.placement === 'trigger' ? labelNameOf(props.sessionId) : ''
      } catch {
        schemeName = ''
      }
      if (modelName === '') return null
      if (schemeName === '') return h('span', { style: LABEL_STYLE.model }, modelName)
      return h(
        'span',
        { style: LABEL_STYLE.root },
        h('span', { style: LABEL_STYLE.scheme }, schemeName),
        h('span', { style: LABEL_STYLE.model }, ' · ' + modelName),
      )
    }

    // ---------- 会话里的方案入口 ----------

    /**
     * 会话输入框右侧的「模型方案」chip，与 Skill / Plugin / MCP 同排。
     *
     * 为什么不挂在官方的模型弹层里：`conversation.input.model` 只能整体替换，
     * `.label` 只换文字，那份「模型 / 推理等级」菜单是 model-selection 内部画的
     * MenuSurface，没有对外暴露可插入的 slot。所以切换方案只能另开一个入口。
     *
     * 浮层里选择即保存：绑定是目录级的一次性决定，没必要再走全局的草稿 + 保存两步。
     */
    /**
     * 当前会话 id。chip 在会话作用域里渲染（standard props 带 sessionId），
     * 浮层在 shell 层渲染、拿不到会话上下文，所以靠这个把两者对齐。
     *
     * 不能用「最近更新的根会话」推断当前目录：用户切了工作区之后，旧会话可能
     * 仍然是最新更新的那一个，浮层就会绑错目录。
     */
    const sessionBus = {
      id: undefined,
      listeners: new Set(),
      read: () => sessionBus.id,
      subscribe: (listener) => {
        sessionBus.listeners.add(listener)
        return () => sessionBus.listeners.delete(listener)
      },
      set: (value) => {
        if (sessionBus.id === value) return
        sessionBus.id = value
        for (const listener of sessionBus.listeners) listener()
      },
    }

    const schemeOverlay = {
      open: false,
      listeners: new Set(),
      read: () => schemeOverlay.open,
      subscribe: (listener) => {
        schemeOverlay.listeners.add(listener)
        return () => schemeOverlay.listeners.delete(listener)
      },
      set: (open) => {
        if (schemeOverlay.open === open) return
        schemeOverlay.open = open
        for (const listener of schemeOverlay.listeners) listener()
      },
    }

    /**
     * chip 的图标：12px、viewBox 16、描边 currentColor、fill none——与
     * dsh-plugin-manager 的网格图标、dsh-skill-manager 的三条横线同一套规格，
     * 四个 chip 并排时线条粗细与视觉重量才一致。
     *
     * 画的是「三条滑轨 + 各一个滑块」：模型方案本质上是给不同档位分配路由。
     */
    function ModelIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
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

    function SchemeChip(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined
      useEffect(() => {
        if (sessionId !== undefined) sessionBus.set(sessionId)
      }, [sessionId])
      const open = useSyncExternalStore(schemeOverlay.subscribe, schemeOverlay.read, schemeOverlay.read)
      return h(
        'button',
        {
          type: 'button',
          style: S.chip,
          title: '把这个工作区绑到某个模型方案；只影响之后新建的会话',
          onClick: () => schemeOverlay.set(!open),
        },
        h(ModelIcon),
        // 与 Skill / Plugin / MCP 三个 manager 的单行英文标签保持一致。
        'Model',
      )
    }

    function SchemeModal(props) {
      const host = props.host
      const open = useSyncExternalStore(schemeOverlay.subscribe, schemeOverlay.read, schemeOverlay.read)
      const [state, setState] = useState({ phase: 'idle', cwd: null, data: null, error: null })
      const [busy, setBusy] = useState(false)
      const sessionId = useSyncExternalStore(sessionBus.subscribe, sessionBus.read, sessionBus.read)

      useEffect(() => {
        if (!open) return undefined
        let alive = true
        setState((prev) => ({ ...prev, phase: 'loading', error: null }))
        ;(async () => {
          const listing = await listWorkspaces(host, sessionId)
          const cwd = listing.currentCwd
          const data = cwd === null ? null : await api.read(cwd)
          if (!alive) return
          setState({ phase: 'ready', cwd: cwd, data: data, error: null })
        })().catch((error) => {
          if (!alive) return
          setState({ phase: 'error', cwd: null, data: null, error: String(error && error.message ? error.message : error) })
        })
        return () => {
          alive = false
        }
      }, [open, sessionId])

      if (!open) return null

      const data = state.data
      const cwd = state.cwd
      const current = data ? workspaceIdOf(data) : null
      const rows = [{ id: BUILTIN_ID, name: BUILTIN_NAME }]
      if (data) {
        const schemes = schemesOf(data)
        for (const id of Object.keys(schemes).sort()) rows.push({ id: id, name: schemeNameOf(data, id) })
      }

      const bind = (schemeId) => {
        if (cwd === null || busy) return
        setBusy(true)
        applyBinding(host, cwd, schemeId).then(
          (fresh) => {
            setState({ phase: 'ready', cwd: cwd, data: fresh, error: null })
            setBusy(false)
          },
          (failure) => {
            setState((prev) => ({ ...prev, error: String(failure && failure.message ? failure.message : failure) }))
            setBusy(false)
          },
        )
      }

      return h(
        'div',
        { style: S.modalBack, onClick: () => schemeOverlay.set(false) },
        h(
          'div',
          { style: S.modal, onClick: (event) => event.stopPropagation() },
          h('div', { style: S.title }, '模型方案'),
          h('div', { style: S.hint }, '选中的方案绑定到当前工作目录 ' + (cwd || '（没有可用的会话目录）') + '，只作用于之后新建的会话。'),
          state.error ? h('div', { style: S.error }, state.error) : null,
          state.phase === 'loading' && data === null ? h('div', { style: S.hint }, '读取中…') : null,
          h(
            'div',
            { style: { ...S.section, marginTop: '10px' } },
            rows.map((row) =>
              h(
                'div',
                { key: row.id, style: S.rowFirst },
                h(
                  'div',
                  { style: S.rowMain },
                  h('div', { style: S.rowName }, row.name),
                  h('div', { style: S.mono }, row.id),
                ),
                current === row.id ? h(Tag, null, '当前绑定') : null,
                h(Button, { disabled: busy || cwd === null || current === row.id, onClick: () => bind(row.id) }, '绑到这里'),
              ),
            ),
          ),
          current === null ? null : h(Button, { disabled: busy || cwd === null, onClick: () => bind(null) }, '跟随全局默认'),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } },
            h(Button, { onClick: () => schemeOverlay.set(false) }, '关闭'),
          ),
        ),
      )
    }

    /** 写绑定并读回最新状态。失败原样抛给调用方显示。 */
    async function applyBinding(host, cwd, schemeId) {
      await api.apply(cwd, [{ op: 'bindWorkspace', schemeId: schemeId }])
      return await api.read(cwd)
    }

    // ---------- 注册 ----------

    return {
      // 依赖声明照抄官方 settings-subagent：remote.session 是独立服务名，
      // 只声明 remote 拿不到它（ctx.remote.session 会是空的，模型目录读不到）。
      // 声明里少一个 → 插件停在 pending → 整个设置分区连入口都不出现。
      inject: ['slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        // 兜底：client 模块的 apply 抛错会把 web boot 判成 entry failed，桌面端整个起不来。
        // 任何意外都只降级成「面板不出来」，绝不连坐宿主。
        try {
          applyPanel(ctx)
        } catch (error) {
          try {
            console.error('[model-scheme] 面板挂载失败：', error)
          } catch {
            // console 也不可用时无计可施。
          }
        }
      },
    }

    /** 面板的实际挂载，由 apply 包一层兜底后调用。 */
    function applyPanel(ctx) {
        const host = createHost(ctx)

        /**
         * 目录只在 apply 里加载一次，并在宿主事件上重读：
         * 换适配器或连接重置后，模型下拉必须跟着变，否则会写成一条已失效的路由。
         * 每个 effect 都返回（或由 ctx 记住）清理函数；释放时事件订阅随 ctx 一起拆。
         */
        ctx.effect(() => {
          host.catalog.load()
        }, 'model-scheme: 首次读取模型目录')

        if (typeof ctx.on === 'function') {
          ctx.effect(() => ctx.on('llm/adapters-updated', () => host.catalog.load()), 'model-scheme: 适配器变化')
          ctx.effect(() => ctx.on('connection/reset', () => host.catalog.load()), 'model-scheme: 连接重置')
        }

        // 组件类型必须是稳定的标识符：写成内联箭头函数的话，每次渲染都是新类型，
        // React 会整棵卸载重挂——输入框每敲一个字就失焦。apply 只跑一次，所以在这里
        // 定义成常量既稳定又拿得到闭包里的 host。
        const SettingsSection = () => h(Panel, { host: host })

        // 入口与 skill-manager / mcp-manager / plugin-manager 一致：只挂设置页的
        // settings.section，不注册 plugins.item 卡片。三个既有插件的用户已经习惯
        // 在设置里找它们，多一个入口反而分散。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: PANEL_ID, order: 61, label: () => TITLE },
            SettingsSection,
          ),
        )

        // ---------- 模型位方案名（ticket 08） ----------

        /**
         * 只注册 `conversation.input.model.label` 这一处，且只处理 placement 'trigger'。
         * `slots.inject` 会等父 slot `conversation.input.model` 的声明出现后再注册，
         * 与 composer 的挂载顺序无关；注册冲突（别的插件也占了这个 single slot）时
         * 静默让位——官方行为原样保留，比抛错好。
         */
        ctx.slots.inject('conversation.input.model.label', () => {
          try {
            return ctx.slots.register({ name: 'conversation.input.model.label' }, labelView)
          } catch {
            return () => {}
          }
        })

        // 会话输入框右侧的入口与它的浮层。组件引用必须稳定（apply 只跑一次），
        // 内联箭头函数会每次渲染换新类型，导致整棵卸载重挂。
        const SchemeOverlay = () => h(SchemeModal, { host: host })

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'model-scheme-chip', order: 42 }, SchemeChip),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'model-scheme-overlay', order: 62 }, SchemeOverlay),
        )

        // 缓存先读一次；连接重置整轮重读；其余时间只为新出现的工作区增量重读。
        ctx.effect(() => {
          labelRefresh(host, true)
        }, 'model-scheme: 读取模型位方案名')

        if (typeof ctx.on === 'function') {
          ctx.effect(() => ctx.on('connection/reset', () => labelRefresh(host, true)), 'model-scheme: 模型位方案名重读')
        }

        ctx.effect(() => {
          if (typeof setInterval !== 'function') return undefined
          const timer = setInterval(() => {
            // 后台标签页不重读：用户看不见触发按钮，读到的也只是缓存。
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            labelRefresh(host, false)
          }, LABEL_REFRESH_MS)
          return () => clearInterval(timer)
        }, 'model-scheme: 模型位方案名增量重读')
    }
  },
})
