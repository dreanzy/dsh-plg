import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createResolver,
  hiddenNames,
  parseGlobal,
  parseGroups,
  parseLayer,
  serializeGlobal,
  serializeGroups,
  serializeLayer,
} from '../lib/policy.js'

const assignments = { 'blender-core': 'g-blender', 'defold-api': 'g-defold' }

function withPolicy(workspace, global = {}, groups = {}, map = assignments) {
  return createResolver({
    workspace,
    global: { items: {}, groups: {}, showOfficialSkills: false, ...global },
    assignments: map,
  })
}

test('没有记录时默认开', () => {
  assert.equal(withPolicy(null).isOpen('anything'), true)
})

test('全局项级关掉即关掉', () => {
  const r = withPolicy(null, { items: { x: false } })
  assert.equal(r.isOpen('x'), false)
})

test('工作区项级覆盖全局项级，两个方向都能覆盖', () => {
  assert.equal(withPolicy({ items: { x: true }, groups: {} }, { items: { x: false } }).isOpen('x'), true)
  assert.equal(withPolicy({ items: { x: false }, groups: {} }, { items: { x: true } }).isOpen('x'), false)
})

test('全局组级覆盖组内成员，未分组成员不受影响', () => {
  const r = withPolicy(null, { groups: { 'g-blender': false } })
  assert.equal(r.isOpen('blender-core'), false)
  assert.equal(r.isOpen('something-else'), true)
})

test('层优先：工作区组级压过全局项级', () => {
  const r = withPolicy({ items: {}, groups: { 'g-blender': true } }, { items: { 'blender-core': false } })
  assert.equal(r.isOpen('blender-core'), true)
})

test('项级压过组级，同一层内', () => {
  const r = withPolicy({ items: { 'blender-core': false }, groups: { 'g-blender': true } })
  assert.equal(r.isOpen('blender-core'), false)
})

test('false 不会被当成缺省', () => {
  const r = withPolicy({ items: { x: false }, groups: {} }, { items: {} , groups: {}, showOfficialSkills: false })
  assert.equal(r.isOpen('x'), false)
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
  const parsed = parseLayer('{ not json')
  assert.deepEqual(parsed.value, { items: {}, groups: {} })
  assert.equal(parsed.warnings.length, 1)
})

test('非布尔取值被忽略，其余项保留', () => {
  const parsed = parseLayer(JSON.stringify({ items: { a: true, b: 'yes' } }))
  assert.deepEqual(parsed.value.items, { a: true })
  assert.equal(parsed.warnings.length, 1)
})

test('全局层的 showOfficialSkills 缺省为 false 且能读到', () => {
  assert.equal(parseGlobal(undefined).value.showOfficialSkills, false)
  assert.equal(parseGlobal(JSON.stringify({ ui: { showOfficialSkills: true } })).value.showOfficialSkills, true)
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

test('序列化稳定：键排序、固定缩进、结尾换行', () => {
  const text = serializeLayer({ items: { b: false, a: true }, groups: {} })
  assert.equal(text, '{\n  "version": 1,\n  "items": {\n    "a": true,\n    "b": false\n  }\n}\n')
  assert.equal(serializeLayer({ items: {}, groups: {} }), '{\n  "version": 1\n}\n')
})

test('全局序列化总是写出 ui 行', () => {
  const text = serializeGlobal({ items: {}, groups: {}, showOfficialSkills: true })
  assert.match(text, /"ui": \{\n {4}"showOfficialSkills": true\n {2}\}/)
})

test('组序列化排序 id 与成员', () => {
  const text = serializeGroups({
    groups: [{ id: 'b', name: '乙' }, { id: 'a', name: '甲' }],
    assignments: { z: 'a', y: 'b' },
  })
  assert.equal(text.indexOf('"id": "a"') < text.indexOf('"id": "b"'), true)
  assert.equal(text.indexOf('"y"') < text.indexOf('"z"'), true)
})

test('往返：序列化后再解析得到同一份策略', () => {
  const original = { items: { x: false, y: true }, groups: { g: false } }
  const round = parseLayer(serializeLayer(original)).value
  assert.deepEqual(round, original)
})
