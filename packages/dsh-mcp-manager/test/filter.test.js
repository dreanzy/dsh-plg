import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admits, filterHidesAnything, filterTools, parseToolFilter, toolRuleEntries } from '../lib/filter.js'

test('空规则放行一切', () => {
  const filter = parseToolFilter([])
  assert.equal(filterHidesAnything(filter), false)
  assert.equal(admits(filter, 'anything'), true)
})

test('纯白名单：只放行命中的', () => {
  const filter = parseToolFilter(['read_*'])
  assert.equal(admits(filter, 'read_file'), true)
  assert.equal(admits(filter, 'write_file'), false)
})

test('纯黑名单：只排除命中的', () => {
  const filter = parseToolFilter(['!delete_*'])
  assert.equal(admits(filter, 'delete_workitem'), false)
  assert.equal(admits(filter, 'read_file'), true)
})

test('混合时先看黑名单，再看白名单', () => {
  const filter = parseToolFilter(['read_*', '!read_secret'])
  assert.equal(admits(filter, 'read_file'), true)
  assert.equal(admits(filter, 'read_secret'), false)
})

test('区分大小写', () => {
  const filter = parseToolFilter(['Read'])
  assert.equal(admits(filter, 'Read'), true)
  assert.equal(admits(filter, 'read'), false)
})

test('问号只匹配单个字符', () => {
  const filter = parseToolFilter(['get_?'])
  assert.equal(admits(filter, 'get_a'), true)
  assert.equal(admits(filter, 'get_ab'), false)
})

test('正则元字符被当作字面量', () => {
  const filter = parseToolFilter(['a.b'])
  assert.equal(admits(filter, 'a.b'), true)
  assert.equal(admits(filter, 'axb'), false)
})

test('非法条目被跳过，不抛错', () => {
  const entries = toolRuleEntries(['ok', 42, null, '  '])
  assert.deepEqual(entries, ['ok'])
  assert.deepEqual(toolRuleEntries('solo'), ['solo'])
  assert.deepEqual(toolRuleEntries({}), [])
})

test('filterTools 报出隐藏数量并保持原顺序', () => {
  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  const result = filterTools(tools, parseToolFilter(['!b']))
  assert.deepEqual(result.visible.map((tool) => tool.name), ['a', 'c'])
  assert.equal(result.hidden, 1)
})
