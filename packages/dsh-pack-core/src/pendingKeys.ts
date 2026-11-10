/**
 * 待保存队列的去重键。
 *
 * 「同一个键只留最后一次取值」是队列的全部语义：同一张 pack 里改两次开关，队列里
 * 只剩一条。键的格式因此是协议的一部分——服务端拿它算落点，客户端拿它算「这一行
 * 有没有未保存改动」，两边算出来的键必须逐字相同。
 *
 * 原先两边各写一遍：服务端在 `ops.ts` 的 `key` 里，客户端在 `pendingKey` 里。
 * 加一个 op 时客户端那份最容易漏——漏了不会报错，只是那条改动不再去重。
 *
 * 现在规则在这张表里，服务端直接引用；客户端的复制品由各包的 `test/client.test.js`
 * 逐 op 比对，漂移立刻红。
 */

/** 键规则的入参：只看 op 与几个字段。 */
export type PendingKeyCommand = { readonly op: string } & Record<string, unknown>

type Rule = (command: Record<string, unknown>) => string | null

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** op → 键规则。`null` 表示没有可覆盖的目标：新建与删除每一条都独立。 */
export const PENDING_KEY_RULES: Readonly<Record<string, Rule>> = {
  packItem: (command) => `packItem:${text(command['packId'])}:${text(command['name'])}`,
  packGroup: (command) => `packGroup:${text(command['packId'])}:${text(command['groupId'])}`,
  packRow: (command) => `packRow:${text(command['packId'])}:${text(command['rowKey'])}`,
  renamePack: (command) => `renamePack:${text(command['packId'])}`,
  renameGroup: (command) => `renameGroup:${text(command['groupId'])}`,
  // bind 用 cwd 的原值：归一化发生在落盘时，队列只按用户点的那个目录去重。
  bind: (command) => `bind:${text(command['cwd'])}`,
  // assign 的键在三个包里分别叫 name 与 rowKey，取到哪个用哪个。
  assign: (command) => `assign:${text(command['name'] ?? command['rowKey'])}`,
  // model-pack 的命令与其他四包不同：整张 pack、会话路由、档位。
  packSession: (command) => `packSession:${text(command['packId'])}`,
  packTier: (command) => `packTier:${text(command['packId'])}:${text(command['tierId'])}`,
  putPack: (command) => `pack:${text(command['packId'])}`,
}

/** 一条命令的队列键；没有规则或没有可覆盖目标时为 `null`。 */
export function pendingKeyOf(command: { readonly op: string }): string | null {
  const rule = PENDING_KEY_RULES[command.op]
  if (rule === undefined) return null
  return rule(command as unknown as Record<string, unknown>)
}
