import { test } from 'node:test'
import assert from 'node:assert/strict'
import { denyNamesFor } from '../lib/shield.js'

test('按前缀收窄到指定 server', () => {
  const deny = denyNamesFor(['mcp__a__x', 'mcp__b__y', 'other'], ['a'])
  assert.deepEqual(deny, ['mcp__a__x'])
})

test('多个 server 一并罩住，结果有序', () => {
  const deny = denyNamesFor(['mcp__b__y', 'mcp__a__x'], ['a', 'b'])
  assert.deepEqual(deny, ['mcp__a__x', 'mcp__b__y'])
})

test('没有 server 时返回空', () => {
  assert.deepEqual(denyNamesFor(['mcp__a__x'], []), [])
})

test('前缀必须完整匹配名字边界', () => {
  // mcp__ab__x 不属于 server "a"
  assert.deepEqual(denyNamesFor(['mcp__ab__x'], ['a']), [])
})
