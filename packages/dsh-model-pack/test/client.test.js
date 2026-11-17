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

/**
 * 把 client.js 装进一个假宿主。
 *
 * `platform` 必须显式给：沙箱里没有 `process` 时 `isWindows()` 恒为 false，
 * 而 `normalizeCwd` 在 Windows 下要转小写——那条分支在测试里永远走不到，
 * 生产上「bind 键两边算出来不等、待保存标记永不出现」就是这么漏的。
 */
function loadClient(platform = 'win32') {
  const captured = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => captured.push(entry) } },
    console,
    setTimeout,
    clearTimeout,
    process: { platform },
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
  for (const name of ["pendingKey","usePending","TABS","PackRoster","WorkspaceBoard","ChipModal","CHIP_CSS"]) assert.ok(__internals[name], '测试出口缺少 ' + name)
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

/** 名册的形状：`data.state.packs.packs`，见 `packsOf`。 */
function rosterOf(packs) {
  return { state: { packs: { packs } } }
}

/**
 * 顺序断言。
 *
 * 不能用 `deepEqual`：`packListOf` 跑在 vm 沙箱里，数组原型与宿主不是同一个，
 * 结构相同也会被判成不等。拼成字符串比。
 */
function orderOf(entries, key) {
  return entries.map((entry) => entry[key]).join(',')
}

test('pack 名册按名字排，default 恒置顶', () => {
  const { packListOf } = loadClient().__internals
  // id 与名字故意反序：按 id 排会得到 p1/p2/p3，按名字排才是 alpha/mid/zeta。
  const data = rosterOf({
    default: { name: '默认' },
    p1: { name: 'zeta' },
    p2: { name: 'alpha' },
    p3: { name: 'mid' },
  })
  assert.equal(orderOf(packListOf(data), 'name'), '默认,alpha,mid,zeta')
})

test('pack 重名时按 id 兜底，顺序仍是全序', () => {
  const { packListOf } = loadClient().__internals
  const data = rosterOf({ default: { name: '默认' }, p2: { name: '同名' }, p1: { name: '同名' } })
  assert.equal(orderOf(packListOf(data), 'id'), 'default,p1,p2')
})

test('待保存期间沿用改动前的 id 序，改名不跳位', () => {
  const { packListOf } = loadClient().__internals
  const before = rosterOf({ default: { name: '默认' }, p1: { name: 'alpha' }, p2: { name: 'zeta' } })
  // 把 alpha 改名成 zzz：按名字排它会跳到末尾，冻结序必须把它留在原位。
  const after = rosterOf({ default: { name: '默认' }, p1: { name: 'zzz' }, p2: { name: 'zeta' } })
  const frozenOrder = packListOf(before).map((entry) => entry.id)
  assert.equal(orderOf(packListOf(after, frozenOrder), 'id'), 'default,p1,p2')
  // 不冻结时按新名字排：p2 的 zeta 在 p1 的 zzz 之前。
  assert.equal(orderOf(packListOf(after), 'id'), 'default,p2,p1')
})

test('待保存键覆盖每一类可覆盖命令', () => {
  const { pendingKey } = loadClient().__internals
  assert.equal(typeof pendingKey, 'function')
  const CASES = [
    [{ op: 'packSession', packId: 'p1' }, 'packSession:p1'],
    [{ op: 'packTier', packId: 'p1', tierId: 'fast' }, 'packTier:p1:fast'],
    [{ op: 'putPack', packId: 'p1' }, 'pack:p1'],
    [{ op: 'renamePack', packId: 'p1' }, 'renamePack:p1'],
    // Windows 下 normalizeCwd 转小写：这条分支以前在沙箱里永远走不到。
    [{ op: 'bind', cwd: 'C:/w' }, 'bind:c:/w'],
    // ADR-0006 记的差异：提示词补丁每条只带自己那几个键，按单键去重会丢键。
    [{ op: 'putPrompts' }, null],
    // 复制与新建同类：每条都是独立一次决定，没有可覆盖的目标。
    [{ op: 'duplicatePack', packId: 'p1' }, null],
  ]
  for (const [command, expected] of CASES) {
    assert.equal(pendingKey(command), expected)
    // bind 是唯一例外：客户端按归一化后的 cwd 算键（渲染处也按它查），服务端按原值
    // 算（归一化发生在落盘时）。其余 op 两边必须逐字相同，否则同一格改动不会被去重。
    if (command.op === 'bind') continue
    assert.equal(pendingKeyOf(command), expected, '服务端规则与客户端漂移了：' + String(command.op))
  }
  assert.equal(pendingKey({ op: 'unknown-op' }), null, '可覆盖之外的命令不落格')
})

test('待保存键在非 Windows 平台不转小写', () => {
  // 同一份用例跑两遍：win32 转小写、linux 不转。两边算出来的键必须与服务端一致，
  // 否则「这一行有没有未保存改动」在某个平台上永远为假。
  const { pendingKey } = loadClient('linux').__internals
  assert.equal(pendingKey({ op: 'bind', cwd: 'C:/w' }), 'bind:C:/w')
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

test('冻结排序：改动前的 id 序变成 rank 表，未冻结时为空', () => {
  const { frozenRank } = loadClient().__internals
  const rank = frozenRank(['b', 'a'])
  assert.equal(rank.get('b'), 0)
  assert.equal(rank.get('a'), 1)
  assert.equal(rank.size, 2)
  assert.equal(frozenRank(undefined).size, 0, '没有冻结序时不产生 rank')
  assert.equal(frozenRank([]).size, 0)
})
