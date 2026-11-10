/**
 * 浏览器半边：设置 → Model Pack，外加会话输入框右侧的 chip。
 *
 * 结构照抄 `dsh-plugin-pack` / `dsh-mcp-pack`：设置页三页（模型 | 提示词 | 分包），
 * chip 是当前工作区绑定 pack 的摘要与切换入口。本包的差异只有一处：
 *
 *   pack 的内容不是一张布尔表，而是「一条会话路由 + 至多四档子智能体路由」，
 *   所以「分包」页放名册与内容编辑器，「工作区」页放绑定。
 *
 * 数据全部来自服务端：`ui.defaultTab` 与工作区绑定都落在 packs.json / workspaces.json，
 * 浏览器不存任何配置。
 *
 * 改动先入队、点「保存」才写盘（ADR 0006）：点控件只把命令放进待保存队列，队列非空时
 * 每一步都拿服务端的 `dryRun` 试算视图来渲染，面板因此不在浏览器里重算一遍求值链。
 *
 * 数据来自本插件的两条路由（read / apply）；模型目录来自宿主的
 * `remote.session.modelCatalog()`，那是唯一能回答「这个模型公布了哪些思考强度」的地方
 * ——不猜、不硬编码。
 *
 * 不引 JSX、不引打包器：宿主用 require('react') 提供 React。工厂必须惰性，
 * 所有订阅与请求都在 apply 里用 ctx.effect 注册并返回清理函数。
 *
 * 一条约定贯穿全文件：**「跟随」是键不存在，不是空值**。
 *   会话路由的 reasoningEffort、pack 的 session、档位本身、工作区绑定，
 *   四处的「跟随」都表现为删键。因此每处都有一个独立的「跟随」入口，
 *   而不是下拉里的一个空选项——空选项会让人以为「选了空 = 跟随」，
 *   实际写下去的是空串，落盘后是坏输入。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-model-pack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

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
    const DEFAULT_PACK_ID = 'default'
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
    const MAX_WORKSPACES = 8

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
    const CHIP_CSS =
      '.dsh-model-pack-chip { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, GrayText); font-weight: 400 }' +
      '.dsh-model-pack-chip[data-bound="true"] { border-color: transparent; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-weight: 500 }' +
      '.dsh-model-pack-chip:hover { background: var(--dsw-alias-interactive-bg-hover) }' +
      '.dsh-model-pack-chip[data-bound="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 6%) }' +
      '.dsh-model-pack-chip:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px }' +
      '@container (max-width: 640px) { .dsh-model-pack-chip-text { display: none } }'

    /**
     * 待保存行的底色。
     *
     * 原先用左侧 `inset` 竖条，真机上它紧贴行首的箭头与文字，`inset` 阴影又没法
     * 给文字让出间距，压字比不标更糟。改成整行浅底：与官方标记「当前项」同一套
     * 做法（pack 行就是浅底），也不会和任何文字抢位置。
     */
    const PENDING_BG =
      'color-mix(in srgb, var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.16)) 55%, transparent)'

    /**
     * 面板按钮与可点行的样式。
     *
     * 尺寸抄官方设置页的行内操作按钮（`ModelsSection.module.css` 的
     * `.rowActions .secondaryButton`）：高 28px、左右 10px、12px 字、`--dsw-radius-sm`。
     * 颜色一律留在类里：内联写 `background` / `color` 会压掉 `:hover`（ui-baseline 红线 7）。
     */
    const PANEL_CSS =
      '.dsh-model-pack-btn { transition: background 120ms ease, border-color 120ms ease, color 120ms ease }' +
      '.dsh-model-pack-btn-secondary { border-color: var(--dsw-alias-border-l1, rgba(127,127,127,0.3)); background: transparent; color: var(--dsw-alias-label-primary, inherit) }' +
      '.dsh-model-pack-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) }' +
      // 确认条上的次要按钮：无边框、浅灰底。照官方弹窗的「取消」——透明底 + 描边在浅色面板上
      // 会读成一条黑框，有底色才显得是按钮而不是一个框。
      '.dsh-model-pack-btn-quiet { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, inherit) }' +
      '.dsh-model-pack-btn-quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)) }' +
      // 主操作：实心。官方弹窗的「保存」就是这个范式（`button-primary-fill` + `label-primary-foreground`）。
      '.dsh-model-pack-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff) }' +
      '.dsh-model-pack-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #33383f) }' +
      '.dsh-model-pack-btn-danger { border-color: transparent; background: transparent; color: var(--dsw-alias-state-error-primary, #c0392b) }' +
      '.dsh-model-pack-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.12)) }' +
      // 确认态照官方的 dangerButton：无边框，只换底色与字重。
      // 官方没有任何"加红描边"的危险按钮，那是我自己发明的，观感上像被框住的一块错误。
      '.dsh-model-pack-btn-danger[data-armed="true"] { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.14)); color: var(--dsw-alias-state-error-primary, #c0392b); font-weight: 500 }' +
      '.dsh-model-pack-btn-danger[data-armed="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.22)) }' +
      '.dsh-model-pack-btn:disabled { opacity: 0.4; cursor: default }' +
      '.dsh-model-pack-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px }' +
      /*
       * 可点行的底色与 hover 全走类。
       *
       * 这几行的底色原本是内联写的（当前项灰底 / 待保存浅蓝），内联会压掉 `:hover`
       * ——红线 7 那条坑。改成 `data-state` 交给 CSS，两种状态与 hover 才能共存。
       */
      '.dsh-model-pack-row { transition: background 120ms ease; cursor: pointer }' +
      '.dsh-model-pack-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)) }' +
      '.dsh-model-pack-row[data-state="current"] { background: rgba(127,127,127,0.16) }' +
      '.dsh-model-pack-row[data-state="pending"] { background: ' + PENDING_BG + ' }'

    /**
     * 设置页的三页，顺序固定：分包 → 工作区 → 提示词。
     *
     * `value` 必须与 `UiState['defaultTab']` 逐字一致：它同时是 `defaultTab` 命令的取值。
     */
    const TABS = [
      { value: 'packs', label: '分包' },
      { value: 'workspace', label: '工作区' },
      { value: 'prompts', label: '提示词' },
    ]

    // ---------- 传输 ----------

    const PATHS = {
      read: '/api/model-pack/read',
      apply: '/api/model-pack/apply',
    }

    /**
     * 两条路由共用一套信封：{ ok: true, data } 或 { ok: false, error }。
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

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token（--dsw-*，不是 --dsh-*），见 docs/ui-baseline.md。
     * 卡片底用 bg-layer-1 而不是 bg-overlay：后者在暗色主题下是中灰浮层，当卡片底会发亮。
     */
    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
    }

    const S = {
      // 设置页的 section 自带滚动容器，面板不自己滚高度。
      root: { fontSize: '13px', color: T.text },
      title: { fontSize: '15px', fontWeight: 600, color: T.text },
      hero: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },

      hint: { color: T.dim, fontSize: '12px', lineHeight: 1.6 },
      mono: { color: T.faint, fontSize: '11px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '14px 0 10px' },
      delta: { padding: '3px 0', fontSize: '12px', color: T.text, lineHeight: 1.6 },
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
      // 分段控件照官方：容器不画整条外框，每个选项是各自独立的小按钮；
      // 选中项用浅底 + 更亮的文字，而不是整块品牌色——官方设置页就是这个观感。
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
      // 自绘下拉。原生 <select> 的弹出层由系统绘制，不跟主题：暗色下一点开是一块
      // 蓝底浮层，与官方设置页的语言选择器完全不是一个观感。
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
      rowFirst: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px',
        borderBottom: '1px solid ' + T.border,
      },
      rowMain: { flex: '1 1 auto', minWidth: 0 },
      rowName: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', color: T.text, fontWeight: 600 },
      rowMeta: { color: T.dim, fontSize: '12px', marginTop: '3px', lineHeight: 1.5 },
      field: { padding: '6px 0 10px', borderTop: '1px solid ' + T.border },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', marginTop: '8px' },
      fieldRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '4px 10px' },
      fieldLabel: { color: T.dim, fontSize: '11px', minWidth: '64px' },
      fallbackRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', padding: '4px 10px 4px 22px' },
      disabledSection: { opacity: 0.5, pointerEvents: 'none', userSelect: 'none' },
      /**
       * 行内操作按钮的尺寸与排布。颜色、hover、危险态全部在 `PANEL_CSS` 里——
       * 内联写 `background` / `color` 会压掉 CSS 的 `:hover`（ui-baseline 红线 7）。
       * 尺寸对齐官方设置页行内按钮：高 28px、左右 10px、12px 字、radius-sm。
       */
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 10px',
        borderWidth: '.5px',
        borderStyle: 'solid',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      /**
       * 底部停靠区：提示行 + 待保存条。贴住面板底边，内容再长也一直看得见。
       * 分隔线只在停靠区顶沿画一条，内部两行之间不再加线。
       */
      dock: {
        position: 'sticky',
        bottom: 0,
        zIndex: 20,
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      },
      /** 提示行：警告色浅底，右侧一个关闭。 */
      noticeBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(245,158,11,0.14))',
      },
      /** 待保存条：不贴边，位置由 `dock` 决定。 */
      pendingBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 12px',
      },
      /** 弹层里的同一条：不贴边、不画分隔线，交给外层的 `bottomBar`。 */
      pendingInline: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '1 1 auto',
        minWidth: 0,
      },
      /**
       * 弹层的底栏：左「关闭」右「待保存 + 撤销/保存」。
       * 「关闭」位置固定在最左：它一会儿在左一会儿在右，只会让人重新找一次按钮。
       */
      bottomBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '14px',
        paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      },
      /**
       * 吸顶的区块标题。
       *
       * 分包页的内容区有几百行，滚到中段时「档位」「工作区绑定」早就滚出视口了，
       * 而这一块每一行都在往同一个对象里写决定。标题跟着滚走等于让人盲改。
       * `top: 0` 相对最近的滚动祖先（宿主的设置弹层内容区）；要是宿主自己也吸顶，
       * 这里会被压住——那就只能退回不吸顶，别硬加偏移量去猜。
       */
      blockTitleSticky: {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        padding: '6px 0',
        marginBottom: '6px',
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        fontSize: '12px',
        fontWeight: 600,
        color: T.text,
      },
      /**
       * 裸文字按钮（行内图标、折叠箭头）。
       *
       * 热区按 24px 起：原来只有字号那么高，指针要精确压住才点得中——这类控件
       * 是整类的问题，不只改被指出来的那一个。
       */
      reset: {
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        color: T.dim,
        fontSize: '12px',
        padding: '2px 4px',
        minHeight: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
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
      block: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid ' + T.border },
      packRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid ' + T.border,
        marginBottom: '6px',
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
      path: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: T.dim, wordBreak: 'break-all' },
      /**
       * chip 的尺寸与排布。颜色、字重、hover、focus 全部在 `CHIP_CSS` 里。
       *
       * 尺寸对齐官方输入框右侧控件（ModelSelect trigger / PlanChip）：高 28px、
       * 字号 13px、圆角 `--dsw-radius-sm`（8px）。两态尺寸必须一致，否则绑定与
       * 解绑时 chip 会横向跳动。
       *
       * 颜色为什么不在内联里：内联 style 的优先级压过任何类选择器，写了
       * `background` 之后 `:hover` 就永远不会生效。内联只留布局，颜色交给
       * 类选择器，hover 才有机会盖上去。
       */
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        maxWidth: '140px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      },
      /**
       * 文字要能缩：`text-overflow` 在内联的 button 上不生效，
       * 必须落在真正被裁的那个 flex item 上，且 `min-width: 0` 才肯缩。
       */
      chipText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
        // 下拉浮层要溢出弹层边缘，裁切会把它切掉一半；内容长了由内层自己滚。
        overflow: 'visible',
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
     * 面板要标「绑定失效」就必须看原始值，否则悬空与未绑定长得一样。
     */
    function bindingOf(data) {
      const id = data && data.state ? data.state.binding : null
      if (typeof id !== 'string' || id === '') return null
      // 绑到 default 与服务端求值同义（bind 命令会把它归一成删键）：按未绑定处理。
      return id === DEFAULT_PACK_ID ? null : id
    }


    function packNameOf(data, id) {
      if (!id) return ''
      // default 的显示名固定：文件里可能是旧名（default / 出厂方案），界面统一成「默认」。
      if (id === DEFAULT_PACK_ID) return DEFAULT_PACK_NAME
      const pack = packsOf(data)[id]
      if (isRecord(pack) && typeof pack.name === 'string' && pack.name !== '') return pack.name
      return id + '（已删除）'
    }

    /**
     * 名册列表：`default` 排第一，其余按 id 排序。
     *
     * `frozenOrder` 是改动前那份视图的 id 序：待保存期间按它排，名册就不会因为刚落下的
     * 一条命令而重排。凭「改动前的排序键」而不是数组下标——新建的 pack 会插进数组，
     * 下标一挪就重排，而 id 是不变的键。
     *
     * `isDefault` 只标 `default` 那一张——它是求值链终点，不是「当前生效的那张」。
     * 服务端保证 `default` 一定存在（`parsePacks` 会补），这里不做兜底造行：
     * 真缺了就该显示成缺了，而不是画一个磁盘上不存在的 pack。
     */
    function packListOf(data, frozenOrder) {
      const packs = packsOf(data)
      const ids = Object.keys(packs)
      if (Array.isArray(frozenOrder) && frozenOrder.length > 0) {
        const rank = new Map()
        frozenOrder.forEach((id, index) => rank.set(id, index))
        ids.sort((a, b) => {
          const left = rank.has(a) ? rank.get(a) : frozenOrder.length
          const right = rank.has(b) ? rank.get(b) : frozenOrder.length
          return left === right ? String(a).localeCompare(String(b)) : left - right
        })
      } else {
        ids.sort()
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

    // ---------- 数据 ----------

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

    /** 工作区键归一。只用它给列表去重，发出去的 cwd 保持原样。 */
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

    /**
     * 已知工作区：从会话列表里取 cwd，去重、按最近更新排序。
     *
     * 这是「当前工作区」的唯一来源——插件页是全局页面，没有会话上下文；
     * 最近更新的根会话所在目录就是用户正在看的那一个。
     * 拿不到会话时返回空列表：面板仍能编辑 pack，只是不能绑定。
     */
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
      // 不在这里截断：工作区页要能管理全部绑定，截断只属于模型位缓存那一处。
      const cwds = []
      if (pinned !== null) cwds.push(pinned)
      for (const item of roots) {
        if (cwds.indexOf(item.cwd) < 0) cwds.push(item.cwd)
      }
      return { currentCwd: cwds.length > 0 ? cwds[0] : null, cwds: cwds }
    }

    /**
     * 读面板数据：一次 read 就够。
     *
     * 绑定表（`state.bindings`）与 cwd 无关——它读的是同一份 workspaces.json，
     * 一次 read 就带回全部工作区的绑定。cwd 只决定 `state.binding` /
     * `state.packId` / `resolved` 算哪一条，所以传当前会话的目录。
     *
     * 旧契约下每个目录要各 read 一次才能拼出绑定表，那是服务端没有绑定表时的权宜；
     * 现在多读只会多几次请求，还会让「当前工作区」与列表里的行对不上。
     */
    async function loadPanel(host) {
      const listing = await listWorkspaces(host, env.sessionId)
      const data = await api.read(listing.currentCwd)
      return { data: data, currentCwd: listing.currentCwd, cwds: listing.cwds }
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
        currentCwd: null,
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
            setState({ phase: 'ready', data: loaded.data, currentCwd: loaded.currentCwd, cwds: loaded.cwds, error: null })
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
       * body 的 cwd 恒取当前工作区：命令自带 cwd（bind），
       * 这个 cwd 只决定回读哪一条绑定——不带的话返回的 `state.binding` 是 null，
       * 界面会闪一下「未绑定」。
       */
      const run = useCallback(
        async (commands) => {
          try {
            const data = await api.apply(state.currentCwd, commands)
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
                  command.op === 'createPack',
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
        [host, state.currentCwd],
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

    function Chevron(props) {
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
          h(Chevron, { open: open }),
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
    function Button(props) {
      const variant = props.variant || (props.danger === true ? 'danger' : 'secondary')
      const className = 'dsh-model-pack-btn dsh-model-pack-btn-' + variant
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled === true,
          className: className,
          style: { ...S.btn, ...(props.style || {}) },
          title: props.title || '',
          ref: props.innerRef,
          'data-armed': variant === 'danger' && props.armed === true ? 'true' : undefined,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /**
     * 删除的二次确认：第一次点变成「确认」，再点一次才执行。
     *
     * 不用弹窗：这类删除都发生在列表行里，弹窗要额外一次「关闭」动作；
     * 行内二次确认把成本压到一次点击，误点的代价只是多看一眼。
     * 进入确认态后 4 秒自动撤销，点别处也撤销，避免一直停在危险状态。
     *
     * 删除是唯一「点了就没了」的动作（不进待保存队列，见 ADR 0006），
     * 所以确认态必须比常态明显：文案换成「确认」、浅红底、字重加重。
     */
    function ConfirmButton(props) {
      const [armed, setArmed] = useState(false)
      const boxRef = useRef(null)
      const disabled = props.disabled === true
      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [armed])
      useEffect(() => {
        if (!armed) return undefined
        const onDown = (event) => {
          const node = boxRef.current
          if (node && node.contains(event.target)) return
          setArmed(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [armed])
      return h(
        Button,
        {
          danger: true,
          armed: armed,
          disabled: disabled,
          innerRef: boxRef,
          style: props.style,
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
        armed ? props.confirmLabel || '确认' : props.label || '删除',
      )
    }

    /**
     * 面板内输入框的 Esc 只作用于输入框自己，不冒泡。
     *
     * 宿主的设置弹层把 Esc 当「关闭面板」：改名途中按 Esc 想反悔，
     * 结果整个面板关掉，改了一半的名字也一起没了。
     */
    function stopEscape(event) {
      if (event.key === 'Escape') event.stopPropagation()
    }

    /**
     * 文本输入：改动先留在输入框里，失焦、回车或 Esc 时才交给调用方。
     *
     * 不逐字入队：每次入队都会发一次 `dryRun`，逐字就是每个键一次往返，光标会跟着
     * 服务端的回显跳。输入框因此自己持有一份缓冲，未聚焦时始终显示外部值。
     */
    function TextField(props) {
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
          return 'bind:' + command.cwd
        default:
          // 新建与提示词补丁没有可覆盖的目标：前者每条都是独立一次决定，
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
    function usePending(options) {
      const [entries, setEntries] = useState([])
      const [preview, setPreview] = useState({ data: null, loading: false, error: null })
      const seq = useRef(0)
      const uid = useRef(0)
      const latest = useRef(options)
      latest.current = options
      /*
       * 队列的实时快照，**由每个变更函数同步维护**。
       *
       * 不能只在渲染期赋值：`commit` / `drop` 是在事件回调里同步调用的，那时还没重渲染，
       * 读到的是上一次渲染的队列。输入框的失焦发生在点击之前——先 push 再点「保存」时，
       * 那个点击处理拿到的是旧队列，最后一段刚提交的文字就会掉。
       */
      const entriesRef = useRef(entries)

      useEffect(() => {
        if (entries.length === 0) {
          // 队列空了就让上一次在途的试算作废，避免它的响应把视图改回「有改动」。
          seq.current += 1
          setPreview({ data: null, loading: false, error: null })
          return
        }
        const mine = (seq.current += 1)
        setPreview((prev) => ({ data: prev.data, loading: true, error: null }))
        latest.current.preview(entries.map((entry) => entry.command)).then(
          (data) => {
            if (mine === seq.current) setPreview({ data: data, loading: false, error: null })
          },
          (error) => {
            if (mine === seq.current) {
              setPreview((prev) => ({ data: prev.data, loading: false, error: String(error.message || error) }))
            }
          },
        )
      }, [entries])

      /** 同步写入快照并交给 React：两处永远是同一份。 */
      const apply = useCallback((next) => {
        entriesRef.current = next
        setEntries(next)
        return next
      }, [])

      const push = useCallback(
        (commands) => {
          const list = Array.isArray(commands) ? commands : [commands]
          const next = entriesRef.current.slice()
          for (const command of list) {
            const key = pendingKey(command)
            if (key !== null) {
              for (let index = next.length - 1; index >= 0; index -= 1) {
                if (next[index].key === key) next.splice(index, 1)
              }
            }
            uid.current += 1
            next.push({ id: uid.current, key: key, command: command })
          }
          apply(next)
        },
        [apply],
      )

      const undo = useCallback(() => {
        apply(entriesRef.current.slice(0, -1))
      }, [apply])

      const discard = useCallback(() => {
        apply([])
      }, [apply])

      /**
       * 强制让那份试算重算一次。
       *
       * 删除走另一条写盘路径：队列里的命令原封不动时 `entries` 不变、effect 不会重跑，
       * 被删掉的 pack 就会一直留在按试算视图渲染的面板上。删除后必须踢一脚。
       */
      const refresh = useCallback(() => {
        apply(entriesRef.current.slice())
      }, [apply])

      /**
       * 丢弃过时的试算结果。
       *
       * 写盘会换掉 base，而手里的试算视图是基于**旧** base 算的：被删掉的对象会
       * 多留在屏幕上一次往返的时间，看起来就是「删了没反应，过一会儿才消失」。
       * 写盘之后先丢掉它，面板立刻回落到新的真实视图，紧接着再按新 base 重算。
       */
      const resetPreview = useCallback(() => {
        seq.current += 1
        setPreview({ data: null, loading: false, error: null })
      }, [])

      /**
       * 丢掉命中 predicate 的命令，返回丢掉了几条。
       *
       * 删除是当场写盘的，队列里引用被删对象的命令（改它的名、给它设开关、
       * 绑到它）在删除之后都落不了地，留着只会在保存时报错。
       */
      const drop = useCallback(
        (predicate) => {
          const victims = entriesRef.current.filter((entry) => predicate(entry.command))
          if (victims.length === 0) return 0
          apply(entriesRef.current.filter((entry) => !predicate(entry.command)))
          return victims.length
        },
        [apply],
      )

      const commit = useCallback(async () => {
        const commands = entriesRef.current.map((entry) => entry.command)
        if (commands.length === 0) return true
        try {
          const data = await latest.current.apply(commands)
          apply([])
          latest.current.onApplied(data)
          return true
        } catch (error) {
          setPreview((prev) => ({ ...prev, error: String(error.message || error) }))
          return false
        }
      }, [apply])

      /** 被改动命中的键，供行渲染标出「这一行还没保存」。 */
      const keys = useMemo(() => {
        const set = new Set()
        for (const entry of entries) if (entry.key !== null) set.add(entry.key)
        return set
      }, [entries])

      return {
        entries: entries,
        keys: keys,
        preview: preview,
        push: push,
        undo: undo,
        discard: discard,
        drop: drop,
        refresh: refresh,
      resetPreview: resetPreview,
        commit: commit,
        count: entries.length,
      }
    }

    /** 停靠区上方那一行提示：说清楚发生了什么，给一个关掉它的入口。 */
    function NoticeBar(props) {
      return h(
        'div',
        { style: S.noticeBar },
        h(
          'span',
          {
            style: {
              ...S.hint,
              flex: '1 1 auto',
              minWidth: 0,
              color: 'var(--dsw-alias-state-warn-label, #b7791f)',
            },
          },
          props.text,
        ),
        h(Button, { variant: 'quiet', onClick: props.onClose, title: '关闭提示' }, '关闭'),
      )
    }

    /** 底部待保存条：左计数与错误，右「撤销 / 放弃全部 / 保存」。 */
    function PendingBar(props) {
      if (props.count === 0) return null
      const busy = props.busy === true
      // 设置页里贴住底边（内容很长，要一直看得见）；弹层里不贴，由外层底栏排布。
      const inline = props.inline === true
      const style = inline ? S.pendingInline : S.pendingBar
      return h(
        'div',
        { style: style },
        // 弹层里「关闭」占住最左，这里先把空位弹开，让文字与按钮一起靠右。
        inline ? h('span', { key: 'spacer', style: { flex: '1 1 auto' } }) : null,
        h(
          'span',
          {
            style: { ...S.hint, flex: inline ? '0 0 auto' : '1 1 auto', color: props.error ? T.error : undefined },
          },
          props.error ? '未保存：' + props.error : '已改 ' + props.count + ' 项，尚未保存',
        ),
        h(Button, { variant: 'quiet', onClick: props.onUndo, disabled: busy }, '撤销'),
        // 只有一项时「撤销」与「放弃全部」做的是同一件事，多一个按钮只是多一次选择。
        props.count > 1
          ? h(Button, { variant: 'quiet', onClick: props.onDiscard, disabled: busy }, '放弃全部')
          : null,
        h(Button, { variant: 'primary', onClick: props.onCommit, disabled: busy }, busy ? '保存中…' : '保存'),
      )
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
      // 父级 opacity 补回来，所以这里把透明度下发给 Picker，由它只装饰触发器。
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
            h(Picker, {
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
              ? h(Picker, {
                  value: effort,
                  disabled: disabled,
                  dim: dim,
                  // 必须显式压小：Picker 根节点默认 minWidth 120px，套在窄容器里
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
              ? h(TextField, {
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
              : h(TextField, {
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
            h(TextField, {
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
            h(TextField, {
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
              h(TextField, {
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
                    h(TextField, {
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
              const dirty = key !== null && pending.keys.has('bind:' + key)
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
                  h(Picker, {
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
      /** 刚新建、等着展开的那张 pack 的名字（id 由服务端生成，只能在试算视图里反查）。 */
      const wanted = useRef(null)

      const preview = useCallback((commands) => api.apply(state.currentCwd, commands, true), [state.currentCwd])
      const apply = useCallback((commands) => api.apply(state.currentCwd, commands), [state.currentCwd])
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
       * 绑定列表：会话来的目录在前，绑定表里多出来的目录在后，按归一化键去重。
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
        return list
      }, [state.cwds, bindings.bindings])

      /**
       * 新建后展开新出现的那一张。
       *
       * `createPack` 只带名字，id 由服务端生成（`p1`、`p2`…）。试算视图里多出来的就是
       * 它；拿不到就保持原样，不猜一个 id 出来。
       */
      useEffect(() => {
        if (wanted.current === null) return
        const found = Object.keys(packsOf(data)).find((id) => {
          const pack = packsOf(data)[id]
          return isRecord(pack) && pack.name === wanted.current && !isRecord(packsOf(base)[id])
        })
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
        wanted.current = trimmed
        enqueue([{ op: 'createPack', name: trimmed }])
      }

      /**
       * 删除：当场写盘。
       *
       * 队列里引用这张 pack 的命令（改名、会话路由、任一档、绑定）先剔掉再写，
       * 丢掉几条要说出来——无声丢改动比丢改动本身更糟。
       */
      const deletePack = (packId, name) => {
        const removed = pending.drop((command) => command.packId === packId)
        if (expanded === packId) setExpanded(null)
        setNotice(removed > 0 ? '已删除「' + name + '」，并丢弃对它的 ' + removed + ' 项未保存改动' : null)
        void run([{ op: 'deletePack', packId: packId }]).then(() => {
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
            h(Picker, {
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
            if (cwds.indexOf(item.cwd) < 0 && cwds.length < MAX_WORKSPACES) cwds.push(item.cwd)
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
      // 外面包一层 try：万一宿主不在渲染期调用这个 slot，hook 会抛 Invalid hook call。
      // 那时退回「只有整页刷新才更新」，与修复前一致——绝不能让异常泄给宿主，
      // 那样官方触发按钮会退回默认文字。
      try {
        if (typeof useSyncExternalStore === 'function') {
          useSyncExternalStore(labelVersion.subscribe, labelVersion.read, labelVersion.read)
        }
      } catch {
        // 见上。
      }
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

    /**
     * 跨组件共享的界面状态。
     *
     * chip 在会话页、设置页在设置弹层里，两者在 React 上没有父子关系；绑定改了要让
     * chip 上的名字跟着变，只能靠一个可订阅的值。
     */
    const env = { sessionId: undefined }
    /** chip 上显示的 pack 名；null = 未绑定。 */
    const chipName = createSignal(null)
    /**
     * 未绑定 pack 时 chip 上的字。
     *
     * 固定英文小写、三字母、去元音（skill→skl、plugin→plg、model→mdl；mcp 本就是
     * 念字母的专名，恰好同形）。不随宿主语言：这四个是领域标识符，不是句子，
     * 中文界面下缩写比中文译名更准，四个 chip 也等长。全名留在 title 里。
     */
    const CHIP_LABEL = 'mdl'
    /** 摘要弹层的开合。chip 与弹层分处两个槽位，只能靠它对齐。 */
    const chipOpen = createSignal(false)

    /** chip 上的名字：绑到哪张 pack 就显示哪个，未绑定是 null（由 `CHIP_LABEL` 补字）。 */
    function refreshChipName(host, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        chipName.set(null)
        return
      }
      listWorkspaces(host, sessionId).then(
        (listing) => {
          const cwd = listing.currentCwd
          if (cwd === null) {
            chipName.set(null)
            return
          }
          api.read(cwd).then(
            (data) => {
              // 悬空绑定（pack 已删）按「默认」显示：服务端求值链已经回落，
              // chip 上写「xxx（已删除）」只会让人以为还在用它。
              const id = bindingOf(data)
              const known = id !== null && isRecord(packsOf(data)[id])
              chipName.set(known ? packNameOf(data, id) : null)
            },
            () => {
              // 读不到就退回默认：chip 本身不能因此消失。
              chipName.set(null)
            },
          )
        },
        () => chipName.set(null),
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
        env.sessionId = sessionId
        const name = useSyncExternalStore(chipName.subscribe, chipName.read, chipName.read)
        const open = useSyncExternalStore(chipOpen.subscribe, chipOpen.read, chipOpen.read)
        useEffect(() => {
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
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: PANEL_ID, order: 63, label: () => TITLE },
          SettingsSection,
        ),
      )

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
  },
})
