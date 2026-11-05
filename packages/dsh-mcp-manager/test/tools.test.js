import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOnDemandTools, releaseAgent } from '../lib/tools.js'
import { parseToolFilter } from '../lib/filter.js'

const defineTool = (options) => options

function fakePool() {
  const state = { acquired: [], released: [], handle: null }
  const pool = {
    async acquire(key, spec) {
      state.acquired.push({ key, spec })
      const handle = {
        key,
        connection: { key, listTools: async () => [], callTool: async () => ({}), close: async () => {} },
        tools: [
          { name: 'read_file', description: '', inputSchema: {} },
          { name: 'delete_file', description: '', inputSchema: {} },
        ],
      }
      state.handle = handle
      return handle
    },
    release(handle) { state.released.push(handle.key) },
    size: () => 0,
    keys: () => [],
    closeAll: async () => {},
  }
  return { pool, state }
}

function fakeTools(failOn = null) {
  const registered = []
  const disposed = []
  return {
    registered,
    disposed,
    register(definition) {
      if (failOn !== null && definition.__spec?.rawName === failOn) throw new Error('register rejected')
      registered.push(definition)
      return () => { disposed.push(definition.name) }
    },
  }
}

function fakeAgent(tools) {
  return { id: 'agent-1', ctx: { get: (key) => (key === 'tools' ? tools : undefined) } }
}

const factory = (_ctx, spec) => ({ name: spec.name, rawName: spec.rawName, call: spec.call, __spec: spec })

const target = (overrides = {}) => ({
  rowKey: 'global:srv',
  serverName: 'srv',
  spec: { transport: 'stdio', serverName: 'srv', command: 'node' },
  filter: parseToolFilter([]),
  mode: 'dynamic',
  ...overrides,
})

function build({ tools = fakeTools(), poolState = fakePool(), resolveTarget = () => target(), resolveFactory = async () => factory } = {}) {
  const { load, unload } = createOnDemandTools({
    defineTool,
    pool: poolState.pool,
    resolveTarget,
    resolveFactory,
    logger: { warn() {} },
  })
  return { load, unload, tools, poolState }
}

test('未知 server 报可读错误', async () => {
  const { load } = build({ resolveTarget: () => null })
  await assert.rejects(() => load.execute({ server: 'nope' }, { agent: fakeAgent(fakeTools()) }), /unknown or disabled/u)
})

test('eager 行拒绝 mcp_load', async () => {
  const { load } = build({ resolveTarget: () => target({ mode: 'eager' }) })
  await assert.rejects(() => load.execute({ server: 'srv' }, { agent: fakeAgent(fakeTools()) }), /already available/u)
})

test('没有 agent 时报错', async () => {
  const { load } = build()
  await assert.rejects(() => load.execute({ server: 'srv' }, {}), /inside an agent session/u)
})

test('加载后按公开名注册全部可见工具', async () => {
  const ctx = build()
  const agent = fakeAgent(ctx.tools)
  const value = await ctx.load.execute({ server: 'srv' }, { agent })
  assert.deepEqual(value.loaded, ['mcp__srv__read_file', 'mcp__srv__delete_file'])
  assert.equal(value.hidden, 0)
  assert.equal(ctx.tools.registered.length, 2)
  assert.equal(ctx.poolState.state.acquired[0].key, 'global:srv')
})

test('过滤规则生效并报出隐藏数量', async () => {
  const ctx = build({ resolveTarget: () => target({ filter: parseToolFilter(['!delete_*']) }) })
  const value = await ctx.load.execute({ server: 'srv' }, { agent: fakeAgent(ctx.tools) })
  assert.deepEqual(value.loaded, ['mcp__srv__read_file'])
  assert.equal(value.hidden, 1)
})

test('注册失败整代回滚并释放连接', async () => {
  const tools = fakeTools('delete_file')
  const ctx = build({ tools })
  await assert.rejects(() => ctx.load.execute({ server: 'srv' }, { agent: fakeAgent(tools) }), /failed to register/u)
  assert.equal(tools.registered.length, 1)
  assert.deepEqual(tools.disposed, ['mcp__srv__read_file'])
  assert.deepEqual(ctx.poolState.state.released, ['global:srv'])
})

test('重复加载先释放上一代', async () => {
  const ctx = build()
  const agent = fakeAgent(ctx.tools)
  await ctx.load.execute({ server: 'srv' }, { agent })
  await ctx.load.execute({ server: 'srv' }, { agent })
  assert.equal(ctx.tools.registered.length, 4)
  assert.deepEqual(ctx.tools.disposed, ['mcp__srv__read_file', 'mcp__srv__delete_file'])
  assert.deepEqual(ctx.poolState.state.released, ['global:srv'])
})

test('unload 释放并幂等', async () => {
  const ctx = build()
  const agent = fakeAgent(ctx.tools)
  await ctx.load.execute({ server: 'srv' }, { agent })
  const first = await ctx.unload.execute({ server: 'srv' }, { agent })
  assert.equal(first.released, true)
  const second = await ctx.unload.execute({ server: 'srv' }, { agent })
  assert.equal(second.released, false)
  assert.deepEqual(ctx.poolState.state.released, ['global:srv'])
})

test('releaseAgent 清空该 agent 的全部加载', async () => {
  const ctx = build()
  const agent = fakeAgent(ctx.tools)
  await ctx.load.execute({ server: 'srv' }, { agent })
  releaseAgent(agent, ctx.poolState.pool)
  assert.deepEqual(ctx.tools.disposed, ['mcp__srv__read_file', 'mcp__srv__delete_file'])
  assert.deepEqual(ctx.poolState.state.released, ['global:srv'])
})

test('适配器取不到时报错，不静默降级', async () => {
  const ctx = build({ resolveFactory: async () => { throw new Error('no adapter') } })
  await assert.rejects(() => ctx.load.execute({ server: 'srv' }, { agent: fakeAgent(ctx.tools) }), /no adapter/u)
})
