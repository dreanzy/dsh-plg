import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filesOf, MAX_COMMANDS, parseCommands } from '../lib/ops.js'

/**
 * 命令协议骨架的测试面。
 *
 * 复现的 bug：四份 `parseCommands` 各写一遍，其中 mcp 与 model 没有条数上限——
 * 2 万条命令要跑 70 秒并阻塞宿主主线程。骨架收进 core 后，上限对四包一起生效。
 *
 * 表是假的：这里只测骨架，各包的 `parse` 与 `apply*` 由它们自己的用例覆盖。
 */

const TABLE = {
  alpha: {
    op: 'alpha',
    files: ['packs'],
    parse(record) {
      const name = record['name']
      return typeof name === 'string' && name !== '' ? { op: 'alpha', name } : 'name 必须是非空字符串'
    },
  },
  beta: {
    op: 'beta',
    files: ['packs', 'bindings'],
    parse(record) {
      const cwd = record['cwd']
      return typeof cwd === 'string' && cwd !== '' ? { op: 'beta', cwd } : 'cwd 必须是非空字符串'
    },
  },
}

test('合法命令逐条解析，顺序保留', () => {
  const result = parseCommands([{ op: 'alpha', name: 'a' }, { op: 'beta', cwd: 'C:/w' }], TABLE)
  assert.equal(result.ok, true)
  assert.deepEqual(result.commands, [{ op: 'alpha', name: 'a' }, { op: 'beta', cwd: 'C:/w' }])
})

test('非数组与空批都拒绝', () => {
  assert.deepEqual(parseCommands('nope', TABLE), { ok: false, message: 'commands 必须是数组' })
  assert.deepEqual(parseCommands([], TABLE), { ok: false, message: 'commands 不能为空' })
})

test('条目不是对象时指出下标', () => {
  assert.deepEqual(parseCommands([null], TABLE), { ok: false, message: 'commands[0] 不是对象' })
  assert.deepEqual(parseCommands([[]], TABLE), { ok: false, message: 'commands[0] 不是对象' })
})

test('未知 op 被拒绝，原型链上的名字同样算未知', () => {
  assert.deepEqual(parseCommands([{ op: 'nope' }], TABLE), { ok: false, message: 'commands[0] op 不是已知操作' })
  for (const op of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(parseCommands([{ op }], TABLE), { ok: false, message: 'commands[0] op 不是已知操作' })
  }
})

test('op 不是字符串时同样拒绝', () => {
  assert.deepEqual(parseCommands([{ op: 1 }], TABLE), { ok: false, message: 'commands[0] op 不是已知操作' })
  assert.deepEqual(parseCommands([{}], TABLE), { ok: false, message: 'commands[0] op 不是已知操作' })
})

test('parse 返回字符串即错误，消息带上下标', () => {
  assert.deepEqual(parseCommands([{ op: 'alpha' }], TABLE), {
    ok: false,
    message: 'commands[0] name 必须是非空字符串',
  })
  assert.deepEqual(parseCommands([{ op: 'alpha', name: 'a' }, { op: 'beta' }], TABLE), {
    ok: false,
    message: 'commands[1] cwd 必须是非空字符串',
  })
})

test('一条不合格就整批拒绝，不返回半批', () => {
  const result = parseCommands([{ op: 'alpha', name: 'a' }, { op: 'nope' }], TABLE)
  assert.equal(result.ok, false)
  assert.equal('commands' in result, false)
})

test('超过条数上限时拒绝，不进入 O(n²) 路径', () => {
  const many = Array.from({ length: MAX_COMMANDS + 1 }, () => ({ op: 'alpha', name: 'a' }))
  const result = parseCommands(many, TABLE)
  assert.equal(result.ok, false)
  assert.match(result.message, /最多 1000 条/)
})

test('恰好等于上限时放行', () => {
  const exact = Array.from({ length: MAX_COMMANDS }, () => ({ op: 'alpha', name: 'a' }))
  assert.equal(parseCommands(exact, TABLE).ok, true)
})

test('filesOf 收集全部落点，一条命令可以命中多个文件', () => {
  assert.deepEqual([...filesOf([{ op: 'alpha', name: 'a' }], TABLE)], ['packs'])
  assert.deepEqual([...filesOf([{ op: 'beta', cwd: 'C:/w' }], TABLE)].sort(), ['bindings', 'packs'])
  assert.deepEqual([...filesOf([{ op: 'alpha', name: 'a' }, { op: 'beta', cwd: 'C:/w' }], TABLE)].sort(), [
    'bindings',
    'packs',
  ])
})

test('filesOf 对未知 op 静默跳过，不抛', () => {
  assert.deepEqual([...filesOf([{ op: 'nope' }], TABLE)], [])
})
