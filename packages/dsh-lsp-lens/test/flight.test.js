import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLIGHT_MAX_MS, FLIGHT_MAX_STEPS, settleFlight } from '../lib/flight.js'

/**
 * 飞行结算的测试面。
 *
 * 这条判定原先埋在 `apply` 的 pre-step 里，只能通过假 ctx 跑整个 `apply` 才测得到。
 * 抽出后它是纯函数：喂一个飞行对象、一个步号、一个时间点，就能把四档结论全试一遍
 * （见 ADR-0018）。
 */

const flight = (over = {}) => ({
  path: '/w/a.ts',
  version: 'v1',
  step: 1,
  startedAt: 1000,
  done: false,
  result: null,
  ...over,
})

test('未落定且未过期 → pending', () => {
  assert.deepEqual(settleFlight(flight(), 1, 1500), { kind: 'pending' })
})

test('恰好第 2 步仍算 pending：边界是严格大于，诊断可能刚好回来', () => {
  assert.deepEqual(settleFlight(flight({ step: 1 }), 1 + FLIGHT_MAX_STEPS, 1500), { kind: 'pending' })
})

test('超出步数 → stale', () => {
  assert.deepEqual(settleFlight(flight({ step: 1 }), 2 + FLIGHT_MAX_STEPS, 1500), { kind: 'stale' })
})

test('超出时间 → stale', () => {
  assert.deepEqual(settleFlight(flight({ startedAt: 1000 }), 1, 1000 + FLIGHT_MAX_MS + 1), { kind: 'stale' })
})

test('落定且有结果 → take，结果原样带出', () => {
  const result = { path: '/w/a.ts', diagnostics: [{ severity: 1, message: 'x' }] }
  assert.deepEqual(settleFlight(flight({ done: true, result }), 5, 9999), { kind: 'take', result })
})

test('落定但没有结果（失败或超时）→ empty', () => {
  assert.deepEqual(settleFlight(flight({ done: true, result: null }), 5, 9999), { kind: 'empty' })
})
