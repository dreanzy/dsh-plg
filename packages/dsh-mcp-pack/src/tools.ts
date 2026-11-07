import { buildNativeDefinitions, type DefinitionFactory } from './carrier.js'
import { admits, filterTools, type ToolFilter } from './filter.js'
import { callOptionsFromExec, type ConnectionSpec, type McpConnection, type McpToolInfo } from './mcp-connection.js'
import type { Pool, PoolHandle } from './pool.js'
import { publicToolName } from './public-name.js'

/** 一台可加载的 server：连接参数 + 该行的工具规则。 */
export interface ToolTarget {
  readonly rowKey: string
  readonly serverName: string
  readonly spec: ConnectionSpec
  readonly filter: ToolFilter
  /** 该行的模式。`eager` 行不允许 mcp_load。 */
  readonly mode: 'eager' | 'dynamic' | 'lazy'
}

export interface OnDemandDeps {
  /** 宿主 `defineTool`，由 loader 注入。 */
  readonly defineTool: (options: unknown) => unknown
  readonly pool: Pool
  /**
   * 按名字找行，**按调用方 agent 的工作区求值**。
   *
   * 只查全局层会让「工作区里启用、全局里禁用」的行永远加载不了——
   * 那正是按工作区区分的意义所在。
   */
  readonly resolveTarget: (name: string, agent: unknown) => ToolTarget | null
  /** 取宿主适配器；失败时抛出可读错误。 */
  readonly resolveFactory: () => Promise<DefinitionFactory>
  readonly logger: { warn(message: string): void }
}

/** 一次加载的记录。`disposers` 为空即为 lazy：只持有连接与名字，不注册工具。 */
interface Loaded {
  readonly handle: PoolHandle
  readonly disposers: readonly (() => unknown)[]
  readonly toolNames: readonly string[]
}

/** 按 agent 对象身份记已加载的行：不同会话互不干扰。 */
const loaded = new WeakMap<object, Map<string, Loaded>>()

/**
 * 同一张表按 agent.id 再挂一份。
 *
 * 工具执行时拿到的 agent 与 `agent/created` 里的未必是同一个对象（宿主行为，见
 * docs/host-pitfalls.md），只按身份索引会让会话结束时的释放落空。
 */
const loadedById = new Map<string, Map<string, Loaded>>()

function loadedOf(agent: object): Map<string, Loaded> {
  let map = loaded.get(agent)
  if (map === undefined) {
    map = new Map()
    loaded.set(agent, map)
  }
  const id = (agent as { id?: unknown }).id
  if (typeof id === 'string' && id !== '') loadedById.set(id, map)
  return map
}

/** 执行期能拿到的最小 agent 面。 */
interface AgentLike {
  readonly id?: string
  readonly ctx?: { get(name: string): unknown }
}

function agentOf(exec: unknown): AgentLike | null {
  const record = exec as { agent?: AgentLike } | undefined
  return record?.agent === undefined ? null : record.agent
}

function toolsOf(agent: AgentLike): { register(definition: unknown): () => unknown } | null {
  const ctx = agent.ctx
  if (ctx === undefined) return null
  const tools = ctx.get('tools') as { register?: unknown } | undefined
  if (tools === undefined || typeof tools.register !== 'function') return null
  return tools as { register(definition: unknown): () => unknown }
}

function disposeAll(disposers: readonly (() => unknown)[]): void {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      // 注销失败不影响后续释放。
    }
  }
}

/** 文本结果块。宿主的 render 只认这个形状。 */
function textBlock(text: string): readonly { type: 'text'; text: string }[] {
  return [{ type: 'text', text }]
}

/** 从 MCP 结果里抠出可读文本：优先 text 块，否则整段 JSON。 */
export function resultText(value: unknown): string {
  const record = value as { content?: unknown } | undefined
  const content = record?.content
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        const item = block as { type?: unknown; text?: unknown }
        return item.type === 'text' && typeof item.text === 'string' ? item.text : null
      })
      .filter((item): item is string => item !== null)
    if (parts.length > 0) return parts.join('\n')
  }
  return JSON.stringify(value)
}

/** 词法收窄：不区分大小写地看工具名是否包含关键词。 */
function matchesQuery(tool: McpToolInfo, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)
}

/**
 * 造 `mcp_load` / `mcp_unload` / `mcp_call`。
 *
 * 两条纪律：
 * 1. **注册落在调用方 agent 的 scope**：`agent.ctx.get('tools')`。在 root ctx 上注册
 *    会变成全局注册，工具漏给所有会话。
 * 2. **整代或零代**：任一注册失败要把本次新增的全部撤销，再连连接一起释放。
 */
export function createOnDemandTools(deps: OnDemandDeps): { load: unknown; unload: unknown; call: unknown } {
  const load = deps.defineTool({
    name: 'mcp_load',
    description:
      "Load one MCP server's tools into this session. Call with a server name listed in your system prompt. " +
      'Dynamic servers register their tools natively; lazy servers return their tool schemas here and are called ' +
      'through mcp_call. Repeat calls widen the selection, never narrow it.',
    parameters: {
      server: { type: 'string', required: true, description: 'Server name, exactly as listed in the system prompt.' },
      query: { type: 'string', description: 'Only load tools whose name or description matches this keyword.' },
      tool: { type: 'string', description: 'Load exactly one tool by its name and return its argument schema.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string' },
          mode: { type: 'string' },
          loaded: { type: 'array', items: { type: 'string' } },
          hidden: { type: 'integer' },
          tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (args: Record<string, unknown>, value: Record<string, unknown>) => {
        const names = Array.isArray(value['loaded']) ? value['loaded'].join(', ') : ''
        const hidden = typeof value['hidden'] === 'number' ? value['hidden'] : 0
        const note = typeof value['note'] === 'string' ? value['note'] : ''
        const body = `${String(value['server'])} (${String(value['mode'])}) loaded${names === '' ? ' no tools' : ': ' + names}`
        const hiddenLine = hidden > 0 ? `\n${hidden} tool(s) hidden by the filter` : ''
        // 逐个工具一行：整段 JSON.stringify 会把几十个 schema 糊成一坨，
        // 模型与人都读不出来。
        const tools = Array.isArray(value['tools']) && value['tools'].length > 0
          ? '\n' + value['tools']
              .map((item) => {
                const tool = item as { name?: unknown; inputSchema?: unknown }
                return `- ${String(tool['name'])}: ${JSON.stringify(tool['inputSchema'])}`
              })
              .join('\n')
          : ''
        return textBlock(body + hiddenLine + tools + (note === '' ? '' : `\n${note}`))
      },
    },
    execute: async (args: Record<string, unknown>, exec: unknown) => {
      const agent = agentOf(exec)
      if (agent === null) throw new Error('mcp_load must run inside an agent session')
      const name = typeof args['server'] === 'string' ? args['server'].trim() : ''
      if (name === '') throw new Error('mcp_load requires a server name')
      const target = deps.resolveTarget(name, agent)
      if (target === null) {
        throw new Error(
          `unknown or disabled MCP server "${name}" — load one of the MCP servers listed in your system prompt`,
        )
      }
      if (target.mode === 'eager') {
        throw new Error(`MCP server "${target.serverName}" is declared eager: its tools are already available without loading`)
      }

      const handle = await deps.pool.acquire(target.rowKey, target.spec)
      const { visible, hidden } = filterTools(handle.tools, target.filter)
      const query = typeof args['query'] === 'string' ? args['query'] : ''
      const one = typeof args['tool'] === 'string' ? args['tool'].trim() : ''
      const selected = one !== ''
        ? visible.filter((tool) => tool.name === one)
        : query !== ''
          ? visible.filter((tool) => matchesQuery(tool, query))
          : visible

      if (target.mode === 'lazy') {
        // lazy 不注册任何工具：工具列表保持恒定，请求前缀永不失效。
        const perAgent = loadedOf(agent)
        const previous = perAgent.get(target.rowKey)
        const names = selected.map((tool) => tool.name)
        // 与 dynamic 同一语义：已加载的记下来，后续加载只增不减。
        const merged = [...new Set([...(previous?.toolNames ?? []), ...names])]
        perAgent.set(target.rowKey, { handle, disposers: [], toolNames: merged })
        if (previous !== undefined) {
          disposeAll(previous.disposers)
          deps.pool.release(previous.handle)
        }
        return {
          server: target.serverName,
          mode: 'lazy',
          loaded: selected.map((tool) => tool.name),
          hidden,
          tools: selected.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          note: one !== '' && selected.length === 0 ? `no tool named "${one}" on this server` : '',
        }
      }

      const tools = toolsOf(agent)
      if (tools === null) throw new Error('the calling agent has no tools service; cannot register MCP tools')
      const perAgent = loadedOf(agent)
      const previous = perAgent.get(target.rowKey)
      // 重复调用只增不减：描述承诺 widen，收窄会让模型第二次调用后丢掉刚加载的工具。
      const already = new Set(previous?.toolNames ?? [])
      const fresh = selected.filter((tool) => !already.has(publicToolName(target.serverName, tool.name)))
      const factory = await deps.resolveFactory()
      const { built } = buildNativeDefinitions({
        factory,
        ctx: agent.ctx,
        connection: handle.connection,
        serverName: target.serverName,
        tools: fresh,
        filter: { keep: [], drop: [] },
      })

      const added: (() => unknown)[] = []
      try {
        for (const item of built) {
          added.push(tools.register(item.definition))
        }
      } catch (error) {
        disposeAll(added)
        deps.pool.release(handle)
        throw new Error(`failed to register tools for "${target.serverName}": ${String(error)}`)
      }

      const loadedNames = built.map((item) => item.publicName)
      perAgent.set(target.rowKey, {
        handle,
        disposers: [...(previous?.disposers ?? []), ...added],
        toolNames: [...(previous?.toolNames ?? []), ...loadedNames],
      })
      if (previous !== undefined) deps.pool.release(previous.handle)

      return {
        server: target.serverName,
        mode: 'dynamic',
        loaded: loadedNames,
        hidden,
        note: selected.length === 0 && previous === undefined ? 'the tool filter admits nothing on this server' : '',
      }
    },
  })

  const unload = deps.defineTool({
    name: 'mcp_unload',
    description: "Release one MCP server's tools from this session. Safe to call when it is not loaded.",
    parameters: {
      server: { type: 'string', required: true, description: 'Server name, exactly as passed to mcp_load.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string' },
          released: { type: 'boolean' },
        },
      },
      render: (_args: Record<string, unknown>, value: Record<string, unknown>) =>
        textBlock(
          value['released'] === true
            ? `${String(value['server'])} released`
            : `${String(value['server'])} was not loaded`,
        ),
    },
    execute: async (args: Record<string, unknown>, exec: unknown) => {
      const agent = agentOf(exec)
      if (agent === null) throw new Error('mcp_unload must run inside an agent session')
      const name = typeof args['server'] === 'string' ? args['server'].trim() : ''
      const target = deps.resolveTarget(name, agent)
      const serverName = target?.serverName ?? name
      const perAgent = loadedOf(agent)
      const key = target?.rowKey ?? [...perAgent.keys()].find((candidate) => candidate.endsWith(':' + name))
      if (key === undefined) return { server: serverName, released: false }
      const entry = perAgent.get(key)
      if (entry === undefined) return { server: serverName, released: false }
      perAgent.delete(key)
      disposeAll(entry.disposers)
      deps.pool.release(entry.handle)
      return { server: serverName, released: true }
    },
  })

  const call = deps.defineTool({
    name: 'mcp_call',
    description:
      'Call one tool on a lazy MCP server. Only lazy servers use this path: dynamic servers register their tools ' +
      'natively, so call those by name instead.',
    parameters: {
      server: { type: 'string', required: true, description: 'Server name, exactly as listed in the system prompt.' },
      tool: { type: 'string', required: true, description: 'Tool name as returned by mcp_load.' },
      args: { type: 'object', additionalProperties: true, description: 'Arguments object for that tool.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: Record<string, unknown>, value: Record<string, unknown>) => textBlock(resultText(value)),
    },
    execute: async (args: Record<string, unknown>, exec: unknown) => {
      const agent = agentOf(exec)
      if (agent === null) throw new Error('mcp_call must run inside an agent session')
      const name = typeof args['server'] === 'string' ? args['server'].trim() : ''
      const tool = typeof args['tool'] === 'string' ? args['tool'].trim() : ''
      if (name === '' || tool === '') throw new Error('mcp_call requires both server and tool')
      const target = deps.resolveTarget(name, agent)
      if (target === null) {
        throw new Error(`unknown or disabled MCP server "${name}" — load it first with mcp_load`)
      }
      if (target.mode !== 'lazy') {
        throw new Error(`MCP server "${target.serverName}" is not lazy: call its tools by their registered names`)
      }
      const perAgent = loadedOf(agent)
      const entry = perAgent.get(target.rowKey)
      const rawArgs = args['args']
      const payload = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {}
      if (entry === undefined) {
        throw new Error(`MCP server "${target.serverName}" is not loaded — call mcp_load first`)
      }
      // lazy 下模式与过滤只决定「哪些工具可被调用」，不改变已注册的工具列表。
      const admitted = entry.handle.tools.some((candidate) => candidate.name === tool && admits(target.filter, candidate.name))
      if (!admitted) {
        throw new Error(`MCP server "${target.serverName}" has no callable tool named "${tool}"`)
      }
      const result = await entry.handle.connection.callTool(tool, payload, callOptionsFromExec(exec))
      const outcome = result as { isError?: unknown } | undefined
      if (outcome?.isError === true) throw new Error(resultText(result))
      return result
    },
  })

  return { load, unload, call }
}

/** 释放某个 agent 的全部加载（会话结束或插件卸载时调用）。 */
export function releaseAgent(agent: object, pool: Pool): void {
  const id = (agent as { id?: unknown }).id
  const perAgent = loaded.get(agent) ?? (typeof id === 'string' ? loadedById.get(id) : undefined)
  if (perAgent === undefined) return
  loaded.delete(agent)
  if (typeof id === 'string') loadedById.delete(id)
  for (const entry of perAgent.values()) {
    disposeAll(entry.disposers)
    pool.release(entry.handle)
  }
}