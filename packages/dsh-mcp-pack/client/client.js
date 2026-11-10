/**
 * 浏览器半边。手写单文件：宿主用 `require('react')` 提供 React，
 * 因此不引入 JSX、CSS Modules 或打包器，避免给这个仓库加第二套构建链。
 *
 * 结构照抄 `dsh-plugin-pack`：设置页三页（分组 | 分包 | 工作区），chip 是当前工作区
 * 绑定 pack 的摘要与切换入口。本包的差异集中在「分包」页：
 *
 *   1. 一行不是一个布尔，而是一组字段（enabled / mode / tools / description），
 *      所以行默认折叠，展开后才出现四个字段的编辑器；
 *   2. 组级只决定开合，不设 mode——「组说 dynamic、行说 disabled」的合并规则没有
 *      廉价答案，四个字段只留在行级。
 *
 * 求值链全部在服务端；这里只负责把 pack 的决定读出来、画出来、按命令写回去：
 *
 *   pack.rows[行][字段] ?? pack.groups[组] ?? default.rows[行][字段] ?? 内置默认
 *
 * 「跟随」与「写了个同值」是两件事：跟随看的是 pack 里有没有这条键，不是值比没比平。
 * 回到跟随的写法是给 `packRow` 的那一个字段发 `null`。
 */
window.__ModuleLoader__.load({
  id: '@dreanzy/dsh-mcp-pack',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PANEL_ID = 'mcp-pack'
    const CHIP_ID = 'mcp-pack-chip'
    const MODAL_ID = 'mcp-pack-chip-modal'
    const TITLE = 'MCP Pack'
    /** 内置 pack 的 id。未绑定的工作区按它求值。 */
    const DEFAULT_PACK_ID = 'default'
    /** 工作区清单上限：会话一多，绑定表会变成一堵墙。 */
    const MAX_WORKSPACES = 30

    /** 三档加载方式。取值与服务端 `types.ts` 的 `MODES` 一致，顺序即 UI 顺序。 */
    const MODES = ['eager', 'dynamic', 'lazy']
    const MODE_LABELS = { eager: '全部加载', dynamic: '动态插入', lazy: '延迟加载' }
    const DEFAULT_MODE = 'dynamic'

    /** 三档的一句话说明。分包页常驻，用户不必猜这三项的差别。 */
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
      '.dsh-mcp-pack-chip { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, GrayText); font-weight: 400 }' +
      '.dsh-mcp-pack-chip[data-bound="true"] { border-color: transparent; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-weight: 500 }' +
      '.dsh-mcp-pack-chip:hover { background: var(--dsw-alias-interactive-bg-hover) }' +
      '.dsh-mcp-pack-chip[data-bound="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 6%) }' +
      '.dsh-mcp-pack-chip:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px }' +
      '@container (max-width: 640px) { .dsh-mcp-pack-chip-text { display: none } }'

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
     * 面板按钮与待保存标记的样式。
     *
     * 尺寸抄官方设置页的行内操作按钮（`ModelsSection.module.css` 的
     * `.rowActions .secondaryButton`）：高 28px、左右 10px、12px 字、`--dsw-radius-sm`。
     * 颜色一律留在类里：内联写 `background` / `color` 会压掉 `:hover`（ui-baseline 红线 7）。
     *
     * 删除确认态抄官方的危险按钮：浅红底 + 红字，hover 用
     * `--dsw-alias-interactive-bg-hover-danger`。官方二次确认是弹窗，这里压成行内两段，
     * 所以只换底色与字重、不加描边；加重靠底色，靠描边会像被框住的一块错误。
     */
    const PANEL_CSS =
      '.dsh-mcp-pack-btn { transition: background 120ms ease, border-color 120ms ease, color 120ms ease }' +
      '.dsh-mcp-pack-btn-secondary { border-color: var(--dsw-alias-border-l1, rgba(127,127,127,0.3)); background: transparent; color: var(--dsw-alias-label-primary, inherit) }' +
      '.dsh-mcp-pack-btn-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) }' +
      // 确认条上的次要按钮：无边框、浅灰底。照官方弹窗的「取消」——透明底 + 描边在浅色面板上
      // 会读成一条黑框，有底色才显得是按钮而不是一个框。
      '.dsh-mcp-pack-btn-quiet { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, inherit) }' +
      '.dsh-mcp-pack-btn-quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)) }' +
      // 主操作：实心。官方弹窗的「保存」就是这个范式（`button-primary-fill` + `label-primary-foreground`）。
      '.dsh-mcp-pack-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff) }' +
      '.dsh-mcp-pack-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #33383f) }' +
      '.dsh-mcp-pack-btn-danger { border-color: transparent; background: transparent; color: var(--dsw-alias-state-error-primary, #c0392b) }' +
      '.dsh-mcp-pack-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.12)) }' +
      // 确认态照官方的 dangerButton：无边框，只换底色与字重。
      // 官方没有任何"加红描边"的危险按钮，那是我自己发明的，观感上像被框住的一块错误。
      '.dsh-mcp-pack-btn-danger[data-armed="true"] { border-color: transparent; background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.14)); color: var(--dsw-alias-state-error-primary, #c0392b); font-weight: 500 }' +
      '.dsh-mcp-pack-btn-danger[data-armed="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,0.22)) }' +
      '.dsh-mcp-pack-btn:disabled { opacity: 0.4; cursor: default }' +
      '.dsh-mcp-pack-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px }' +
      /*
       * 可点行的底色与 hover 全走类。
       *
       * 这几行的底色原本是内联写的（当前项灰底 / 待保存浅蓝），内联会压掉 `:hover`
       * ——红线 7 那条坑。改成 `data-state` 交给 CSS，两种状态与 hover 才能共存。
       */
      '.dsh-mcp-pack-row { transition: background 120ms ease; cursor: pointer }' +
      '.dsh-mcp-pack-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)) }' +
      '.dsh-mcp-pack-row[data-state="current"] { background: rgba(127,127,127,0.16) }' +
      '.dsh-mcp-pack-row[data-state="pending"] { background: ' + PENDING_BG + ' }'

    // ---------- 传输 ----------

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

    // ---------- 样式 ----------

    /**
     * 颜色一律取宿主主题 token。
     *
     * 宿主的真实前缀是 `--dsw-`（不是 `--dsh-`），且全部 token 都要求浅色与深色两套取值，
     * 底色用 `--dsw-alias-bg-layer-1`，不用 `--dsw-alias-bg-overlay`：后者在暗色主题下
     * 绑定的是 neutral-bluish-700（中灰），弹窗会比页面亮一大截；它的语义是「半透明
     * 浮层」，本来也不该当卡片底。layer-1 与页面同色，界线交给边框与阴影。
     */
    const T = {
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      surface: 'var(--dsw-alias-bg-layer-1, Canvas)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.55))',
      // 不用 --dsw-alias-state-idle-primary：暗色主题下它解析成接近白色，
      // 与白色圆点叠成一条纯白胶囊，开/关完全看不出来。这里用固定的半透明灰，
      // 再给轨道加一圈内描边，暗色与亮色下都有轮廓。
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b7791f)',
      /*
       * 开关配色照官方「反色」风格：开态轨道取前景色（暗色主题下是亮白），圆点取底色
       * （近黑）；关态轨道是中灰、圆点是浅圆点。反色在亮暗两套主题里都成立，
       * 也不依赖品牌色——品牌色在主题里存在与否不确定，撞色时开关就废了。
       */
      track: 'var(--dsw-alias-label-primary, #e6e6e6)',
      trackOff: 'rgba(127, 127, 127, 0.30)',
      knob: 'var(--dsw-alias-bg-layer-1, #111111)',
      knobOff: 'rgba(255, 255, 255, 0.92)',
      /*
       * 待保存行的底色。
       *
       * 原先用左侧 `inset` 竖条，真机上它紧贴行首的箭头与文字，`inset` 阴影又没法
       * 给文字让出间距，压字比不标更糟。改成整行浅底：与官方标记「当前项」同一套
       * 做法（pack 行就是浅底），也不会和任何文字抢位置。
       */
      pendingBg: PENDING_BG,
    }

    const S = {
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
      // 分段控件照官方：容器不画整条外框，每个选项是各自独立的小按钮；
      // 选中项用浅底 + 更亮的文字，而不是整块品牌色——官方设置页就是这个观感，
      // 品牌色实心块在暗色主题下会盖掉周围所有信息。
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
      stat: {
        fontSize: '12px',
        color: T.text,
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid ' + T.border,
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
      rowName: {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: T.text,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        // server 名是开关的键，必须完整显示：own:x 与 global:x 同名的场景真实存在，
        // 短名会让人分不清关的是哪一个。长名允许折行，不做省略号。
        wordBreak: 'break-all',
      },
      rowDesc: { color: T.dim, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { color: T.dim, fontSize: '11px', marginTop: '2px' },
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
      sw: (on, disabled) => ({
        width: '36px',
        height: '20px',
        borderRadius: '999px',
        border: 0,
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: on ? T.track : T.trackOff,
        position: 'relative',
        flex: '0 0 auto',
        transition: 'background 140ms ease',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: on ? T.knob : T.knobOff,
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
        transition: 'left 140ms ease, background 140ms ease',
      }),
      /*
       * 自绘下拉。原生 <select> 的弹出层由系统绘制，不跟主题：暗色下一点开是一块
       * 蓝底浮层，与官方设置页的语言选择器完全不是一个观感。这里改成按钮 + 浮层。
       */
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
      error: { color: T.error, fontSize: '12px', marginTop: '8px' },
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
      /**
       * 吸顶的区块标题。
       *
       * 分包页第二块有几百行，滚到中段时「包内开关：哪张 pack」早就滚出视口了，
       * 而这一块每一行都在往这张 pack 里写决定。标题跟着滚走等于让人盲改。
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
      block: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid ' + T.border },
      blockTitle: { fontSize: '12px', fontWeight: 600, color: T.text, marginBottom: '6px' },
      packRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        border: '1px solid ' + T.border,
        marginBottom: '6px',
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
      settingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid ' + T.border,
      },
      /** 分包页的一行：行头常驻，点开才出现四个字段的编辑器。 */
      lineHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 4px',
        borderTop: '1px solid ' + T.border,
        cursor: 'pointer',
      },
      lineBody: { display: 'grid', gap: '8px', padding: '2px 4px 10px 22px' },
      field: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      fieldLabel: { flex: '0 0 84px', color: T.dim, fontSize: '12px' },
      mono: { fontFamily: 'ui-monospace, monospace' },
      toolInput: {
        flex: '1 1 320px',
        minWidth: '180px',
        padding: '5px 8px',
        border: '1px solid ' + T.border,
        borderRadius: '6px',
        background: 'transparent',
        color: T.text,
        fontSize: '12px',
      },
    }

    /**
     * 面板按钮。颜色全部在 `PANEL_CSS` 里，这里只给尺寸与语义。
     *
     * 尺寸抄官方设置页的行内操作按钮（28px 高、左右 10px、12px 字、radius-sm），
     * 比原来的裸文字热区大一倍以上——裸文字只有字号那么高，指针要精确压住才点得中。
     */
    function Button(props) {
      const variant = props.variant || (props.danger === true ? 'danger' : 'secondary')
      const className = 'dsh-mcp-pack-btn dsh-mcp-pack-btn-' + variant
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
     * 删除的二次确认：第一次点变成「确认」（浅红底 + 红字），再点一次才执行。
     *
     * 不用弹窗：这类删除都发生在列表行里，弹窗要额外一次「关闭」动作；
     * 行内二次确认把成本压到一次点击，误点的代价只是多看一眼。
     * 进入确认态后 4 秒自动撤销，点别处也撤销，避免一直停在危险状态。
     *
     * 删除是唯一「点了就没了」的动作（不进待保存队列），
     * 所以确认态必须比常态明显：文案换成「确认」、红字、浅红底。
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

    /** 每条命令命中哪一格状态。同键后写覆盖，队列里永远只有最后一次取值。 */
    /**
     * 待保存期间的组名回溯表：组 id → 改动前的名字。
     *
     * 冻结的是「排序键」，不是视图。组 id 与行键都不变，只有分组名要回溯——否则改完名
     * 的那一组会立刻跳到新位置，下一次点击就落在别的组上。也不能用 `base` 的数组位置
     * 当序：列表平时按名字排，两者顺序本来就不同，那样一进待保存状态反而会重排一次。
     *
     * `frozen` 为 false 时返回空表，调用方按当前名字排即可。
     */
    function frozenGroupNames(base, frozen) {
      const map = new Map()
      if (!frozen) return map
      const groups = base && base.groups && Array.isArray(base.groups.groups) ? base.groups.groups : []
      for (const group of groups) {
        if (group && typeof group.id === 'string') map.set(group.id, group.name)
      }
      return map
    }

    function pendingKey(command) {
      switch (command.op) {
        case 'packRow':
          return 'packRow:' + command.packId + ':' + command.rowKey
        case 'packGroup':
          return 'packGroup:' + command.packId + ':' + command.groupId
        case 'bind':
          return 'bind:' + command.cwd
        case 'assign':
          return 'assign:' + command.rowKey
        case 'renamePack':
          return 'renamePack:' + command.packId
        case 'renameGroup':
          return 'renameGroup:' + command.groupId
        default:
          // 新建与删除没有可覆盖的目标：每条都是独立一次决定。
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
    function createQueue(keyOf) {
      let entries = []
      let uid = 0

      const set = (next) => {
        entries = next
        return next
      }

      return {
        get entries() {
          return entries
        },
        get count() {
          return entries.length
        },
        /** 被改动命中的键，供行渲染标出「这一行还没保存」。 */
        keys() {
          const set = new Set()
          for (const entry of entries) if (entry.key !== null) set.add(entry.key)
          return set
        },
        commands() {
          return entries.map((entry) => entry.command)
        },
        push(commands) {
          const list = Array.isArray(commands) ? commands : [commands]
          const next = entries.slice()
          for (const command of list) {
            const key = keyOf(command)
            if (key !== null) {
              for (let index = next.length - 1; index >= 0; index -= 1) {
                if (next[index].key === key) next.splice(index, 1)
              }
            }
            uid += 1
            next.push({ id: uid, key: key, command: command })
          }
          return set(next)
        },
        undo() {
          return set(entries.slice(0, -1))
        },
        discard() {
          return set([])
        },
        /** 换一个新引用但内容不变：删除是另一条写盘路径，队列没变也要重算一次试算。 */
        touch() {
          return set(entries.slice())
        },
        /** 丢掉命中 predicate 的命令，返回丢掉的条数。 */
        drop(predicate) {
          const victims = entries.filter((entry) => predicate(entry.command))
          if (victims.length === 0) return 0
          set(entries.filter((entry) => !predicate(entry.command)))
          return victims.length
        },
      }
    }

    /**
     * 待保存改动。
     *
     * 点一下只入队，不发写请求；队列非空时每次变化都用 `dryRun` 试算一次，
     * 拿服务端算好的视图来渲染——浏览器不复制求值链。
     * 点「保存」才把整批命令写盘。
     *
     * 队列活在这一次挂载里：关闭面板即丢。跨面板保留会被「我到底存了没」拖住，
     * 而用户关掉面板再回来时通常已经不记得点过什么了。
     *
     * 这里只剩两件需要 React 的事：试算的世代号与提交。队列规则全在 `createQueue`，
     * 因此可以脱离渲染直接测。
     */
    function usePending(options) {
      const queueRef = useRef(null)
      if (queueRef.current === null) queueRef.current = createQueue(pendingKey)
      const queue = queueRef.current
      const [entries, setEntries] = useState(queue.entries)
      const [preview, setPreview] = useState({ data: null, loading: false, error: null })
      const seq = useRef(0)
      const latest = useRef(options)
      latest.current = options

      useEffect(() => {
        if (entries.length === 0) {
          // 队列空了就让上一次在途的试算作废，避免它的响应把视图改回「有改动」。
          seq.current += 1
          setPreview({ data: null, loading: false, error: null })
          return
        }
        const mine = (seq.current += 1)
        setPreview((prev) => ({ data: prev.data, loading: true, error: null }))
        latest.current.preview(queue.commands()).then(
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

      /** 把队列的新数组交给 React：队列自己同步持有同一份，事件回调里读到的永远是最新。 */
      const apply = useCallback((next) => {
        setEntries(next)
        return next
      }, [])

      const push = useCallback((commands) => apply(queue.push(commands)), [apply, queue])
      const undo = useCallback(() => apply(queue.undo()), [apply, queue])
      const discard = useCallback(() => apply(queue.discard()), [apply, queue])
      const refresh = useCallback(() => apply(queue.touch()), [apply, queue])

      const resetPreview = useCallback(() => {
        seq.current += 1
        setPreview({ data: null, loading: false, error: null })
      }, [])

      const drop = useCallback(
        (predicate) => {
          const dropped = queue.drop(predicate)
          if (dropped > 0) apply(queue.entries)
          return dropped
        },
        [apply, queue],
      )

      const commit = useCallback(async () => {
        const commands = queue.commands()
        if (commands.length === 0) return true
        try {
          const data = await latest.current.apply(commands)
          apply(queue.discard())
          latest.current.onApplied(data)
          return true
        } catch (error) {
          setPreview((prev) => ({ ...prev, error: String(error.message || error) }))
          return false
        }
      }, [apply, queue])

      const keys = useMemo(() => queue.keys(), [entries, queue])

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

    /**
     * 极小的可观测量。
     *
     * 设置页改的是持久化配置，槽位注册却发生在 `apply` 里，两者在 React 上没有
     * 父子关系，改完不会自动重挂；chip 在会话页、设置页在设置弹层里，同理。
     * 一个 set/subscribe 就够了，不引任何状态库。
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

    /**
     * 跨组件共享的界面状态。
     *
     * `onChipChange` 由 `apply` 订阅：设置页拨动后立刻挂上或摘下槽位。
     * `chipName` 是 chip 上显示的 pack 名。
     */
    const env = {
      onChipChange: null,
      sessionId: undefined,
    }
    const chipName = createSignal(null)
    /**
     * 未绑定 pack 时 chip 上的字。
     *
     * 固定英文小写、三字母、去元音（skill→skl、plugin→plg、model→mdl；mcp 本就是
     * 念字母的专名，恰好同形）。不随宿主语言：这四个是领域标识符，不是句子，
     * 中文界面下缩写比中文译名更准，四个 chip 也等长。全名留在 title 里。
     */
    const CHIP_LABEL = 'mcp'
    /** chip 弹层订阅的会话 id：弹层只订阅 chipOpen 时，切会话后它仍绑着旧目录。 */
    const chipSessionId = createSignal(undefined)

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

    /**
     * 三态开关：开 / 关 / 跟随。
     *
     * 「跟随」必须是独立可点的第三个选项：显式关掉与「不表态」是两件事，
     * 用「点两次循环」或和「开」共用一个按钮都表达不出来。选中态沿用分段控件的
     * 浅底样式，不引新样式。
     */
    const TRI_STATE = [
      { value: 'on', label: '开', title: '显式打开（压过组与 default）' },
      { value: 'off', label: '关', title: '显式关闭（压过组与 default）' },
      { value: 'follow', label: '跟随', title: '不记录，按组与 default 求值' },
    ]

    function triStateOf(value, allowInherit) {
      if (value === true) return 'on'
      if (value === false) return 'off'
      // default pack 没有上一层：未记录就是取内置缺省（开），显示成「开」而不是「跟随」。
      return allowInherit === false ? 'on' : 'follow'
    }

    function TriState(props) {
      // `default` 是求值链的终点，没有「跟随」可言；两态就够，多一个按钮反而让人
      // 以为还能往上找。
      const allowInherit = props.allowInherit !== false
      const active = triStateOf(props.value, allowInherit)
      const options = allowInherit ? TRI_STATE : TRI_STATE.filter((option) => option.value !== 'follow')
      return h(
        'div',
        { style: { display: 'inline-flex', gap: '4px', alignItems: 'center', flex: '0 0 auto' } },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              title: option.title,
              'aria-pressed': active === option.value,
              disabled: props.disabled,
              style: {
                ...S.segItem(active === option.value),
                /*
                 * 三态是这个面板里点得最多的控件。原来是 11px 字 + 2px 7px 内距，
                 * 热区只有 19px 高——比被抱怨"太小"的删除按钮还小一截。
                 * 高度按官方控件档位取 24px（一排三个，28 会显得笨重）。
                 */
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                height: '24px',
                padding: '0 10px',
                fontSize: '12px',
                lineHeight: '18px',
                opacity: props.disabled ? 0.45 : 1,
                cursor: props.disabled ? 'not-allowed' : 'pointer',
              },
              onClick: () => {
                if (props.disabled) return
                props.onChange(option.value === 'on' ? true : option.value === 'off' ? false : null)
              },
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
     * `options` 是 `[{ value, label, disabled? }]`。点外部或按 Esc 关闭：监听挂在文档上，
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
            style: { ...S.pickerTrigger, ...(props.triggerStyle || {}) },
            title: props.title || label,
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
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
                    'aria-disabled': option.disabled === true,
                    style:
                      option.disabled === true
                        ? { ...S.pickerItem(option.value === props.value, hover === option.value), opacity: 0.45, cursor: 'not-allowed' }
                        : S.pickerItem(option.value === props.value, hover === option.value),
                    onMouseEnter: () => setHover(option.value),
                    onMouseLeave: () => setHover(null),
                    onClick: (event) => {
                      event.stopPropagation()
                      // 禁用项只是「还没选」的提示：点了不关闭浮层，也不回传值。
                      if (option.disabled === true) return
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

    /**
     * 文本字段：失焦或按 Enter 才提交。
     *
     * 逐字符发请求会把服务器打满，也会让每次响应把正在输入的光标顶掉。本地草稿在
     * 未聚焦时跟随外部值，聚焦时只认用户输入。
     */
    function TextField(props) {
      const [text, setText] = useState(props.value)
      const focused = useRef(false)
      // Esc 是「放弃这一格」：blur 会紧跟着触发，得先立一个标记让那次 blur 不提交。
      const skip = useRef(false)
      useEffect(() => {
        if (!focused.current) setText(props.value)
      }, [props.value])
      const commit = () => {
        if (text === props.value) return
        // 提交被拒时把输入框退回外部值：否则被拒的文本留在框里，看着像已保存。
        const settled = props.onCommit(text)
        if (settled && typeof settled.then === 'function') {
          void settled.then((ok) => {
            if (ok === false) setText(props.value)
          })
        }
      }
      return h('input', {
        style: props.style || S.input,
        value: text,
        placeholder: props.placeholder,
        'aria-label': props.label,
        onChange: (event) => setText(event.target.value),
        onFocus: () => {
          focused.current = true
        },
        onBlur: () => {
          focused.current = false
          if (skip.current) {
            skip.current = false
            return
          }
          commit()
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.target.blur()
          if (event.key === 'Escape') {
            skip.current = true
            setText(props.value)
            event.target.blur()
          }
        },
      })
    }

    /**
     * MCP 用的图标：两条横排 + 左侧圆点，与 skill / plugin 的图标区分开。
     *
     * 输入的右侧一排 chip 只靠图标辨认，用同一组宫格会把「找 MCP 设置」变成逐个读文字。
     */
    function McpiIcon(props) {
      const size = props && props.size ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2, y: 2.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
        h('rect', { x: 2, y: 9.5, width: 12, height: 4, rx: 1, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
        h('circle', { cx: 4.6, cy: 4.5, r: 1, fill: 'currentColor' }),
        h('circle', { cx: 4.6, cy: 11.5, r: 1, fill: 'currentColor' }),
      )
    }

    // ---------- 宿主与求值 ----------

    /**
     * 取 `ctx.remote`。
     *
     * 服务是否在 `ctx` 上由 `inject` 决定：声明了才可能有值。但 `ctx.get` 对取不到
     * 的已声明服务是**抛错**而不是返回 undefined，所以探测必须包 try/catch——
     * 这一行漏了会让整个 client 模块加载失败，桌面端直接起不来。
     * 取不到就退化成 `remote: null`，工作区页会空着，其它功能照常。
     */
    function createHost(ctx) {
      let remote = null
      try {
        remote = (ctx && ctx.remote) || null
      } catch {
        remote = null
      }
      if (remote === null || !remote.session) {
        try {
          const session = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined
          if (session) remote = { session: session }
        } catch {
          // 取不到就保持 null。
        }
      }
      return { ctx: ctx, remote: remote }
    }

    // ---------- 数据读取 ----------

    /**
     * 工作区键归一，必须与服务端 `normalizeCwd` 逐字节一致：
     * 反斜杠转正斜杠、去尾斜杠、Windows 下转小写、盘符根保留尾斜杠（`c:/`）。
     * 这里只用它回读 `bindings`；发出去的 cwd 保持原样，由服务端自己归一。
     */
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

    /** 读绑定：先精确匹配；历史键大小写不同时再比一次小写。 */
    function bindingOf(bindings, cwd) {
      if (!bindings || !bindings.bindings) return null
      const key = normalizeCwd(cwd)
      if (key === null) return null
      const exact = bindings.bindings[key]
      if (typeof exact === 'string') return exact
      const lower = key.toLowerCase()
      for (const candidate of Object.keys(bindings.bindings)) {
        if (candidate.toLowerCase() === lower) return bindings.bindings[candidate]
      }
      return null
    }

    function hasPack(packs, id) {
      if (typeof id !== 'string') return false
      for (const pack of packs || []) {
        if (pack.id === id) return true
      }
      return false
    }

    /** 查不到就返回 null：回退到第一个包会让编辑目标悄悄换成另一张 pack。 */
    function packById(packs, id) {
      if (!Array.isArray(packs)) return null
      for (const pack of packs) {
        if (pack.id === id) return pack
      }
      return null
    }

    function defaultPackOf(packs) {
      for (const pack of packs || []) {
        if (pack.id === DEFAULT_PACK_ID) return pack
      }
      return null
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

    /** pack 里的组级显式值；没有键返回 null（跟随）。 */
    function groupValueOf(pack, groupId) {
      const groups = pack && pack.groups && typeof pack.groups === 'object' ? pack.groups : null
      const value = groups === null ? undefined : groups[groupId]
      return typeof value === 'boolean' ? value : null
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
     * 排序档位：显式开 0、显式关 1、跟随且落到开 2、跟随且落到关 3。
     *
     * 跟随要按「实际会落到哪」再分一次：两种跟随在界面上长得一样，但一个等于开、
     * 一个等于关，混在同一档里用户没法按状态扫读。
     *
     * `default` 没有上一层，它的「未记录」就等于开，所以直接归 0——否则同一屏会
     * 出现「排在跟随档、按钮却亮在开上」的错位。
     */
    function rankOf(value, isDefault, inherit) {
      if (value === true) return 0
      if (value === false) return 1
      if (isDefault) return 0
      return inherit ? 2 : 3
    }

    /**
     * 已知工作区：从会话列表里取 cwd，排除子代理会话，按最近更新倒序去重，
     * 当前会话所在目录置顶。取不到会话时返回空列表——面板仍能编辑 pack，
     * 只是工作区页会空着。
     */
    async function listWorkspaceCwds(host, sessionId) {
      const session = host && host.remote ? host.remote.session : null
      if (!session || typeof session.list !== 'function') return []
      let result
      try {
        result = await session.list({})
      } catch {
        return []
      }
      if (!result || result.ok !== true) return []
      const items = result.value && Array.isArray(result.value.items) ? result.value.items : []
      const roots = items.filter(
        (item) => item && typeof item.cwd === 'string' && item.cwd !== '' && item.origin !== 'subagent',
      )
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
      roots.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const cwds = []
      if (pinned !== null) cwds.push(pinned)
      for (const item of roots) {
        if (cwds.indexOf(item.cwd) < 0) cwds.push(item.cwd)
        if (cwds.length >= MAX_WORKSPACES) break
      }
      return cwds
    }

    // ---------- 面板 ----------

    /**
     * 单调递增的请求号：晚到的旧响应不许落回界面。
     *
     * 写失败后会自动重读一次，两条请求同时在飞；没有这个号，旧响应会把新视图顶掉。
     */
    let requestSeq = 0
    const nextRequestId = () => {
      requestSeq += 1
      return requestSeq
    }

    /** 一次全量读取 + 一次写命令的落回。所有页面共用同一份视图。 */
    function useGlobalView() {
      const [state, setState] = useState({ loading: true, data: null })
      // 错误不跟 data 走：重读成功会把 data 里的错误一起清掉，提示就再也看不见了。
      const [errorState, setErrorState] = useState(null)

      const load = useCallback(async () => {
        const id = nextRequestId()
        try {
          const data = await api.global(env.sessionId)
          if (id !== requestSeq) return null
          setState({ loading: false, data: data })
          return data
        } catch (error) {
          if (id !== requestSeq) return null
          setErrorState(String(error.message || error))
          setState({ loading: false, data: null })
          return null
        }
      }, [])

      useEffect(() => {
        let alive = true
        const id = nextRequestId()
        setState((prev) => ({ loading: prev.data === null, data: prev.data }))
        // 面板可能被渲染在任意路由下，但这是一次显式的全量读取，不需要防抖。
        api.global(env.sessionId).then(
          (data) => {
            if (alive && id === requestSeq) setState({ loading: false, data: data })
          },
          (error) => {
            if (alive && id === requestSeq) {
              setErrorState(String(error.message || error))
              setState({ loading: false, data: null })
            }
          },
        )
        return () => {
          alive = false
        }
      }, [load])

      const run = useCallback(
        async (commands) => {
          const id = nextRequestId()
          try {
            const data = await api.apply(commands)
            // 写入成功是唯一该让旧错误消失的时刻。
            setErrorState(null)
            if (id === requestSeq) setState({ loading: false, data: data })
            // 绑定改了要把 chip 上的 pack 名一起更新：chip 直接读当前会话的工作区视图，
            // 与设置页之间没有通道，只能在这里主动重读一次。
            if (commands.some((command) => command.op === 'bind')) refreshChipName(env.sessionId)
            return true
          } catch (error) {
            if (id === requestSeq) setErrorState(String(error.message || error))
            await load()
            return false
          }
        },
        [load],
      )

      // 错误拆在外面，出口仍是 state.error：两处调用点一行都不用改。
      return {
        state: { loading: state.loading, data: state.data, error: errorState },
        run: run,
        reload: load,
        /** 把一次写盘返回的视图直接装进去：保存与试算返回的是同一种视图，不必再读一遍。 */
        accept: useCallback((data) => {
          nextRequestId()
          setErrorState(null)
          setState({ loading: false, data: data })
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
     * 当前 pack 相对 default 的差异：分组在上，行在下。
     *
     * 只列「记录过、且与 default 取值不同」的键。没有键是「不表态」，与 default
     * 同值的记录不改变任何结果——两者都不算「差在哪」。
     */
    function diffOf(data) {
      const packs = Array.isArray(data.packs) ? data.packs : []
      const pack = packById(packs, data.packId)
      // 生效 pack 查不到时无从比较：返回空差异，不假造条目。
      if (pack === null) return []
      const fallback = defaultPackOf(packs)
      const groups = groupsOf(data)
      const rows = []
      // 组已从注册表删掉时没有名字可显示：那是悬空引用，不是差异。
      for (const group of groups.groups) {
        const own = groupValueOf(pack, group.id)
        if (own === null) continue
        const base = groupValueOf(fallback, group.id)
        if (own === (base === null ? true : base)) continue
        rows.push({ key: 'group:' + group.id, isGroup: true, name: group.name, on: own })
      }
      for (const row of rowsOf(data)) {
        const rowKey = rowKeyOf(row)
        if (rowKey === '') continue
        const entry = policyOf(pack, rowKey)
        if (entry === null) continue
        const baseEntry = policyOf(fallback, rowKey)
        const item = { key: 'row:' + rowKey, isGroup: false, name: rowNameOf(row), on: null }
        if (typeof entry.enabled === 'boolean') {
          const baseEnabled = baseEntry && typeof baseEntry.enabled === 'boolean' ? baseEntry.enabled : true
          if (entry.enabled !== baseEnabled) item.on = entry.enabled
        }
        // `mode` / `tools` / `description` 只在内置 `default` 里求值，分包不读它们。
        // 把它们标成「差异」会让用户以为那条键有效，实际不影响任何结果。
        if (item.on === null) continue
        rows.push(item)
      }
      return rows
    }


    /**
     * 策略文件的告警。
     *
     * 写入失败不再是错误信封：它和既有的读告警一样，跟着视图的 `warnings` 回来，
     * 所以面板得有一处能看见。默认折起只显示条数——正常情况一条都没有，出现时才
     * 占位置；展开才列出全文。
     */
    function Warnings(props) {
      const [open, setOpen] = useState(false)
      const list = Array.isArray(props.warnings) ? props.warnings : []
      if (list.length === 0) return null
      return h(
        'div',
        { style: { marginTop: '8px' } },
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': open,
            style: { ...S.badge, cursor: 'pointer' },
            onClick: () => setOpen(!open),
          },
          (open ? '▾ ' : '▸ ') + list.length + ' 条告警',
        ),
        open
          ? h(
              'div',
              { style: { ...S.hint, marginTop: '4px' } },
              list.map((warning, index) => h('div', { key: index }, warning)),
            )
          : null,
      )
    }

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
      const rows = data !== null && !usingDefault ? diffOf(data) : []
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
                      className: 'dsh-mcp-pack-row',
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

    /** 设置页的三页，顺序固定：分组 → 分包 → 工作区。 */
    const TABS = [
      { value: 'servers', label: 'MCP' },
      { value: 'groups', label: '分组' },
      { value: 'packs', label: '分包' },
      { value: 'workspace', label: '工作区' },
    ]

    /**
     * 设置 → MCP Pack。
     *
     * 四页：MCP 管全局默认（加载方式、工具规则、描述）与托管定义，分组管结构（行与
     * 分组），分包管 pack 名册与包内开关，工作区管目录到 pack 的绑定。「当前页」与
     * 「默认页」是两件事：切页只改当前页，打开设置时落在哪一页由顶部那组选项写盘
     * （`ui.defaultTab`）——两者混成一个状态时，「临时看一眼分包」会顺手改掉用户的默认页。
     *
     * 开关、绑定、归属、改名一律先入队（`usePending`），点「保存」才整批写盘；
     * 删除是当场写盘的例外。
     */
    function SettingsPanel(props) {
      const host = props.host
      const view = useGlobalView()
      const { state, run, accept } = view
      // 当前页只由分页按钮切；初值取 `ui.defaultTab`，之后不再跟随任何外部请求。
      const [tab, setTab] = useState(null)
      const [diag, setDiag] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        api.diag().then(
          (value) => {
            if (alive) setDiag(value)
          },
          () => {
            if (alive) setDiag(null)
          },
        )
        return () => {
          alive = false
        }
      }, [])

      // 自检快照含工具清单，序列化不便宜；它只随 diag 变化，不该每次渲染重做一遍。
      const diagText = useMemo(() => (diag === null ? '' : JSON.stringify(diag, null, 2)), [diag])
      const diagLabel =
        diag === null
          ? '运行期自检：适配器、闸门、连接池'
          : '运行期自检：适配器、闸门、连接池（' +
            (diag.toolsRegistered === true
              ? '按需工具已注册'
              : diag.toolsRegistered === false
                ? '按需工具未注册'
                : '已采集') +
            '）'

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

      /** 引用某个分组的待保存命令：改它的名、给它设组级开关、把行归到它。 */
      const groupDeps = (groupId) => (command) => {
        if (command.op === 'packGroup' || command.op === 'renameGroup') return command.groupId === groupId
        if (command.op === 'assign') return command.groupId === groupId
        return false
      }

      /** 引用某张 pack 的待保存命令：改名、行级/组级开关、绑定到它。 */
      const packDeps = (packId) => (command) => command.packId === packId

      /** 引用某一行的待保存命令：行级开关、归属。托管定义删掉后这些命令落不了地。 */
      const rowDeps = (rowKey) => (command) => {
        if (command.op === 'packRow') return command.rowKey === rowKey
        if (command.op === 'assign') return command.rowKey === rowKey
        return false
      }

      const base = state.data
      // 有待保存改动时，面板按「试算视图」渲染；否则就是真实视图。
      const data = pending.preview.data !== null ? pending.preview.data : base
      const ui = uiOf(data)
      const current = tab !== null ? tab : ui.defaultTab

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
          { style: { ...S.hint, marginTop: '8px' } },
          '一张 pack 是一套具名策略：工作区绑到哪个 pack，就按哪套开关生效；未绑定按默认。加载方式、工具规则与描述是每台 server 的全局默认，在「MCP」页改；分包页只决定每张 pack 的开关。改动先攒着，点「保存」才写盘。',
        ),
        data.complete === false
          ? h(
              'div',
              { style: S.probeWarn },
              '行扫描不完整：列表可能缺少条目。这里的开关只对已经发现的行生效，不会抹掉没扫到的决定。',
            )
          : null,
        h(Warnings, { warnings: data.warnings }),

        h(
          'div',
          { style: { ...S.bar, marginTop: '10px', marginBottom: '0' } },
          h('span', { style: S.hint }, '打开设置时默认显示'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '120px' } },
            h(Picker, {
              value: ui.defaultTab,
              options: TABS.map((entry) => ({ value: entry.value, label: entry.label })),
              onChange: (next) => run([{ op: 'defaultTab', value: next }]),
            }),
          ),
        ),
        h('div', { style: { marginTop: '10px' } }, h(Segmented, { value: current, onChange: setTab, options: TABS })),
        state.error ? h('div', { style: { ...S.error, marginTop: '8px' } }, state.error) : null,
        current === 'groups'
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { marginTop: '12px' } },
                h(SettingRow, {
                  label: '在输入框右侧显示入口',
                  hint: '关掉后会话输入框右侧不再出现 MCP chip；pack 绑定仍可在「工作区」页操作。立刻生效。',
                  on: ui.showChip,
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
                queue: enqueue,
                pending: pending,
                notify: notify,
                onDeleteGroup: (groupId, name) =>
                  deleteWith(name, groupDeps(groupId), [{ op: 'deleteGroup', groupId: groupId }]),
              }),
            )
          : null,
        current === 'servers'
          ? h(
              'div',
              null,
              h(ServersBlock, { data: data, reload: view.reload, pending: pending }),
              h(RowsBoard, {
                data: data,
                base: base,
                queue: enqueue,
                pending: pending,
                notify: notify,
                rowDeps: rowDeps,
                reload: view.reload,
              }),
            )
          : null,
        current === 'packs'
          ? h(PackSettings, {
              data: data,
              base: base,
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
              queue: enqueue,
              pending: pending,
              host: host,
            })
          : null,

        // 运行期自检放页面最末：适配器、闸门、连接池的数字只在排查时看，
        // 顶在标题下面会把正文挤下去。
        h(
          'details',
          { style: { margin: '20px 0 0', borderTop: '1px solid ' + T.border, paddingTop: '10px' } },
          h('summary', { style: { ...S.hint, cursor: 'pointer' } }, diagLabel),
          h(
            'pre',
            {
              style: {
                fontSize: '11px',
                color: T.dim,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                marginTop: '6px',
                maxHeight: '220px',
                overflow: 'auto',
              },
            },
            diagText || '读取中…',
          ),
        ),
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

    /** 批量归组下拉里的「还没选」哨兵：得是一个既不是分组 id、也不是 `''` 的值。 */
    const BULK_NONE = '__bulk_none'

    /**
     * 「分组」页：只做结构，不做策略。
     *
     * 按分组折叠展示成员，展开后在行内直接改归属；开关与加载方式都不在这里——它们
     * 属于 pack，由「分包」页按 pack 设置。一页只做一件事，否则同一个开关会有两个入口。
     *
     * 顺序是「新建 → 搜索 → 列表」：新建入口在列表底下时，用户要滚到最底才看得见。
     * 搜索同时匹配分组名——搜「数据库」多半是想找那一组，而不是名字里恰好含这三个
     * 字的行，所以组名命中时整组保留。
     */
    function GroupsPage(props) {
      const data = props.data
      const base = props.base || props.data
      const queue = props.queue
      const pending = props.pending || { count: 0, keys: new Set() }
      const frozen = pending.count > 0
      const [query, setQuery] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const [editing, setEditing] = useState(null)
      /** 批量归组的目标分组；`null` 表示还没选，`''` 表示未分组。 */
      const [bulkGroup, setBulkGroup] = useState(null)

      const rows = rowsOf(data)
      const groups = groupsOf(data)
      const registry = groups.groups
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
          needle === ''
            ? true
            : (rowNameOf(row) + ' ' + rowKeyOf(row) + ' ' + rowDescriptionOf(row)).toLowerCase().indexOf(needle) >= 0
        const byId = new Map()
        const loose = []
        for (const row of rows) {
          // 悬空引用由宿主归一成 null，这里拿到的 gid 一定在注册表里。
          const gid = groupIdOf(row)
          if (gid === null) {
            if (matchRow(row)) loose.push(row)
            continue
          }
          if (!byId.has(gid)) byId.set(gid, [])
          byId.get(gid).push(row)
        }
        const byName = (a, b) => rowNameOf(a).localeCompare(rowNameOf(b), 'zh') || rowKeyOf(a).localeCompare(rowKeyOf(b))
        /*
         * 待保存期间冻结排序：分组按**改动前**的名字排。
         *
         * 不能直接按新名字排：改完名的那一组会立刻跳到新位置，下一次点击就落在别的组上。
         * 也不能按 `base` 数组的原始位置排——列表平时是按名字排的，两者顺序本来就不同，
         * 那样一进入待保存状态反而会重排一次（第一版就是这么错的）。
         * 正确的冻结是「沿用改动前的排序键」：组 id 与行键都不变，只有分组名要回溯。
         */
        const baseGroupName = frozenGroupNames(base, frozen)
        const sortGroups = (list) =>
          list.slice().sort((a, b) => {
            const left = frozen && baseGroupName.has(a.id) ? baseGroupName.get(a.id) : a.name
            const right = frozen && baseGroupName.has(b.id) ? baseGroupName.get(b.id) : b.name
            return String(left).localeCompare(String(right), 'zh')
          })
        // 未分组恒在最上：新发现的行先落这里，用户第一眼要看到的就是它。
        const out = [{ id: null, name: '未分组', rows: loose.sort(byName) }]
        for (const group of sortGroups(registry)) {
          const members = byId.get(group.id) || []
          const groupHit = needle !== '' && group.name.toLowerCase().indexOf(needle) >= 0
          out.push({
            id: group.id,
            name: group.name,
            rows: (groupHit ? members : members.filter(matchRow)).sort(byName),
          })
        }
        return out
      }, [rows, registry, needle, base, frozen])

      const searching = needle !== ''
      const total = buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0)
      /** 当前筛选命中的行（跨分组拍平），批量归组的对象。 */
      const matched = buckets.reduce((list, bucket) => list.concat(bucket.rows), [])
      const assignTo = (row, groupId) =>
        queue([{ op: 'assign', rowKey: rowKeyOf(row), groupId: groupId === '' ? null : groupId }])
      // 一批 assign 走同一次请求：逐个发在几十行时会被乱序返回的响应来回覆盖。
      const assignAll = () => {
        if (matched.length === 0) return
        queue(
          matched.map((row) => ({
            op: 'assign',
            rowKey: rowKeyOf(row),
            groupId: bulkGroup === '' ? null : bulkGroup,
          })),
        )
      }
      const bulkReady = bulkGroup !== null && matched.length > 0

      /** 改名：重名在这里先拦，别留给服务端拒掉整份 groups.json。 */
      const renameGroup = (groupId, current, next) => {
        const trimmed = String(next || '').trim()
        if (trimmed === '' || trimmed === current) return
        const clash = registry.some((group) => group.id !== groupId && group.name === trimmed)
        if (clash) {
          // 「点了但没生效」必须当场说一句，否则界面上就是什么都没发生。
          if (props.notify) props.notify('已存在同名分组：' + trimmed)
          return
        }
        queue([{ op: 'renameGroup', groupId: groupId, name: trimmed }])
      }

      return h(
        'div',
        { style: { marginTop: '12px' } },
        h(
          'div',
          { style: { ...S.hint, marginBottom: '6px' } },
          '点分组展开成员，在行内直接改归属。开关与加载方式不在这里——去「分包」页按 pack 设置。',
        ),
        h(GroupCreator, {
          onCreate: (name) => queue([{ op: 'createGroup', name: name }]),
          existing: registry.map((group) => group.name),
          onReject: props.notify,
        }),
        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            placeholder: '搜索 server 名、描述或分组名',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: stopEscape,
          }),
          h('span', { style: S.hint }, total + ' 行'),
        ),
        h(
          'div',
          { style: { ...S.bar, marginTop: '0' } },
          h('span', { style: S.hint }, '把当前 ' + matched.length + ' 行归到'),
          h(
            'div',
            { style: { flex: '0 0 auto', minWidth: '130px' } },
            h(Picker, {
              value: bulkGroup === null ? BULK_NONE : bulkGroup,
              options: [
                { value: BULK_NONE, label: '选择分组…', disabled: true },
                { value: '', label: '未分组' },
                ...registry.map((group) => ({ value: group.id, label: group.name })),
              ],
              onChange: (next) => setBulkGroup(next),
            }),
          ),
          h(
            Button,
            {
              onClick: assignAll,
              disabled: !bulkReady,
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
                className: 'dsh-mcp-pack-row',
                'data-state':
                  bucket.id !== null && pending.keys.has('renameGroup:' + bucket.id) ? 'pending' : undefined,
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
                      const next = event.target.value
                      setEditing(null)
                      renameGroup(bucket.id, bucket.name, next)
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
              h('span', { style: S.badge }, bucket.rows.length + ' 行'),
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
                      { key: rowKeyOf(row), style: S.row },
                      h(
                        'div',
                        { style: S.rowMain },
                        h(
                          'div',
                          { style: S.rowName },
                          rowNameOf(row),
                          h('span', { style: S.badge }, rowTransportOf(row)),
                          isOwned(row) ? h('span', { style: S.badge }, '托管') : null,
                        ),
                        h('div', { style: { ...S.rowDesc, ...S.mono }, title: rowKeyOf(row) }, rowKeyOf(row)),
                        h(
                          'div',
                          { style: S.rowDesc, title: rowDescriptionOf(row) },
                          rowDescriptionOf(row) || '（无描述）',
                        ),
                      ),
                      h(
                        'div',
                        { style: { flex: '0 0 auto', minWidth: '128px' } },
                        h(Picker, {
                          value: bucket.id === null ? '' : bucket.id,
                          options: [
                            { value: '', label: '未分组' },
                            ...registry.map((group) => ({ value: group.id, label: group.name })),
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

    /**
     * 「MCP」页的上块：全局行清单。
     *
     * 加载方式、工具规则与描述描述的是「这台 server 怎么加载」，是全局默认值，写进
     * `default` pack；分包页只决定开关。所以这三个字段只有这一个编辑入口，每次失焦
     * 或 Enter 发一条 `packRow` 到 `default`，patch 里只带本次改的那个键——值为 `null`
     * 表示删掉这条键、回到内置缺省。合并规则仍在服务端，这里不做本地推导。
     */
    function RowsBoard(props) {
      const rows = rowsOf(props.data)
      const defaultPack = defaultPackOf(Array.isArray(props.data.packs) ? props.data.packs : [])
      return h(
        'div',
        { style: S.block },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('div', { style: S.blockTitle }, '加载方式与描述'),
          h('span', { style: S.stat }, rows.length + ' 行'),
        ),
        h('div', { style: { ...S.hint, marginBottom: '8px' } }, '这些是全局默认值，各 pack 只覆盖开关。'),
        // 三档差别是参考信息，折叠起来：这一页的正文是行清单与托管服务器。
        h(
          'details',
          { style: { marginBottom: '8px' } },
          h('summary', { style: { ...S.hint, cursor: 'pointer' } }, '三档加载方式有什么区别'),
          h(
            'div',
            { style: { ...S.hint, marginTop: '4px' } },
            MODE_HELP.map((item) =>
              h(
                'div',
                { key: item.mode },
                h('span', { style: { color: T.text, fontWeight: 600 } }, item.label),
                '：',
                item.text,
              ),
            ),
          ),
        ),
        rows.length === 0
          ? h('div', { style: S.empty }, '还没有发现 MCP 服务器。')
          : rows.map((row) =>
              h(RowEditor, {
                key: rowKeyOf(row),
                row: row,
                defaultPack: defaultPack,
                queue: props.queue,
                pending: props.pending,
                notify: props.notify,
                rowDeps: props.rowDeps,
                reload: props.reload,
              }),
            ),
      )
    }

    /** MCP 页的一行：行头常驻，展开后是三个字段的编辑器。 */
    function RowEditor(props) {
      const row = props.row
      const defaultPack = props.defaultPack
      const queue = props.queue
      const [open, setOpen] = useState(false)
      const [removeError, setRemoveError] = useState(null)
      const rowKey = rowKeyOf(row)
      const entry = defaultEntryOf(row, defaultPack)
      const mode = entryField(entry, 'mode')
      const tools = entryField(entry, 'tools')
      const description = entryField(entry, 'description')
      const source = rowSourceOf(row)
      // 生效值由宿主下发；这里只贴标签，不再重算链。
      const activeMode = MODE_LABELS[row.mode] ? row.mode : DEFAULT_MODE
      const toolCount = Array.isArray(row.tools) ? row.tools.length : 0
      // 全局默认值的改动同样先入队：它和开关一样是策略，攒着点「保存」才写盘。
      const patch = (delta) => queue([{ op: 'packRow', packId: DEFAULT_PACK_ID, rowKey: rowKey, patch: delta }])
      // 托管服务器的连接定义可以就地删掉；只关开关定义仍然在，与删除是两件事。
      const removeOwned = () => {
        if (!isOwned(row)) return
        // 定义没了，队列里对这一行的开关与归属都落不了地：先剔掉，并把丢了几项说出来。
        const removed = props.pending && props.rowDeps ? props.pending.drop(props.rowDeps(rowKey)) : 0
        if (removed > 0 && props.notify) props.notify('已删除「' + rowNameOf(row) + '」，并丢弃对它的 ' + removed + ' 项未保存改动')
        api.servers({ op: 'remove', name: rowNameOf(row) }).then(
          () => {
            /*
             * 重读之后才能重算试算视图。
             *
             * 定义的增删走独立路由、不经过队列：队列里的命令原封不动时 `entries` 不变，
             * 试算的 effect 不会重跑。若在重读之前踢那一脚，它算的还是删除前的行清单，
             * 被删的行照样挂在面板上。
             */
            const reloaded = props.reload ? props.reload() : undefined
            Promise.resolve(reloaded).then(() => {
              if (props.pending) {
                props.pending.resetPreview()
                props.pending.refresh()
              }
            })
          },
          (error) => setRemoveError(String(error.message || error)),
        )
      }

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.lineHead, onClick: () => setOpen(!open) },
          h(Chevron, { open: open }),
          h(
            'div',
            { style: S.rowMain },
            h(
              'div',
              { style: S.rowName },
              rowNameOf(row),
              h('span', { style: S.badge }, rowTransportOf(row)),
              source !== '' ? h('span', { style: S.badge }, source) : null,
            ),
            h('div', { style: { ...S.rowMeta, ...S.mono } }, rowKey),
          ),
          h(
            'span',
            {
              style: {
                ...S.hint,
                flex: '0 1 auto',
                minWidth: '80px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'right',
              },
            },
            '当前生效：' + MODE_LABELS[activeMode] + (toolCount === 0 ? ' · 工具不限' : ' · 工具 ' + toolCount + ' 条'),
          ),
          isOwned(row)
            ? h(ConfirmButton, {
                // 文案走「删除 → 确认」两段：红色只在确认态出现。
                title: '删除这台托管 server 的定义（所有工作区都不再发现它）',
                onConfirm: removeOwned,
              })
            : null,
        ),
        // 失败必须留在这一行上：ConfirmButton 的失败回调原来吞掉了错误。
        removeError ? h('div', { style: { ...S.error, paddingLeft: '22px' } }, removeError) : null,
        open
          ? h(
              'div',
              { style: S.lineBody },
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }, '加载方式'),
                h(
                  'div',
                  { style: { flex: '0 0 auto', minWidth: '150px' } },
                  h(Picker, {
                    value: mode === null ? '' : mode,
                    options: [{ value: '', label: '跟随' }].concat(
                      MODES.map((item) => ({ value: item, label: MODE_LABELS[item] })),
                    ),
                    onChange: (next) => patch({ mode: next === '' ? null : next }),
                  }),
                ),
                h('span', { style: S.hint }, '跟随 = 不记录，按内置默认（' + MODE_LABELS[DEFAULT_MODE] + '）'),
              ),
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }, '工具规则'),
                h(TextField, {
                  value: (tools === null ? [] : tools).join(', '),
                  placeholder: '留空则不筛工具',
                  label: '工具规则',
                  style: S.toolInput,
                  onCommit: (text) => patch({ tools: parseRules(text) }),
                }),
              ),
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }),
                h(
                  'span',
                  { style: { ...S.hint, flex: '1 1 320px' } },
                  '逗号分隔：read_* 只留匹配项，!delete_* 排除匹配项；清空回到不筛。',
                ),
              ),
              h(
                'div',
                { style: S.field },
                h('span', { style: S.fieldLabel }, '描述'),
                h(TextField, {
                  value: description === null ? '' : description,
                  placeholder: '名册里显示的描述',
                  label: '描述',
                  style: S.input,
                  onCommit: (text) => patch({ description: text.trim() === '' ? null : text }),
                }),
              ),
            )
          : null,
      )
    }

    /**
     * 分包页的一行：只决定开合。
     *
     * 加载方式、工具规则与描述搬去「MCP」页当全局默认值了，这里只剩 enabled 的三态：
     * 显式开/关压过组与 default，「跟随」表示这张 pack 不表态。
     */
    function RowLine(props) {
      const row = props.row
      const pack = props.pack
      const groups = props.groups
      const isDefault = props.isDefault
      const queue = props.queue
      const pending = props.pending || { count: 0, keys: new Set() }
      const [open, setOpen] = useState(false)
      const rowKey = rowKeyOf(row)
      const gid = groupIdOf(row)
      const enabled = fieldOf(pack, rowKey, 'enabled')
      const source = rowSourceOf(row)
      // 「跟随」不是一种状态值，而是一个待求值的位置：告诉用户它此刻落到开还是关，
      // 否则三态里那个中间项等于什么也没说。选中 pack 的组记录优先，其余由宿主
      // 按 default 求出的值决定——链只在宿主那边走一次。
      const landing = groupValueOf(pack, gid) ?? row.openGlobal
      // 迁移可能把老的三个字段带进非 default 的 pack。MCP 页只读 default，看不到这些
      // 覆盖；这里只提示，绝不删数据。
      const overridden =
        !isDefault &&
        (fieldOf(pack, rowKey, 'mode') !== null ||
          fieldOf(pack, rowKey, 'tools') !== null ||
          fieldOf(pack, rowKey, 'description') !== null)

      return h(
        'div',
        null,
        h(
          'div',
          {
            style: S.lineHead,
            className: 'dsh-mcp-pack-row',
            // 待保存优先于「当前」：这一行更重要的是「还没保存」。
            'data-state': pending.keys.has('packRow:' + pack.id + ':' + rowKey) ? 'pending' : undefined,
            onClick: () => setOpen(!open),
          },
          h(Chevron, { open: open }),
          h(
            'div',
            { style: S.rowMain },
            h(
              'div',
              { style: S.rowName },
              rowNameOf(row),
              h('span', { style: S.badge }, rowTransportOf(row)),
              source !== '' ? h('span', { style: S.badge }, source) : null,
              h('span', { style: S.badge }, gid === null ? '未分组' : groupNameOf(groups.groups, gid)),
            ),
            h('div', { style: { ...S.rowMeta, ...S.mono } }, rowKey),
          ),
          // 三态按钮在可折叠的行头里：拦下冒泡，否则点一次开关就顺手把行折起来。
          h(
            'span',
            { style: { display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: '6px' }, onClick: (event) => event.stopPropagation() },
            enabled === null && !isDefault
              ? h('span', { style: { ...S.hint, whiteSpace: 'nowrap' } }, landing ? '跟随（开）' : '跟随（关）')
              : null,
            h(TriState, {
              value: enabled,
              allowInherit: !isDefault,
              onChange: (next) => queue([{ op: 'packRow', packId: pack.id, rowKey: rowKey, patch: { enabled: next } }]),
            }),
          ),
        ),
        open
          ? h(
              'div',
              { style: S.lineBody },
              h('span', { style: S.hint }, '加载方式、工具规则与描述的全局值在「MCP」页设置；这一行只决定开合。'),
              overridden
                ? h(
                    'span',
                    { style: S.hint },
                    '这张 pack 还覆盖了加载方式/工具规则/描述——它们不影响这里的开关，可在「MCP」页查看全局值。',
                  )
                : null,
            )
          : null,
      )
    }

    /** 工具规则以数组存盘，界面上用逗号分隔的字符串编辑；空列表等价「跟随」。 */
    function parseRules(text) {
      const rules = String(text)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
      return rules.length === 0 ? null : rules
    }

    /**
     * 托管 server 的增删。
     *
     * 这是本包独有的能力（别处没有托管 MCP 连接定义的地方）：删除只动托管文件里的
     * 定义，不动任何开关；新增走同一个 `servers` 路由，成功与否都整页重读一次。
     */
    function ServersBlock(props) {
      const reload = props.reload
      const [adding, setAdding] = useState(false)
      const [name, setName] = useState('')
      const [transport, setTransport] = useState('stdio')
      const [command, setCommand] = useState('')
      const [args, setArgs] = useState('')
      const [url, setUrl] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const close = () => {
        setAdding(false)
        setName('')
        setCommand('')
        setArgs('')
        setUrl('')
      }

      const submit = () => {
        const trimmed = name.trim()
        if (trimmed === '') {
          setError('先给 server 起个名字')
          return
        }
        const def =
          transport === 'stdio'
            ? {
                transport: 'stdio',
                command: command.trim(),
                args: args
                  .split(/\s+/)
                  .map((item) => item.trim())
                  .filter((item) => item !== ''),
              }
            : { transport: 'streamable-http', url: url.trim() }
        setBusy(true)
        setError('')
        api.servers({ op: 'upsert', name: trimmed, def }).then(
          () => {
            setBusy(false)
            close()
            // 与删除同理：重读之后再让试算重算一次，新行才会立刻出现在按试算视图渲染的面板上。
            Promise.resolve(reload()).then(() => {
              if (props.pending) {
                props.pending.resetPreview()
                props.pending.refresh()
              }
            })
          },
          (cause) => {
            setBusy(false)
            setError(String(cause.message || cause))
          },
        )
      }

      return h(
        'div',
        { style: S.block },
        h('div', { style: S.blockTitle }, '新增托管服务器'),
        h(
          'div',
          { style: { ...S.hint, marginBottom: '8px' } },
          '这里维护的是连接定义本身，与 pack 的开关无关：删掉定义，所有工作区都不再发现它；只关开关，定义仍然在。删除入口在上面的行清单里。',
        ),
        adding
          ? h(
              'div',
              { style: { marginTop: '8px' } },
              h(
                'div',
                { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('input', {
                  style: { ...S.input, flex: '1 1 140px' },
                  placeholder: 'serverName（字母数字_-，≤32）',
                  value: name,
                  onChange: (event) => setName(event.target.value),
                }),
                h(
                  'div',
                  { style: { flex: '0 0 auto', minWidth: '120px' } },
                  h(Picker, {
                    value: transport,
                    options: [
                      { value: 'stdio', label: 'stdio' },
                      { value: 'streamable-http', label: 'HTTP' },
                    ],
                    onChange: (next) => setTransport(next),
                  }),
                ),
              ),
              transport === 'stdio'
                ? h(
                    'div',
                    null,
                    h('input', {
                      style: S.input,
                      placeholder: 'command，例如 npx',
                      value: command,
                      onChange: (event) => setCommand(event.target.value),
                    }),
                    h('input', {
                      style: S.input,
                      placeholder: '参数，空格分隔',
                      value: args,
                      onChange: (event) => setArgs(event.target.value),
                    }),
                  )
                : h('input', {
                    style: S.input,
                    placeholder: 'url，例如 http://127.0.0.1:8080/mcp',
                    value: url,
                    onChange: (event) => setUrl(event.target.value),
                  }),
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' } },
                h(Button, { variant: 'quiet', onClick: close }, '取消'),
                h(Button, { variant: 'primary', disabled: busy, onClick: submit }, busy ? '保存中…' : '保存'),
              ),
            )
          : h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
              h(Button, { onClick: () => setAdding(true) }, '新增服务器'),
            ),
        error ? h('div', { style: S.error }, error) : null,
      )
    }

    /** 「分包」页：包名册 → 包内开关，自上而下两块。工作区绑定与托管定义不在这一页。 */
    function PackSettings(props) {
      const data = props.data
      const base = props.base || props.data
      const queue = props.queue
      const pending = props.pending || { count: 0, keys: new Set() }
      const frozen = pending.count > 0
      const packs = Array.isArray(data.packs) ? data.packs : []
      /** 磁盘上真实存在的 pack id；刚新建还没保存的那些不在里面。 */
      const realPackIds = new Set((base.packs || []).map((entry) => entry.id))
      const groups = groupsOf(data)
      const rows = rowsOf(data)
      const defaultPack = defaultPackOf(packs)
      const [selected, setSelected] = useState(DEFAULT_PACK_ID)
      const [query, setQuery] = useState('')
      const [newName, setNewName] = useState('')
      const [editing, setEditing] = useState(null)
      const pack = packById(packs, selected)
      /** 选中的 pack 已不在名册里：这时不能退回第一个包，否则开关会落到别的 pack 上。 */
      const packMissing = pack === null && packs.length > 0
      /** `default` 没有上一层，未记录直接显示成「开」，排序也按开算。 */
      const isDefault = pack === null || pack.id === DEFAULT_PACK_ID

      /*
       * 排序键的来源：待保存期间用改动前的 pack（`sortPack`），位置因此不会跟着
       * 未保存的值乱跳；保存之后才按新值重排。
       */
      const basePacks = Array.isArray(base.packs) ? base.packs : []
      const basePack = frozen ? packById(basePacks, selected) : pack
      const sortPack = basePack !== null ? basePack : pack
      const sortDefault = frozen ? defaultPackOf(basePacks) : defaultPack
      /** 分组在改动前的名字：冻结排序时用它当键，否则改名的组会立刻跳位。 */
      const baseGroupName = useMemo(() => {
        const map = new Map()
        for (const group of groupsOf(base).groups) map.set(group.id, group.name)
        return map
      }, [base])
      /** 这张 pack 有没有未保存的改动：改名、行级或组级开关任一命中即算。 */
      const dirtyOf = (packId) => {
        const rowPrefix = 'packRow:' + packId + ':'
        const groupPrefix = 'packGroup:' + packId + ':'
        for (const key of pending.keys) {
          if (key === 'renamePack:' + packId) return true
          if (key.indexOf(rowPrefix) === 0 || key.indexOf(groupPrefix) === 0) return true
        }
        return false
      }

      const items = useMemo(() => {
        const needle = query.trim().toLowerCase()
        // 命中组名等于命中整组：在分包页搜「数据库」应该把该组的所有行都筛出来，
        // 而不是因为 server 名里没有这三个字就报没结果。
        const hitGroups = new Set()
        if (needle !== '') {
          for (const group of groups.groups) {
            if (group.name.toLowerCase().indexOf(needle) >= 0) hitGroups.add(group.id)
          }
        }
        const visible =
          needle === ''
            ? [...rows]
            : rows.filter((row) => {
                if ((rowNameOf(row) + ' ' + rowKeyOf(row) + ' ' + rowDescriptionOf(row)).toLowerCase().indexOf(needle) >= 0) {
                  return true
                }
                const gid = groupIdOf(row)
                return gid !== null && hitGroups.has(gid)
              })
        // 顺序是「开 > 关 > 跟随(开) > 跟随(关)」：显式决定过的排在前面，
        // 跟随项再按它会落到开还是关区分。落点与 RowLine 同一套：选中 pack 的组记录
        // 优先，其余是宿主按 default 求出的值。同档按 server 名排。
        //
        // 待保存期间排序键取自改动前的那份视图（`sortPack`）：否则拨一个开关就把行
        // 挪到另一档，下一次点击会落在别的行上。
        const landingOf = (row) => groupValueOf(sortPack, groupIdOf(row)) ?? row.openGlobal
        return visible.sort((a, b) => {
          const left = rankOf(fieldOf(sortPack, rowKeyOf(a), 'enabled'), isDefault, landingOf(a))
          const right = rankOf(fieldOf(sortPack, rowKeyOf(b), 'enabled'), isDefault, landingOf(b))
          if (left !== right) return left - right
          return rowNameOf(a).localeCompare(rowNameOf(b), 'zh') || rowKeyOf(a).localeCompare(rowKeyOf(b))
        })
      }, [rows, groups, query, sortPack, sortDefault, isDefault])

      /** 分组同样「开 > 关 > 跟随(开) > 跟随(关)」；跟随落点用 default 的组记录。 */
      const orderedGroups = useMemo(() => {
        const inheritOf = (gid) => groupValueOf(sortDefault, gid) ?? true
        return [...groups.groups].sort((a, b) => {
          const left = rankOf(groupValueOf(sortPack, a.id), isDefault, inheritOf(a.id))
          const right = rankOf(groupValueOf(sortPack, b.id), isDefault, inheritOf(b.id))
          if (left !== right) return left - right
          // 兜底按「改动前」的名字：否则改个组名，这一组就跳到新位置。
          const leftName = frozen && baseGroupName.has(a.id) ? baseGroupName.get(a.id) : a.name
          const rightName = frozen && baseGroupName.has(b.id) ? baseGroupName.get(b.id) : b.name
          return String(leftName).localeCompare(String(rightName), 'zh')
        })
      }, [groups.groups, sortPack, isDefault, sortDefault, frozen, baseGroupName])

      const groupCounts = useMemo(() => {
        const counts = {}
        for (const row of rows) {
          const gid = groupIdOf(row)
          if (gid === null) continue
          counts[gid] = (counts[gid] || 0) + 1
        }
        return counts
      }, [rows])

      if (pack === null) {
        return h('div', { style: S.hint }, packMissing ? '该 pack 已不存在' : '没有可用的 pack')
      }

      const createPack = () => {
        const trimmed = newName.trim()
        if (trimmed === '') return
        // 与分组同理：重名在这里就说清楚，别留给服务端拒掉整份文件。
        if (packs.some((entry) => entry.name === trimmed)) {
          if (props.notify) props.notify('已存在同名 pack：' + trimmed)
          return
        }
        queue([{ op: 'createPack', name: trimmed }])
        setNewName('')
      }
      /** 改名：重名先拦住，与新建同一条口径。 */
      const renamePack = (packId, current, next) => {
        const trimmed = String(next || '').trim()
        if (trimmed === '' || trimmed === current) return
        if (packs.some((entry) => entry.id !== packId && entry.name === trimmed)) {
          if (props.notify) props.notify('已存在同名 pack：' + trimmed)
          return
        }
        queue([{ op: 'renamePack', packId: packId, name: trimmed }])
      }
      const overrides = (entry) =>
        Object.keys(entry.rows || {}).length + Object.keys(entry.groups || {}).length

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
                className: 'dsh-mcp-pack-row',
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
                      const next = event.target.value
                      setEditing(null)
                      renamePack(entry.id, entry.name, next)
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
                    title: entry.builtin ? '未绑定的工作区按它运行' : '双击改名',
                    onDoubleClick: entry.builtin
                      ? undefined
                      : (event) => {
                          event.stopPropagation()
                          setEditing(entry.id)
                        },
                  },
                  entry.name,
                ),
              h('span', { style: S.badge }, overrides(entry) + ' 条覆盖'),
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
                      title: '删除 pack（指向它的绑定会变成悬空引用，按默认 求值；不可撤销）',
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
            { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.input, flex: '0 0 200px' },
              placeholder: '新 pack 名',
              value: newName,
              onChange: (event) => setNewName(event.target.value),
              onKeyDown: (event) => {
                stopEscape(event)
                if (event.key === 'Enter') createPack()
              },
            }),
            h(Button, { onClick: createPack }, '新建 pack'),
          ),
        ),

        // 2. 包内开关：组与行都只决定开合
        h(
          'div',
          { style: S.block },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('div', { style: S.blockTitleSticky }, '包内开关：' + pack.name),
            h('span', { style: S.stat }, rows.length + ' 行'),
          ),
          h(
            'div',
            { style: { ...S.hint, marginBottom: '8px' } },
            '组与行都只决定开合：显式打开/关闭压过上一层，「跟随」表示这张 pack 不表态。加载方式、工具规则与描述是全局默认值，在「MCP」页设置。',
          ),
          groups.groups.length === 0
            ? h('div', { style: S.hint }, '还没有分组。到「分组」页新建，或直接在下面逐行设置。')
            : orderedGroups.map((group) => {
                const value = groupValueOf(pack, group.id)
                const inherited = groupValueOf(defaultPack, group.id) ?? true
                return h(
                  'div',
                  {
                    key: group.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 0',
                      borderTop: '1px solid ' + T.border,
                      background: pending.keys.has('packGroup:' + pack.id + ':' + group.id)
                        ? T.pendingBg
                        : undefined,
                    },
                  },
                  h('span', { style: { ...S.groupName, flex: '1 1 auto' } }, group.name),
                  h('span', { style: S.badge }, (groupCounts[group.id] || 0) + ' 行'),
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
          h(
            'div',
            { style: { ...S.bar, marginTop: '10px' } },
            h('input', {
              style: S.input,
              placeholder: '搜索 server 名、描述或分组名',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: stopEscape,
            }),
            h('span', { style: S.hint }, items.length + ' 行'),
          ),
          items.length === 0
            ? h('div', { style: S.empty }, rows.length === 0 ? '还没有发现 MCP 服务器。' : '没有匹配的行')
            : items.map((row) =>
                h(RowLine, {
                  key: rowKeyOf(row),
                  row: row,
                  pack: pack,
                  groups: groups,
                  isDefault: isDefault,
                  queue: queue,
                  pending: pending,
                }),
              ),
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
     * 绑定保存时就会对所有 live 会话重新求值，不是只影响新会话：每个 Agent 按自己的
     * cwd 重新读绑定，改动落在下一个回合边界。
     */
    function WorkspacePage(props) {
      const data = props.data
      const queue = props.queue
      const pending = props.pending || { count: 0, keys: new Set() }
      const host = props.host
      const [cwds, setCwds] = useState([])
      const [settled, setSettled] = useState(false)

      useEffect(() => {
        let alive = true
        setSettled(false)
        listWorkspaceCwds(host, env.sessionId).then(
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

      const packs = Array.isArray(data.packs) ? data.packs : []
      const bindings = bindingsOf(data)
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
          '切换会话或重新启用插件后，输入框的 / 候选可能还是旧的：宿主按会话缓存 MCP 清单。刷新页面即可。',
        ),
        !settled
          ? h('div', { style: S.hint }, '读取会话列表…')
          : paths.length === 0
            ? h('div', { style: S.empty }, '还没有开过会话的目录。开一个会话后这里就会出现。')
            : paths.map((cwd) => {
                const bound = bindingOf(bindings, cwd)
                // 内置 default 与「未绑定」等价（服务端把 bind default 当解绑），悬空引用也
                // 走这里：两者都显示成「默认」，否则下拉里会出现两个同名的默认项。
                const value = bound === null || bound === DEFAULT_PACK_ID || !hasPack(packs, bound) ? '' : bound
                const changed = pending.keys.has('bind:' + normalizeCwd(cwd))
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
                      background: changed ? T.pendingBg : undefined,
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
                      value: value,
                      options: [
                        { value: '', label: '默认' },
                        // 内置 default 与「默认」等价（服务端把 bind default 当解绑），
                        // 列出来只会让人以为有两个不同的选择。
                        ...packs
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
    function refreshChipName(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        chipName.set(null)
        return
      }
      const id = nextRequestId()
      api.workspace(sessionId).then(
        (view) => {
          if (id !== requestSeq) return
          chipName.set(view && view.packId !== DEFAULT_PACK_ID ? view.packName : null)
        },
        () => {
          if (id !== requestSeq) return
          // 读不到就退回 Default：chip 本身不能因此消失。
          chipName.set(null)
        },
      )
    }

    return {
      // 测试出口：只供 test/ 断言结构与纯逻辑用，运行期不要读它。
      __internals: { pendingKey, createQueue, frozenGroupNames, usePending, TABS, GroupsPage, PackSettings, WorkspacePage, PendingBar, CHIP_CSS },
      // `remote` 与 `remote.session` 都是独立服务名：只声明 `remote` 拿不到 session。
      // 声明是「服务在不在 ctx 上」的唯一开关；取用仍要 try/catch（ctx.get 对取不到的
      // 已声明服务会抛错）。缺了这两个，工作区页会空着。
      // `locale` 只用来判断 chip 的缺省文案该写「默认」还是 Default。
      inject: ['slots', 'remote', 'remote.session'],
      apply(ctx) {
        // 兜底：client 模块的 apply 抛错会把 web boot 判成 entry failed，桌面端整个起不来。
        // 任何意外都只降级成「面板不出来」，绝不连坐宿主。
        try {
          const host = createHost(ctx)

          // 组件必须是稳定标识符：内联箭头每次渲染都是新类型，React 会整棵卸载重挂
          // （AGENTS.md 客户端红线 4）。apply 只跑一次，闭包里拿 host 是安全的。
          const SettingsSection = () => h(SettingsPanel, { host: host })
          // 设置页侧栏的图标：宿主给 `settings.section.icon` 留了槽位，按 section 的 id
          // 匹配。不注册就落到 `navIcon(id)` 的通用齿轮上，那一排分不清谁是谁。
          const SettingsIcon = (props) => h(McpiIcon, { size: props && props.size ? props.size : 16 })
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: PANEL_ID, order: 62, label: () => TITLE },
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

          const McpChip = (props) => {
            const sessionId = props && props.sessionId ? props.sessionId : undefined
            env.sessionId = sessionId
            const name = useSyncExternalStore(chipName.subscribe, chipName.read, chipName.read)
            const isOpen = useSyncExternalStore(subscribeChip, readChipOpen, readChipOpen)
            useEffect(() => {
              chipSessionId.set(sessionId)
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
                  className: 'dsh-mcp-pack-chip',
                  'data-bound': bound ? 'true' : 'false',
                  style: S.chip,
                  title: bound ? 'mcp pack：' + label : 'mcp pack：未绑定（使用默认）',
                  onClick: () => {
                    chipOpen = !isOpen
                    notifyChip()
                  },
                },
                h(McpiIcon, { size: 14 }),
                h('span', { key: 'chip-text', className: 'dsh-mcp-pack-chip-text', style: S.chipText }, label),
              ),
            )
          }

          const ChipOverlay = () => {
            const isOpen = useSyncExternalStore(subscribeChip, readChipOpen, readChipOpen)
            const sessionId = useSyncExternalStore(chipSessionId.subscribe, chipSessionId.read, chipSessionId.read)
            return h(ChipModal, {
              open: isOpen,
              sessionId: sessionId,
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
                ctx.slots.register({ name: 'conversation.input.right', id: CHIP_ID, order: 41 }, McpChip),
              ),
            )
            chipDisposers.push(
              ctx.slots.inject('shell.overlay', () =>
                ctx.slots.register({ name: 'shell.overlay', id: MODAL_ID, order: 62 }, ChipOverlay),
              ),
            )
          }
          env.onChipChange = (visible) => {
            if (visible) registerChip()
            else unmountChip()
          }

          // 读一次 UI 开关决定挂不挂 chip。失败按缺省（显示）处理，不让入口整体缺失。
          api.global(env.sessionId).then(
            (view) => {
              env.onChipChange(uiOf(view).showChip)
            },
            () => {
              env.onChipChange(true)
            },
          )
        } catch (error) {
          console.error('dsh-mcp-pack: 客户端初始化失败', error)
        }
      },
    }
  },
})
