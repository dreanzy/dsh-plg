import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * 客户端面板的测试面。
 *
 * 这里不测渲染（仓库没有 DOM 环境），测三件会被结构漂移破坏、又真能回归的东西：
 * 1. factory 的测试出口还在——替代 scripts/check-panels.mjs 里的字符串计数；
 * 2. `apply` 在服务缺失时不抛：它抛错会把 web boot 判成 entry failed，桌面端起不来；
 * 3. 待保存队列的键规则：同键后写覆盖，不可覆盖的命令不落格。
 *
 * 宿主全程是假的：vm 里只有一个捕获 factory 的 window，React 是桩。
 */
const CLIENT = new URL('../client/client.js', import.meta.url)

const fakeReact = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
  useState: (initial) => [initial, () => undefined],
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, read) => read(),
}

function loadClient() {
  const captured = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => captured.push(entry) } },
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })
  assert.equal(captured.length, 1, '模块必须通过 __ModuleLoader__.load 注册一次')
  const entry = captured[0]
  assert.equal(typeof entry.factory, 'function')
  const mod = entry.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('工厂请求了未提供的模块：' + String(name))
  })
  assert.equal(typeof mod.apply, 'function', 'factory 的返回值缺少 apply')
  return mod
}

test('factory 暴露测试出口', () => {
  const { __internals } = loadClient()
  assert.ok(__internals, '缺少 __internals 测试出口')
  for (const name of ["pendingKey","usePending","TABS","GroupsPage","PackSettings","WorkspacePage","PendingBar","CHIP_CSS"]) assert.ok(__internals[name], '测试出口缺少 ' + name)
})

test('apply 在服务缺失时只降级，不抛错', () => {
  const { apply } = loadClient()
  const ctx = {
    get() {
      throw new Error('service unavailable')
    },
    on() {
      return () => undefined
    },
    effect() {
      return undefined
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
  assert.doesNotThrow(() => apply(ctx))
})

test('待保存键覆盖每一类可覆盖命令', () => {
  const { pendingKey } = loadClient().__internals
  assert.equal(typeof pendingKey, 'function')
  const CASES = [
    [{ op: 'packRow', packId: 'p1', rowKey: 'r1' }, 'packRow:p1:r1'],
    [{ op: 'packGroup', packId: 'p1', groupId: 'g1' }, 'packGroup:p1:g1'],
    [{ op: 'bind', cwd: 'C:/w' }, 'bind:C:/w'],
    [{ op: 'assign', rowKey: 'r1' }, 'assign:r1'],
    [{ op: 'renamePack', packId: 'p1' }, 'renamePack:p1'],
    [{ op: 'renameGroup', groupId: 'g1' }, 'renameGroup:g1'],
  ]
  for (const [command, expected] of CASES) assert.equal(pendingKey(command), expected)
  assert.equal(pendingKey({ op: 'unknown-op' }), null, '可覆盖之外的命令不落格')
})
