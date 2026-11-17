import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/**
 * 极简 Streamable HTTP MCP server，用来固定「服务端回收 session」这条契约。
 *
 * 与真实服务端（mcp-for-unity-server）一致的两条行为：
 * 1. `initialize` 时分配 session id，之后每个请求都要带 `Mcp-Session-Id`；
 * 2. session 被回收后，带旧 id 的请求返回 404 + `Session not found`。
 *
 * 额外给测试一个开关：`POST /__drop` 立刻回收当前 session，等价于服务端的空闲超时。
 */
const sessions = new Map()

const server = new McpServer({ name: 'http-fixture', version: '1.0.0' })
server.tool('echo', 'echo the given text', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}))
// 额外工具：验「服务端重启后工具列表变了，池里的缓存会不会过期」。
if (process.env.FIXTURE_EXTRA === 'newtool') {
  server.tool('newtool', 'a tool that only exists after restart', {}, async () => ({
    content: [{ type: 'text', text: 'new' }],
  }))
}

/** 让下一次 MCP 请求返回 500：用来固定「非 session 错误不重试」这条契约。 */
let failNext = false

const http = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__drop') {
    for (const transport of sessions.values()) await transport.close()
    sessions.clear()
    res.writeHead(200).end('dropped')
    return
  }
  if (req.method === 'POST' && req.url === '/__fail-next') {
    failNext = true
    res.writeHead(200).end('armed')
    return
  }
  if (failNext && req.url === '/mcp') {
    failNext = false
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('fixture exploded')
    return
  }

  const sid = req.headers['mcp-session-id']
  if (typeof sid === 'string' && sid !== '' && !sessions.has(sid)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 'server-error',
      error: { code: -32600, message: 'Session not found' },
    }))
    return
  }

  const transport = typeof sid === 'string' && sid !== '' ? sessions.get(sid) : new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID().replaceAll('-', ''),
    onsessioninitialized: (id) => { sessions.set(id, transport) },
  })
  if (typeof sid !== 'string' || sid === '') await server.connect(transport)
  await transport.handleRequest(req, res)
})

// 固定端口：测试要验「服务端重启后连接自愈」，重启必须落在同一个地址上。
const fixed = Number(process.env.FIXTURE_PORT ?? '0')
http.listen(fixed, '127.0.0.1', () => {
  const { port } = http.address()
  process.stdout.write(JSON.stringify({ port }) + '\n')
})
