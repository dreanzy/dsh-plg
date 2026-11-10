import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effective } from '../lib/effective.js'

const EMPTY_UI = { showOfficialPlugins: false, showChip: true, defaultTab: 'groups' }

/** 造一份已加载的状态：本模块是纯函数，不吃文件。 */
function state(pack, defaultPack, assignments = {}) {
  // 落盘路径上 parsePacks 总会补齐 items / groups，用例里也补齐，免得测到不存在的形状。
  const normalize = (entry) => ({ items: {}, groups: {}, ...entry })
  const own = pack === null ? null : normalize(pack)
  return {
    packs: { packs: { default: normalize(defaultPack), ...(own === null ? {} : { p1: own }) } },
    ui: { ...EMPTY_UI },
    binding: own === null ? null : 'p1',
    packId: own === null ? 'default' : 'p1',
    pack: own,
    // 归属必须同时注册在 groups 里：指向已删分组的 id 按未分组处理。
    groups: { groups: [...new Set(Object.values(assignments))].map((id) => ({ id, name: id })), assignments },
    bindings: { bindings: {} },
    warnings: [],
  }
}

const NAMES = ['a', 'c', 'd', 'e']

test('链的四个落点各给一份答案', () => {
  const policy = state(
    { name: 'p1', items: { a: false }, groups: { g1: false } },
    { name: '默认', items: { d: false }, groups: {} },
    { c: 'g1' },
  )
  const out = effective({ policy, names: NAMES, scope: 'workspace', complete: true })
  assert.deepEqual(
    out.rows.map((row) => [row.name, row.open, row.itemWorkspace, row.itemGlobal, row.decidedBy, row.decidedVia]),
    [
      ['a', false, false, null, 'p1', 'item'],
      ['c', false, null, null, 'p1', 'group'],
      ['d', false, null, false, 'default', 'item'],
      ['e', true, null, null, 'default', 'builtin'],
    ],
  )
  assert.deepEqual(out.rows[1].groupId, 'g1')
  assert.equal(out.isOpen('e'), true)
  assert.equal(out.complete, true)
})

test('global 只走 default 层，绑定 pack 的决定不参与', () => {
  const policy = state({ name: 'p1', items: { a: false } }, { name: '默认' })
  const out = effective({ policy, names: ['a'], scope: 'global', complete: true })
  assert.deepEqual(
    [out.rows[0].open, out.rows[0].itemWorkspace, out.rows[0].decidedBy, out.rows[0].decidedVia],
    [true, false, 'default', 'builtin'],
  )
  assert.equal(out.isOpen('a'), true)
})

test('目录残缺时 open 为 null，链路答案照旧', () => {
  const policy = state({ name: 'p1', items: { a: false } }, { name: '默认' })
  const out = effective({ policy, names: NAMES, scope: 'workspace', complete: false })
  assert.deepEqual(
    out.rows.map((row) => row.open),
    [null, null, null, null],
  )
  // 残缺只说明名单可能少了几项，不足以让已知项失效。
  assert.equal(out.isOpen('a'), false)
  assert.equal(out.isOpen('不在名单里'), true)
})
