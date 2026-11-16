import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScopeSnapshot } from '../lib/snapshot.js'

/**
 * 缓存行为：指纹短路、单飞、显式失效。
 * 「读盘几次」用依赖的调用计数判断，不再暴露只给测试用的计数接口。
 */
function policyOf(items = {}, overrides = {}) {
  const defaultPack = {
    name: 'default',
    items,
    groups: overrides.defaultGroups ?? {},
  }
  return {
    packs: { packs: { default: defaultPack } },
    ui: { showOfficialSkills: false, showChip: true, defaultTab: 'groups' },
    binding: overrides.binding ?? null,
    packId: overrides.packId ?? 'default',
    pack: overrides.pack ?? null,
    groups: { groups: [], assignments: overrides.assignments ?? {} },
    bindings: { bindings: {} },
    warnings: [],
  }
}

function row(name) {
  return { name, description: name + ' description', provider: 'filesystem', source: 'custom', path: '/root/skills/' + name }
}

function fixture(options = {}) {
  const calls = { loadPolicy: 0, readInventory: 0, fingerprint: 0 }
  let stamp = options.stamp ?? '0'
  let complete = options.complete !== false
  let rows = options.rows ?? [row('off-a'), row('on-b')]
  let items = options.items ?? { 'off-a': false }
  let overrides = options.overrides ?? {}
  const snapshot = createScopeSnapshot({
    loadPolicy: async () => {
      calls.loadPolicy += 1
      return policyOf(items, overrides)
    },
    readInventory: async () => {
      calls.readInventory += 1
      return { rows, complete }
    },
    fingerprint: async () => {
      calls.fingerprint += 1
      return stamp
    },
  })
  return {
    snapshot,
    calls,
    setStamp: (value) => { stamp = value },
    setRows: (value) => { rows = value },
    setComplete: (value) => { complete = value },
    setItems: (value) => { items = value },
    setOverrides: (value) => { overrides = value },
  }
}

test('同键二次刷新被指纹短路，不重读磁盘', async () => {
  const f = fixture()
  await f.snapshot.refresh('/proj')
  assert.equal(f.calls.readInventory, 1)
  await f.snapshot.refresh('/proj')
  assert.equal(f.calls.readInventory, 1)
})

test('指纹变化触发重读', async () => {
  const f = fixture()
  await f.snapshot.refresh('/proj')
  f.setStamp('1')
  await f.snapshot.refresh('/proj')
  assert.equal(f.calls.readInventory, 2)
})

test('显式失效后下一次刷新重读', async () => {
  const f = fixture()
  await f.snapshot.refresh('/proj')
  f.snapshot.invalidate('/proj')
  await f.snapshot.refresh('/proj')
  assert.equal(f.calls.readInventory, 2)
})

test('并发刷新同一格只算一次', async () => {
  const f = fixture()
  const [first, second] = await Promise.all([f.snapshot.refresh('/proj'), f.snapshot.refresh('/proj')])
  assert.equal(f.calls.readInventory, 1)
  assert.equal(f.calls.loadPolicy, 1)
  assert.equal(first, second)
})

test('同 cwd 不同 scope 互不命中', async () => {
  const f = fixture()
  const scopeA = {}
  const scopeB = {}
  const a = await f.snapshot.refresh('/proj', scopeA)
  assert.deepEqual(a.hidden, ['off-a'])
  f.setItems({})
  const b = await f.snapshot.refresh('/proj', scopeB)
  assert.deepEqual(b.hidden, [])
  assert.equal(f.calls.readInventory, 2)
  // 指纹没变：A 仍然命中自己的那一格，不会读到 B 的清单。
  const again = await f.snapshot.refresh('/proj', scopeA)
  assert.deepEqual(again.hidden, ['off-a'])
  assert.equal(f.calls.readInventory, 2)
})

test('按目录失效不影响别的目录', async () => {
  const f = fixture()
  await f.snapshot.refresh('/a')
  await f.snapshot.refresh('/b')
  assert.equal(f.calls.readInventory, 2)
  f.snapshot.invalidate('/a')
  await f.snapshot.refresh('/a')
  assert.equal(f.calls.readInventory, 3)
  await f.snapshot.refresh('/b')
  assert.equal(f.calls.readInventory, 3)
})

test('清单不完整时不算隐藏集', async () => {
  const f = fixture({ complete: false })
  const value = await f.snapshot.refresh('/proj')
  assert.equal(value.complete, false)
  assert.deepEqual(value.hidden, [])
})

test('不传 cwd 的调用落在全局那一格', async () => {
  const f = fixture()
  const first = await f.snapshot.refresh(null)
  const second = await f.snapshot.refresh(null)
  assert.equal(first, second)
  assert.equal(f.calls.readInventory, 1)
})

test('绑定 pack 的开关参与求值，未被覆盖的项跟随 default', async () => {
  const f = fixture({
    items: { inherited: false },
    overrides: {
      binding: 'p1',
      packId: 'p1',
      pack: { name: 'p1', items: { own: false }, groups: {} },
    },
    rows: [row('own'), row('inherited'), row('visible')],
  })
  const value = await f.snapshot.refresh('/proj')
  assert.deepEqual(value.hidden, ['inherited', 'own'])
  assert.equal(value.policy.packId, 'p1')
})

test('Windows 上同一目录的两种写法命中同一格', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture()
  await f.snapshot.refresh('D:/Projects/Sample')
  await f.snapshot.refresh('d:\\projects\\sample\\')
  assert.equal(f.calls.readInventory, 1)
})
test('在飞的 refresh 被 invalidate 后不把旧值写回缓存', async () => {
  // 让 loadPolicy 卡住，制造「refresh 在飞时被失效」的窗口。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let items = { 'off-a': false }
  let calls = 0
  const snapshot = createScopeSnapshot({
    loadPolicy: async () => {
      calls += 1
      if (calls === 1) await gate
      return policyOf(items)
    },
    readInventory: async () => ({ rows: [row('off-a')], complete: true }),
    fingerprint: async () => '0',
  })

  const pending = snapshot.refresh('/proj')
  // 失效发生在计算中途：指纹不变，只有世代号能区分。
  snapshot.invalidate('/proj')
  items = {}
  release()
  await pending

  // 旧值不得留在缓存里：下一次 refresh 必须重算并看到新策略。
  const after = await snapshot.refresh('/proj')
  assert.deepEqual(after.hidden, [], '失效后必须读到新策略，而不是被写回的旧值')
  assert.equal(calls, 2, '旧值写回会让第二次刷新命中缓存，不再读盘')
})
