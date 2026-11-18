import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleKeysOf } from '../lib/index.js'

/**
 * 残留键判定。
 *
 * 三包共用这一条：策略里有、当前名册里没有。它原先各写一遍，分叉的后果是同一个包
 * 在 plugin 面板里算残留、在 mcp 面板里不算。这里钉住的是集合语义——空名册不等于
 * 「没有残留」，也不等于「全是残留」，取决于策略里有没有键。
 */

test('空策略：没有残留键', () => {
  assert.deepEqual(staleKeysOf([], new Set()), [])
  assert.deepEqual(staleKeysOf([], new Set(['a', 'b'])), [])
})

test('空名册：策略里的键全是残留', () => {
  assert.deepEqual(staleKeysOf(['a', 'b'], new Set()), ['a', 'b'])
})

test('全交集：没有残留键', () => {
  assert.deepEqual(staleKeysOf(['a', 'b'], new Set(['a', 'b'])), [])
})

test('全不相交：策略里的键全是残留', () => {
  assert.deepEqual(staleKeysOf(['a', 'b'], new Set(['c', 'd'])), ['a', 'b'])
})

test('部分相交：只返回名册里没有的那些', () => {
  assert.deepEqual(staleKeysOf(['a', 'b', 'c'], new Set(['b'])), ['a', 'c'])
})

test('结果排序且去重：输入顺序不影响输出', () => {
  assert.deepEqual(staleKeysOf(['c', 'a', 'b', 'a'], new Set()), ['a', 'b', 'c'])
})

test('空字符串不算键：手改文件留下的空键不该出现在面板上', () => {
  assert.deepEqual(staleKeysOf(['', 'a'], new Set()), ['a'])
})

test('接受任意可迭代对象：Set 与生成器都行', () => {
  function* keys() {
    yield 'x'
    yield 'y'
  }
  assert.deepEqual(staleKeysOf(keys(), new Set(['x'])), ['y'])
  assert.deepEqual(staleKeysOf(new Set(['x', 'y']), new Set(['x'])), ['y'])
})
