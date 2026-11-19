import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSession } from '../lib/session.js'

/**
 * 会话解析的测试面。
 *
 * 复现的 bug：三份 `resolveSession` 各写一遍，其中 skill 那份内联了 cwd 解析、没走
 * core；而 `observeSession` 的观察体必须在 `finally` 里释放——漏一次就是一条长期
 * 泄漏。三个包对这条路径零覆盖，所以这里补上。
 *
 * 宿主全程是假的：ctx 只有 `get` 与 `logger`。
 */

/**
 * 带工作区的 Agent。
 *
 * 工作区读 `header.cwd`（会话创建时的工作区，创建后不可变）。投影不参与：
 * 模型 `cd` 不该改变会话所属工作区。
 */
function agentWith(cwd) {
  return { session: { header: { cwd } } }
}

function ctxOf(services, warnings = [], label = 'test-pack') {
  return {
    get(name) {
      return services[name]
    },
    logger: { warn: (message) => warnings.push(message) },
    label,
  }
}

test('live Agent 优先：拿到 agent 本体与工作区', async () => {
  const agent = agentWith('D:/current')
  const ctx = ctxOf({ agents: { get: () => agent } })
  const resolved = await resolveSession(ctx, 's1')
  assert.deepEqual(resolved, { live: true, cwd: 'D:/current', agent })
})

test('live Agent 抛错时退回观察快照', async () => {
  const observed = { header: { cwd: 'D:/observed' } }
  const ctx = ctxOf({
    agents: {
      get() {
        throw new Error('unknown session')
      },
    },
    sessionQuery: { observeSession: async () => observed },
  })
  assert.deepEqual(await resolveSession(ctx, 's1'), { live: false, cwd: 'D:/observed' })
})

test('观察体在 finally 里释放，且只释放一次', async () => {
  let disposed = 0
  const observed = {
    header: { cwd: 'C:/created' },
    [Symbol.dispose]() {
      disposed += 1
    },
  }
  const ctx = ctxOf({ sessionQuery: { observeSession: async () => observed } })
  await resolveSession(ctx, 's1')
  assert.equal(disposed, 1, '观察体必须被释放，且只释放一次')
})

test('观察体解析不出目录时同样释放', async () => {
  let disposed = 0
  const observed = {
    [Symbol.dispose]() {
      disposed += 1
    },
  }
  const ctx = ctxOf({ sessionQuery: { observeSession: async () => observed } })
  assert.equal(await resolveSession(ctx, 's1'), null)
  assert.equal(disposed, 1, '解析失败也要释放，否则每次失败都漏一条订阅')
})

test('observeSession 抛错时返回 null，不把异常抛给调用方', async () => {
  const ctx = ctxOf({
    sessionQuery: {
      observeSession: async () => {
        throw new Error('unknown session')
      },
    },
  })
  assert.equal(await resolveSession(ctx, 's1'), null)
})

test('释放失败只记一条带包名的 warn，不逃逸', async () => {
  const warnings = []
  const observed = {
    header: { cwd: 'C:/created' },
    [Symbol.dispose]() {
      throw new Error('dispose boom')
    },
  }
  const ctx = ctxOf({ sessionQuery: { observeSession: async () => observed } }, warnings)
  const resolved = await resolveSession(ctx, 's1')
  assert.deepEqual(resolved, { live: false, cwd: 'C:/created' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^test-pack: 释放会话观察失败（sessionId=s1）：/)
})

test('两个服务都不可用时返回 null', async () => {
  assert.equal(await resolveSession(ctxOf({}), 's1'), null)
  assert.equal(await resolveSession(ctxOf({ agents: {} }), 's1'), null)
  assert.equal(await resolveSession(ctxOf({ sessionQuery: {} }), 's1'), null)
})

test('非 live 的结论不带 agent 字段', async () => {
  const ctx = ctxOf({
    sessionQuery: { observeSession: async () => ({ header: { cwd: 'C:/created' } }) },
  })
  const resolved = await resolveSession(ctx, 's1')
  assert.equal(resolved.live, false)
  assert.equal('agent' in resolved, false, 'live: false 时不该有 agent 字段')
})
