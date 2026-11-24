import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DirtySet } from '../lib/dirty.js'

test('同版本只登记一次', () => {
  const set = new DirtySet()
  set.mark('a.ts', 'v1', 1)
  set.mark('a.ts', 'v1', 2)
  assert.equal(set.size, 1)
})

test('新版本覆盖旧版本并刷新时间', () => {
  const set = new DirtySet()
  set.mark('a.ts', 'v1', 1)
  set.mark('a.ts', 'v2', 5)
  assert.equal(set.size, 1)
  assert.equal(set.has('a.ts', 'v2'), true)
  assert.equal(set.has('a.ts', 'v1'), false)
})

test('take 按登记顺序且取走后不再重复', () => {
  const set = new DirtySet()
  set.mark('a.ts', '1', 1)
  set.mark('b.py', '1', 2)
  set.mark('c.lua', '1', 3)
  const first = set.take(2)
  assert.deepEqual(first.map((entry) => entry.path), ['a.ts', 'b.py'])
  assert.equal(set.size, 1)
  assert.deepEqual(set.take(5).map((entry) => entry.path), ['c.lua'])
})
