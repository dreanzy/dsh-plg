/**
 * 四个 pack 插件共用的服务端骨架。
 *
 * 边界见 docs/adr/0007：会话目录、会话解析、装配记账、求值链、落盘规则与协议类型放这里；
 * 宿主接线（hooks）、各包的条目 schema、mcp 的连接与闸门留在各自包里。
 */

export { cwdFromAgent, cwdFromObserved } from './cwd.js'

export { resolveSession, type RouteContext, type SessionResolution } from './session.js'

export { createReconciler, type Dispose, type Reconciler } from './reconcile.js'

export type { Envelope, ErrorCode } from './protocol.js'

export {
  toResponse,
  wrap,
  readFetchFace,
  registerRoutes,
  type FetchFace,
  type FetchRouteSpec,
  type RouteHandler,
} from './routes.js'

export {
  storePaths,
  readText,
  transact,
  previewText,
  writableReason,
  type StorePaths,
  type TransactResult,
} from './store.js'

export {
  createResolver,
  normalizeCwd,
  rankOf,
  RANK_ORDER,
  type Decision,
  type GroupRegistryLike,
  type PackLike,
  type Rank,
  type Resolver,
  type ResolverInput,
} from './policy.js'

export { pendingKeyOf, PENDING_KEY_RULES, type PendingKeyCommand } from './pendingKeys.js'

export { staleKeysOf } from './stale.js'

export {
  parseCommands,
  filesOf,
  MAX_COMMANDS,
  type OpSpec,
  type OpTable,
  type StoreFile,
} from './ops.js'

export {
  assertNameFree,
  assertPackRoom,
  copyName,
  findPack,
  nextGroupId,
  nextPackId,
  requireName,
  setKey,
} from './draft.js'

export {
  isPlainRecord,
  readJson,
  parseRoster,
  packViews,
  type PackView,
  type RosterConfig,
  type RosterDeps,
  type RosterResult,
} from './roster.js'
