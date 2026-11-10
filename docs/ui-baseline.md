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

## 按钮与确认条

**8. 行内操作按钮抄官方设置页的尺寸。**
`ModelsSection.module.css` 的 `.rowActions .secondaryButton` / `.dangerButton` 是
`height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px;
border-radius: var(--dsw-radius-sm)`。裸文字按钮（`padding: 2px 4px`、无边框）的热区
只有字号那么高，指针要精确压住才点得中——这是"很难点"的全部原因。

**8b. 按钮分四档，别把"描边"当默认。**
`secondary` 透明底 + 浅描边，只用于行内操作（编辑）；`quiet` 无边框 + 浅灰底
（`--dsw-alias-interactive-bg-hover`），用于确认条上的撤销/放弃/关闭；`primary`
实心（`--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`），
只给保存；`danger` 红字无边框。透明底 + 描边在浅色面板上会读成一条黑框，看起来
像"被框住的错误"而不是按钮——确认条那排必须用 `quiet`。

**9. 危险按钮的颜色同样只能在类里。**
常态是红字、无边框、hover 用 `--dsw-alias-interactive-bg-hover-danger`；确认态照官方的
`dangerButton` 只换底色与字重——浅红底 + 红字 + 500，**不加描边**。官方没有任何
"加红描边"的危险按钮，那是自己发明的样式，观感上像被框住的一块错误。文案换成「确认」。
这条红线与第 7 条同源：内联写 `color` / `background` 会把 hover 与确认态一起压掉。

**10. 待保存的行铺整行浅底，不画左边框。**
`color-mix(in srgb, var(--dsw-alias-state-business-tertiary) 55%, transparent)`。
试过 `box-shadow: inset 2px 0 0`，真机上那条线紧贴行首的箭头与文字，`inset` 又没法给
文字让出间距，压字比不标更糟。浅底与官方标记「当前项」是同一套做法，也不和任何文字
抢位置。与「当前选中」的灰底同时命中时，待保存优先。

**11. 确认条贴住面板底边，不飘。**
`position: sticky; bottom: 0`，整块叫"停靠区"：上方是提示行（发生了一件当场必须知道的事，
例如"删除带走了你两项未保存改动"，带关闭），下方是待保存条。飘走的 toast 与"提示放在
标题下面"都不行——分包页有几百行，滚到中段就看不见了。弹层里是例外：底栏一行，左「关闭」
固定不动，右侧才是提示与「撤销 / 保存」——关闭的位置不能跟着待保存状态左右横跳。

**12. 面板内输入框的 Esc 必须 `stopPropagation`。**
宿主的设置弹层把 Esc 当"关闭面板"。不拦的话，改名改到一半按 Esc 以为在反悔，
结果整个面板连带未保存的改动一起没了。改名框、搜索框、新建框都要拦。

**13. 样式表要在每个挂载点各注入一次。**
设置页在 `settings.section`，chip 弹层在 `shell.overlay`，是两棵没有父子关系的 DOM。
把 `<style>` 只在设置页渲染，弹层里的按钮就只剩内联尺寸，边框与底色落回浏览器默认
——表现是"那边的按钮永远是一条黑框，改多少遍 CSS 都没用"。chip 图标那边同理。

**14. 可点行的状态底色用 `data-state`，不要内联。**
行同时有「当前」「待保存」和 hover 三种底色，内联写其中一种就把 `:hover` 压死（红线 7）。
统一用 `.dsh-skill-pack-row` + `data-state="current|pending"`，让 CSS 决定叠加顺序。
三态开关（开/关/跟随）是这个面板点得最多的控件，热区 24px 起；它原来只有 19px，
比被抱怨"太小"的删除按钮还小——小控件要整类地查，不要只改被指出来的那一个。

## 为什么要写这份文档

上面四条全是真渲染才暴露的坑：语法合法、`node --check` 通过、测试全绿，打开面板才发现
开关是一条白条。不写下来，下一个人（或三个月后的自己）会原样再踩一遍。

## 代码重复的现状

两个面板各有一份 `T` / `S`，约 200–290 行，几乎逐行相同。这是**有意保留**的：
界面基调还在漂移期（同一轮里改过四次：配色、底色、开关、分段）。现在抽公共包，抽出来的
接口八成是错的，而且会把「改一处要改两处」升级成「改一处要改三处」。

等它连续两次改动不再变动，再抽 `dsh-ui-kit`——届时抽的是稳定形状，不是猜测。

「待保存改动」这一轮（ADR 0006）又加了按钮、确认条、行标记三种形状。做法仍是先在
`dsh-skill-pack` 打样：观感在这种改动里第一次必然不准，早抽包会把错误接口固化。
等四个包都跟上、形状不再变，再考虑抽。
