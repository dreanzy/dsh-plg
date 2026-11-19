import { asRecord, nonEmpty } from './unknown.js'

/**
 * 会话所属工作区。
 *
 * 权威值是 `header.cwd`——**会话创建时的工作区路径，创建后不可变**。宿主把它声明为
 * `readonly`（`dsh-session/src/types.ts` 的 `SessionHeader.cwd`），`workspace.attachSession`
 * 也按它校验归属，注释原文：both inputs (stored header cwd, workspace path) are immutable。
 *
 * 不读 `workingDirectory` 投影。投影会被 `working_directory` 工具（模型调用 `cd`）改写，
 * 而本项目的设计是「工作区由用户决定，模型无权变更」：读投影会让模型一次 `cd` 就把
 * 清单、绑定与开关换到另一个目录，与面板 chip 显示的内容不一致（chip 读的是
 * `session.list()` 的 `item.cwd`，也就是 header.cwd）。
 *
 * 用户在 UI 上切换工作区不是改现有会话的 cwd，而是换到该工作区的 blank 会话或新建一个
 * （`dsh-client-ui-workspace/src/client/navigation.ts` 的 `createInWorkspace` →
 * `sessions.create({ workspaceId })` → `cwd = workspace.path`）。所以换会话时 header.cwd
 * 自然就是新工作区，不需要读投影。
 */

/** 活动 Agent 所属工作区。 */
export function cwdFromAgent(agent: unknown): string | null {
  const session = asRecord(asRecord(agent)?.['session'])
  return nonEmpty(asRecord(session?.['header'])?.['cwd'])
}

/**
 * `observeSession` 快照所属工作区。
 *
 * 同样以 header 为准。观察体上的 `projections.values.workingDirectory` 是投影值，
 * 与 `cwdFromAgent` 保持同一口径，否则 live 与非 live 两条路径会给出不同结论。
 */
export function cwdFromObserved(observation: unknown): string | null {
  return nonEmpty(asRecord(asRecord(observation)?.['header'])?.['cwd'])
}
