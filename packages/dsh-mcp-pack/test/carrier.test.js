import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNativeDefinitions } from '../lib/carrier.js'

/**
 * 原生载体造定义时的字段透传。
 *
 * 复现的 bug：`McpToolInfo` 只带 name/description/inputSchema/outputSchema，
 * 上游的 `execution.taskSupport` 在列目录时就被丢掉了。宿主
 * `createMcpToolDefinition` 见到 `taskRequired` 会直接拒绝调用，本地不透传就等于
 * 把这个判断丢了——task-required 的工具会被真的发出去。
 */

/** 记录宿主工厂收到的 spec，不造真定义。 */
function factoryOf(seen) {
  return (_ctx, spec) => {
    seen.push(spec)
    return { name: spec.name }
  }
}

function tool(name, extra = {}) {
  return { name, description: name + ' tool', inputSchema: { type: 'object' }, ...extra }
}

test('taskSupport=required 透传成 taskRequired', () => {
  const seen = []
  buildNativeDefinitions({
    factory: factoryOf(seen),
    ctx: {},
    connection: { callTool: async () => ({}) },
    serverName: 'srv',
    tools: [tool('tasky', { taskSupport: 'required' })],
    filter: { keep: [], drop: [] },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].taskRequired, true)
})

test('没声明 taskSupport 时不传 taskRequired', () => {
  const seen = []
  buildNativeDefinitions({
    factory: factoryOf(seen),
    ctx: {},
    connection: { callTool: async () => ({}) },
    serverName: 'srv',
    tools: [tool('plain')],
    filter: { keep: [], drop: [] },
  })
  assert.equal('taskRequired' in seen[0], false, '没声明就不该凭空造一个')
})

test('taskSupport=optional / forbidden 不算 required', () => {
  const seen = []
  buildNativeDefinitions({
    factory: factoryOf(seen),
    ctx: {},
    connection: { callTool: async () => ({}) },
    serverName: 'srv',
    tools: [tool('a', { taskSupport: 'optional' }), tool('b', { taskSupport: 'forbidden' })],
    filter: { keep: [], drop: [] },
  })
  assert.equal(seen.length, 2)
  assert.equal('taskRequired' in seen[0], false)
  assert.equal('taskRequired' in seen[1], false)
})
