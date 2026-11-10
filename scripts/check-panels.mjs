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
    mustNot: ['sidebar.panellist', 'showSidebarEntry'],
  },
  'dsh-plugin-pack': {
    must: { 'pack.id !== DEFAULT_PACK_ID': 1, 'dryRun': 1 },
    mustNot: ['sidebar.panellist', 'showSidebarEntry'],
  },
  'dsh-mcp-pack': {
    must: { 'diagText': 2, 'pack.id !== DEFAULT_PACK_ID': 1, 'dryRun': 1 },
    // diag 的渲染表达式不再就地序列化：回潮就是把预计算改回每次渲染重做。
    mustNot: ['sidebar.panellist', 'showSidebarEntry', '}, JSON.stringify(diag'],
  },
  'dsh-model-pack': {
    must: { '!pack.isDefault': 1, 'labelView': 2, 'dryRun': 1 },
    // 后三条是旧命令契约；localStorage 同理——配置已经搬到服务端。
    mustNot: ['sidebar.panellist', 'showSidebarEntry', 'putScheme', 'deleteScheme', 'bindWorkspace', 'localStorage'],
  },
}

function loadFactory(path) {
  const captured = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => captured.push(entry) } },
    console,
    setTimeout,
    clearTimeout,
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
    const rules = RULES[dir.name]
    if (rules === undefined) continue
    for (const [needle, count] of Object.entries(rules.must ?? {})) {
      const actual = source.split(needle).length - 1
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

if (failures > 0) {
  console.error('')
  console.error('面板结构检查失败 ' + failures + ' 处')
  process.exit(1)
}
console.log('panels: ok（加载 ' + checked + ' 个面板文件，派生断言全部满足）')
