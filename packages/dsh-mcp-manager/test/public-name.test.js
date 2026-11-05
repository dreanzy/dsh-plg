import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicToolName, isPublicNameOf } from '../lib/public-name.js'

test('干净情况下就是 mcp__server__tool', () => {
  assert.equal(publicToolName('playwright', 'click'), 'mcp__playwright__click')
})

test('非法字符被替换并附哈希', () => {
  const name = publicToolName('srv', 'a.b/c')
  assert.match(name, /^mcp__srv__a_b_c_[0-9a-f]{12}$/u)
  assert.ok(name.length <= 64)
})

test('超长名截断并附哈希', () => {
  const long = 'x'.repeat(100)
  const name = publicToolName('srv', long)
  assert.equal(name.length, 64)
  assert.match(name, /_[0-9a-f]{12}$/u)
})

test('不同身份不会塌成同一个名字', () => {
  const left = publicToolName('srv', 'a.b')
  const right = publicToolName('srv', 'a_b')
  assert.notEqual(left, right)
})

test('同一身份稳定', () => {
  assert.equal(publicToolName('srv', 'a.b'), publicToolName('srv', 'a.b'))
})

test('isPublicNameOf 只按前缀判断', () => {
  assert.equal(isPublicNameOf('srv', 'mcp__srv__x'), true)
  assert.equal(isPublicNameOf('srv', 'mcp__other__x'), false)
})
