import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderInventory, INVENTORY_SECTION } from '../lib/inventory-section.js'

test('没有行时返回空串，等于不出段', () => {
  assert.equal(renderInventory([]), '')
})

test('段名固定', () => {
  assert.equal(INVENTORY_SECTION, 'mcp-manager:on-demand')
})

test('导语同时点名 mcp_load、mcp_unload、mcp_call', () => {
  const text = renderInventory([{ serverName: 'playwright', description: '' }])
  assert.match(text, /mcp_load/u)
  assert.match(text, /mcp_unload/u)
  assert.match(text, /mcp_call/u)
})

test('每行一条，名字在前描述在后', () => {
  const text = renderInventory([
    { serverName: 'playwright', description: '浏览器' },
    { serverName: 'joplin', description: '' },
  ])
  assert.match(text, /^- playwright — 浏览器$/mu)
  assert.match(text, /^- joplin$/mu)
})

test('单条描述超 80 字符被截断', () => {
  const text = renderInventory([{ serverName: 'a', description: 'x'.repeat(200) }])
  assert.ok(text.includes('- a — ' + 'x'.repeat(80)))
  assert.ok(!text.includes('x'.repeat(81)))
})

test('整段预算耗尽后仍然列出名字', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ serverName: 's' + index, description: 'd'.repeat(80) }))
  const text = renderInventory(rows)
  for (const row of rows) assert.ok(text.includes('- ' + row.serverName), row.serverName)
  const described = text.split('\n').filter((line) => line.includes(' — ')).length
  assert.ok(described * 80 <= 900 + 80, 'described=' + described)
})

test('空名字被跳过', () => {
  assert.equal(renderInventory([{ serverName: '  ', description: 'x' }]), '')
})
