import { stat } from 'node:fs/promises'
import { DirtySet } from './dirty.js'
import { changedFiles } from './git.js'
import { argumentPath, DEFAULT_EXTENSIONS, isSupportedPath, normalizePath, SHELL_TOOLS, WRITE_TOOLS } from './paths.js'
import { renderFeedback } from './render.js'
import type { DiagnosticLike, FileFeedback } from './render.js'

/** Cordis 插件名。 */
export const name = 'lsp-lens'
/** 工具、子进程与作业服务：subprocess 跑 git 差分，jobs 用来结算后台 shell。诊断工具本身仍按次探测。 */
export const inject = ['tools', 'subprocess', 'jobs']

export interface Config {
  enabled?: boolean
  maxFilesPerStep?: number
  maxCharsPerFile?: number
  diagnosticTimeoutMs?: number
  extensions?: string[]
}

interface DecisionLike { kind?: string; content?: unknown[]; messages?: unknown[] }
interface ExecutionLike { name?: string; arguments?: unknown; signal?: AbortSignal; agent?: unknown; workspace?: unknown }

const TIMEOUT = Symbol('lsp-lens:timeout')

function timeoutAfter(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(TIMEOUT), ms); if (typeof timer.unref === 'function') timer.unref() })
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
  const dirty = new DirtySet()
  const pendingShell = new Set<string>()
  const backgroundJobs = new Map<string, string>()
  let warnedMissingMessage = false

  const warn = (message: string): void => { try { ctx.logger?.warn?.('lsp-lens: ' + message) } catch { /* 日志失败不影响主流程 */ } }

  const diagnose = async (path: string, exec: ExecutionLike | undefined): Promise<FileFeedback | null> => {
    const tool = ctx.tools.get('lsp_diagnostics')
    if (!tool || typeof tool.execute !== 'function') return null
    const attempt = async (): Promise<FileFeedback> => {
      const outcome = await Promise.race([
        tool.execute({ file_path: path }, exec as never),
        timeoutAfter(diagnosticTimeoutMs),
      ])
      if (outcome === TIMEOUT) return { path, diagnostics: [], unconfirmed: true, timedOut: true }
      return { path, diagnostics: toDiagnostics(outcome) }
    }
    try { return await attempt() } catch { return { path, diagnostics: [], unconfirmed: true } }
  }

  const offPost = ctx.on('tools/post-execute', async (exec: ExecutionLike, result: any, next: () => Promise<DecisionLike>): Promise<DecisionLike> => {
    const decision = await next()
    try {
      if (!enabled || decision?.kind !== 'accept' || result?.isError === true) return decision
      const toolName = String(exec?.name ?? '')

      if (SHELL_TOOLS.has(toolName)) {
        const value = result?.value as { kind?: unknown; jobId?: unknown } | undefined
        // 拿不到 cwd 时登记哨兵 ''，由 pre-step 用 payload.agent 的会话目录解析。
        const cwd = shellCwd(exec, value) ?? ''
        if (value?.kind === 'background' && typeof value.jobId === 'string') backgroundJobs.set(value.jobId, cwd)
        else if (value?.kind !== 'promoted') pendingShell.add(cwd)
        return decision
      }

      if (!WRITE_TOOLS.has(toolName)) return decision
      const rawPath = argumentPath(exec.arguments)
      if (rawPath === null || !isSupportedPath(rawPath, extensions)) return decision
      // 只登记，不等诊断：tsls 每次诊断约 2s，同步等会让每次写文件多付这个延迟。
      const path = normalizePath(rawPath)
      const version = (await fileVersion(path)) ?? 'unknown'
      dirty.mark(path, version)
      return decision
    } catch (error) {
      warn('回灌失败，保留原结果：' + String(error))
      return decision
    }
  })

  // 文件观测只登记脏文件；真正回灌在 pre-step 汇总，避免每写一次都打断工具返回。
  let offObserved: (() => void) | null = null
  try {
    offObserved = ctx.on('fs/observed', (target: any, observation: any) => {
      if (!enabled || observation?.kind !== 'present') return
      const raw = String(target?.displayPath ?? target?.targetKey ?? '')
      if (raw === '' || !isSupportedPath(raw, extensions)) return
      dirty.mark(normalizePath(raw), String(observation.version ?? 'observed'))
    })
  } catch { offObserved = null }

  const offPre = ctx.on('agent/pre-step', async (payload: any, next: () => Promise<DecisionLike>): Promise<DecisionLike> => {
    const decision = await next()
    try {
      if (!enabled) return decision

      // 1. 后台作业：结算后再差分。jobs 服务是可选的，取不到就退回"立即差分"。
      if (backgroundJobs.size > 0) {
        const jobs: any = ctx.jobs ?? null
        for (const [jobId, cwd] of [...backgroundJobs]) {
          if (!jobs || typeof jobs.read !== 'function') { pendingShell.add(cwd); backgroundJobs.delete(jobId); continue }
          try {
            const view = jobs.read(jobId)
            if (String(view?.status ?? '') !== 'running') { pendingShell.add(cwd); backgroundJobs.delete(jobId) }
          } catch { pendingShell.add(cwd); backgroundJobs.delete(jobId) }
        }
      }

      // 2. git 差分：一次拿到 shell 写下的全部受支持文件。
      const sessionCwd = sessionCwdOf(payload?.agent)
      for (const key of [...pendingShell]) {
        pendingShell.delete(key)
        const cwd = key === '' ? sessionCwd : key
        if (cwd === null) continue
        const files = await changedFiles(ctx, cwd, payload?.signal)
        if (files === null) continue
        for (const file of files) {
          if (!isSupportedPath(file, extensions)) continue
          const version = (await fileVersion(file)) ?? 'unknown'
          dirty.mark(normalizePath(file), version)
        }
      }

      // 3. 汇总回灌。诊断在这里发生：写入与 shell 都只登记，回到下一步再取结果。
      const entries = dirty.take(maxFiles)
      if (entries.length === 0) return decision
      const feedback: FileFeedback[] = []
      for (const entry of entries) {
        const result = await diagnose(entry.path, { agent: payload?.agent, signal: payload?.signal })
        if (result !== null) feedback.push(result)
      }
      const text = renderFeedback(feedback, { maxFiles, maxCharsPerFile })
      if (text === '') return decision

      const message = await buildMessage(payload, text)
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
    dirty.clear()
    pendingShell.clear()
    backgroundJobs.clear()
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
  } catch { return null }
}
