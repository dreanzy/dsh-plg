import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLayer, resolveRow, serializeLayer, hasLayerEntry } from '../lib/policy.js'
import { EMPTY_LAYER } from '../lib/types.js'

const layer = (rows) => ({ version: 1, rows })

test('工作区层压过全局层', () => {
  const workspace = layer({ 'global:a': { enabled: false } })
  const global = layer({ 'global:a': { enabled: true } })
  const resolved = resolveRow('global:a', workspace, global)
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.sources.enabled, 'workspace')
})

test('工作区没定的字段继续往下读', () => {
  const workspace = layer({ 'global:a': { enabled: false } })
  const global = layer({ 'global:a': { mode: 'lazy', tools: ['read_*'] } })
  const resolved = resolveRow('global:a', workspace, global)
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.mode, 'lazy')
  assert.deepEqual(resolved.tools, ['read_*'])
  assert.equal(resolved.sources.mode, 'global')
  assert.equal(resolved.from, 'workspace')
})

test('两层都没有时取默认：允许、dynamic、无规则', () => {
  const resolved = resolveRow('global:a', null, EMPTY_LAYER)
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.mode, 'dynamic')
  assert.deepEqual(resolved.tools, [])
  assert.equal(resolved.from, 'default')
})

test('显式 false 与缺席是两件事', () => {
  const global = layer({ 'global:a': { enabled: false } })
  assert.equal(hasLayerEntry(global, 'global:a'), true)
  assert.equal(hasLayerEntry(global, 'global:b'), false)
  assert.equal(resolveRow('global:a', null, global).enabled, false)
  assert.equal(resolveRow('global:b', null, global).enabled, true)
})

test('坏 JSON 降级为空策略并给 warning', () => {
  const parsed = parseLayer('{ not json')
  assert.deepEqual(parsed.value.rows, {})
  assert.equal(parsed.warnings.length, 1)
})

test('版本不认识时降级', () => {
  const parsed = parseLayer(JSON.stringify({ version: 2, rows: {} }))
  assert.deepEqual(parsed.value.rows, {})
  assert.match(parsed.warnings[0], /版本/u)
})

test('坏字段被丢弃，好字段保留', () => {
  const parsed = parseLayer(JSON.stringify({
    version: 1,
    rows: { 'global:a': { enabled: 'yes', mode: 'lazy', tools: ['x', 1] } },
  }))
  assert.equal(parsed.value.rows['global:a'].mode, 'lazy')
  assert.equal(parsed.value.rows['global:a'].enabled, undefined)
  assert.equal(parsed.value.rows['global:a'].tools, undefined)
  assert.equal(parsed.warnings.length, 2)
})

test('序列化按 rowKey 排序且往返稳定', () => {
  const text = serializeLayer(layer({ 'global:b': { mode: 'eager' }, 'global:a': { enabled: false } }))
  const again = parseLayer(text).value
  assert.deepEqual(Object.keys(again.rows), ['global:a', 'global:b'])
  assert.equal(serializeLayer(again), text)
})
