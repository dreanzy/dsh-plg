import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScopeSnapshot } from '../lib/snapshot.js'

/**
 * 本文件只为 `PolicyState` 换了新形状（pack 名册 + 绑定），缓存行为与旧用例一致。
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
    bindings: { bindings: {}, extra: [] },
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

test('read 未命中返回 null，且不触发任何依赖', () => {
  const f = fixture()
  assert.equal(f.snapshot.read('/proj'), null)
  assert.deepEqual({ ...f.calls }, { loadPolicy: 0, readInventory: 0, fingerprint: 0 })
  assert.equal(f.snapshot.stats().misses, 1)
  assert.equal(f.snapshot.stats().hits, 0)
})

test('同键二次刷新被指纹短路，不重读磁盘', async () => {
  const f = fixture()
  await f.snapshot.refresh('/proj')
  assert.equal(f.snapshot.stats().reads, 1)
  await f.snapshot.refresh('/proj')
  assert.equal(f.snapshot.stats().reads, 1)
  assert.equal(f.calls.readInventory, 1)
  assert.equal(f.snapshot.stats().refreshes, 2)
})

test('指纹变化触发重读', async () => {
  const f = fixture()
  await f.snapshot.refresh('/proj')
  f.setStamp('1')
  await f.snapshot.refresh('/proj')
  assert.equal(f.snapshot.stats().reads, 2)
})

test('显式失效后下一次刷新重读', async () => {
  const f = fixture()
  await f.snapshot.refresh('/proj')
  f.snapshot.invalidate('/proj')
  assert.equal(f.snapshot.read('/proj'), null)
  await f.snapshot.refresh('/proj')
  assert.equal(f.snapshot.stats().reads, 2)
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
  assert.equal(f.snapshot.stats().reads, 2)
  assert.deepEqual(f.snapshot.read('/proj', scopeA).hidden, ['off-a'])
})

test('按目录失效不影响别的目录', async () => {
  const f = fixture()
  await f.snapshot.refresh('/a')
  await f.snapshot.refresh('/b')
  f.snapshot.invalidate('/a')
  assert.equal(f.snapshot.read('/a'), null)
  assert.notEqual(f.snapshot.read('/b'), null)
})

test('清单不完整时不算隐藏集', async () => {
  const f = fixture({ complete: false })
  const value = await f.snapshot.refresh('/proj')
  assert.equal(value.complete, false)
  assert.deepEqual(value.hidden, [])
})

test('不传 cwd 的调用落在全局那一格', async () => {
  const f = fixture()
  await f.snapshot.refresh(null)
  assert.notEqual(f.snapshot.read(null), null)
  assert.equal(f.snapshot.stats().reads, 1)
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
  assert.notEqual(f.snapshot.read('d:\\projects\\sample\\'), null)
  assert.equal(f.snapshot.stats().reads, 1)
})
