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

function layer(rows = {}) {
  return { version: 1, rows, settings: { showSidebarEntry: true } }
}

function stdioDef(command) {
  return { transport: 'stdio', command: command, args: [], env: {}, cwd: '' }
}

function fixture(options = {}) {
  const calls = { scan: 0, load: 0, fingerprint: 0 }
  let stamp = options.stamp ?? '0'
  let scanned = options.rows ?? [row('global:a', 'a'), row('global:b', 'b')]
  let global = options.global ?? layer({ 'global:b': { mode: 'eager' } })
  let workspace = options.workspace ?? null
  let owned = options.owned ?? { version: 1, servers: {} }
  const snapshot = createScopeSnapshot({
    scan: () => {
      calls.scan += 1
      return { rows: scanned, complete: true, warnings: [] }
    },
    load: async () => {
      calls.load += 1
      return { global, workspace, owned, warnings: [] }
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
    setGlobal: (value) => { global = value },
    setOwned: (value) => { owned = value },
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
    global: layer({ 'global:b': { mode: 'eager' }, 'global:c': { enabled: false } }),
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

test('工作区层覆盖全局层', async () => {
  const f = fixture({
    global: layer({ 'global:a': { enabled: false } }),
    workspace: layer({ 'global:a': { enabled: true } }),
  })
  const value = await f.snapshot.refresh('D:/proj')
  assert.equal(value.policies.get('a').enabled, true)
  assert.equal(value.resolved.get('global:a').from, 'workspace')
})

test('按目录失效不影响别的目录', async () => {
  const f = fixture()
  await f.snapshot.refresh('D:/a')
  await f.snapshot.refresh('D:/b')
  f.snapshot.invalidate('D:/a')
  assert.equal(f.snapshot.read('D:/a'), null)
  assert.notEqual(f.snapshot.read('D:/b'), null)
})
