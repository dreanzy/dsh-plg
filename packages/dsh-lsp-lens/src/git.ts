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

/**
 * 跑一次 git 差分，返回仓库内变更的绝对路径。
 * 不是 git 仓库、没有 subprocess 服务、或命令失败时返回 null（调用方按"无差分"处理）。
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
    const argv = [command, '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all']
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: { data: '' }, stdout: { maxBytes: 4_000_000 }, stderr: { maxBytes: 64_000 } },
      graceMs: 1000,
      ...(signal === undefined ? {} : { signal }),
    })
    const outcome = await handle?.done
    const exitCode = outcome?.exitCode
    if (typeof exitCode === 'number' && exitCode !== 0) return null
    const relative = parsePorcelainZ(readCollected(handle))
    return relative.map((path) => joinPath(cwd, path))
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
