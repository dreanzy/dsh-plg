import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildChildEnv, connectMcp } from '../lib/mcp-connection.js'

const fixture = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))

/** 沙箱可能禁止 spawn 子进程；这类环境下真实连接用例没有意义，跳过而不是判红。 */
async function canSpawn() {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    try {
      // 必须用管道：真实连接走的是 piped stdio，只在管道被禁的环境里才该跳过。
      const child = spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', () => resolve(false))
      child.on('exit', () => resolve(true))
    } catch {
      resolve(false)
    }
  })
}

function spec() {
  return {
    transport: 'stdio',
    serverName: 'echo',
    command: process.execPath,
    args: [fixture],
  }
}

/**
 * 一条连接内跑完列目录与调用。
 *
 * 刻意不拆成多个 test：每条都要 spawn 一个子进程，跨测试的连接生命周期
 * 在 `--test-isolation=none` 下容易互相干扰。这里要固定的是**调用契约**，
 * 一次连接足够验证。
 */
test('真实 stdio 连接：listTools、callTool、isError 都走得通', async (t) => {
  if (!(await canSpawn())) {
    t.skip('当前环境禁止 spawn 子进程')
    return
  }
  const connection = await connectMcp('echo', spec(), { timeoutMs: 15000 })
  try {
    const tools = await connection.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['boom', 'echo'])
    const echo = tools.find((tool) => tool.name === 'echo')
    assert.equal(echo.description, 'echo the given text')
    assert.ok(echo.inputSchema !== undefined)

    // 关键断言：这一步曾经报 "resultSchema.safeParse is not a function"，
    // 因为 options 被塞进了第二个参数（SDK 把它当 zod result schema）。
    const hello = await connection.callTool('echo', { text: 'hi' })
    assert.deepEqual(hello, { content: [{ type: 'text', text: 'hi' }] })

    const failed = await connection.callTool('boom', {})
    assert.equal(failed.isError, true)
    assert.match(String(failed.content[0].text), /failed on purpose/u)
  } finally {
    await connection.close()
  }
})

test('子进程只继承白名单变量，显式 env 照传', () => {
  process.env.MY_TEST_API_KEY = 'secret-value'
  process.env.DSH_SOMETHING = 'internal'
  process.env.DATABASE_URL = 'postgres://user:secret@db.internal/app'
  process.env.PLAIN_VALUE = 'dropped'
  process.env.UV_CACHE_DIR = 'D:/uv-cache'
  process.env.HTTP_PROXY = 'http://user:secret@proxy.internal:3128'
  const previousPath = process.env.PATH
  process.env.PATH = previousPath || '/usr/bin'
  try {
    const env = buildChildEnv({ EXTRA: '1' })
    assert.equal(env['MY_TEST_API_KEY'], undefined)
    assert.equal(env['DSH_SOMETHING'], undefined)
    assert.equal(env['DATABASE_URL'], undefined)
    assert.equal(env['PLAIN_VALUE'], undefined)
    assert.equal(env['UV_CACHE_DIR'], 'D:/uv-cache')
    // 代理值里常带凭据，刻意不传；需要的 server 在配置的 env 里自己声明。
    assert.equal(env['HTTP_PROXY'], undefined)
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
    assert.ok(pathKey !== undefined, 'PATH 必须传给子进程')
    assert.equal(env[pathKey], process.env.PATH)
    assert.equal(env['EXTRA'], '1')
  } finally {
    delete process.env.MY_TEST_API_KEY
    delete process.env.DSH_SOMETHING
    delete process.env.DATABASE_URL
    delete process.env.PLAIN_VALUE
    delete process.env.UV_CACHE_DIR
    delete process.env.HTTP_PROXY
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

test('连不上时抛出原始错误', async () => {
  await assert.rejects(
    () =>
      connectMcp(
        'nope',
        { transport: 'stdio', serverName: 'nope', command: process.execPath, args: ['-e', 'process.exit(1)'] },
        { timeoutMs: 5000 },
      ),
    (error) => error instanceof Error,
  )
})
