import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../lib/pool.js'

function fakeConnection(key, tools = [{ name: 'a', description: '', inputSchema: {} }]) {
  const state = { closed: 0 }
  return {
    state,
    connection: {
      key,
      listTools: async () => tools,
      callTool: async () => ({}),
      close: async () => { state.closed += 1 },
    },
  }
}

const spec = { transport: 'stdio', serverName: 'srv', command: 'node' }

test('同一个 key 只连一次，并发 acquire 也共享', async () => {
  let connects = 0
  const pool = createPool({ connect: async (key) => { connects += 1; return fakeConnection(key).connection } })
  const [left, right] = await Promise.all([pool.acquire('k', spec), pool.acquire('k', spec)])
  assert.equal(connects, 1)
  assert.equal(left.connection, right.connection)
  assert.equal(pool.size(), 1)
  await pool.closeAll()
})

test('引用计数：最后一个释放才关闭', async () => {
  const made = fakeConnection('k')
  const pool = createPool({ connect: async () => made.connection })
  const a = await pool.acquire('k', spec)
  const b = await pool.acquire('k', spec)
  pool.release(a)
  assert.equal(made.state.closed, 0)
  assert.equal(pool.size(), 1)
  pool.release(b)
  assert.equal(pool.size(), 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(made.state.closed, 1)
})

test('连接失败不留槽位，下一次重试', async () => {
  let attempts = 0
  const pool = createPool({
    connect: async (key) => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return fakeConnection(key).connection
    },
  })
  await assert.rejects(() => pool.acquire('k', spec), /boom/u)
  assert.equal(pool.size(), 0)
  const handle = await pool.acquire('k', spec)
  assert.equal(attempts, 2)
  assert.equal(handle.key, 'k')
  await pool.closeAll()
})

test('列出工具失败时关闭已建立的连接', async () => {
  const made = fakeConnection('k')
  made.connection.listTools = async () => { throw new Error('list failed') }
  const pool = createPool({ connect: async () => made.connection })
  await assert.rejects(() => pool.acquire('k', spec), /list failed/u)
  assert.equal(made.state.closed, 1)
})

test('closeAll 关闭全部常驻连接', async () => {
  const first = fakeConnection('a')
  const second = fakeConnection('b')
  const pool = createPool({ connect: async (key) => (key === 'a' ? first : second).connection })
  await pool.acquire('a', spec)
  await pool.acquire('b', spec)
  assert.equal(pool.size(), 2)
  await pool.closeAll()
  assert.equal(first.state.closed, 1)
  assert.equal(second.state.closed, 1)
})
