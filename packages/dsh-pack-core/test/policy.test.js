import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResolver, normalizeCwd } from '../lib/index.js'

/**
 * 求值链与 cwd 归一。
 *
 * 这两样原先在三个包里各有一份，注释里写着「必须逐字节一致」。第二份开始就会分叉：
 * 一份加了名册上限、一份没加。这里钉住的是链序与 `false` 的语义——它们一旦走样，
 * 表现是「面板显示关了、模型那边还开着」。
 */

const win = process.platform === 'win32'

test('normalizeCwd：斜杠统一，盘符根保留尾斜杠', () => {
  assert.equal(normalizeCwd(null), null)
  assert.equal(normalizeCwd('   '), null)
  assert.equal(normalizeCwd('C:\\a\\b\\'), win ? 'c:/a/b' : 'C:/a/b')
  assert.equal(normalizeCwd('C:\\'), win ? 'c:/' : 'C:/')
  assert.equal(normalizeCwd('/a/b/'), '/a/b')
})

test('求值链：项级 > 组级 > default 项级 > default 组级 > 缺省开', () => {
  const groups = { groups: [{ id: 'g1', name: 'G' }], assignments: { a: 'g1', b: 'g1', c: 'g1' } }
  const defaultPack = { items: { c: false }, groups: { g1: false } }
  const pack = { items: { a: false }, groups: { g1: true } }
  const resolver = createResolver({ pack, packId: 'p1', defaultPack, groups })

  assert.deepEqual(resolver.decide('a'), { value: false, packId: 'p1', via: 'item' })
  assert.deepEqual(resolver.decide('b'), { value: true, packId: 'p1', via: 'group' })
  // 组级压过 default 的项级：这是链序里最容易写反的一格。
  assert.deepEqual(resolver.decide('c'), { value: true, packId: 'p1', via: 'group' })
  assert.deepEqual(resolver.decide('d'), { value: true, packId: 'default', via: 'builtin' })
})

test('未绑定工作区时直接问 default 层', () => {
  const groups = { groups: [], assignments: {} }
  const defaultPack = { items: { x: false }, groups: {} }
  const resolver = createResolver({ pack: null, defaultPack, groups })
  assert.deepEqual(resolver.decide('x'), { value: false, packId: 'default', via: 'item' })
  assert.deepEqual(resolver.decide('y'), { value: true, packId: 'default', via: 'builtin' })
  assert.equal(resolver.isOpen('x'), false)
})

test('指向已删分组的残留归属不参与求值', () => {
  const groups = { groups: [], assignments: { a: 'gone' } }
  const pack = { items: {}, groups: { gone: false } }
  const resolver = createResolver({ pack, packId: 'p1', defaultPack: { items: {}, groups: {} }, groups })
  assert.equal(resolver.decide('a').via, 'builtin')
  assert.equal(resolver.groupOf('a'), undefined)
})
