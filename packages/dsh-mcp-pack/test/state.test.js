import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryState, sectionText } from '../lib/state.js'
import { createScopeSnapshot } from '../lib/snapshot.js'

const row = (serverName, rowKey) => ({
  rowKey,
  serverName,
  config: { transport: 'stdio', serverName, command: 'node' },
})

function emptyPack(name = 'default') {
  return { name, groups: {}, rows: {} }
}

function policyOf({ pack = null, packId = 'default', defaultPack = emptyPack(), assignments = {} } = {}) {
  const packs = { default: defaultPack }
  if (pack !== null) packs[packId] = pack
  return {
    packs: { packs },
    ui: { showChip: true, defaultTab: 'groups' },
    binding: pack === null ? null : packId,
    packId: pack === null ? 'default' : packId,
    pack,
    groups: { groups: [], assignments },
    bindings: { bindings: {}, extra: [] },
    warnings: [],
  }
}

function stateWith(rows, defaultRows = {}, packRows = null, owned = { version: 1, servers: {} }) {
  const policy = policyOf({
    defaultPack: { name: 'default', groups: {}, rows: defaultRows },
    pack: packRows === null ? null : { name: '工作', groups: {}, rows: packRows },
    packId: packRows === null ? 'default' : 'p1',
  })
  const snapshot = createScopeSnapshot({
    scan: () => ({ rows, complete: true, warnings: [] }),
    load: async () => ({ policy, owned, warnings: [] }),
  })
  return createInventoryState(snapshot, null)
}

test('默认模式是 dynamic，行进入名册', async () => {
  const state = stateWith([row('playwright', 'global:playwright')])
  await state.refresh()
  assert.deepEqual(state.snapshot().map((item) => item.serverName), ['playwright'])
})

test('eager 行不进名册', async () => {
  const state = stateWith([row('hot', 'global:hot')], { 'global:hot': { mode: 'eager' } })
  await state.refresh()
  assert.deepEqual(state.snapshot(), [])
})

test('禁用的行不进名册', async () => {
  const state = stateWith([row('off', 'global:off')], { 'global:off': { enabled: false } })
  await state.refresh()
  assert.deepEqual(state.snapshot(), [])
})

test('描述透传到名册行', async () => {
  const state = stateWith([row('a', 'global:a')], { 'global:a': { description: '浏览器' } })
  await state.refresh()
  assert.equal(state.snapshot()[0].description, '浏览器')
  assert.match(sectionText(state), /- a — 浏览器/u)
})

test('mode 只读 default，绑定 pack 的同名字段不参与', async () => {
  // eager 不进名册（那是「总是加载」），所以两边都用会进名册的模式，
  // 只靠 policyOf 区分究竟读了哪一层。
  const state = stateWith([row('a', 'global:a')], { 'global:a': { mode: 'dynamic' } }, { 'global:a': { mode: 'lazy' } })
  await state.refresh()
  assert.equal(state.snapshot().length, 1)
  assert.equal(state.policyOf('a').mode, 'dynamic')
})

test('空名册的段文本是空串', async () => {
  const state = stateWith([])
  await state.refresh()
  assert.equal(sectionText(state), '')
})

test('serverName 匹配不区分大小写', async () => {
  const state = stateWith([row('unityMCP8082', 'own:unityMCP8082')])
  await state.refresh()
  assert.ok(state.target('unityMCP8082'))
  assert.ok(state.target('unitymcp8082'))
  assert.ok(state.target('UNITYMCP8082'))
  assert.equal(state.target('other'), null)
})

test('托管定义会并进行视图，并按绑定 pack 求值', async () => {
  const owned = {
    version: 1,
    servers: {
      unity: { transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp', headers: {} },
    },
  }
  // default 禁用、绑定 pack 启用：这是最容易被漏掉的一条路径。
  const state = stateWith(
    [],
    { 'own:unity': { enabled: false, mode: 'lazy' } },
    { 'own:unity': { enabled: true } },
    owned,
  )
  await state.refresh()
  assert.deepEqual(state.snapshot().map((item) => item.serverName), ['unity'])
  assert.ok(state.target('unity'))
  // mode 在绑定 pack 里没记录，跟随 default。
  assert.equal(state.target('unity').mode, 'lazy')
})

test('托管定义与 Loader 行同名时保留 Loader 行', async () => {
  const owned = { version: 1, servers: { srv: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } } }
  const state = stateWith([row('srv', 'global:srv')], {}, null, owned)
  await state.refresh()
  assert.equal(state.snapshot().length, 1)
  assert.ok(state.snapshot()[0].serverName === 'srv')
})
