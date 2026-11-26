import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packViews, parseRoster, readJson } from '../lib/roster.js'

/**
 * 名册读侧的测试面。
 *
 * 复现的 bug：三份 `parsePacks` 各守了一处纪律——skill 守了 pack 键的
 * `defineProperty`，plugin 守了 `setKey` 与 `hasOwn`，mcp 那两份都没守。同一段
 * 代码三份副本，没有一份是完整的。框架收进 core 后，这些纪律只有一处可以丢。
 */

const config = {
  defaultPackId: 'default',
  defaultPackName: '默认',
  emptyPack: { name: 'default', items: {} },
  maxNames: 3,
}

const deps = {
  parseUi: (raw) => (raw === undefined ? { showChip: true } : raw),
  parsePack: (id, raw, warnings) => {
    if (typeof raw !== 'object' || raw === null) {
      warnings.push(`packs.${id} 不是对象，已按空 pack 处理`)
      return { name: id, items: {} }
    }
    return { name: typeof raw.name === 'string' ? raw.name : id, items: raw.items ?? {} }
  },
}

test('坏文件降到空名册，并说明原因', () => {
  for (const text of [undefined, '', '  ', '{oops', '[]', 'null']) {
    const parsed = parseRoster(text, deps, config)
    assert.deepEqual(Object.keys(parsed.value.book.packs), ['default'])
    assert.equal(parsed.value.ui.showChip, true)
    assert.ok(parsed.warnings.length >= 0)
  }
  assert.ok(parseRoster('{oops', deps, config).warnings.some((w) => /不是合法 JSON/u.test(w)))
  assert.ok(parseRoster('[]', deps, config).warnings.some((w) => /顶层不是对象/u.test(w)))
})

test('正常解析：条目走回调，default 的显示名被归一', () => {
  const text = JSON.stringify({ packs: { default: { name: '旧名' }, b: { name: '乙', items: { s: false } } } })
  const parsed = parseRoster(text, deps, config)
  assert.equal(parsed.value.book.packs['default']?.name, '默认')
  assert.deepEqual(parsed.value.book.packs['b']?.items, { s: false })
})

test('多个 pack 按 id 排序解析，键可枚举', () => {
  const text = JSON.stringify({ packs: { c: {}, a: {}, default: {} } })
  const parsed = parseRoster(text, deps, config)
  assert.deepEqual(Object.keys(parsed.value.book.packs), ['a', 'c', 'default'])
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed.value.book.packs, 'a')?.enumerable, true)
})

test('超过上限按 id 截断并留 warning', () => {
  const text = JSON.stringify({ packs: { a: {}, b: {}, c: {}, d: {}, e: {} } })
  const parsed = parseRoster(text, deps, config)
  assert.deepEqual(Object.keys(parsed.value.book.packs), ['a', 'b', 'c', 'default'])
  assert.ok(parsed.warnings.some((w) => /超过 3 个/u.test(w)))
})

test('空 id 的条目被跳过', () => {
  const text = JSON.stringify({ packs: { '': { name: 'x' }, default: {} } })
  const parsed = parseRoster(text, deps, config)
  assert.deepEqual(Object.keys(parsed.value.book.packs), ['default'])
  assert.ok(parsed.warnings.some((w) => /空 id/u.test(w)))
})

test('default 缺席时补一个空 pack 并留 warning', () => {
  const parsed = parseRoster(JSON.stringify({ packs: { a: {} } }), deps, config)
  assert.deepEqual(parsed.value.book.packs['default'], config.emptyPack)
  assert.ok(parsed.warnings.some((w) => /缺少 default/u.test(w)))
})

test('__proto__ 作为 pack id 落成自有属性，不污染原型', () => {
  const parsed = parseRoster('{"packs":{"__proto__":{"name":"evil"},"default":{"name":"默认"}}}', deps, config)
  const packs = parsed.value.book.packs
  assert.equal(Object.hasOwn(packs, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(packs), Object.prototype)
  assert.deepEqual(packs['default']?.items, {})
})

test('readJson：空文本与坏 JSON 都返回 null，好文件返回对象', () => {
  const warnings = []
  assert.equal(readJson(undefined, warnings), null)
  assert.equal(readJson('   ', warnings), null)
  assert.equal(readJson('{bad', warnings), null)
  assert.deepEqual(readJson('{"a":1}', warnings), { a: 1 })
  // 空文本不是错误：它表示「还没有任何决定」，不报警告。
  assert.equal(warnings.length, 1)
})

test('packViews：default 第一，其余按名字序', () => {
  const packs = { b: { name: 'beta' }, default: { name: '旧名' }, a: { name: 'alpha' } }
  const views = packViews(packs, config, (row) => row.name)
  assert.deepEqual(views.map((view) => view.id), ['default', 'a', 'b'])
  assert.equal(views[0]?.name, '默认')
})

test('packViews 按名字排，不是按 id 排', () => {
  // id 与名字的顺序故意相反：退回按 id 排会让这条用例失败。
  const packs = { a: { name: 'zeta' }, z: { name: 'alpha' } }
  const views = packViews(packs, config, (row) => row.name)
  assert.deepEqual(views.map((view) => view.id), ['z', 'a'])
})

test('packViews：重名按 id 兜底，是全序', () => {
  const packs = { y: { name: 'same' }, x: { name: 'same' } }
  const views = packViews(packs, config, (row) => row.name)
  assert.deepEqual(views.map((view) => view.id), ['x', 'y'])
})

test('packViews：builtin 只标 default', () => {
  const views = packViews({ default: { name: '默认' }, a: { name: 'alpha' } }, config, (row) => row.name)
  assert.deepEqual(views.map((view) => view.builtin), [true, false])
})
