import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResolver, normalizeCwd as serverNormalizeCwd } from '../lib/policy.js'

/**
 * 浏览器侧复制了一份求值链（client.js 不能 import 本地模块）。这里用同一组
 * fixture 跑两端，任何一侧改了链，这条测试都会先失败。
 */
let entry = null
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      entry = value
    },
  },
}
await import('../client/client.js')

const fakeReact = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useState: (initial) => [initial, () => undefined],
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, read) => read(),
}
const mod = entry.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('意外请求模块：' + String(name))
})
const { resolveItem, normalizeCwd } = mod.__test

function pack(name, items = {}, groups = {}) {
  return { name, items, groups }
}

const defaultPack = pack('default', { fragile: false }, { 'g-a': false })
const cases = [
  { pack: null, assignments: {} },
  { pack: pack('p1'), assignments: {} },
  { pack: pack('p1'), assignments: { fixed: 'g-a' } },
  { pack: pack('p1', { fragile: true }), assignments: {} },
  { pack: pack('p1', {}, { 'g-a': true }), assignments: { fixed: 'g-a' } },
  { pack: pack('p1', { fixed: false }, { 'g-a': true }), assignments: { fixed: 'g-a' } },
  { pack: pack('p1', { fixed: true }, { 'g-a': false }), assignments: { fixed: 'g-a' } },
  { pack: pack('p1'), assignments: { fixed: '' } },
]
const names = ['fragile', 'fixed', 'untouched']

test('浏览器侧求值链与服务端一致', () => {
  for (const item of cases) {
    const server = createResolver({
      pack: item.pack,
      defaultPack,
      assignments: item.assignments,
    })
    for (const name of names) {
      assert.equal(
        resolveItem(item.pack, defaultPack, item.assignments, name),
        server.isOpen(name),
        JSON.stringify({ pack: item.pack?.name ?? null, assignments: item.assignments, name }),
      )
    }
  }
})

test('浏览器侧 normalizeCwd 与服务端逐字一致', () => {
  const inputs = [null, '   ', '/a/b/', '/a/b///', 'C:\\X\\', 'D:\\Projects\\Sample\\', '/']
  for (const input of inputs) {
    assert.equal(normalizeCwd(input), serverNormalizeCwd(input), String(input))
  }
})
