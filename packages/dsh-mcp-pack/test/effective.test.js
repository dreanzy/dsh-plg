import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effective } from '../lib/effective.js'

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

/** 造一份已加载的 `PolicyState`；`pack` 为 null 表示按 default 求值。 */
function policyOf({ pack = null, packId = 'default', defaultPack, groups = { groups: [], assignments: {} } }) {
  const packs = { default: defaultPack }
  if (pack !== null) packs[packId] = pack
  return {
    packs: { packs },
    ui: { showChip: true, defaultTab: 'groups' },
    binding: pack === null ? null : packId,
    packId: pack === null ? 'default' : packId,
    pack,
    groups,
    bindings: { bindings: {} },
    warnings: [],
  }
}

test('一次求值给出与输入同序的行视图', () => {
  const result = effective({
    policy: policyOf({
      pack: { name: 'p1', groups: {}, rows: { 'global:a': { enabled: false } } },
      packId: 'p1',
      defaultPack: { name: '默认', groups: {}, rows: {} },
    }),
    rows: [row('global:a', 'a'), row('global:b', 'b')],
  })
  assert.deepEqual(result.rows.map((item) => item.rowKey), ['global:a', 'global:b'])
  assert.equal(result.rows[0].open, false)
  assert.equal(result.rows[0].decidedBy, 'p1')
  assert.equal(result.rows[0].itemWorkspace, false)
  assert.equal(result.rows[1].open, true)
  assert.equal(result.rows[1].decidedVia, 'builtin')
})

test('isOpen 按 server 名查，清单外的名字一律 false', () => {
  const result = effective({
    policy: policyOf({ defaultPack: { name: '默认', groups: {}, rows: { 'global:a': { enabled: false } } } }),
    rows: [row('global:a', 'a')],
  })
  assert.equal(result.isOpen('a'), false)
  assert.equal(result.isOpen('nope'), false)
})

test('悬空分组按未分组求值，不被 pack 里的遗留开关决定', () => {
  const result = effective({
    policy: policyOf({
      defaultPack: { name: '默认', groups: { 'g-gone': false }, rows: {} },
      groups: { groups: [], assignments: { 'global:a': 'g-gone' } },
    }),
    rows: [row('global:a', 'a')],
  })
  assert.equal(result.rows[0].groupId, null)
  assert.equal(result.rows[0].open, true)
  assert.equal(result.rows[0].decidedVia, 'builtin')
})

test('组级决定归属做出决定的 pack，并标成 group', () => {
  const result = effective({
    policy: policyOf({
      pack: { name: 'p1', groups: { g1: false }, rows: {} },
      packId: 'p1',
      defaultPack: { name: '默认', groups: {}, rows: {} },
      groups: { groups: [{ id: 'g1', name: '一' }], assignments: { 'global:a': 'g1' } },
    }),
    rows: [row('global:a', 'a')],
  })
  assert.equal(result.rows[0].groupId, 'g1')
  assert.equal(result.rows[0].open, false)
  assert.equal(result.rows[0].decidedBy, 'p1')
  assert.equal(result.rows[0].decidedVia, 'group')
  assert.equal(result.rows[0].itemWorkspace, null)
  // 只按 default 求值时组级没有记录，落到内置缺省。
  assert.equal(result.rows[0].openGlobal, true)
})

test('可信度跟着结论一起走：行发现不完整时同样标注', () => {
  const base = () =>
    effective({
      policy: policyOf({ defaultPack: { name: '默认', groups: {}, rows: {} } }),
      rows: [row('global:a', 'a')],
      complete: true,
    })
  assert.equal(base().complete, true)
  const partial = effective({
    policy: policyOf({ defaultPack: { name: '默认', groups: {}, rows: {} } }),
    rows: [row('global:a', 'a')],
    complete: false,
  })
  assert.equal(partial.complete, false, '行发现不完整时这份答案不能拿去落地')
})
