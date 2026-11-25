/** 诊断的最小形状，与 lsp_diagnostics 的返回对齐。 */
export interface DiagnosticLike {
  readonly severity: number
  readonly message: string
  readonly line?: number
  readonly source?: string
}

/** 没拿到可信结果的原因：超时，或调用失败（containment、服务器未就绪、工具抛错）。 */
export type UnconfirmedReason = 'timeout' | 'failed'

/** 一个文件的诊断结果。unconfirmed 表示没拿到可信结果，不等于干净。 */
export interface FileFeedback {
  readonly path: string
  readonly diagnostics: readonly DiagnosticLike[]
  readonly unconfirmed?: boolean
  readonly reason?: UnconfirmedReason
}

export interface RenderOptions {
  readonly maxFiles?: number
  readonly maxCharsPerFile?: number
}

const SEVERITY_LABEL: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

/** severity 1/2 是待处理与告知的分界；未确认单独成行。 */
export function isPending(diagnostic: DiagnosticLike): boolean {
  return diagnostic.severity === 1
}

/** 单条诊断成行：L4: message (source)。 */
export function formatDiagnostic(diagnostic: DiagnosticLike): string {
  const where = diagnostic.line !== undefined ? 'L' + diagnostic.line + ': ' : ''
  const label = SEVERITY_LABEL[diagnostic.severity] ?? 'issue'
  const source = diagnostic.source ? ' (' + diagnostic.source + ')' : ''
  return '  ' + where + '[' + label + '] ' + diagnostic.message + source
}

/**
 * 未确认的两档措辞：超时是「可能有问题，别当干净」，调用失败是
 * 「这套诊断在这里不可用，重试没用」。合并成一句模型只能猜。
 */
export function unconfirmedLine(file: FileFeedback): string {
  const why = file.reason === 'timeout'
    ? 'timed out — treat as unknown, not clean'
    : 'unavailable — not checked, do not retry'
  return '⚠️ ' + file.path + ': diagnostics ' + why
}

/**
 * 渲染回灌文本。预算：每文件最多 maxCharsPerFile 字符、最多 maxFiles 个文件，
 * 超出部分只给汇总，不静默丢弃。
 */
export function renderFeedback(files: readonly FileFeedback[], options: RenderOptions = {}): string {
  const maxFiles = options.maxFiles ?? 3
  const maxCharsPerFile = options.maxCharsPerFile ?? 800
  const shown = files.slice(0, maxFiles)
  const hidden = files.length - shown.length

  if (shown.length === 0) return ''

  const lines: string[] = [
    '[Diagnostic feedback from dsh-lsp-lens — not a user request]',
  ]

  let pending = 0
  let notices = 0

  for (const file of shown) {
    if (file.unconfirmed) {
      lines.push(unconfirmedLine(file))
      continue
    }
    if (file.diagnostics.length === 0) continue
    const ordered = [...file.diagnostics].sort((a, b) => a.severity - b.severity || (a.line ?? 0) - (b.line ?? 0))
    const body: string[] = []
    let chars = 0
    for (const diagnostic of ordered) {
      if (diagnostic.severity === 1) pending += 1
      else notices += 1
      const line = formatDiagnostic(diagnostic)
      if (chars + line.length > maxCharsPerFile) {
        body.push('  … ' + (ordered.length - body.length) + ' more')
        break
      }
      body.push(line)
      chars += line.length
    }
    const head = pending > 0 ? '🔴 Pending' : 'ℹ️ Notice'
    lines.push(head + ' — ' + file.path)
    lines.push(...body)
  }

  if (hidden > 0) {
    lines.push('… ' + hidden + ' more file(s) with diagnostics were not shown; call lsp_diagnostics for detail.')
  }

  if (pending > 0) {
    lines.push('Address pending errors before reporting the task as done. Notices are informational only.')
  }

  return lines.length > 1 ? lines.join('\n') : ''
}
