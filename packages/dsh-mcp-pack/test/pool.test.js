import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../lib/pool.js'

function fakeConnection(key, tools = [{ name: 'a', description: '', inputSchema: {} }]) {
  const state = { closed: 0, generation: 1 }
  return {
    state,
    connection: {
      key,
      alive: () => state.dead !== true,
      generation: () => state.generation,
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
test('acquire 在 await 期间被 release：重开而不是拿到死连接', async () => {
  let connects = 0
  const made = []
  const pool = createPool({
    connect: async (key) => {
      connects += 1
      const item = fakeConnection(key)
      made.push(item)
      return item.connection
    },
  })
  // 先建立一条，再让它在 acquire 的 await 窗口里被释放。
  const first = await pool.acquire('k', spec)
  const pending = pool.acquire('k', spec)
  pool.release(first)
  const second = await pending
  assert.equal(connects, 2, '死连接必须重开')
  assert.notEqual(second.connection, first.connection)
  assert.equal(pool.size(), 1)
  await pool.closeAll()
})

test('closeAll 与在飞的 open 竞态：不把连接塞回 live', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const made = fakeConnection('k')
  const pool = createPool({
    connect: async () => {
      await gate
      return made.connection
    },
  })
  const pending = pool.acquire('k', spec)
  await pool.closeAll()
  release()
  await assert.rejects(() => pending, /连接池已关闭/u)
  assert.equal(pool.size(), 0, '关闭后不得留下 entry')
  assert.equal(made.state.closed, 1, '作废的连接必须自己关掉')
})

test('旧 handle 二次 release 不误减新 entry 的引用', async () => {
  const made = []
  const pool = createPool({
    connect: async (key) => {
      const item = fakeConnection(key)
      made.push(item)
      return item.connection
    },
  })
  const old = await pool.acquire('k', spec)
  pool.release(old)
  const fresh = await pool.acquire('k', spec)
  assert.notEqual(fresh.connection, old.connection)
  // 旧 handle 再释放一次：不能把新 entry 的 refs 减到 0。
  pool.release(old)
  assert.equal(pool.size(), 1, '新 entry 不该被旧 handle 关掉')
  assert.equal(made[1].state.closed, 0)
  await pool.closeAll()
})
test('连接崩溃后池重连，不把死连接交出去', async () => {
  let connects = 0
  const made = []
  const pool = createPool({
    connect: async (key) => {
      connects += 1
      const item = fakeConnection(key)
      made.push(item)
      return item.connection
    },
  })
  const first = await pool.acquire('k', spec)
  // 模拟子进程崩溃：传输关闭。
  made[0].state.dead = true
  const second = await pool.acquire('k', spec)
  assert.equal(connects, 2, '死连接必须重连')
  assert.notEqual(second.connection, first.connection)
  await pool.closeAll()
})

test('连接仍活着时复用，不重连', async () => {
  let connects = 0
  const pool = createPool({
    connect: async (key) => { connects += 1; return fakeConnection(key).connection },
  })
  await pool.acquire('k', spec)
  await pool.acquire('k', spec)
  assert.equal(connects, 1)
  await pool.closeAll()
})
