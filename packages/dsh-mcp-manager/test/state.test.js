import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryState, sectionText } from '../lib/state.js'

const row = (serverName, rowKey) => ({
  rowKey,
  serverName,
  config: { transport: 'stdio', serverName, command: 'node' },
})

function stateWith(rows, rowsPolicy = {}, workspacePolicy = null) {
  return createInventoryState({
    scan: () => ({ rows, warnings: [] }),
    load: async () => ({
      global: { version: 1, rows: rowsPolicy },
      workspace: workspacePolicy === null ? null : { version: 1, rows: workspacePolicy },
    }),
  })
}

test('默认模式是 dynamic，行进入名册', async () => {
  const state = stateWith([row('playwright', 'global:playwright')])
  await state.refresh()
  assert.deepEqual(state.snapshot().map((item) => item.serverName), ['playwright'])
})

test('eager 行不进名册', async () => {
  const state = stateWith([row('hot', 'global:hot')], { 'global:hot': { mode: 'eager' } })
  await state.refresh()
  assert.deepEqual(state.snapshot(), [])
})

test('禁用的行不进名册', async () => {
  const state = stateWith([row('off', 'global:off')], { 'global:off': { enabled: false } })
  await state.refresh()
  assert.deepEqual(state.snapshot(), [])
})

test('描述透传到名册行', async () => {
  const state = stateWith([row('a', 'global:a')], { 'global:a': { description: '浏览器' } })
  await state.refresh()
  assert.equal(state.snapshot()[0].description, '浏览器')
  assert.match(sectionText(state), /- a — 浏览器/u)
})

test('工作区层压过全局层', async () => {
  const state = stateWith(
    [row('a', 'global:a')],
    { 'global:a': { mode: 'eager' } },
    { 'global:a': { mode: 'lazy' } },
  )
  await state.refresh()
  assert.equal(state.snapshot().length, 1)
})

test('空名册的段文本是空串', async () => {
  const state = stateWith([])
  await state.refresh()
  assert.equal(sectionText(state), '')
})
test('serverName 匹配不区分大小写', async () => {
  const state = stateWith([row('unityMCP8082', 'own:unityMCP8082')])
  await state.refresh()
  assert.ok(state.target('unityMCP8082'))
  assert.ok(state.target('unitymcp8082'))
  assert.ok(state.target('UNITYMCP8082'))
  assert.equal(state.target('other'), null)
})
