import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { DirtySet } from './dirty.js'
import { changedFiles } from './git.js'
import { argumentPath, DEFAULT_EXTENSIONS, isSupportedPath, normalizePath, resolvePath, SHELL_TOOLS, withinRoot, WRITE_TOOLS } from './paths.js'
import { renderFeedback } from './render.js'
import type { DiagnosticLike, FileFeedback } from './render.js'

/** Cordis 插件名。 */
export const name = 'lsp-lens'
/** 工具与子进程：subprocess 跑 git 差分。jobs 用延迟绑定（见 apply），缺席时退回立即差分而不是整插件 pending。 */
export const inject = ['tools', 'subprocess']

export interface Config {
  enabled?: boolean
  maxFilesPerStep?: number
  maxCharsPerFile?: number
  diagnosticTimeoutMs?: number
  extensions?: string[]
}

interface DecisionLike { kind?: string; content?: unknown[]; messages?: unknown[] }
interface ExecutionLike { name?: string; arguments?: unknown; signal?: AbortSignal; agent?: unknown; workspace?: unknown }

/** 一次诊断在飞行表里的行程。结果写回这里，下一步 pre-step 结算。 */
interface Flight {
  readonly path: string
  readonly version: string
  readonly step: number
  readonly startedAt: number
  done: boolean
  result: FileFeedback | null
}

/** 一个会话的脏表与待结算项。键见 sessionKeyOf。 */
interface SessionState {
  readonly dirty: DirtySet
  readonly pendingShell: Set<string>
  readonly backgroundJobs: Map<string, string>
  readonly inFlight: Map<string, Flight>
}

/** 观测候选的存活时间：过了这么久还没被任何会话认领，就没必要留着。 */
const OBSERVED_TTL_MS = 10 * 60_000
/** 飞行结果的最长生命周期：超过 2 步或 30s 就放弃并落墓碑。 */
const FLIGHT_MAX_STEPS = 2
const FLIGHT_MAX_MS = 30_000

/** 临时调试：LSP_LENS_DEBUG 指向文件时逐点记录，验证宿主事件是否到达。 */
const DEBUG_LOG = process.env.LSP_LENS_DEBUG ?? ''
export const debug = (message: string): void => {
  if (DEBUG_LOG === '') return
  try { appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + message + '\n') } catch { /* 忽略 */ }
}

/** lsp_diagnostics 的返回归一化成渲染用的最小形状。 */
export function toDiagnostics(value: unknown): DiagnosticLike[] {
  if (value === null || typeof value !== 'object') return []
  const list = (value as { diagnostics?: unknown }).diagnostics
  if (!Array.isArray(list)) return []
  const out: DiagnosticLike[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.message !== 'string' || typeof record.severity !== 'number') continue
    const range = record.range as { start?: { line?: unknown } } | undefined
    const line = typeof range?.start?.line === 'number' ? range.start.line + 1 : undefined
    out.push({ severity: record.severity, message: record.message, line, source: typeof record.source === 'string' ? record.source : undefined })
  }
  return out
}

async function fileVersion(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return info.mtimeMs + ':' + info.size
  } catch { return null }
}

/**
 * shell 那次执行的工作目录：参数 workdir → 返回里的 cwd → 会话目录 → 执行上下文的工作区。
 * 会话目录取 `agent.session.header.cwd`，与 lsp-actions 的 sessionCwd 一致。
 */
export function shellCwd(exec: ExecutionLike | undefined, value: unknown): string | null {
  const args = exec?.arguments as Record<string, unknown> | undefined
  if (typeof args?.workdir === 'string' && args.workdir !== '') return args.workdir
  const returned = (value as { cwd?: unknown } | undefined)?.cwd
  if (typeof returned === 'string' && returned !== '') return returned
  const session = (exec?.agent as { session?: { header?: { cwd?: unknown }; cwd?: unknown } } | undefined)?.session
  const sessionCwd = session?.header?.cwd ?? session?.cwd
  if (typeof sessionCwd === 'string' && sessionCwd !== '') return sessionCwd
  const workspace = exec?.workspace as Record<string, unknown> | undefined
  const root = workspace?.root ?? workspace?.path
  return typeof root === 'string' && root !== '' ? root : null
}

/** 会话目录：与 lsp-actions 的 sessionCwd 一致，取 header.cwd。 */
export function sessionCwdOf(agent: unknown): string | null {
  const session = (agent as { session?: { header?: { cwd?: unknown }; cwd?: unknown } } | undefined)?.session
  const cwd = session?.header?.cwd ?? session?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * 会话键：优先会话 id，缺失时退回会话目录。拿不到就返回 null——
 * 宁可不登记，也不把一条脏数据塞进别人的表。
 */
export function sessionKeyOf(agent: unknown): string | null {
  const session = (agent as { session?: { header?: { id?: unknown }; id?: unknown } } | undefined)?.session
  const id = session?.header?.id ?? session?.id
  if (typeof id === 'string' && id !== '') return id
  return sessionCwdOf(agent)
}

/** 扩展名分组：同组视为同一台语言服务器，同时只飞一个。 */
export function groupOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot).toLowerCase()
}

/**
 * 注册诊断回灌。
 * @param ctx - 插件上下文（必须 inject tools；subprocess 用于 git 差分）。
 * @param config - 生效配置。
 */
export function apply(ctx: any, config: Config = {}): void {
  const enabled = config.enabled !== false
  const extensions = new Set((config.extensions ?? DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase()))
  const maxFiles = config.maxFilesPerStep ?? 3
  const maxCharsPerFile = config.maxCharsPerFile ?? 800
  const diagnosticTimeoutMs = config.diagnosticTimeoutMs ?? 5000
  // jobs 走延迟绑定：headless 模板里它会后到，直接写进 inject 会让整个插件 pending。
  let jobsRegistry: any = null
  try {
    ctx.inject?.(['jobs'], (jobsCtx: any) => { jobsRegistry = jobsCtx.get('jobs') ?? null })
  } catch { jobsRegistry = null }

  /** 会话作用域的脏表。一个 profile 里多个会话共用一个插件实例，不能共用一张表。 */
  const sessions = new Map<string, SessionState>()
  /** `fs/observed` 不带会话，先落进程级候选池，pre-step 用当前会话根分流。 */
  const observed = new Map<string, { version: string; at: number }>()
  let warnedMissingMessage = false

  debug('apply')
  const warn = (message: string): void => { try { ctx.logger?.warn?.('lsp-lens: ' + message) } catch { /* 日志失败不影响主流程 */ } }

  const stateOf = (key: string): SessionState => {
    let state = sessions.get(key)
    if (state === undefined) {
      state = { dirty: new DirtySet(), pendingShell: new Set(), backgroundJobs: new Map(), inFlight: new Map() }
      sessions.set(key, state)
    }
    return state
  }

  /**
   * 发起一次诊断，不等待。控制器自持：pre-step 返回后宿主的 signal 可能被中止，
   * 绑它就等于每步都在半路取消。超时由这里自己的定时器放弃。
   */
  const launch = (flight: Flight, agent: unknown): void => {
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 已中止 */ } }, diagnosticTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const settle = (result: FileFeedback): void => { flight.result = result; flight.done = true; clearTimeout(timer) }
    const tool = ctx.tools.get('lsp_diagnostics')
    if (!tool || typeof tool.execute !== 'function') {
      settle({ path: flight.path, diagnostics: [], unconfirmed: true, reason: 'failed' })
      return
    }
    void Promise.resolve(tool.execute({ file_path: flight.path }, { agent, signal: controller.signal }))
      .then((outcome: unknown) => { settle({ path: flight.path, diagnostics: toDiagnostics(outcome) }) })
      .catch(() => { settle({ path: flight.path, diagnostics: [], unconfirmed: true, reason: controller.signal.aborted ? 'timeout' : 'failed' }) })
  }

  const offPost = ctx.on('tools/post-execute', async (exec: ExecutionLike, result: any, next: () => Promise<DecisionLike>): Promise<DecisionLike> => {
    const decision = await next()
    try {
      if (!enabled || decision?.kind !== 'accept' || result?.isError === true) return decision
      const key = sessionKeyOf(exec?.agent)
      if (key === null) return decision
      const toolName = String(exec?.name ?? '')
      debug('post ' + toolName + ' key=' + key)
      const state = stateOf(key)

      if (SHELL_TOOLS.has(toolName)) {
        const value = result?.value as { kind?: unknown; jobId?: unknown } | undefined
        // 拿不到 cwd 时登记哨兵 ''，由 pre-step 用 payload.agent 的会话目录解析。
        const cwd = shellCwd(exec, value) ?? ''
        if (value?.kind === 'background' && typeof value.jobId === 'string') state.backgroundJobs.set(value.jobId, cwd)
        else if (value?.kind !== 'promoted') state.pendingShell.add(cwd)
        return decision
      }

      if (!WRITE_TOOLS.has(toolName)) return decision
      const rawPath = argumentPath(exec.arguments)
      if (rawPath === null || !isSupportedPath(rawPath, extensions)) return decision
      // 只登记，不等诊断：tsls 每次诊断约 2s，同步等会让每次写文件多付这个延迟。
      // 路径必须绝对化：file_path 常是相对会话目录的，相对路径既判不了可达性，也当不了版本键。
      const path = resolvePath(sessionCwdOf(exec.agent), rawPath)
      const version = (await fileVersion(path)) ?? 'unknown'
      state.dirty.mark(path, version)
      debug('mark ' + path + ' v=' + version + ' size=' + String(state.dirty.size))
      return decision
    } catch (error) {
      warn('回灌失败，保留原结果：' + String(error))
      return decision
    }
  })

  // 文件观测只进候选池；归属与判定都在 pre-step 里，因为这里拿不到会话。
  let offObserved: (() => void) | null = null
  try {
    offObserved = ctx.on('fs/observed', (target: any, observation: any) => {
      if (!enabled || observation?.kind !== 'present') return
      const raw = String(target?.displayPath ?? target?.targetKey ?? '')
      if (raw === '' || !isSupportedPath(raw, extensions)) return
      observed.set(normalizePath(raw), { version: String(observation.version ?? 'observed'), at: Date.now() })
    })
  } catch { offObserved = null }

  const offPre = ctx.on('agent/pre-step', async (payload: any, next: () => Promise<DecisionLike>): Promise<DecisionLike> => {
    const decision = await next()
    try {
      if (!enabled) return decision
      const key = sessionKeyOf(payload?.agent)
      if (key === null) return decision
      const state = stateOf(key)
      const step = typeof payload?.step === 'number' ? payload.step : 0
      const root = sessionCwdOf(payload?.agent)
      debug('pre-step key=' + key + ' step=' + String(step) + ' dirty=' + String(state.dirty.size) + ' flying=' + String(state.inFlight.size))

      // 1. 结算飞行：落定的取走并落墓碑；过期的直接放弃（同样落墓碑，避免无限重试）。
      const feedback: FileFeedback[] = []
      for (const [flightKey, flight] of [...state.inFlight]) {
        if (!flight.done) {
          const stale = step - flight.step > FLIGHT_MAX_STEPS || Date.now() - flight.startedAt > FLIGHT_MAX_MS
          if (!stale) continue
          state.inFlight.delete(flightKey)
          debug('drop stale ' + flight.path)
          continue
        }
        state.inFlight.delete(flightKey)
        if (flight.result !== null) feedback.push(flight.result)
      }

      // 2. 后台作业：结算后再差分。jobs 服务是可选的，取不到就退回「立即差分」。
      if (state.backgroundJobs.size > 0) {
        const jobs: any = jobsRegistry
        for (const [jobId, cwd] of [...state.backgroundJobs]) {
          if (!jobs || typeof jobs.read !== 'function') { state.pendingShell.add(cwd); state.backgroundJobs.delete(jobId); continue }
          try {
            const view = jobs.read(jobId)
            if (String(view?.status ?? '') !== 'running') { state.pendingShell.add(cwd); state.backgroundJobs.delete(jobId) }
          } catch { state.pendingShell.add(cwd); state.backgroundJobs.delete(jobId) }
        }
      }

      // 3. git 差分：一次拿到 shell 写下的全部受支持文件。
      for (const cwdKey of [...state.pendingShell]) {
        state.pendingShell.delete(cwdKey)
        const cwd = cwdKey === '' ? root : cwdKey
        if (cwd === null) continue
        const files = await changedFiles(ctx, cwd, payload?.signal)
        if (files === null) continue
        for (const file of files) {
          if (!isSupportedPath(file, extensions)) continue
          const version = (await fileVersion(file)) ?? 'unknown'
          state.dirty.mark(normalizePath(file), version)
        }
      }

      // 4. 观测分流：只把当前会话根内的并进脏表；根外和过期的丢掉，不放回。
      const now = Date.now()
      for (const [path, record] of [...observed]) {
        if (now - record.at > OBSERVED_TTL_MS) { observed.delete(path); continue }
        const absolute = resolvePath(root, path)
        if (root === null || !withinRoot(absolute, root)) { observed.delete(path); continue }
        observed.delete(path)
        state.dirty.mark(absolute, record.version)
      }

      // 5. 发起新飞行：同扩展名同时只飞一个，别把一台服务器压成队列。
      const busy = new Set<string>()
      for (const flight of state.inFlight.values()) busy.add(groupOf(flight.path))
      const slots = maxFiles - state.inFlight.size
      if (slots > 0) {
        for (const entry of state.dirty.take(slots)) {
          const group = groupOf(entry.path)
          if (busy.has(group)) { state.dirty.putBack(entry); continue }
          busy.add(group)
          const flight: Flight = { path: entry.path, version: entry.version, step, startedAt: Date.now(), done: false, result: null }
          state.inFlight.set(group + '\u0000' + entry.path + '\u0000' + entry.version, flight)
          launch(flight, payload?.agent)
          debug('launch ' + entry.path)
        }
      }

      // 6. 只回灌已落定的结果；飞行中静默——「进行中」不可执行，每步重复正是要修的病。
      if (feedback.length === 0) return decision
      const text = renderFeedback(feedback, { maxFiles, maxCharsPerFile })
      debug('render len=' + String(text.length))
      if (text === '') return decision

      const message = await buildMessage(payload, text)
      debug('message ' + (message === null ? 'null' : 'ok'))
      if (message === null) {
        if (!warnedMissingMessage) { warnedMissingMessage = true; warn('宿主未提供 createUserMessage，pre-step 汇总跳过') }
        return decision
      }
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      return { ...decision, messages: [...messages, message] }
    } catch (error) {
      warn('pre-step 汇总失败：' + String(error))
      return decision
    }
  })

  ctx.effect(() => () => {
    for (const state of sessions.values()) {
      state.dirty.clear()
      state.pendingShell.clear()
      state.backgroundJobs.clear()
      state.inFlight.clear()
    }
    sessions.clear()
    observed.clear()
    try { offPost() } catch { /* 退订失败不影响释放 */ }
    try { offObserved?.() } catch { /* 同上 */ }
    try { offPre() } catch { /* 同上 */ }
  }, 'lsp-lens:listeners')
}

/** 宿主提供的消息工厂；变量说明符让它不必在编译期解析到具体包。 */
async function buildMessage(payload: any, text: string): Promise<unknown | null> {
  try {
    const specifier = '@deepseek-ai/' + 'dsh-llm'
    const mod: any = await import(specifier)
    const create = mod?.createUserMessage
    if (typeof create !== 'function') return null
    return create({
      source: { kind: 'dsh-lsp-lens:feedback', turn: payload?.turn, step: payload?.step },
      content: [{ type: 'text', text }],
    })
  } catch (error) {
    // 宿主工厂拿不到（link 安装时裸包名解析不到）时手造同形状消息。
    debug('factory unavailable: ' + String(error))
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-lsp-lens:feedback', turn: payload?.turn, step: payload?.step },
    }
  }
}
