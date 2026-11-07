import { callOptionsFromExec, type McpConnection, type McpToolInfo } from './mcp-connection.js'
import { filterTools, type ToolFilter } from './filter.js'
import { publicToolName } from './public-name.js'

/** 造一条工具定义所需的原始字段。 */
export interface ToolDefinitionSpec {
  readonly name: string
  readonly rawName: string
  readonly description: string
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  readonly call: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

/**
 * 宿主适配器：`@deepseek-ai/dsh-mcp-client` 的 `createMcpToolDefinition`。
 *
 * 必须经 loader 取同一实例，不要自己拼定义——它负责上游 schema 校验、canonical
 * 结果校验、`isError` 处理与图片落盘，自己写的版本只会更弱。
 */
export type DefinitionFactory = (ctx: unknown, spec: ToolDefinitionSpec) => unknown

export interface BuiltTool {
  readonly publicName: string
  readonly definition: unknown
}

/**
 * 把一台服务器的工具目录变成可注册的定义。
 *
 * 只做「造定义」，不注册：注册要落在调用方 agent 的 scope 上，由调用点决定。
 * 被过滤掉的工具根本不造定义，所以它们对模型完全不存在——这是 native 载体
 * 与 proxy 载体的差别，后者必须在调用时再校验一次。
 */
export function buildNativeDefinitions(options: {
  readonly factory: DefinitionFactory
  readonly ctx: unknown
  readonly connection: McpConnection
  readonly serverName: string
  readonly tools: readonly McpToolInfo[]
  readonly filter: ToolFilter
}): { built: readonly BuiltTool[]; hidden: number } {
  const { visible, hidden } = filterTools(options.tools, options.filter)
  const built: BuiltTool[] = []
  for (const tool of visible) {
    const publicName = publicToolName(options.serverName, tool.name)
    const definition = options.factory(options.ctx, {
      name: publicName,
      rawName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      call: async (args, exec) => await options.connection.callTool(tool.name, args, callOptionsFromExec(exec)),
    })
    built.push({ publicName, definition })
  }
  return { built, hidden }
}
