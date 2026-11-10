import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pendingKeyOf } from '@dreanzy/dsh-pack-core'

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
  for (const [command, expected] of CASES) {
    assert.equal(pendingKey(command), expected)
    // 服务端与客户端算出来的键必须逐字相同，否则同一格改动不会被去重。
    assert.equal(pendingKeyOf(command), expected, '服务端规则与客户端漂移了：' + String(command.op))
  }
  assert.equal(pendingKey({ op: 'unknown-op' }), null, '可覆盖之外的命令不落格')
})

test('待保存队列：同键后写覆盖，键为 null 的命令各占一条', () => {
  const { createQueue, pendingKey } = loadClient().__internals
  const queue = createQueue(pendingKey)
  queue.push({ op: 'bind', cwd: 'C:/a' })
  queue.push({ op: 'bind', cwd: 'C:/a' })
  assert.equal(queue.count, 1, '同键必须覆盖，不是追加')
  queue.push({ op: 'createPack', packId: 'p1' })
  queue.push({ op: 'createPack', packId: 'p1' })
  assert.equal(queue.count, 3, '没有可覆盖目标的命令每条都独立')
  assert.equal(queue.keys().size, 1, '只有带键的条目进 keys')
  assert.equal(queue.commands().length, 3)
})

test('待保存队列：undo / discard / drop', () => {
  const { createQueue, pendingKey } = loadClient().__internals
  const queue = createQueue(pendingKey)
  queue.push([{ op: 'bind', cwd: 'C:/a' }, { op: 'createPack', packId: 'p1' }, { op: 'createPack', packId: 'p1' }])
  assert.equal(queue.count, 3)
  queue.undo()
  assert.equal(queue.count, 2)
  assert.equal(queue.drop((command) => command.packId === 'p1'), 1)
  assert.equal(queue.count, 1)
  assert.equal(queue.drop(() => true), 1)
  assert.equal(queue.count, 0)
  queue.push({ op: 'bind', cwd: 'C:/b' })
  queue.discard()
  assert.equal(queue.count, 0)
})

test('待保存队列：touch 换引用但不改内容，试算才会重跑', () => {
  const { createQueue, pendingKey } = loadClient().__internals
  const queue = createQueue(pendingKey)
  queue.push({ op: 'bind', cwd: 'C:/a' })
  const before = queue.entries
  const after = queue.touch()
  assert.notEqual(after, before, '引用必须换，否则 effect 不会重跑')
  assert.equal(queue.count, 1)
})

test('冻结排序：待保存期间沿用改动前的组名，未冻结时返回空表', () => {
  const { frozenGroupNames } = loadClient().__internals
  const base = { groups: { groups: [{ id: 'g1', name: 'alpha' }, { id: 'g2', name: 'beta' }] } }
  assert.equal(frozenGroupNames(base, false).size, 0, '未冻结时不提供回溯表')
  const map = frozenGroupNames(base, true)
  assert.equal(map.get('g1'), 'alpha')
  assert.equal(map.get('g2'), 'beta')
  assert.equal(frozenGroupNames(null, true).size, 0, '没有 base 也不能抛')
  assert.equal(frozenGroupNames({}, true).size, 0)
})
