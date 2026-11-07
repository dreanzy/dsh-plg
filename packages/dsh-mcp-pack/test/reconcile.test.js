import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReconciler } from '../lib/reconcile.js'

function setup() {
  const warns = []
  return { warns, reconciler: createReconciler((message) => warns.push(message)) }
}

test('同一个 key 连调两次：旧 dispose 被调用，只留新资源', async () => {
  const { reconciler } = setup()
  const disposed = []
  assert.equal(await reconciler.apply('a', () => () => disposed.push('old')), true)
  assert.equal(await reconciler.apply('a', () => () => disposed.push('new')), true)
  assert.deepEqual(disposed, ['old'])
  reconciler.release('a')
  assert.deepEqual(disposed, ['old', 'new'])
})

test('先释放上一轮再落地新一轮', async () => {
  const { reconciler } = setup()
  const log = []
  await reconciler.apply('a', () => {
    log.push('build-1')
    return () => log.push('drop-1')
  })
  await reconciler.apply('a', () => {
    log.push('build-2')
    return () => log.push('drop-2')
  })
  assert.deepEqual(log, ['build-1', 'drop-1', 'build-2'])
})

test('两次并发调用排队：先入队的一轮被作废，只落地最后一份', async () => {
  const { reconciler } = setup()
  const log = []
  const first = reconciler.apply('a', () => {
    log.push('build-1')
    return () => log.push('drop-1')
  })
  const second = reconciler.apply('a', () => {
    log.push('build-2')
    return () => log.push('drop-2')
  })
  assert.deepEqual(await Promise.all([first, second]), [false, true])
  assert.deepEqual(log, ['build-2'])
})

test('build 抛错：返回 false、上一轮已释放、warn 一条', async () => {
  const { reconciler, warns } = setup()
  const disposed = []
  await reconciler.apply('a', () => () => disposed.push('old'))
  const ok = await reconciler.apply('a', () => {
    throw new Error('boom')
  })
  assert.equal(ok, false)
  assert.deepEqual(disposed, ['old'])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /装配失败/)
  // 失败之后这个主体没有资源：再 release 不会重复释放。
  reconciler.release('a')
  assert.deepEqual(disposed, ['old'])
})

test('release 释放当前资源，重复调用是空操作', async () => {
  const { reconciler } = setup()
  const disposed = []
  await reconciler.apply('a', () => () => disposed.push('x'))
  reconciler.release('a')
  assert.deepEqual(disposed, ['x'])
  reconciler.release('a')
  assert.deepEqual(disposed, ['x'])
})

test('入队后立刻 release：这一轮不落地，也不持有资源', async () => {
  const { reconciler } = setup()
  let built = 0
  const pending = reconciler.apply('a', () => {
    built += 1
    return () => {}
  })
  reconciler.release('a')
  assert.equal(await pending, false)
  assert.equal(built, 0)
  reconciler.release('a')
})

test('落地期间被 release：这一份资源立刻释放，且不持有', async () => {
  const { reconciler } = setup()
  const disposed = []
  const ok = await reconciler.apply('a', () => {
    // 主体在 build 中途被销毁（例如 dispose 事件插进来的那一轮）。
    reconciler.release('a')
    return () => disposed.push('late')
  })
  assert.equal(ok, false)
  assert.deepEqual(disposed, ['late'])
  reconciler.release('a')
  assert.deepEqual(disposed, ['late'])
})
