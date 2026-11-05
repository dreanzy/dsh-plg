import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryState, sectionText } from '../lib/state.js'
import { createScopeSnapshot } from '../lib/snapshot.js'

const row = (serverName, rowKey) => ({
  rowKey,
  serverName,
  config: { transport: 'stdio', serverName, command: 'node' },
})

function layerOf(policy) {
  return { version: 1, rows: policy, settings: { showSidebarEntry: true } }
}

function stateWith(rows, rowsPolicy = {}, workspacePolicy = null, owned = { version: 1, servers: {} }) {
  const snapshot = createScopeSnapshot({
    scan: () => ({ rows, complete: true, warnings: [] }),
    load: async () => ({
      global: layerOf(rowsPolicy),
      workspace: workspacePolicy === null ? null : layerOf(workspacePolicy),
      owned,
      warnings: [],
    }),
  })
  return createInventoryState(snapshot, null)
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
test('托管定义会并进行视图，并按工作区开关求值', async () => {
  const owned = {
    version: 1,
    servers: {
      unity: { transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp', headers: {} },
    },
  }
  // 全局禁用、工作区启用：这是最容易被漏掉的一条路径。
  const state = stateWith(
    [],
    { 'own:unity': { enabled: false, mode: 'lazy' } },
    { 'own:unity': { enabled: true } },
    owned,
  )
  await state.refresh()
  assert.deepEqual(state.snapshot().map((item) => item.serverName), ['unity'])
  assert.ok(state.target('unity'))
  assert.equal(state.target('unity').mode, 'lazy')
})

test('托管定义与 Loader 行同名时保留 Loader 行', async () => {
  const owned = { version: 1, servers: { srv: { transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' } } }
  const state = stateWith([row('srv', 'global:srv')], {}, null, owned)
  await state.refresh()
  assert.equal(state.snapshot().length, 1)
  assert.ok(state.snapshot()[0].serverName === 'srv')
})
