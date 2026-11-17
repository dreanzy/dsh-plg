import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectMcp } from '../lib/mcp-connection.js'
import { createPool } from '../lib/pool.js'

const fixture = fileURLToPath(new URL('./fixtures/http-server.mjs', import.meta.url))

/**
 * 起一台 Streamable HTTP fixture，返回端口与关闭函数。
 *
 * 沙箱可能禁止 spawn 子进程；这类环境下真实连接用例没有意义，跳过而不是判红。
 */
async function startFixture(wantedPort = 0, options = {}) {
  const child = spawn(process.execPath, [fixture], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, FIXTURE_PORT: String(wantedPort), FIXTURE_EXTRA: options.extra ?? '' },
  })
  const port = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('fixture 启动超时')), 15000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n')[0]
      if (line === undefined || line === '') return
      try {
        clearTimeout(timer)
        resolve(JSON.parse(line).port)
      } catch {
        // 还没收全，等下一块。
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return {
    port,
    url: `http://127.0.0.1:${String(port)}/mcp`,
    async drop() {
      const response = await fetch(`http://127.0.0.1:${String(port)}/__drop`, { method: 'POST' })
      await response.text()
    },
    async failNext() {
      const response = await fetch(`http://127.0.0.1:${String(port)}/__fail-next`, { method: 'POST' })
      await response.text()
    },
    stop() {
      child.kill()
    },
  }
}

async function canSpawn() {
  return await new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', () => resolve(false))
      child.on('exit', () => resolve(true))
    } catch {
      resolve(false)
    }
  })
}

/**
 * 回归：服务端回收 session 后，连接必须自愈。
 *
 * 这是 mcp-for-unity-server 的实测故障：服务端 30 分钟空闲超时丢弃 session，此后
 * 每个请求都返回 404 `Session not found`。SDK 不清 `_sessionId`、不触发 `onclose`，
 * 所以 `alive()` 一直报活着，池一直交出这条死连接——一次空闲超时就让这台 server
 * 永久废掉，直到进程重启。
 */
test('服务端回收 session 后，下一次调用自动重建会话', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const server = await startFixture()
  const connection = await connectMcp('http', { transport: 'streamable-http', serverName: 'http', url: server.url }, { timeoutMs: 15000 })
  try {
    const before = await connection.callTool('echo', { text: 'before' })
    assert.deepEqual(before, { content: [{ type: 'text', text: 'before' }] })

    await server.drop()

    // 关键断言：这一步在修复前报 "Session not found"。
    const after = await connection.callTool('echo', { text: 'after' })
    assert.deepEqual(after, { content: [{ type: 'text', text: 'after' }] })

    // 自愈之后连接仍然可用，不是一次性恢复。
    const again = await connection.callTool('echo', { text: 'again' })
    assert.deepEqual(again, { content: [{ type: 'text', text: 'again' }] })
  } finally {
    await connection.close()
    server.stop()
  }
})

test('session 回收后 listTools 也自愈', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const server = await startFixture()
  const connection = await connectMcp('http', { transport: 'streamable-http', serverName: 'http', url: server.url }, { timeoutMs: 15000 })
  try {
    assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ['echo'])
    await server.drop()
    assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ['echo'])
  } finally {
    await connection.close()
    server.stop()
  }
})

/**
 * 池层：连接自愈后，池不该把这条连接判死重连。
 *
 * 池的 `alive()` 判据看不见 session 失效（SDK 不报），所以自愈必须发生在连接内部；
 * 池这一层只负责「同一个 key 一条连接」。
 */
test('池里的连接在 session 回收后仍可复用，不重连', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const server = await startFixture()
  const pool = createPool()
  const spec = { transport: 'streamable-http', serverName: 'http', url: server.url }
  try {
    const handle = await pool.acquire('own:http', spec)
    assert.deepEqual(await handle.connection.callTool('echo', { text: 'before' }), { content: [{ type: 'text', text: 'before' }] })

    await server.drop()

    const reused = await pool.acquire('own:http', spec)
    assert.equal(reused.connection, handle.connection, '自愈发生在连接内部，池不该重连')
    assert.deepEqual(await reused.connection.callTool('echo', { text: 'after' }), { content: [{ type: 'text', text: 'after' }] })
  } finally {
    await pool.closeAll()
    server.stop()
  }
})

/**
 * 回归：服务端进程挂掉后，连接必须自愈。
 *
 * HTTP 没有长连接，服务端进程挂掉时客户端这边什么都不会发生：`onclose` 不触发、
 * `alive()` 一直报活着，下一次请求才报 `fetch failed`。不重建的话，池会一直交出
 * 这条死连接，每次调用都失败，直到进程重启。
 */
test('服务端进程挂掉后重启，连接自动重建', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const first = await startFixture()
  const connection = await connectMcp('http', { transport: 'streamable-http', serverName: 'http', url: first.url }, { timeoutMs: 15000 })
  let second = null
  try {
    assert.deepEqual(await connection.callTool('echo', { text: 'before' }), { content: [{ type: 'text', text: 'before' }] })

    first.stop()
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // 服务端死着：重连也失败，错误必须原样抛出，不能吞掉。
    await assert.rejects(() => connection.callTool('echo', { text: 'x' }), /fetch failed/u)

    // 同一个端口重启：下一次调用必须自愈。
    second = await startFixture(first.port)
    assert.deepEqual(await connection.callTool('echo', { text: 'back' }), { content: [{ type: 'text', text: 'back' }] })
  } finally {
    await connection.close()
    if (second !== null) second.stop()
  }
})

/**
 * 回归：会话重建后，池里的工具目录必须刷新。
 *
 * 服务端重启后工具列表可能变了（插件升级、换项目）。池里的 `tools` 是首次连接时
 * 列的，不刷新的话新工具永远看不到，`mcp_call` 的 `admitted` 检查还会用旧目录拒掉它。
 */
test('会话重建后池刷新工具目录', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const first = await startFixture()
  const pool = createPool()
  const spec = { transport: 'streamable-http', serverName: 'http', url: first.url }
  let second = null
  try {
    const handle = await pool.acquire('own:http', spec)
    assert.deepEqual(handle.tools.map((tool) => tool.name), ['echo'])

    first.stop()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    second = await startFixture(first.port, { extra: 'newtool' })

    // 先触发一次重建。
    await handle.connection.callTool('echo', { text: 'x' })
    assert.equal(handle.connection.generation(), 2, '会话必须重建过一次')

    // 再 acquire：工具目录必须跟着刷新。
    const refreshed = await pool.acquire('own:http', spec)
    assert.deepEqual(refreshed.tools.map((tool) => tool.name).sort(), ['echo', 'newtool'])
  } finally {
    await pool.closeAll()
    if (second !== null) second.stop()
  }
})

test('非 session 错误照常抛出，不重试', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const server = await startFixture()
  const connection = await connectMcp('http', { transport: 'streamable-http', serverName: 'http', url: server.url }, { timeoutMs: 15000 })
  try {
    // 服务端 500：不是 session 失效。必须原样抛出，不能被「重连一次」掩盖成
    // 第二次的同一个错误。
    await server.failNext()
    await assert.rejects(
      () => connection.callTool('echo', { text: 'x' }),
      (error) => error instanceof Error && !/session not found/iu.test(error.message),
    )
    // 失败之后连接仍然可用：非 session 错误不该把连接判死。
    assert.deepEqual(await connection.callTool('echo', { text: 'still' }), { content: [{ type: 'text', text: 'still' }] })
  } finally {
    await connection.close()
    server.stop()
  }
})
