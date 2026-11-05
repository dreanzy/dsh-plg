import type { DefinitionFactory } from './carrier.js'

/** 宿主模块名。 */
export const TOOLS_MODULE = '@deepseek-ai/dsh-tools'
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** loader.internal.import 的最小面。 */
interface LoaderInternal {
  import?(name: string, baseUrl?: string, options?: unknown): Promise<unknown>
}

function internalOf(loader: unknown): LoaderInternal | null {
  const face = loader as { internal?: unknown } | undefined
  const internal = face?.internal
  if (typeof internal !== 'object' || internal === null) return null
  const importModule = (internal as LoaderInternal).import
  if (typeof importModule !== 'function') return null
  return internal as LoaderInternal
}

/**
 * 调 `internal.import` 取模块。
 *
 * **必须保住接收者**：它内部要读 `this.getOrCreateModuleJob`。解构出来单独调用
 * 会把 `this` 变成 undefined，报 `Cannot read properties of undefined`——
 * 这一类错误在单元测试里用简单 stub 永远测不到，所以这里统一走 `.call`。
 */
async function importModule(loader: unknown, name: string, baseUrl?: string): Promise<unknown> {
  const internal = internalOf(loader)
  if (internal === null) throw new Error('宿主 loader 没有 internal.import，无法取得工具适配器')
  return await (internal.import as NonNullable<LoaderInternal['import']>).call(internal, name, baseUrl, {})
}

/**
 * 取宿主导出的 `defineTool` 与 `createMcpToolDefinition`。
 *
 * `baseUrl` 必须用**插件自己的** ctx.baseUrl（不是 loader 的）：`internal.import`
 * 按它解析模块图，传错会拿不到实例或直接抛错。
 *
 * 取不到时一律抛错，不静默降级：`dynamic` 模式下没有它就无法注册工具，而模型看到
 * 「加载成功但没工具」比看到明确错误更糟。
 */
export async function loadAdapters(loader: unknown, baseUrl?: string): Promise<{
  defineTool: (options: unknown) => unknown
  createMcpToolDefinition: DefinitionFactory
}> {
  const toolsModule = (await importModule(loader, TOOLS_MODULE, baseUrl)) as { defineTool?: unknown } | undefined
  const defineTool = toolsModule?.defineTool
  if (typeof defineTool !== 'function') {
    throw new Error(`${TOOLS_MODULE} 未导出 defineTool`)
  }

  const mcpModule = (await importModule(loader, MCP_CLIENT_MODULE, baseUrl)) as { createMcpToolDefinition?: unknown } | undefined
  const createMcpToolDefinition = mcpModule?.createMcpToolDefinition
  if (typeof createMcpToolDefinition !== 'function') {
    throw new Error(`${MCP_CLIENT_MODULE} 未导出 createMcpToolDefinition；dynamic 模式无法注册工具，可改用 lazy 模式`)
  }

  return {
    defineTool: defineTool as (options: unknown) => unknown,
    createMcpToolDefinition: createMcpToolDefinition as DefinitionFactory,
  }
}

/**
 * 取整个 `dsh-mcp-client` 模块，用于 `ctx.plugin` 运行时挂载。
 *
 * 与 `loadAdapters` 共用同一个 `internal.import`（保住接收者），所以挂上去的实例与
 * 组合挂载的是同一份模块、同一套工具定义适配器。
 */
export async function loadMcpClientModule(loader: unknown, baseUrl?: string): Promise<unknown> {
  return await importModule(loader, MCP_CLIENT_MODULE, baseUrl)
}

/** 诊断用：只探测，不抛错。 */
export interface AdapterProbe {
  readonly ok: boolean
  readonly defineTool: boolean
  readonly createMcpToolDefinition: boolean
  readonly error: string | null
}

export async function probeAdapters(loader: unknown, baseUrl?: string): Promise<AdapterProbe> {
  if (internalOf(loader) === null) {
    return { ok: false, defineTool: false, createMcpToolDefinition: false, error: 'loader 没有 internal.import' }
  }
  try {
    const toolsModule = (await importModule(loader, TOOLS_MODULE, baseUrl)) as { defineTool?: unknown } | undefined
    const mcpModule = (await importModule(loader, MCP_CLIENT_MODULE, baseUrl)) as { createMcpToolDefinition?: unknown } | undefined
    const hasDefine = typeof toolsModule?.defineTool === 'function'
    const hasCreate = typeof mcpModule?.createMcpToolDefinition === 'function'
    return {
      ok: hasDefine && hasCreate,
      defineTool: hasDefine,
      createMcpToolDefinition: hasCreate,
      error: hasDefine ? (hasCreate ? null : 'mcp-client 未导出 createMcpToolDefinition') : 'dsh-tools 未导出 defineTool',
    }
  } catch (error) {
    return { ok: false, defineTool: false, createMcpToolDefinition: false, error: String(error) }
  }
}