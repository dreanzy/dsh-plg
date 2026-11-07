import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createResolver,
  defaultPackOf,
  hiddenNames,
  normalizeCwd,
  parseBindings,
  parseGroups,
  parsePacks,
  serializeBindings,
  serializeGroups,
  serializePacks,
} from '../lib/policy.js'

/**
 * 本文件按「pack」语义重写。与旧用例的对应关系：
 * - 旧「工作区层」一律换成「绑定的 pack」（`pack`）；
 * - 旧「全局层」一律换成 `default` pack（`defaultPack`）；
 * - 旧「层优先」用例改写成「链序优先」：pack 的项级 → pack 的组级 →
 *   default 的项级 → default 的组级 → true。
 */

const assignments = { 'blender-core': 'g-blender', 'defold-api': 'g-defold' }

function emptyPack(name = 'default') {
  return { name, items: {}, groups: {} }
}

function withPolicy(pack = null, defaultPack = emptyPack(), map = assignments, packId) {
  return createResolver({
    pack,
    ...(packId === undefined ? {} : { packId }),
    defaultPack: { ...emptyPack(), ...defaultPack },
    assignments: map,
  })
}

test('没有记录时默认开', () => {
  assert.equal(withPolicy(null).isOpen('anything'), true)
  assert.deepEqual(withPolicy(null).decide('anything'), {
    value: true,
    packId: 'default',
    via: 'builtin',
  })
})

test('default pack 项级关掉即关掉（原「全局项级」用例）', () => {
  const r = withPolicy(null, { items: { x: false } })
  assert.equal(r.isOpen('x'), false)
})

test('绑定 pack 的项级覆盖 default 项级，两个方向都能覆盖', () => {
  assert.equal(
    withPolicy({ name: 'p1', items: { x: true }, groups: {} }, { items: { x: false } }).isOpen('x'),
    true,
  )
  assert.equal(
    withPolicy({ name: 'p1', items: { x: false }, groups: {} }, { items: { x: true } }).isOpen('x'),
    false,
  )
})

test('default 组级覆盖组内成员，未分组成员不受影响', () => {
  const r = withPolicy(null, { groups: { 'g-blender': false } })
  assert.equal(r.isOpen('blender-core'), false)
  assert.equal(r.isOpen('something-else'), true)
})

test('链序优先：绑定 pack 的组级压过 default 的项级', () => {
  // 旧用例是「工作区组级压过全局项级」；新链同样是 pack 先于 default。
  const r = withPolicy(
    { name: 'p1', items: {}, groups: { 'g-blender': true } },
    { items: { 'blender-core': false } },
  )
  assert.equal(r.isOpen('blender-core'), true)
})

test('项级压过组级，同一个 pack 内', () => {
  const r = withPolicy(
    { name: 'p1', items: { 'blender-core': false }, groups: { 'g-blender': true } },
    emptyPack(),
  )
  assert.equal(r.isOpen('blender-core'), false)
})

test('false 不会被当成缺省', () => {
  const r = withPolicy({ name: 'p1', items: { x: false }, groups: {} }, { items: {} })
  assert.equal(r.isOpen('x'), false)
})

test('绑定 pack 没有记录时逐级跟随 default', () => {
  const r = withPolicy(
    { name: 'p1', items: {}, groups: {} },
    { items: {}, groups: { 'g-defold': false } },
  )
  assert.equal(r.isOpen('defold-api'), false)
  assert.equal(r.isOpen('unrelated'), true)
})

test('绑定 pack 未覆盖的项按 default 求值，决策来源记为 default', () => {
  const r = withPolicy(
    { name: 'p1', items: { covered: false }, groups: {} },
    { items: { inherited: false } },
    assignments,
    'p1',
  )
  assert.deepEqual(r.decide('covered'), { value: false, packId: 'p1', via: 'item' })
  assert.deepEqual(r.decide('inherited'), { value: false, packId: 'default', via: 'item' })
  assert.deepEqual(r.decide('unknown'), { value: true, packId: 'default', via: 'builtin' })
})

test('组决策也带来源 pack 与级别', () => {
  const r = withPolicy(
    { name: 'p1', items: {}, groups: { 'g-blender': false } },
    emptyPack(),
    assignments,
    'p1',
  )
  assert.deepEqual(r.decide('blender-core'), { value: false, packId: 'p1', via: 'group' })
})

test('hiddenNames 只返回关掉的并排序', () => {
  const r = withPolicy(null, { items: { b: false, a: false } })
  assert.deepEqual(hiddenNames(['a', 'b', 'c'], r), ['a', 'b'])
})

test('求值链解析组归属', () => {
  const r = withPolicy(null)
  assert.equal(r.groupOf('blender-core'), 'g-blender')
  assert.equal(r.groupOf('unknown'), undefined)
})

test('坏 JSON 降级成空策略且不抛错', () => {
  const parsed = parsePacks('{ not json')
  assert.deepEqual(parsed.value.book.packs, { default: emptyPack() })
  assert.deepEqual(parsed.value.ui, {
    showOfficialSkills: false,
    showChip: true,
    defaultTab: 'groups',
  })
  assert.equal(parsed.warnings.length, 1)
})

test('packs.json 缺少 default 时补一个空 default 并留 warning', () => {
  const parsed = parsePacks(JSON.stringify({ packs: { p1: { name: '一', items: { a: false } } } }))
  assert.equal(parsed.value.book.packs['default'].name, 'default')
  assert.deepEqual(parsed.value.book.packs['p1'].items, { a: false })
  assert.equal(parsed.warnings.some((line) => line.includes('缺少 default')), true)
  assert.equal(defaultPackOf(parsed.value.book).name, 'default')
})

test('非布尔取值被忽略，其余项保留', () => {
  const parsed = parsePacks(
    JSON.stringify({ packs: { default: { name: 'default', items: { a: true, b: 'yes' } } } }),
  )
  assert.deepEqual(parsed.value.book.packs['default'].items, { a: true })
  assert.equal(parsed.warnings.length, 1)
})

test('ui 缺省值：官方技能默认隐藏、chip 默认开、默认页是分组', () => {
  const parsed = parsePacks(undefined)
  assert.equal(parsed.value.ui.showOfficialSkills, false)
  assert.equal(parsed.value.ui.showChip, true)
  assert.equal(parsed.value.ui.defaultTab, 'groups')
})

test('ui 显式值能读到，非法 defaultTab 回落 groups', () => {
  const parsed = parsePacks(
    JSON.stringify({
      ui: { showOfficialSkills: true, showChip: false, defaultTab: 'packs' },
      packs: { default: { name: 'default' } },
    }),
  )
  assert.equal(parsed.value.ui.showOfficialSkills, true)
  assert.equal(parsed.value.ui.showChip, false)
  assert.equal(parsed.value.ui.defaultTab, 'packs')
  assert.equal(parsePacks(JSON.stringify({ ui: { defaultTab: 'workspace' } })).value.ui.defaultTab, 'workspace')
  assert.equal(parsePacks(JSON.stringify({ ui: { defaultTab: 'nope' } })).value.ui.defaultTab, 'groups')
})

test('已废弃的 ui.showSidebarEntry 残留键被忽略，不留 warning', () => {
  const parsed = parsePacks(
    JSON.stringify({
      ui: { showOfficialSkills: true, showSidebarEntry: false, showChip: true, defaultTab: 'groups' },
      packs: { default: { name: 'default' } },
    }),
  )
  assert.equal('showSidebarEntry' in parsed.value.ui, false)
  assert.equal(parsed.value.ui.showOfficialSkills, true)
  assert.deepEqual(parsed.warnings, [])
})

test('组定义解析：成员表与孤儿引用都保留', () => {
  const parsed = parseGroups(
    JSON.stringify({
      groups: [{ id: 'g1', name: '一' }, { id: 'g1', name: '重复' }],
      assignments: { a: 'g1', b: 'g2' },
    }),
  )
  assert.deepEqual(parsed.value.groups, [{ id: 'g1', name: '一' }])
  assert.deepEqual(parsed.value.assignments, { a: 'g1', b: 'g2' })
  assert.equal(parsed.warnings.length, 1)
})

test('packs 序列化稳定：键排序、固定缩进、结尾换行', () => {
  const ui = { showOfficialSkills: false, showChip: true, defaultTab: 'groups' }
  const packs = {
    default: { name: 'default', items: { b: false, a: true }, groups: {} },
    p1: { name: '一', items: {}, groups: {} },
  }
  const text = serializePacks(packs, ui)
  assert.equal(
    text,
    '{\n' +
      '  "version": 1,\n' +
      '  "ui": {\n' +
      '    "showOfficialSkills": false,\n' +
      '    "showChip": true,\n' +
      '    "defaultTab": "groups"\n' +
      '  },\n' +
      '  "packs": {\n' +
      '    "default": {\n' +
      '      "name": "default",\n' +
      '      "items": {\n' +
      '        "a": true,\n' +
      '        "b": false\n' +
      '      }\n' +
      '    },\n' +
      '    "p1": {\n' +
      '      "name": "一"\n' +
      '    }\n' +
      '  }\n' +
      '}\n',
  )
})

test('往返：序列化后再解析得到同一份 pack 名册与 ui', () => {
  const ui = { showOfficialSkills: true, showChip: false, defaultTab: 'packs' }
  const packs = {
    default: { name: 'default', items: { x: false, y: true }, groups: { g: false } },
    p1: { name: '二', items: { z: false }, groups: {} },
  }
  const round = parsePacks(serializePacks(packs, ui))
  assert.deepEqual(round.value.book.packs, packs)
  assert.deepEqual(round.value.ui, ui)
})

test('bindings 解析把键归一，并保留 extra', () => {
  const rawKey = 'D:\\Proj\\Sub\\'
  const expected = normalizeCwd(rawKey)
  const parsed = parseBindings(JSON.stringify({ bindings: { [rawKey]: 'p1' }, extra: [rawKey, rawKey] }))
  assert.deepEqual(parsed.value.bindings, { [expected]: 'p1' })
  assert.deepEqual(parsed.value.extra, [expected])
})

test('bindings 坏数据降级成空表且留 warning', () => {
  const parsed = parseBindings(JSON.stringify({ bindings: { '': 'p1', x: 3 }, extra: 'nope' }))
  assert.deepEqual(parsed.value, { bindings: {}, extra: [] })
  assert.equal(parsed.warnings.length, 3)
})

test('bindings 序列化按 cwd 排序', () => {
  const text = serializeBindings({ bindings: { 'd:/b': 'p2', 'd:/a': 'p1' }, extra: [] })
  assert.equal(text.indexOf('"d:/a"') < text.indexOf('"d:/b"'), true)
  assert.match(text, /"extra": \[\]/)
})

test('组序列化排序 id 与成员', () => {
  const text = serializeGroups({
    groups: [{ id: 'b', name: '乙' }, { id: 'a', name: '甲' }],
    assignments: { z: 'a', y: 'b' },
  })
  assert.equal(text.indexOf('"id": "a"') < text.indexOf('"id": "b"'), true)
  assert.equal(text.indexOf('"y"') < text.indexOf('"z"'), true)
})

test('normalizeCwd 归一尾斜杠与分隔符', () => {
  assert.equal(normalizeCwd(null), null)
  assert.equal(normalizeCwd('   '), null)
  assert.equal(normalizeCwd('/a/b/'), '/a/b')
  assert.equal(normalizeCwd('/a/b///'), '/a/b')
  assert.equal(normalizeCwd('C:\\X\\'), process.platform === 'win32' ? 'c:/x' : 'C:/X')
})

test('normalizeCwd 在 Windows 上大小写与尾斜杠落到同一个键', { skip: process.platform !== 'win32' }, () => {
  assert.equal(normalizeCwd('D:\\Projects\\Sample\\'), 'd:/projects/sample')
  assert.equal(normalizeCwd('d:/projects/sample'), 'd:/projects/sample')
  assert.equal(normalizeCwd('  D:/Projects/Sample  '), 'd:/projects/sample')
})

test('normalizeCwd 保留盘符根目录的尾斜杠', () => {
  assert.equal(normalizeCwd('C:\\'), process.platform === 'win32' ? 'c:/' : 'C:/')
})
