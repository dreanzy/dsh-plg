import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/** 极简 MCP server：一个 echo 工具，用来固定客户端的调用契约。 */
const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' })

server.tool('echo', 'echo the given text', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}))

server.tool('boom', 'always fails', { reason: z.string().optional() }, async () => ({
  content: [{ type: 'text', text: 'tool failed on purpose' }],
  isError: true,
}))

await server.connect(new StdioServerTransport())