import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOnDemandTools, resultText } from '../lib/tools.js'
import { parseToolFilter } from '../lib/filter.js'

const defineTool = (options) => options

function fakePool() {
  const state = { acquired: [], released: [], called: [] }
  const pool = {
    async acquire(key) {
      state.acquired.push(key)
      return {
        key,
        connection: {
          key,
          listTools: async () => [],
          callTool: async (name, args) => {
            state.called.push({ name, args })
            if (name === 'boom') return { isError: true, content: [{ type: 'text', text: 'tool failed' }] }
            return { content: [{ type: 'text', text: 'ok:' + name }] }
          },
          close: async () => {},
        },
        tools: [
          { name: 'read_file', description: '读文件', inputSchema: { type: 'object' } },
          { name: 'write_file', description: '写文件', inputSchema: { type: 'object' } },
          { name: 'boom', description: '', inputSchema: {} },
        ],
      }
    },
    release(handle) { state.released.push(handle.key) },
    size: () => 0,
    keys: () => [],
    closeAll: async () => {},
  }
  return { pool, state }
}

function fakeTools() {
  const registered = []
  return { registered, register: (definition) => { registered.push(definition); return () => {} } }
}

const factory = (_ctx, spec) => ({ name: spec.name, __spec: spec })

const target = (overrides = {}) => ({
  rowKey: 'global:srv',
  serverName: 'srv',
  spec: { transport: 'stdio', serverName: 'srv', command: 'node' },
  filter: parseToolFilter([]),
  mode: 'lazy',
  ...overrides,
})

function build(overrides = {}) {
  const poolState = fakePool()
  const tools = fakeTools()
  const { load, unload, call } = createOnDemandTools({
    defineTool,
    pool: poolState.pool,
    resolveTarget: () => target(overrides.target ?? {}),
    resolveFactory: async () => factory,
    logger: { warn() {} },
  })
  const agent = { id: 'a', ctx: { get: (key) => (key === 'tools' ? tools : undefined) } }
  return { load, unload, call, tools, poolState, agent }
}

test('lazy 不注册工具，只返回 schema', async () => {
  const ctx = build()
  const value = await ctx.load.execute({ server: 'srv' }, { agent: ctx.agent })
  assert.equal(value.mode, 'lazy')
  assert.equal(ctx.tools.registered.length, 0)
  assert.deepEqual(value.loaded, ['read_file', 'write_file', 'boom'])
  assert.equal(value.tools[0].name, 'read_file')
  assert.equal(value.tools[0].description, '读文件')
})

test('lazy 的 query 收窄返回集合', async () => {
  const ctx = build()
  const value = await ctx.load.execute({ server: 'srv', query: 'write' }, { agent: ctx.agent })
  assert.deepEqual(value.loaded, ['write_file'])
})

test('lazy 的 tool 精确取一个', async () => {
  const ctx = build()
  const value = await ctx.load.execute({ server: 'srv', tool: 'boom' }, { agent: ctx.agent })
  assert.deepEqual(value.loaded, ['boom'])
  assert.match(value.note, /^$/u)
})

test('lazy 过滤规则同时约束返回集合', async () => {
  const ctx = build({ target: { filter: parseToolFilter(['!write_*']) } })
  const value = await ctx.load.execute({ server: 'srv' }, { agent: ctx.agent })
  assert.deepEqual(value.loaded, ['read_file', 'boom'])
  assert.equal(value.hidden, 1)
})

test('mcp_call 在未加载时拒绝', async () => {
  const ctx = build()
  await assert.rejects(() => ctx.call.execute({ server: 'srv', tool: 'read_file' }, { agent: ctx.agent }), /not loaded/u)
})

test('mcp_call 在 dynamic 行上拒绝', async () => {
  const ctx = build({ target: { mode: 'dynamic' } })
  await assert.rejects(() => ctx.call.execute({ server: 'srv', tool: 'read_file' }, { agent: ctx.agent }), /not lazy/u)
})

test('mcp_call 转发参数并透传结果', async () => {
  const ctx = build()
  await ctx.load.execute({ server: 'srv' }, { agent: ctx.agent })
  const value = await ctx.call.execute({ server: 'srv', tool: 'read_file', args: { path: 'a.txt' } }, { agent: ctx.agent })
  assert.equal(resultText(value), 'ok:read_file')
  assert.deepEqual(ctx.poolState.state.called, [{ name: 'read_file', args: { path: 'a.txt' } }])
})

test('mcp_call 拒绝被过滤掉的工具', async () => {
  const ctx = build({ target: { filter: parseToolFilter(['!write_*']) } })
  await ctx.load.execute({ server: 'srv' }, { agent: ctx.agent })
  await assert.rejects(() => ctx.call.execute({ server: 'srv', tool: 'write_file' }, { agent: ctx.agent }), /no callable tool/u)
})

test('mcp_call 把 isError 结果转成错误', async () => {
  const ctx = build()
  await ctx.load.execute({ server: 'srv' }, { agent: ctx.agent })
  await assert.rejects(() => ctx.call.execute({ server: 'srv', tool: 'boom' }, { agent: ctx.agent }), /tool failed/u)
})

test('mcp_call 拒绝未知工具名', async () => {
  const ctx = build()
  await ctx.load.execute({ server: 'srv' }, { agent: ctx.agent })
  await assert.rejects(() => ctx.call.execute({ server: 'srv', tool: 'nope' }, { agent: ctx.agent }), /no callable tool/u)
})
