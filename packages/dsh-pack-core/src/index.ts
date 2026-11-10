/**
 * 四个 pack 插件共用的服务端骨架。
 *
 * 边界见 docs/adr/0007：会话目录、装配记账、求值链、落盘规则与协议类型放这里；
 * 宿主接线（hooks）、各包的条目 schema、mcp 的连接与闸门留在各自包里。
 */

/** 骨架包的版本。搬迁期间用它确认四个插件加载的是同一份核心。 */
export const CORE_VERSION = '0.1.0'

export { projectedCwd, cwdFromAgent, cwdFromObserved } from './cwd.js'

export { createReconciler, type Dispose, type Reconciler } from './reconcile.js'

export type { Envelope, ErrorCode } from './protocol.js'

export { storePaths, readText, type StorePaths } from './store.js'

export { createResolver, normalizeCwd, type Decision, type GroupRegistryLike, type PackLike, type Resolver, type ResolverInput } from './policy.js'

export { pendingKeyOf, PENDING_KEY_RULES, type PendingKeyCommand } from './pendingKeys.js'
