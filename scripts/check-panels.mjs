/**
 * 面板的结构护栏。
 *
 * 这里不测渲染（仓库没有 DOM 测试环境），只留两件跨包、且用字符串最便宜的事：
 * 1. 每个 client 能被宿主的模块加载器解析，工厂返回带 `apply` 的对象；
 * 2. 已废弃的结构与旧命令契约没有回潮（mustNot）。
 *
 * 能符号化的结构断言与行为用例已搬到各包的 test/client.test.js：它们通过 factory 的
 * `__internals` 出口断言，改名或删结构会让用例直接失败，不必等这里数不到字符串。
 * `apply` 抛错的红线冒烟也在那里——四包各跑一次，而不是只跑一个。
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')

const fakeReact = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
  useState: (initial) => [initial, () => undefined],
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, read) => read(),
}

/** 每个面板的断言。count 表示出现次数，未写表示「至少一次」。 */
/**
 * 每个面板的结构断言。
 *
 * 只留无法用符号表达的那几条：它们是渲染表达式里的判据，字符串计数是验证它们仍在的
 * 最低成本方式。可符号化的结构（TABS、各页面组件、待保存队列）已搬进各包的
 * test/client.test.js，由 factory 的 __internals 出口断言——改名或删结构会让用例
 * 直接失败，而不是等这里数不到字符串。
 */
const RULES = {
  'dsh-skill-pack': {
    must: { 'pack.id !== DEFAULT_PACK_ID': 1, 'dryRun': 1 },
    // 侧栏入口与单机开关已废弃：一旦回潮，就是又有人把面板挂回侧栏。
    // 求值链已收进服务端：客户端再写一遍 rankOf / diffOf / itemValue / groupValue
    // 就是把链复制回来，显示态会与服务端静默漂移。
    mustNot: [
      'sidebar.panellist',
      'showSidebarEntry',
      'function rankOf(',
      'function diffOf(',
      'function itemValue(',
      'function groupValue(',
    ],
  },
  'dsh-plugin-pack': {
    must: { 'pack.id !== DEFAULT_PACK_ID': 1, 'dryRun': 1 },
    mustNot: [
      'sidebar.panellist',
      'showSidebarEntry',
      'function rankOf(',
      'function diffOf(',
      'function itemValue(',
      'function groupValue(',
      'function rowOpen(',
    ],
  },
  'dsh-mcp-pack': {
    must: { 'diagText': 2, 'pack.id !== DEFAULT_PACK_ID': 1, 'dryRun': 1 },
    // diag 的渲染表达式不再就地序列化：回潮就是把预计算改回每次渲染重做。
    // 求值链已收进服务端，理由同 skill。
    mustNot: [
      'sidebar.panellist',
      'showSidebarEntry',
      '}, JSON.stringify(diag',
      'function rankOf(',
      'function diffOf(',
      'function groupValueOf(',
    ],
  },
  'dsh-model-pack': {
    must: { '!pack.isDefault': 1, 'labelView': 2, 'dryRun': 1 },
    // 后三条是旧命令契约；localStorage 同理——配置已经搬到服务端。
    mustNot: ['sidebar.panellist', 'showSidebarEntry', 'putScheme', 'deleteScheme', 'bindWorkspace', 'localStorage'],
  },
}

/**
 * 剥掉块注释与行注释。
 *
 * 计数与判据都只该看代码：`dryRun` 这类词在注释里出现 3-6 次，把代码里的用法删掉
 * 计数仍然达标；反过来，注释里解释「为什么不用 X」也会让禁用判据误报。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

/**
 * 界面基调红线里能用字符串表达的那几条（见 docs/ui-baseline.md）。
 *
 * 只收「当前已满足、且回潮会静默坏掉」的：不测渲染，测的是「这条纪律还在不在」。
 * 真正的样式正确性要真渲染才看得见，这里挡的是回潮。
 */
const BASELINE = [
  {
    // 红线 12：宿主的设置弹层把 Esc 当「关闭面板」。不拦的话，改名改到一半按 Esc
    // 以为在反悔，结果整个面板连带未保存的改动一起没了。
    name: '每个 onKeyDown 都拦 Esc',
    check(source) {
      const handlers = source.match(/onKeyDown:s*(event)s*=>s*{/g) ?? []
      const stopEscape = (source.match(/stopEscape(event)/g) ?? []).length
      const inline = (source.match(/event.key === 'Escape'/g) ?? []).length
      // 每个内联 handler 要么自己判 Escape，要么调 stopEscape；两者加起来要够。
      return handlers.length === 0 || stopEscape + inline >= handlers.length
    },
    detail: '有 onKeyDown 没拦 Esc：宿主的设置弹层会把它当「关闭面板」',
  },
  {
    // 红线 13：设置页在 settings.section，chip 弹层在 shell.overlay，是两棵没有父子
    // 关系的 DOM。样式表只在一处渲染，另一处的按钮就只剩内联尺寸。
    name: '样式表在两个挂载点各注入一次',
    check(source) {
      return (source.match(/CHIP_CSS/g) ?? []).length >= 2 && (source.match(/PANEL_CSS/g) ?? []).length >= 2
    },
    detail: 'CHIP_CSS / PANEL_CSS 只被引用一次：另一个挂载点的按钮会落回浏览器默认样式',
  },
  {
    // 红线 14：行同时有「当前」「待保存」和 hover 三种底色，内联写其中一种就把
    // :hover 压死。统一用 data-state 让 CSS 决定叠加顺序。
    name: '可点行的状态底色走 data-state',
    check(source) {
      return (source.match(/data-state/g) ?? []).length >= 2
    },
    detail: '没有 data-state：行状态底色只能内联，会把 :hover 压死',
  },
  {
    // 红线 2：--dsw-alias-state-idle-primary 在暗色主题下解析成接近白色，与白色圆点
    // 叠成一条纯白胶囊，开与关完全看不出。开关必须用反色。
    name: '开关不用 state-idle-primary',
    check(source) {
      // 注释里提到它是允许的——`T` 的注释正是在解释「为什么不用它」。
      // 只查代码：剥掉块注释与行注释再判。
      return !stripComments(source).includes('--dsw-alias-state-idle-primary')
    },
    detail: '开关用了 --dsw-alias-state-idle-primary：暗色主题下会变成一条白条',
  },
  {
    // 分包页编辑的是**用户选中的**那张 pack，服务端行上的 itemWorkspace / landing /
    // groupWorkspace 算的是**工作区绑定的**那张。两者不是一回事：全局视图里
    // policy.pack 恒为 null，拿它渲染会让每张 pack 都显示成同一份值——默认 pack 里
    // 显式关掉的项显示成「开」，其余 pack 全显示成「跟随」。
    name: '分包页不读工作区求值字段',
    check(source) {
      return !/\brow\.(itemWorkspace|landing|groupWorkspace|groupGlobal)\b/u.test(stripComments(source))
    },
    detail: '分包页读了 row.itemWorkspace / row.landing：那是工作区绑定的 pack，不是用户选中的那张',
  },
  {
    // 2026-11-18 真出过：残留键组件在三个包里都写了 `style: S.action`，但只有
    // plugin-pack 有这个样式键。另外两包拿到 `undefined`，按钮落回浏览器默认样式
    // ——用户看到的是「一条黑框」，而 `node --check`、单测、check-panels 全绿。
    //
    // 判据：源码里引用的每个 `S.<键>` 都必须在同一个文件的 `S = {` 里定义过。
    // 只查 S 不查 T：T 是颜色常量，漏了会直接报 undefined 而不是静默降级。
    name: '引用的 S 样式键都有定义',
    check(source) {
      const code = stripComments(source)
      const start = code.indexOf('const S = {')
      if (start < 0) return true
      // 从 `const S = {` 起找到配对的 `}`：按花括号深度扫，跳过字符串。
      let depth = 0
      let end = -1
      let quote = null
      for (let index = start; index < code.length; index += 1) {
        const char = code[index]
        if (quote !== null) {
          if (char === '\\') { index += 1; continue }
          if (char === quote) quote = null
          continue
        }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue }
        if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) { end = index; break }
        }
      }
      if (end < 0) return true
      const body = code.slice(start, end)
      // 定义：行首缩进后的 `键:` 或 `键(`（函数式样式）。
      const defined = new Set()
      for (const match of body.matchAll(/^\s{4,}([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/gmu)) defined.add(match[1])
      // 引用：`S.键`，排除 `S.键(` 之外的属性链（`S.a.b` 只取 a）。
      for (const match of code.matchAll(/\bS\.([A-Za-z_][A-Za-z0-9_]*)/gu)) {
        if (!defined.has(match[1])) return false
      }
      return true
    },
    detail: '引用了未定义的 S 样式键：该处 style 会拿到 undefined，控件落回浏览器默认样式',
  },
  {
    // 分包页的档位要判「选中的是不是 default pack」，不是「选中的是不是 null」。
    // default pack 在数据里是真实对象，永远不为 null——写成 sortPack === null 会让
    // isDefault 恒假，default 里没记录的项被算成「跟随」而不是「开」，于是「关」
    // 排到了「开」前面。
    name: '分包页档位判 isDefault 而不是 null',
    check(source) {
      // 逐行判：`packRankOf(packItemOf(...), sortPack === null, ...)` 里第一个参数自带
      // 括号，用 `[^)]*` 会在那里停住，判据形同虚设。
      for (const line of stripComments(source).split('\n')) {
        if (line.includes('packRankOf(') && line.includes('=== null')) return false
      }
      return true
    },
    detail: 'packRankOf 的 isDefault 参数写成了 `xxx === null`：default pack 是真实对象，恒不为 null',
  },
]

function loadFactory(path) {
  const captured = []
  // `process.platform` 必须给：沙箱里没有它时 `isWindows()` 恒为 false，而
  // `normalizeCwd` 在 Windows 下要转小写——那条分支在检查里永远走不到。
  // 与各包 `test/client.test.js` 的 `loadClient` 保持同一份沙箱形状。
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => captured.push(entry) } },
    console,
    setTimeout,
    clearTimeout,
    process: { platform: 'win32' },
  }
  vm.runInNewContext(readFileSync(path, 'utf8'), sandbox, { filename: path })
  if (captured.length !== 1) throw new Error('模块没有通过 __ModuleLoader__.load 注册一次')
  const entry = captured[0]
  if (typeof entry.id !== 'string' || entry.id === '') throw new Error('模块缺少 id')
  if (typeof entry.factory !== 'function') throw new Error('模块缺少 factory')
  const mod = entry.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('工厂请求了未提供的模块：' + String(name))
  })
  if (typeof mod !== 'object' || mod === null) throw new Error('factory 没有返回对象')
  if (typeof mod.apply !== 'function') throw new Error('factory 的返回值缺少 apply')
  return { entry, mod }
}

let failures = 0
let checked = 0

let dirs
try {
  dirs = await readdir(packagesDir, { withFileTypes: true })
} catch {
  console.log('panels: 没有 packages 目录，跳过')
  process.exit(0)
}

for (const dir of dirs) {
  if (!dir.isDirectory()) continue
  const clientDir = join(packagesDir, dir.name, 'client')
  let files
  try {
    files = await readdir(clientDir)
  } catch {
    continue
  }
  for (const file of files) {
    if (!file.endsWith('.js')) continue
    const path = join(clientDir, file)
    const label = dir.name + '/client/' + file
    checked += 1
    let loaded
    try {
      loaded = loadFactory(path)
    } catch (error) {
      failures += 1
      console.error(label + ': 无法作为宿主模块加载 —— ' + String(error && error.message ? error.message : error))
      continue
    }
    const source = readFileSync(path, 'utf8')
    // 计数前先剥注释：`dryRun` 这类词在注释里出现 3-6 次，把代码里的用法删掉
    // 计数仍然达标，断言形同虚设。
    const code = stripComments(source)
    const rules = RULES[dir.name]
    if (rules === undefined) continue
    for (const [needle, count] of Object.entries(rules.must ?? {})) {
      const actual = code.split(needle).length - 1
      if (actual < count) {
        failures += 1
        console.error(label + ': 缺少 `' + needle + '`（期望至少 ' + count + ' 处，实际 ' + actual + '）')
      }
    }
    for (const needle of rules.mustNot ?? []) {
      if (source.includes(needle)) {
        failures += 1
        console.error(label + ': 不应再出现 `' + needle + '`（派生已被预计算取代）')
      }
    }
  }
}

// 界面基调红线：对每个面板文件跑一遍。
for (const dir of dirs) {
  if (!dir.isDirectory()) continue
  const clientDir = join(packagesDir, dir.name, 'client')
  let files
  try {
    files = await readdir(clientDir)
  } catch {
    continue
  }
  for (const file of files) {
    if (!file.endsWith('.js')) continue
    const path = join(clientDir, file)
    const label = dir.name + '/client/' + file
    const source = readFileSync(path, 'utf8')
    for (const rule of BASELINE) {
      if (rule.check(source)) continue
      failures += 1
      console.error(label + ': ' + rule.name + ' —— ' + rule.detail)
    }
  }
}

if (checked === 0) {
  console.error('panels: 没有加载到任何面板文件——目录改名或权限问题会让这条检查静默失效')
  process.exit(1)
}

if (failures > 0) {
  console.error('')
  console.error('面板结构检查失败 ' + failures + ' 处')
  process.exit(1)
}
console.log('panels: ok（加载 ' + checked + ' 个面板文件，派生断言全部满足）')
