import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildChildEnv, connectMcp } from '../lib/mcp-connection.js'

const fixture = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))

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
test('真实 stdio 连接：listTools、callTool、isError 都走得通', async () => {
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

test('凭证形状与 DSH_ 变量不会传给子进程', () => {
  process.env.MY_TEST_API_KEY = 'secret-value'
  process.env.DSH_SOMETHING = 'internal'
  process.env.PLAIN_VALUE = 'kept'
  try {
    const env = buildChildEnv({ EXTRA: '1' })
    assert.equal(env['MY_TEST_API_KEY'], undefined)
    assert.equal(env['DSH_SOMETHING'], undefined)
    assert.equal(env['PLAIN_VALUE'], 'kept')
    assert.equal(env['EXTRA'], '1')
  } finally {
    delete process.env.MY_TEST_API_KEY
    delete process.env.DSH_SOMETHING
    delete process.env.PLAIN_VALUE
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
