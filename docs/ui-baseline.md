# 界面基调（UI baseline）

本仓库的插件面板共用一套视觉基调。这份文档只记**为什么**与红线；具体像素、圆角、
过渡时长以各包 `client/client.js` 里的 `T` / `S` 为准——把它们抄进文档必然漂移，
而且漂移了没人会发现。

## 红线

**1. 只用宿主的 `--dsw-*` 变量，不引第三方插件的 CSS 变量。**
`--dsh-dream-skin-popup-fill` 这类变量随它自家主题走，在官方暗色主题下偏亮，整块面板
会发灰；对方没装时变量还会落空。这条由 `scripts/check-ui-vars.mjs` 自动拦住。

**2. 开关的颜色语义不要按变量名猜。**
`--dsw-alias-state-idle-primary` 在暗色主题下解析成接近白色，与白色圆点叠成一条纯白
胶囊，开与关完全看不出——这个坑真的踩过。开关用反色：开态轨道取
`--dsw-alias-label-primary`（暗色下亮白）配 `--dsw-alias-bg-layer-1` 圆点（近黑），
关态用中灰轨道配浅圆点。反色在亮暗两套主题里都成立，也不依赖品牌色。

**3. 不用品牌色做实心高亮。**
分段控件、标签这类小块元素用「浅底 + 主文字色」。品牌蓝实心块在暗色主题下会盖掉周围
所有信息，官方设置页也不是那个观感。

**4. 面板底色用 `--dsw-alias-bg-layer-1`。**
`--dsw-alias-bg-overlay` 在暗色主题下绑的是 `neutral-bluish-700`（中灰），弹窗会比页面
亮一大截；它的语义是「半透明浮层」，本来就不该当卡片底。layer-1 与页面同色，界线交给
边框与阴影。

**5. 浅底高亮只能用 `--dsw-alias-state-business-tertiary`，不能用 `bg-layer-1/2`。**
`bg-layer-2` 在亮色主题下与 layer-1 同为 `#fff`，拿它做浅底在亮色下完全看不见——
暗色下它确实比 layer-1 亮一档（`#2c2c2e` vs `#232324`），所以只在暗色主题里试会以为
它成立。跨主题成立的浅底只有 `state-business-tertiary`（亮 `#e4edfd` / 暗 `#34415b`），
配 `state-business-primary`（亮 `#4176e6` / 暗 `#7aaaff`）作文字色。官方 `PlanChip`
就是这个范式，红线 3 禁的是品牌色**实心**块，浅底加主文字色正是它推荐的写法。

**6. 输入框右侧的 chip 尺寸对齐官方控件。**
`conversation.input.right` 里官方没注册任何东西，但紧邻的 `conversation.input.model`
（ModelSelect trigger）与输入栏左侧的 `PlanChip` 给了两套可直接抄的规格：都是
`height: 28px`、`font-size: 13px`、`border-radius: var(--dsw-radius-sm)`（8px）、
`gap: 4px`、glyph 14×14。弱化态（未配置）抄 trigger：透明底、`label-secondary` 字、
`border: none`、hover 用 `--dsw-alias-interactive-bg-hover`；强调态（已配置）抄 PlanChip：
`state-business-tertiary` 底、`state-business-primary` 字、`font-weight: 500`、
hover 用 `color-mix(in srgb, tertiary, primary 6%)`。两态只换颜色不换尺寸，否则切换时
chip 会横向跳动；尺寸里必须带 `box-sizing: border-box`，否则带边框的那一态会高 2px。

**7. 内联 style 里的 `background` / `color` 会压掉 `:hover`。**
内联样式的优先级高于任何类选择器，所以「内联写底色 + CSS 写 hover」的组合一定失败——
hover 规则还在、语法也没错，只是永远不生效。要给控件做 hover，颜色必须整体移进类选择器，
内联只留尺寸与排布。这个坑在 chip 上踩过一次：CSS 里的 `:hover` 写得完全正确，
界面上鼠标移上去却毫无反应。

## 为什么要写这份文档

上面四条全是真渲染才暴露的坑：语法合法、`node --check` 通过、测试全绿，打开面板才发现
开关是一条白条。不写下来，下一个人（或三个月后的自己）会原样再踩一遍。

## 代码重复的现状

两个面板各有一份 `T` / `S`，约 200–290 行，几乎逐行相同。这是**有意保留**的：
界面基调还在漂移期（同一轮里改过四次：配色、底色、开关、分段）。现在抽公共包，抽出来的
接口八成是错的，而且会把「改一处要改两处」升级成「改一处要改三处」。

等它连续两次改动不再变动，再抽 `dsh-ui-kit`——届时抽的是稳定形状，不是猜测。
