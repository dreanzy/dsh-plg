/**
 * 名册草稿的纯操作。
 *
 * 三个包的 `ops.ts` 各抄一份：九个函数里 1 个三份逐字、4 个函数体逐字仅类型标注不同、
 * 4 个语义分叉。分叉里有三处不是领域差异，而是同一份纪律在复制时丢在了别处——
 * `setKey` 只有 plugin 用了 `defineProperty`，`findPack` 只有 plugin 用了 `hasOwn`，
 * 名字的上限与字符校验只有 skill 有。收在这里后各取三份中最严的一种（见 ADR-0016）。
 *
 * 留包内的两个：`clonePack` 跟 `rows` 形状与 `tools` 深拷走，`groupNameOf` 只是
 * 从命令里取一个字段再交给 `requireName`。
 */

/** 名字上限：超长名字会撑破面板布局，含控制字符的名字会在日志里伪造行。 */
const MAX_NAME_CHARS = 64

/**
 * 写一个键或删掉它。
 *
 * `null` 表示「回到跟随」：删键，不是写一个空值。其余值用 `defineProperty` 写——
 * `next['__proto__'] = value` 改的是原型，键被静默丢弃，序列化时消失且没有 warning。
 */
export function setKey<T>(map: Readonly<Record<string, T>>, key: string, value: T | null): Record<string, T> {
  const next = { ...map }
  if (value === null) {
    delete next[key]
    return next
  }
  Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true })
  return next
}

/** 去掉首尾空白，再要求非空、不超长、不含控制字符。`label` 只影响报错措辞。 */
export function requireName(raw: string, label = 'pack'): string {
  const name = raw.trim()
  if (name === '') throw new Error(`${label} 名不能为空`)
  if (name.length > MAX_NAME_CHARS) throw new Error(`${label} 名过长（上限 ${String(MAX_NAME_CHARS)} 字符）`)
  if (/[\u0000-\u001f]/u.test(name)) throw new Error(`${label} 名不能含控制字符`)
  return name
}

/**
 * 取一张 pack；不存在就抛。
 *
 * `hasOwn` 而不是下标取值：`packs['__proto__']` 拿到的是 `Object.prototype`，
 * 不是 `undefined`，会让「未知 pack」的报错消失，后续求值抛 TypeError。
 */
export function findPack<P>(packs: Readonly<Record<string, P>>, packId: string): P {
  const pack = Object.hasOwn(packs, packId) ? packs[packId] : undefined
  if (pack === undefined) throw new Error(`未知 pack：${packId}`)
  return pack
}

/** 名字不能与别的 pack 撞。`exceptId` 是本次改名的那个 pack，它自己不算撞。 */
export function assertNameFree<P extends { name: string }>(
  packs: Readonly<Record<string, P>>,
  name: string,
  exceptId?: string,
): void {
  for (const [id, pack] of Object.entries(packs)) {
    if (id !== exceptId && pack.name === name) throw new Error(`pack 名已存在：${name}`)
  }
}

/** 造一个短且稳定的 pack id，与名字脱钩。 */
export function nextPackId<P>(packs: Readonly<Record<string, P>>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `p${String(index)}`
    if (packs[candidate] === undefined) return candidate
  }
}

/**
 * 副本的显示名：原名 + 空格 + 序号，从 2 起，撞名就往后数。
 *
 * 不做尾部数字识别：「前端 2」的副本叫「前端 2 2」。规则只有一条，用户看一眼就能
 * 预测下一个叫什么；识别尾部数字会让「前端 2 3」这类名字产生歧义。
 */
export function copyName<P extends { name: string }>(packs: Readonly<Record<string, P>>, base: string): string {
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${String(index)}`
    let taken = false
    for (const pack of Object.values(packs)) {
      if (pack.name === candidate) {
        taken = true
        break
      }
    }
    if (!taken) return candidate
  }
}

/** 写侧也按读侧的上限拒绝：写得进去、读不回来是最难排查的一类问题。 */
export function assertPackRoom(packs: Readonly<Record<string, unknown>>, maxNames: number): void {
  if (Object.keys(packs).length >= maxNames) throw new Error(`pack 已达上限 ${String(maxNames)} 个`)
}

/** 造一个短且稳定的分组 id，与名字脱钩。 */
export function nextGroupId(groups: readonly { id: string }[]): string {
  const taken = new Set(groups.map((group) => group.id))
  for (let index = groups.length + 1; ; index += 1) {
    const candidate = `g${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}
