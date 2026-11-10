import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScopeSnapshot } from '../lib/snapshot.js'

function row(rowKey, serverName) {
  return {
    rowKey,
    serverName,
    transport: 'stdio',
    definition: 'node x.js',
    source: 'profile',
    sourcePath: null,
    owned: false,
    declaredDisabled: false,
    config: { transport: 'stdio', serverName, command: 'node', args: ['x.js'] },
    entryId: rowKey,
  }
}

function emptyPack(name = 'default') {
  return { name, groups: {}, rows: {} }
}

function packOf(rows = {}, groups = {}, name = 'p1') {
  return { name, groups, rows }
}

/** 造一份 `PolicyState` 形状的最小对象；`pack` 为 null 表示按 default 求值。 */
function policyOf({ pack = null, packId = 'default', defaultPack = emptyPack(), assignments = {}, binding = null } = {}) {
  const packs = { default: defaultPack }
  if (pack !== null) packs[packId] = pack
  // 注册表按 assignments 里的 id 补齐：悬空引用要测的话，直接在用例里构造 policy。
  const groupIds = [...new Set(Object.values(assignments))]
  return {
    packs: { packs },
    ui: { showChip: true, defaultTab: 'groups' },
    binding,
    packId: pack === null ? 'default' : packId,
    pack,
    groups: { groups: groupIds.map((id) => ({ id, name: id })), assignments },
    bindings: { bindings: binding === null ? {} : { 'd:/proj': binding } },
    warnings: [],
  }
}

function stdioDef(command) {
  return { transport: 'stdio', command: command, args: [], env: {}, cwd: '' }
}

function fixture(options = {}) {
  const calls = { scan: 0, load: 0, fingerprint: 0 }
  let stamp = options.stamp ?? '0'
  let scanned = options.rows ?? [row('global:a', 'a'), row('global:b', 'b')]
  let policy = options.policy ?? policyOf({ defaultPack: packOf({ 'global:b': { mode: 'eager' } }, {}, 'default') })
  let owned = options.owned ?? { version: 1, servers: {} }
  const snapshot = createScopeSnapshot({
    scan: () => {
      calls.scan += 1
      return { rows: scanned, complete: true, warnings: [] }
    },
    load: async () => {
      calls.load += 1
      return { policy, owned, warnings: [] }
    },
    fingerprint: async () => {
      calls.fingerprint += 1
      return stamp
    },
  })
  return {
    snapshot,
    calls,
    setStamp: (value) => {
      stamp = value
    },
    setPolicy: (value) => {
      policy = value
    },
    setOwned: (value) => {
      owned = value
    },
  }
}

test('read 未命中返回 null 且不触发任何依赖', () => {
  const f = fixture()
  assert.equal(f.snapshot.read('D:/proj'), null)
  assert.deepEqual({ ...f.calls }, { scan: 0, load: 0, fingerprint: 0 })
})

test('同键二次刷新被指纹短路', async () => {
  const f = fixture()
  await f.snapshot.refresh('D:/proj')
  await f.snapshot.refresh('D:/proj')
  assert.equal(f.snapshot.stats().reads, 1)
  assert.equal(f.calls.load, 1)
})

test('显式失效后重读', async () => {
  const f = fixture()
  await f.snapshot.refresh('D:/proj')
  f.snapshot.invalidate('D:/proj')
  await f.snapshot.refresh('D:/proj')
  assert.equal(f.snapshot.stats().reads, 2)
})

test('并发刷新同一格只算一次', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.snapshot.refresh('D:/proj'), f.snapshot.refresh('D:/proj')])
  assert.equal(a, b)
  assert.equal(f.calls.load, 1)
})

test('cwd 的写法归一后命中同一格', async () => {
  const f = fixture()
  await f.snapshot.refresh('D:/Proj/')
  await f.snapshot.refresh(process.platform === 'win32' ? 'd:\\proj' : 'D:/Proj')
  assert.equal(f.snapshot.stats().reads, 1)
})

test('不同 scope 同 cwd 互不命中', async () => {
  const f = fixture()
  const scopeA = {}
  const scopeB = {}
  await f.snapshot.refresh('D:/proj', scopeA)
  await f.snapshot.refresh('D:/proj', scopeB)
  assert.equal(f.snapshot.stats().reads, 2)
})

test('名册只收允许且非 eager 的行', async () => {
  const f = fixture({
    policy: policyOf({
      defaultPack: packOf(
        { 'global:b': { mode: 'eager' }, 'global:c': { enabled: false } },
        {},
        'default',
      ),
    }),
    rows: [row('global:a', 'a'), row('global:b', 'b'), row('global:c', 'c')],
  })
  const value = await f.snapshot.refresh(null)
  assert.deepEqual(value.inventory.map((item) => item.serverName), ['a'])
  assert.equal(value.policies.get('b').enabled, true)
  assert.equal(value.policies.get('b').mode, 'eager')
  assert.equal(value.policies.get('c').enabled, false)
  // eager 行仍可查目标：面板要能显示它
  assert.equal(value.targets.has('global:b'), true)
  assert.equal(value.targets.has('global:c'), false)
})

test('托管定义并入行，重名则跳过并告警', async () => {
  const f = fixture({ owned: { version: 1, servers: { s1: stdioDef('node'), a: stdioDef('node') } } })
  const value = await f.snapshot.refresh(null)
  assert.equal(value.rows.some((item) => item.rowKey === 'own:s1'), true)
  assert.equal(value.warnings.some((line) => line.includes('重名')), true)
  assert.equal(value.targets.has('own:s1'), true)
  assert.equal(value.inventory.some((item) => item.serverName === 's1'), true)
})

test('绑定 pack 覆盖 default，逐字段求值', async () => {
  const f = fixture({
    policy: policyOf({
      pack: packOf({ 'global:a': { enabled: true } }),
      packId: 'p1',
      binding: 'p1',
      defaultPack: packOf({ 'global:a': { enabled: false, mode: 'lazy' } }, {}, 'default'),
    }),
  })
  const value = await f.snapshot.refresh('D:/proj')
  assert.equal(value.policies.get('a').enabled, true)
  assert.equal(value.policies.get('a').mode, 'lazy')
  // 与 rows 同序：第一行是 global:a。
  assert.equal(value.effective.rows[0].decidedBy, 'p1')
  assert.equal(value.effective.rows[0].decidedVia, 'item')
  assert.equal(value.effective.rows[0].itemWorkspace, true)
  assert.equal(value.effective.rows[0].itemGlobal, false)
  assert.equal(value.policy.packId, 'p1')
})

test('未绑定（pack 为 null）时按 default 求值', async () => {
  const f = fixture({
    policy: policyOf({ defaultPack: packOf({ 'global:a': { enabled: false } }, {}, 'default') }),
  })
  const value = await f.snapshot.refresh('D:/proj')
  assert.equal(value.policies.get('a').enabled, false)
  assert.equal(value.effective.rows[0].decidedBy, 'default')
  assert.equal(value.effective.rows[0].decidedVia, 'item')
  assert.equal(value.effective.rows[0].itemWorkspace, null)
  assert.equal(value.effective.rows[0].itemGlobal, false)
  // 清单内的名字可查；清单外的名字没有行，按关处理。
  assert.equal(value.effective.isOpen('a'), false)
  assert.equal(value.effective.isOpen('nope'), false)
})

test('组级只影响 enabled', async () => {
  const f = fixture({
    policy: policyOf({
      defaultPack: packOf({ 'global:a': { mode: 'lazy' } }, { g1: false }, 'default'),
      assignments: { 'global:a': 'g1' },
    }),
  })
  const value = await f.snapshot.refresh(null)
  assert.equal(value.policies.get('a').enabled, false)
  assert.equal(value.policies.get('a').mode, 'lazy')
  assert.equal(value.effective.rows[0].groupId, 'g1')
  assert.equal(value.effective.rows[0].decidedVia, 'group')
})

test('按目录失效不影响别的目录', async () => {
  const f = fixture()
  await f.snapshot.refresh('D:/a')
  await f.snapshot.refresh('D:/b')
  f.snapshot.invalidate('D:/a')
  assert.equal(f.snapshot.read('D:/a'), null)
  assert.notEqual(f.snapshot.read('D:/b'), null)
})

// 子代理与父会话同 cwd：会话结束只该回收自己那格。按 cwd 全清会让父会话的
// `target()` 读不到缓存，`mcp_call` 报「unknown or disabled MCP server」。
test('按 scope 失效不影响同 cwd 的另一个 scope', async () => {
  const f = fixture()
  const parent = {}
  const child = {}
  await f.snapshot.refresh('D:/proj', parent)
  await f.snapshot.refresh('D:/proj', child)
  f.snapshot.invalidate('D:/proj', child)
  assert.equal(f.snapshot.read('D:/proj', child), null)
  assert.notEqual(f.snapshot.read('D:/proj', parent), null)
})

// 不带 scope 的全清是刻意的（路由写入后紧跟 reconcileAll 重建）。
test('按目录失效不带 scope 时清掉该目录全部格子', async () => {
  const f = fixture()
  const scopeA = {}
  const scopeB = {}
  await f.snapshot.refresh('D:/proj', scopeA)
  await f.snapshot.refresh('D:/proj', scopeB)
  f.snapshot.invalidate('D:/proj')
  assert.equal(f.snapshot.read('D:/proj', scopeA), null)
  assert.equal(f.snapshot.read('D:/proj', scopeB), null)
})
