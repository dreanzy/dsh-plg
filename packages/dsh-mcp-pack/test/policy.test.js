import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultPackOf,
  normalizeCwd,
  parseBindings,
  parseGroups,
  parsePacks,
  resolveRow,
  rowEntryOf,
  serializeBindings,
  serializeGroups,
  serializePacks,
} from '../lib/policy.js'

/**
 * 本文件按「pack」语义重写。与旧用例的对应关系：
 * - 旧「全局层」→ `default` pack；
 * - 旧「工作区层」→ 绑定的 pack；
 * - 旧「层优先」→ 链序优先，且逐字段独立：
 *   enabled:  pack.rows[行].enabled ?? pack.groups[组] ?? default.rows[行].enabled ?? default.groups[组] ?? true
 *   mode:     pack.rows[行].mode ?? default.rows[行].mode ?? 'dynamic'
 *   tools:    pack.rows[行].tools ?? default.rows[行].tools ?? []
 *   description: pack.rows[行].description ?? default.rows[行].description ?? ''
 *
 * 组级两环只在 gid 仍留在注册表里时参与：悬空引用按未分组处理。
 */

const registry = {
  groups: [
    { id: 'g-a', name: '甲' },
    { id: 'g-c', name: '丙' },
  ],
  assignments: { 'global:a': 'g-a', 'global:b': 'g-a', 'global:c': 'g-c' },
}

function emptyPack(name = '默认') {
  return { name, groups: {}, rows: {} }
}

function packOf(rows = {}, groups = {}, name = 'p1') {
  return { name, groups, rows }
}

function resolve(rowKey, pack = null, defaultPack = emptyPack(), groups = registry, packId = 'p1') {
  return resolveRow(rowKey, pack, packId, defaultPack, groups)
}

test('两层都没有记录时取内置缺省：允许、dynamic、无规则、空描述', () => {
  const resolved = resolve('global:a')
  assert.equal(resolved.open, true)
  assert.equal(resolved.openGlobal, true)
  assert.equal(resolved.mode, 'dynamic')
  assert.deepEqual(resolved.tools, [])
  assert.equal(resolved.description, '')
  assert.equal(resolved.groupId, 'g-a')
  assert.equal(resolved.itemWorkspace, null)
  assert.equal(resolved.itemGlobal, null)
  assert.equal(resolved.decidedBy, 'default')
  assert.equal(resolved.decidedVia, 'builtin')
})

test('default pack 的逐字段决定生效（原「全局项级」用例）', () => {
  const resolved = resolve('global:a', null, packOf({ 'global:a': { enabled: false, mode: 'lazy' } }, {}, 'default'))
  assert.equal(resolved.open, false)
  assert.equal(resolved.mode, 'lazy')
  assert.equal(resolved.itemWorkspace, null)
  assert.equal(resolved.itemGlobal, false)
  assert.equal(resolved.decidedBy, 'default')
  assert.equal(resolved.decidedVia, 'item')
})

test('绑定 pack 压过 default pack，两个方向都能覆盖', () => {
  const on = resolve(
    'global:a',
    packOf({ 'global:a': { enabled: true } }),
    packOf({ 'global:a': { enabled: false } }, {}, 'default'),
  )
  assert.equal(on.open, true)
  assert.equal(on.itemWorkspace, true)
  assert.equal(on.itemGlobal, false)
  assert.equal(on.decidedBy, 'p1')
  assert.equal(on.decidedVia, 'item')

  const off = resolve(
    'global:a',
    packOf({ 'global:a': { enabled: false } }),
    packOf({ 'global:a': { enabled: true } }, {}, 'default'),
  )
  assert.equal(off.open, false)
  assert.equal(off.decidedBy, 'p1')
})

test('逐字段独立：pack 只改 enabled，mode 仍跟随 default', () => {
  const resolved = resolve(
    'global:a',
    packOf({ 'global:a': { enabled: false } }),
    packOf({ 'global:a': { mode: 'lazy', description: '浏览器' } }, {}, 'default'),
  )
  assert.equal(resolved.open, false)
  assert.equal(resolved.decidedVia, 'item')
  assert.equal(resolved.mode, 'lazy')
  // 只按 default 求值时两层都没有 enabled 记录，落到内置缺省的「开」。
  assert.equal(resolved.openGlobal, true)
  assert.equal(resolved.itemGlobal, null)
  assert.equal(resolved.description, '浏览器')
})

test('组级只影响 enabled；mode 等只读 default，pack 级不参与', () => {
  const pack = packOf({ 'global:a': { mode: 'eager' } }, { 'g-a': false })
  const resolved = resolve('global:a', pack)
  assert.equal(resolved.open, false)
  assert.equal(resolved.decidedBy, 'p1')
  assert.equal(resolved.decidedVia, 'group')
  // 加载方式描述的是服务器本身，按工作区换没有意义：pack 里写了也不生效。
  assert.equal(resolved.mode, 'dynamic')
  assert.equal(resolved.groupId, 'g-a')
  assert.equal(resolved.itemGlobal, null)
  assert.equal(resolved.openGlobal, true)
})

test('行级压过组级，同一个 pack 内', () => {
  const pack = packOf({ 'global:a': { enabled: true } }, { 'g-a': false })
  assert.equal(resolve('global:a', pack).open, true)
})

test('default 的组级压过 default 的行级之外的一切，未分组行不受影响', () => {
  const defaultPack = packOf({}, { 'g-a': false }, 'default')
  assert.equal(resolve('global:a', null, defaultPack).open, false)
  assert.equal(resolve('global:b', null, defaultPack).open, false)
  assert.equal(resolve('global:c', null, defaultPack).open, true)
  assert.equal(resolve('not-grouped', null, defaultPack).open, true)
})

test('链序优先：绑定 pack 的组级压过 default 的行级', () => {
  const resolved = resolve(
    'global:a',
    packOf({}, { 'g-a': true }),
    packOf({ 'global:a': { enabled: false } }, {}, 'default'),
  )
  assert.equal(resolved.open, true)
  assert.equal(resolved.decidedBy, 'p1')
  assert.equal(resolved.decidedVia, 'group')
})

test('绑定 pack 未覆盖的字段逐级跟随 default，来源记为 default', () => {
  const resolved = resolve(
    'global:c',
    packOf({ 'global:a': { enabled: false } }),
    packOf({ 'global:c': { enabled: false, description: 'x' } }, {}, 'default'),
  )
  assert.equal(resolved.open, false)
  assert.equal(resolved.decidedBy, 'default')
  assert.equal(resolved.decidedVia, 'item')
  assert.equal(resolved.itemWorkspace, null)
  assert.equal(resolved.itemGlobal, false)
  assert.equal(resolved.description, 'x')
})

test('显式 false 与缺席是两件事', () => {
  const pack = packOf({ 'global:a': { enabled: false } })
  assert.equal(resolve('global:a', pack).open, false)
  assert.equal(resolve('global:b', pack).open, true)
  assert.equal(rowEntryOf(pack, 'global:a').enabled, false)
  assert.equal(rowEntryOf(pack, 'global:b'), null)
  assert.equal(rowEntryOf(null, 'global:a'), null)
})

test('没有分组信息时组级两环自然跳过', () => {
  const resolved = resolveRow('global:a', packOf({}, { 'g-a': false }), 'p1', emptyPack())
  assert.equal(resolved.open, true)
  assert.equal(resolved.groupId, null)
})

test('指向已删分组的悬空引用按未分组处理', () => {
  const dangling = {
    groups: [{ id: 'g-live', name: '在用' }],
    assignments: { 'global:a': 'g-gone' },
  }
  const pack = packOf({}, { 'g-gone': false })
  const defaultPack = packOf({}, { 'g-gone': false }, 'default')
  const resolved = resolveRow('global:a', pack, 'p1', defaultPack, dangling)
  assert.equal(resolved.groupId, null)
  // 若悬空 id 仍被拿去查 pack.groups，这里会是被遗留开关决定的 false。
  assert.equal(resolved.open, true)
  assert.equal(resolved.decidedBy, 'default')
  assert.equal(resolved.decidedVia, 'builtin')
})

test('坏 JSON 降级成空策略且不抛错', () => {
  const parsed = parsePacks('{ not json')
  assert.deepEqual(parsed.value.book.packs, { default: emptyPack() })
  assert.deepEqual(parsed.value.ui, { showChip: true, defaultTab: 'groups' })
  assert.equal(parsed.warnings.length, 1)
})

test('packs.json 缺少 default 时补一个空 default 并留 warning', () => {
  const parsed = parsePacks(JSON.stringify({ packs: { p1: { name: '一', rows: { 'global:a': { enabled: false } } } } }))
  assert.equal(parsed.value.book.packs['default'].name, '默认')
  assert.deepEqual(parsed.value.book.packs['p1'].rows, { 'global:a': { enabled: false } })
  assert.equal(parsed.warnings.some((line) => line.includes('缺少 default')), true)
  assert.equal(defaultPackOf(parsed.value.book).name, '默认')
})

test('坏字段被丢弃，好字段保留；行对象坏掉则整条丢', () => {
  const parsed = parsePacks(
    JSON.stringify({
      packs: {
        default: {
          name: 'default',
          rows: { 'global:a': { enabled: 'yes', mode: 'lazy', tools: ['x', 1] }, 'global:b': 'nope' },
        },
      },
    }),
  )
  const row = parsed.value.book.packs['default'].rows['global:a']
  assert.equal(row.mode, 'lazy')
  assert.equal(row.enabled, undefined)
  assert.equal(row.tools, undefined)
  assert.equal(parsed.value.book.packs['default'].rows['global:b'], undefined)
  assert.equal(parsed.warnings.length, 3)
})

test('组级解析只认布尔；非布尔丢弃并留 warning', () => {
  const parsed = parsePacks(
    JSON.stringify({ packs: { default: { name: 'default', groups: { g1: true, g2: 'yes' } } } }),
  )
  assert.deepEqual(parsed.value.book.packs['default'].groups, { g1: true })
  assert.equal(parsed.warnings.length, 1)
})

test('ui 缺省值：chip 默认开、默认页是分组', () => {
  const parsed = parsePacks(undefined)
  assert.equal(parsed.value.ui.showChip, true)
  assert.equal(parsed.value.ui.defaultTab, 'groups')
})

test('ui 三值 defaultTab 都能取到，非法值回落 groups', () => {
  assert.equal(parsePacks(JSON.stringify({ ui: { defaultTab: 'packs' } })).value.ui.defaultTab, 'packs')
  assert.equal(parsePacks(JSON.stringify({ ui: { defaultTab: 'workspace' } })).value.ui.defaultTab, 'workspace')
  assert.equal(parsePacks(JSON.stringify({ ui: { defaultTab: 'nope' } })).value.ui.defaultTab, 'groups')
  assert.equal(parsePacks(JSON.stringify({ ui: { showChip: false } })).value.ui.showChip, false)
})

test('已废弃的 ui.showSidebarEntry 残留键被忽略，不留 warning', () => {
  const parsed = parsePacks(
    JSON.stringify({
      ui: { showSidebarEntry: false, showChip: true, defaultTab: 'groups' },
      packs: { default: { name: 'default' } },
    }),
  )
  assert.equal('showSidebarEntry' in parsed.value.ui, false)
  assert.deepEqual(parsed.value.ui, { showChip: true, defaultTab: 'groups' })
  assert.deepEqual(parsed.warnings, [])
})

test('组定义解析：成员表与孤儿引用都保留', () => {
  const parsed = parseGroups(
    JSON.stringify({
      groups: [{ id: 'g1', name: '一' }, { id: 'g1', name: '重复' }],
      assignments: { 'own:a': 'g1', 'global:b': 'g-none' },
    }),
  )
  assert.deepEqual(parsed.value.groups, [{ id: 'g1', name: '一' }])
  assert.deepEqual(parsed.value.assignments, { 'own:a': 'g1', 'global:b': 'g-none' })
  assert.equal(parsed.warnings.length, 1)
})

test('packs 序列化稳定：键排序、固定缩进、结尾换行', () => {
  const ui = { showChip: true, defaultTab: 'groups' }
  const packs = {
    default: packOf({ 'global:b': { mode: 'eager' }, 'global:a': { enabled: false } }, {}, '默认'),
    p1: { name: '一', groups: {}, rows: {} },
  }
  const text = serializePacks(packs, ui)
  assert.equal(
    text,
    '{\n' +
      '  "version": 1,\n' +
      '  "ui": {\n' +
      '    "showChip": true,\n' +
      '    "defaultTab": "groups"\n' +
      '  },\n' +
      '  "packs": {\n' +
      '    "default": {\n' +
      '      "name": "默认",\n' +
      '      "rows": {\n' +
      '        "global:a": {\n' +
      '          "enabled": false\n' +
      '        },\n' +
      '        "global:b": {\n' +
      '          "mode": "eager"\n' +
      '        }\n' +
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
  const ui = { showChip: false, defaultTab: 'packs' }
  const packs = {
    default: packOf({ 'global:a': { enabled: false, mode: 'lazy' } }, { g1: false }, '默认'),
    p1: { name: '二', groups: { g2: true }, rows: { 'own:x': { tools: ['read_*'], description: 'x' } } },
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
  assert.match(text, /"extra": \[\]/u)
})

test('组序列化排序 id 与成员', () => {
  const text = serializeGroups({
    groups: [{ id: 'b', name: '乙' }, { id: 'a', name: '甲' }],
    assignments: { 'global:z': 'a', 'own:y': 'b' },
  })
  assert.equal(text.indexOf('"id": "a"') < text.indexOf('"id": "b"'), true)
  assert.equal(text.indexOf('"global:z"') < text.indexOf('"own:y"'), true)
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
