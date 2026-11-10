/**
 * 会话当前工作目录。
 *
 * 权威值在 `workingDirectory` 投影里：`cd` 与切换工作区只改投影，`header.cwd` 是会话
 * 创建时的快照。读 header 会让「切到另一个工作区后仍按上一个目录求值」——清单、绑定与
 * 开关全部停在旧目录（skill-pack 在 a0357f0 修正过同一处，其余包当时未同步）。
 *
 * 不走 `workingDirectory.get()`：它在投影尚未写入时回落到进程的 `defaultDirectory`，
 * 会把「还没 cd 过的新会话」解析成宿主安装目录。顺序与宿主 `skill-catalog` 一致：
 * 投影 → header.cwd → 缺省。
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 读 `workingDirectory` 投影的原始值。 */
export function projectedCwd(session: unknown): string | null {
  const projections = asRecord(asRecord(session)?.['projections'])
  const faceOf = projections?.['faceOf']
  if (typeof faceOf !== 'function') return null
  try {
    const face = asRecord((faceOf as (key: string) => unknown).call(projections, 'workingDirectory'))
    const getSnapshot = face?.['getSnapshot']
    const value = typeof getSnapshot === 'function' ? getSnapshot.call(face) : undefined
    return nonEmpty(value)
  } catch {
    return null
  }
}

/** 活动 Agent 的当前目录。 */
export function cwdFromAgent(agent: unknown): string | null {
  const session = asRecord(asRecord(agent)?.['session'])
  return projectedCwd(session) ?? nonEmpty(asRecord(session?.['header'])?.['cwd'])
}

/** `observeSession` 快照的当前目录：投影值在 `projections.values.workingDirectory`。 */
export function cwdFromObserved(observation: unknown): string | null {
  const observed = asRecord(observation)
  const values = asRecord(asRecord(observed?.['projections'])?.['values'])
  const projected = nonEmpty(values?.['workingDirectory'])
  if (projected !== null) return projected
  return nonEmpty(asRecord(observed?.['header'])?.['cwd'])
}
