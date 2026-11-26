import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionStore } from '../lib/sessions.js'

/**
 * 会话状态表的测试面。
 *
 * 这张表原先在 `apply` 的闭包里，测它的唯一方式是构造假 ctx 驱动整个 `apply`
 * 再断言两个会话互不干扰。抽出后「同键同一份、异键各自独立、释放会清干净」三条
 * 都能直接断言（见 ADR-0018）。
 */

test('同一会话键拿到同一份状态', () => {
  const store = createSessionStore()
  assert.equal(store.of('a'), store.of('a'))
})

test('不同会话键各自独立', () => {
  const store = createSessionStore()
  const a = store.of('a')
  const b = store.of('b')
  assert.notEqual(a, b)
  a.pendingShell.add('/w')
  assert.equal(b.pendingShell.size, 0)
})

test('size 只数跟踪到的会话', () => {
  const store = createSessionStore()
  assert.equal(store.size, 0)
  store.of('a')
  store.of('b')
  store.of('a')
  assert.equal(store.size, 2)
})

test('clear 清空每个会话的容器，再丢掉表', () => {
  const store = createSessionStore()
  const state = store.of('a')
  state.dirty.mark('/w/a.ts', 'v1')
  state.pendingShell.add('/w')
  state.backgroundJobs.set('job1', '/w')
  state.inFlight.set('k1', { path: '/w/a.ts', version: 'v1', step: 1, startedAt: 0, done: false, result: null })

  store.clear()

  assert.equal(store.size, 0)
  assert.equal(state.dirty.size, 0)
  assert.equal(state.pendingShell.size, 0)
  assert.equal(state.backgroundJobs.size, 0)
  assert.equal(state.inFlight.size, 0)
})
