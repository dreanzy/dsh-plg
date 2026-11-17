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
    name,
    description: '',
    source: 'custom',
    provider: 'filesystem',
    official: false,
    groupId: null,
    open: true,
    openGlobal: true,
    itemGlobal: null,
    itemWorkspace: null,
    groupGlobal: null,
    groupWorkspace: null,
    landing: true,
    // 服务端在全局视图里恒给 explicit-on：policy.pack 为 null，rankOf 直接归这一档。
    rank: 'explicit-on',
    decidedBy: 'default',
    decidedVia: 'builtin',
    origin: '',
    ...extra,
  }
}

function viewOf(packs, skills) {
  return {
    packs,
    ui: { showOfficialSkills: false, showChip: true, defaultTab: 'packs' },
    groups: { groups: [], assignments: {} },
    bindings: { bindings: {} },
    skills,
    complete: true,
    diff: [],
    groupRanks: {},
    warnings: [],
    stuck: [],
  }
}

function render(data) {
  const { PackSettings } = loadPanel(CLIENT)
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

test('默认 pack 里显式关掉的项，分包页显示「关」而不是「开」', () => {
  const packs = [{ id: 'default', name: '默认', items: { alpha: false }, groups: {}, builtin: true }]
  const tree = render(viewOf(packs, [rowOf('alpha', { open: false, openGlobal: false, itemGlobal: false })]))
  const label = pressedLabelOfRow(tree, 'alpha')
  assert.equal(label, '关', '默认 pack 里 alpha 是显式关，分包页却显示成「' + String(label) + '」')
})

test('default 没记录时显示「开」，不被别的 pack 的记录带偏', () => {
  const packs = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: '工作', items: { alpha: false }, groups: {}, builtin: false },
  ]
  const tree = render(viewOf(packs, [rowOf('alpha')]))
  assert.equal(pressedLabelOfRow(tree, 'alpha'), '开', 'default 没记录 alpha，应显示「开」')
})

test('default pack 里没记录的项排在显式关之前（它们等于开，不是跟随）', () => {
  // default 没有上一层：没记录就是开，档位该是 explicit-on，不是 follow-on。
  const packs = [{ id: 'default', name: '默认', items: { alpha: false }, groups: {}, builtin: true }]
  const tree = render(viewOf(packs, [rowOf('alpha'), rowOf('beta')]))
  // beta 没记录 = 开，应排在显式关的 alpha 前面。
  assert.deepEqual(orderOfRows(tree, ['alpha', 'beta']), ['beta', 'alpha'])
})

test('未保存的组级改动立刻显示（试算视图，不是冻结的改动前视图）', () => {
  const groups = { groups: [{ id: 'g1', name: 'work-unity' }], assignments: {} }
  const basePacks = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: 'wk-b', items: {}, groups: {}, builtin: false },
  ]
  // 试算视图：用户把 g1 改成「开」，还没保存。
  const previewPacks = [
    { id: 'default', name: '默认', items: {}, groups: {}, builtin: true },
    { id: 'p1', name: 'wk-b', items: {}, groups: { g1: true }, builtin: false },
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
  // 试算视图：新建后多出 p1。
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

test('三态按钮把「关」传成 false，不是 null', () => {
  // 传 null 等于「跟随」，用户点「关」却变成「不表态」——开关看着点了，实际没关。
  const packs = [{ id: 'default', name: '默认', items: {}, groups: {}, builtin: true }]
  const queued = []
  const { PackSettings } = loadPanel(CLIENT)
  const tree = PackSettings({
    data: viewOf(packs, [rowOf('alpha')]),
    base: viewOf(packs, [rowOf('alpha')]),
    run: () => {},
    queue: (commands) => queued.push(...commands),
    pending: { count: 0, keys: new Set() },
  })
  let row = null
  walk(tree, (node) => {
    if (row === null && node.props && node.props.key === 'alpha') row = node
  })
  walk(row, (node) => {
    if (node.type === 'button' && node.props.key === 'off') node.props.onClick()
  })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].value, false, '点「关」应写入 false，实际写入 ' + JSON.stringify(queued[0].value))
})

test('排序档位顺序是 开 > 关 > 跟随(开) > 跟随(关)', () => {
  // 直接验 RANK_ORDER 的序：对调 follow-on / follow-off 会让「跟随且落到关」排到
  // 「跟随且落到开」前面，整页顺序错乱，但每行的开关值都是对的——只有排序能发现。
  const source = readFileSync(CLIENT, 'utf8')
  const block = source.slice(source.indexOf('const RANK_ORDER = {'), source.indexOf('}', source.indexOf('const RANK_ORDER = {')))
  const order = []
  for (const line of block.split('\n')) {
    const found = /'(explicit-on|explicit-off|follow-on|follow-off)':\s*(\d+)/u.exec(line)
    if (found !== null) order.push([found[1], Number(found[2])])
  }
  order.sort((a, b) => a[1] - b[1])
  assert.deepEqual(
    order.map((entry) => entry[0]),
    ['explicit-on', 'explicit-off', 'follow-on', 'follow-off'],
    '档位顺序错了：' + JSON.stringify(order),
  )
})

test('排序是「开 > 关 > 跟随(开) > 跟随(关)」，按选中那张 pack 算', () => {
  const packs = [{ id: 'default', name: '默认', items: { beta: false, gamma: true }, groups: {}, builtin: true }]
  const tree = render(viewOf(packs, [rowOf('alpha'), rowOf('beta'), rowOf('gamma'), rowOf('delta')]))
  // default 没有上一层：没记录就是开。alpha / delta / gamma 同属「开」档，按名字排；
  // beta 显式关，排最后。default 里不存在「跟随」这一档。
  assert.deepEqual(orderOfRows(tree, ['alpha', 'beta', 'gamma', 'delta']), ['alpha', 'delta', 'gamma', 'beta'])
})
