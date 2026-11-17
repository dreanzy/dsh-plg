import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPanel, orderOfRows, pressedLabelOfRow, walk } from '../../../scripts/test-helpers/panel.mjs'

/**
 * 分包页的开关取值与排序。
 *
 * 分包页的 pack 是**用户选的**，不是工作区绑定的那张。服务端行上的
 * `itemWorkspace` / `rank` 按绑定 pack 算，在全局视图里恒为 null / explicit-on，
 * 拿它渲染会让每一行都显示成「开」，且排序退化成按名字。
 */
const CLIENT = new URL('../client/client.js', import.meta.url)

function rowOf(name, extra) {
  return {
    rowKey: name,
    serverName: name,
    transport: 'stdio',
    source: 'discovered',
    groupId: null,
    open: true,
    itemGlobal: null,
    itemWorkspace: null,
    groupGlobal: null,
    groupWorkspace: null,
    landing: true,
    // 服务端在全局视图里恒给 explicit-on：policy.pack 为 null，rankOf 直接归这一档。
    rank: 'explicit-on',
    decidedBy: 'default',
    decidedVia: 'builtin',
    ...extra,
  }
}

function viewOf(packs, rows) {
  return {
    packs,
    ui: { showOfficialServers: true, showChip: true, defaultTab: 'packs' },
    groups: { groups: [], assignments: {} },
    bindings: { bindings: {} },
    rows,
    complete: true,
    diff: [],
    groupRanks: {},
    warnings: [],
    stuck: [],
  }
}

function render(data, options) {
  const { PackSettings } = loadPanel(CLIENT, options)
  return PackSettings({ data, base: data, run: () => {}, queue: () => {}, pending: { count: 0, keys: new Set() } })
}

test('待保存期间沿用改动前的 pack 序，改名不跳位', () => {
  const { orderPacks } = loadPanel(CLIENT)
  const before = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: 'alpha', items: {}, groups: {}, builtin: false },
    { id: 'p2', name: 'zeta', items: {}, groups: {}, builtin: false },
  ]
  // 把 alpha 改名成 zzz：服务端按名字排会把它挪到 zeta 之后，冻结序必须留在原位。
  const after = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p2', name: 'zeta', items: {}, groups: {}, builtin: false },
    { id: 'p1', name: 'zzz', items: {}, groups: {}, builtin: false },
  ]
  assert.deepEqual(orderPacks(after, before, true).map((pack) => pack.id), ['default', 'p1', 'p2'])
  // 不冻结时原样返回服务端给的序：改名后的位置就是新名字该在的位置。
  assert.deepEqual(orderPacks(after, before, false).map((pack) => pack.id), ['default', 'p2', 'p1'])
})

test('待保存期间新建的 pack 落到末尾，不插进改动前的序里', () => {
  const { orderPacks } = loadPanel(CLIENT)
  const before = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: 'alpha', items: {}, groups: {}, builtin: false },
  ]
  const after = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: 'alpha', items: {}, groups: {}, builtin: false },
    { id: 'p2', name: 'aaa', items: {}, groups: {}, builtin: false },
  ]
  assert.deepEqual(orderPacks(after, before, true).map((pack) => pack.id), ['default', 'p1', 'p2'])
})

test('默认 pack 里显式关掉的行，分包页显示「关」而不是「开」', () => {
  const packs = [{ id: 'default', name: '默认', groups: {}, rows: { alpha: { enabled: false } }, builtin: true }]
  const tree = render(viewOf(packs, [rowOf('alpha', { open: false, itemGlobal: false })]))
  const label = pressedLabelOfRow(tree, 'alpha')
  assert.equal(label, '关', '默认 pack 里 alpha 是显式关，分包页却显示成「' + String(label) + '」')
})

test('default pack 里没记录的行排在显式关之前（它们等于开，不是跟随）', () => {
  const packs = [{ id: 'default', name: '默认', groups: {}, rows: { alpha: { enabled: false } }, builtin: true }]
  const tree = render(viewOf(packs, [rowOf('alpha'), rowOf('beta')]))
  assert.deepEqual(orderOfRows(tree, ['alpha', 'beta']), ['beta', 'alpha'])
})

test('未保存的组级改动立刻显示（试算视图，不是冻结的改动前视图）', () => {
  const groups = { groups: [{ id: 'g1', name: 'work-unity' }], assignments: {} }
  const basePacks = [
    { id: 'default', name: '默认', groups: {}, rows: {}, builtin: true },
    { id: 'p1', name: 'wk-b', groups: {}, rows: {}, builtin: false },
  ]
  // 试算视图：用户把 g1 改成「开」，还没保存。
  const previewPacks = [
    { id: 'default', name: '默认', groups: {}, rows: {}, builtin: true },
    { id: 'p1', name: 'wk-b', groups: { g1: true }, rows: {}, builtin: false },
  ]
  // 选中 p1：`selected` 是组件内部状态，只能靠 useState 初值注入。
  const { PackSettings } = loadPanel(CLIENT, { initialStates: ['p1'] })
  const tree = PackSettings({
    data: { ...viewOf(previewPacks, []), groups },
    base: { ...viewOf(basePacks, []), groups },
    run: () => {},
    queue: () => {},
    pending: { count: 1, keys: new Set(['packGroup:p1:g1']) },
  })
  const label = pressedLabelOfRow(tree, 'g1')
  assert.equal(label, '开', '组级改动还没保存，分包页却显示成「' + String(label) + '」')
})

test('新建 pack 后自动选中它，接着改开关改的是新包', () => {
  const basePacks = [{ id: 'default', name: '默认', items: {}, groups: {}, builtin: true }]
  const previewPacks = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: '新包', items: {}, groups: {}, builtin: false },
  ]
  const queued = []
  // 选中项由 effect 切换，而测试里的 useState 是桩、effect 不跑。这里直接注入
  // 「已经切到 p1」的结果，验证的是**切过去之后**点开关落在哪张 pack 上。
  const { PackSettings } = loadPanel(CLIENT, { initialStates: ['p1'] })
  const tree = PackSettings({
    data: viewOf(previewPacks, [rowOf('alpha')]),
    base: viewOf(basePacks, [rowOf('alpha')]),
    run: () => {},
    queue: (commands) => queued.push(...commands),
    pending: { count: 1, keys: new Set() },
  })
  let row = null
  walk(tree, (node) => {
    if (row === null && node.props && node.props.key === 'alpha') row = node
  })
  walk(row, (node) => {
    if (node.type === 'button' && node.props.key === 'off') node.props.onClick()
  })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].packId, 'p1', '选中新包后点开关，改动应落在新包上')
})

test('新建 pack 会记下改动前的 id 集合，供 effect 选中新出现的那张', () => {
  // 这条守的是 createPack 里那行 `wanted.current = new Set(...)`：删掉它，
  // 新建后 selected 停在上一张 pack，用户接着改的开关全落在旧包上。
  const source = readFileSync(CLIENT, 'utf8')
  const body = source.slice(source.indexOf('const createPack = () =>'), source.indexOf('const duplicatePack'))
  assert.ok(
    body.includes('wanted.current = new Set('),
    'createPack 没有记下改动前的 id 集合：新建后不会自动选中新包，改动会落在上一张 pack 上',
  )
})

test('排序是「开 > 关 > 跟随(开) > 跟随(关)」，按选中那张 pack 算', () => {
  const packs = [
    { id: 'default', name: '默认', groups: {}, rows: { beta: { enabled: false }, gamma: { enabled: true } }, builtin: true },
  ]
  const tree = render(viewOf(packs, [rowOf('alpha'), rowOf('beta'), rowOf('gamma'), rowOf('delta')]))
  // default 没有上一层：没记录就是开。alpha / delta / gamma 同属「开」档，按名字排；
  // beta 显式关，排最后。default 里不存在「跟随」这一档。
  assert.deepEqual(orderOfRows(tree, ['alpha', 'beta', 'gamma', 'delta']), ['alpha', 'delta', 'gamma', 'beta'])
})
