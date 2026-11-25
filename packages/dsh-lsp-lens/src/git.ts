/** 解析 `git status --porcelain=v1 -z` 的输出，返回变更路径（相对仓库根的原始字符串）。 */
export function parsePorcelainZ(output: string): string[] {
  const parts = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (entry === undefined || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    // 重命名/复制条目后面紧跟一个原路径 token，跳过它。
    if (status.includes('R') || status.includes('C')) index += 1
    if (path !== '') paths.push(path)
  }
  return paths
}

/** 从子进程句柄里取出 stdout 文本；readFrom 是官方 subprocess seam 的形状。 */
export function readCollected(handle: unknown): string {
  const reader = (handle as { collected?: { stdout?: { readFrom?: (offset: number) => { text?: unknown } } } } | null)?.collected?.stdout
  if (typeof reader?.readFrom !== 'function') return ''
  try {
    const read = reader.readFrom(0)
    return typeof read?.text === 'string' ? read.text : ''
  } catch { return '' }
}

interface GitRun { readonly ok: boolean; readonly text: string }

/** 跑一条 git 命令。非零退出按失败处理，调用方据此中止差分。 */
async function runGit(subprocess: any, argv: string[], cwd: string, signal?: AbortSignal): Promise<GitRun> {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: { data: '' }, stdout: { maxBytes: 4_000_000 }, stderr: { maxBytes: 64_000 } },
    graceMs: 1000,
    ...(signal === undefined ? {} : { signal }),
  })
  const outcome = await handle?.done
  const exitCode = outcome?.exitCode
  if (typeof exitCode === 'number' && exitCode !== 0) return { ok: false, text: '' }
  return { ok: true, text: readCollected(handle) }
}

/**
 * 跑一次 git 差分，返回仓库内变更的绝对路径。
 * 不是 git 仓库、没有 subprocess 服务、或命令失败时返回 null（调用方按"无差分"处理）。
 *
 * git status 输出的路径是相对**仓库根**的，不是相对 `-C` 的那个目录。shell 的
 * workdir 常是子目录，直接拼 cwd 会得到 `<子目录>/<仓库根相对路径>` 这种不存在的
 * 路径，诊断必然失败。所以先问一次 `rev-parse --show-toplevel`。
 */
export async function changedFiles(
  topCtx: any,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const subprocess = typeof topCtx?.subprocess?.spawn === 'function' ? topCtx.subprocess : null
  if (!subprocess || typeof subprocess.spawn !== 'function') return null
  try {
    // spawn 要求 argv[0] 是解析过的可执行文件路径，不能直接给裸命令名。
    const command = typeof subprocess.resolveExecutable === 'function'
      ? await subprocess.resolveExecutable('git', undefined, signal)
      : 'git'
    const top = await runGit(subprocess, [command, '-C', cwd, 'rev-parse', '--show-toplevel'], cwd, signal)
    if (!top.ok) return null
    const text = top.text.trim()
    const root = text !== '' ? text : cwd
    const status = await runGit(subprocess, [command, '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, signal)
    if (!status.ok) return null
    return parsePorcelainZ(status.text).map((path) => joinPath(root, path))
  } catch (error) {
    try { topCtx?.logger?.warn?.('lsp-lens: git 差分失败：' + String(error)) } catch { /* 日志失败不影响主流程 */ }
    return null
  }
}

/** 拼接工作目录与相对路径，统一成 `/` 分隔。 */
export function joinPath(cwd: string, relative: string): string {
  const base = cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return base + '/' + relative.replace(/\\/g, '/').replace(/^\.\//, '')
}
