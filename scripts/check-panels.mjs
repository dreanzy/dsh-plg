#!/usr/bin/env node
/**
 * 面板的结构护栏。
 *
 * 这里不测渲染（仓库没有 DOM 测试环境），测两件更便宜、也更容易退化的东西：
 * 1. 三个 client 能被宿主的模块加载器解析，工厂返回带 `apply` 的对象；
 * 2. 上一轮为性能做的派生改造没有被改回去。
 *
 * 判据是「必须出现 / 必须不出现」的字符串，故意写得具体：改结构时会刻意改这里的
 * 断言，而不是在一次无关重构里悄悄丢掉预计算。
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
const RULES = {
  'dsh-skill-pack': {
    // 后一条：绑定下拉必须把内置 default 过滤掉，否则「默认」会出现两次。
    must: { 'TABS': 1, 'GroupsPage': 1, 'PackSettings': 1, 'WorkspacePage': 1, 'pack.id !== DEFAULT_PACK_ID': 2 },
    // 侧栏入口与单机开关已废弃：这两个字符串一旦回潮，就是又有人把面板挂回侧栏。
    mustNot: ['sidebar.panellist', 'showSidebarEntry'],
  },
  'dsh-plugin-pack': {
    must: { 'TABS': 1, 'GroupsPage': 1, 'PackSettings': 1, 'WorkspacePage': 1, 'CHIP_CSS': 1, 'pack.id !== DEFAULT_PACK_ID': 2 },
    // 侧栏入口与工作区层已废弃：这两个字符串一旦回潮，就是又有人把面板挂回侧栏。
    mustNot: ['sidebar.panellist', 'showSidebarEntry'],
  },
  'dsh-mcp-pack': {
    must: { 'TABS': 1, 'GroupsPage': 1, 'PackSettings': 1, 'WorkspacePage': 1, 'CHIP_CSS': 1, 'diagText': 2, 'pack.id !== DEFAULT_PACK_ID': 2 },
    // 侧栏入口已废弃、diag 的渲染表达式不再就地序列化：这两组字符串一旦回潮，
    // 就是又有人把面板挂回侧栏，或把预计算改回每次渲染重做。
    mustNot: ['sidebar.panellist', 'showSidebarEntry', '}, JSON.stringify(diag'],
  },
  'dsh-model-pack': {
    // 三页（分包 | 工作区 | 提示词）、分包页两块（名册 / 内容）、chip 摘要与容器查询、
    // 以及模型位的 pack 名标签：少了任何一个，都是这套结构被拆掉了一半。
    must: { 'TABS': 2, 'PackRoster': 2, 'WorkspaceBoard': 2, 'ChipModal': 2, 'CHIP_CSS': 2, 'labelView': 2, '!pack.isDefault': 2 },
    // 侧栏入口与单机侧栏开关已废弃：这两个字符串一旦回潮，就是又有人把面板挂回侧栏。
    // 后三条是旧命令契约（服务端只认 putPack / packSession / packTier / bind / …）：
    // 它们一旦回潮，所有保存都会拿到 bad-request。localStorage 同理——默认页与
    // 手动添加的路径已经搬到服务端，浏览器不该再存配置。
    mustNot: [
      'sidebar.panellist',
      'showSidebarEntry',
      'putScheme',
      'deleteScheme',
      'bindWorkspace',
      'localStorage',
    ],
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

/**
 * 客户端红线的冒烟：`apply` 抛错会让整个桌面端起不来，所以必须真的调一次。
 *
 * 假 ctx 的 `get` 一调就抛——宿主对取不到的已声明服务就是抛错，返回 undefined
 * 的假 ctx 会掩盖降级路径（AGENTS.md 客户端红线 3）。
 */
function smokeApply(mod) {
  const ctx = {
    get() {
      throw new Error('service unavailable')
    },
    slots: {
      inject(_name, callback) {
        callback()
        return () => undefined
      },
      register() {
        return () => undefined
      },
    },
  }
  try {
    mod.apply(ctx)
  } catch (error) {
    throw new Error(
      'apply 在服务缺失时抛错（桌面端会起不来）：' + String(error && error.message ? error.message : error),
    )
  }
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
    if (dir.name === 'dsh-plugin-pack') {
      try {
        smokeApply(loaded.mod)
      } catch (error) {
        failures += 1
        console.error(label + ': ' + String(error && error.message ? error.message : error))
        continue
      }
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
