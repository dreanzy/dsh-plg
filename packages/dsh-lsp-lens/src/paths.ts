/** 写入类工具名：原生与 dsh-ops 的 PTC 版本都要覆盖。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'ops_write_file',
  'ops_edit_file',
  'ops_replace',
])

/** shell 类工具：执行后触发 git 差分（含后台作业）。 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'pwsh_persistent',
  'shell',
  'ops_bash',
])

/** 默认受支持扩展名；与 profile 里配置的 LSP 服务器语言一致。 */
export const DEFAULT_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.lua',
  '.ps1', '.psm1', '.psd1',
  '.bat', '.cmd',
]

/** 从工具参数里取目标路径。原生 write/edit 与 dsh-ops 都用 file_path。 */
export function argumentPath(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const value = record.file_path ?? record.path
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 扩展名是否受支持。路径大小写不敏感。 */
export function isSupportedPath(path: string, extensions: ReadonlySet<string> | readonly string[]): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return false
  const ext = path.slice(dot).toLowerCase()
  return Array.isArray(extensions) ? extensions.includes(ext) : (extensions as ReadonlySet<string>).has(ext)
}

/** 去掉首尾引号与统一的 `./` 前缀，得到稳定的版本键。 */
export function normalizePath(path: string): string {
  const stripped = path.trim().replace(/^["']|["']$/g, '')
  return stripped.replace(/\\/g, '/')
}

/** 把相对路径挂到会话根上。写入类工具的 file_path 常是相对会话目录的。 */
export function resolvePath(root: string | null, path: string): string {
  const raw = normalizePath(path).replace(/^\.\//, '')
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith('/')) return raw
  if (root === null) return raw
  return normalizePath(root).replace(/\/+$/, '') + '/' + raw
}

/**
 * 路径是否在会话根之内。基准必须与 `dsh-lsp-actions` 的 `sessionCwd` 同源
 * （`agent.session.header.cwd`），否则过滤放行、执行被拒。
 *
 * shortcut: Windows 大小写不敏感，这里统一小写比较；POSIX 上两个仅大小写
 * 不同的目录会被误判为同一根，升级条件是出现这种布局。
 */
export function withinRoot(path: string, root: string): boolean {
  const base = normalizePath(root).replace(/\/+$/, '')
  if (base === '') return true
  const candidate = normalizePath(path).toLowerCase()
  const prefix = base.toLowerCase()
  return candidate === prefix || candidate.startsWith(prefix + '/')
}
