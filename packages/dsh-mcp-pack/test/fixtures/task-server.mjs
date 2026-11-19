import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * 低层 Server：直接给 tools/list 响应，绕开 McpServer.registerTool 对
 * taskSupport: 'required' 的拒绝（它要求配 registerToolTask）。
 *
 * 目的只有一个：让客户端真的收到一个声明 task-required 的工具，
 * 验证本地把 execution.taskSupport 透传给了宿主工厂。
 */
const server = new Server({ name: 'task-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'tasky',
      description: 'requires task-based execution',
      inputSchema: { type: 'object', properties: {} },
      execution: { taskSupport: 'required' },
    },
    {
      name: 'plain',
      description: 'ordinary tool',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: 'called ' + request.params.name }],
}))

await server.connect(new StdioServerTransport())
