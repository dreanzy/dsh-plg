import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReconciler } from '../lib/reconcile.js'

/** 收集 warn 文本，顺带证明失败路径确实报告了原因。 */
function recorder() {
  const warnings = []
  return { warnings, warn: (message) => warnings.push(message) }
}

test('同一个 key 再落地一次会先释放上一轮', async () => {
  const { warn } = recorder()
  const reconciler = createReconciler(warn)
  const log = []

  assert.equal(await reconciler.apply('a', () => () => log.push('dispose-1')), true)
  assert.deepEqual(log, [])

  assert.equal(await reconciler.apply('a', () => () => log.push('dispose-2')), true)
  assert.deepEqual(log, ['dispose-1'])

  reconciler.release('a')
  assert.deepEqual(log, ['dispose-1', 'dispose-2'])
})

test('同一 key 的并发落地不并行，后一轮顶掉前一轮', async () => {
  const { warnings, warn } = recorder()
  const reconciler = createReconciler(warn)
  const log = []

  const first = reconciler.apply('a', () => {
    log.push('build-1')
    return () => log.push('dispose-1')
  })
  const second = reconciler.apply('a', () => {
    log.push('build-2')
    return () => log.push('dispose-2')
  })

  // 调用当场谁都没落地：两轮都排进微任务，不存在并行装配。
  assert.deepEqual(log, [])
  // 后一次入队即顶掉前一次：前一轮不落地，也不动资源。
  assert.deepEqual(await Promise.all([first, second]), [false, true])
  assert.deepEqual(log, ['build-2'])

  reconciler.release('a')
  assert.deepEqual(log, ['build-2', 'dispose-2'])
  assert.deepEqual(warnings, [])
})

test('落地失败退回无资源并返回 false', async () => {
  const { warnings, warn } = recorder()
  const reconciler = createReconciler(warn)
  let disposed = 0

  await reconciler.apply('a', () => () => {
    disposed += 1
  })
  assert.equal(disposed, 0)

  const landed = await reconciler.apply('a', () => {
    throw new Error('造不出来')
  })
  assert.equal(landed, false)
  // 上一轮已经被释放，此刻这个主体没有资源。
  assert.equal(disposed, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /装配失败/)

  // 失败不留半份：再 release 一次不会重复释放。
  reconciler.release('a')
  assert.equal(disposed, 1)
})

test('release 之后不再持有资源', async () => {
  const { warnings, warn } = recorder()
  const reconciler = createReconciler(warn)
  let disposed = 0

  await reconciler.apply('a', () => () => {
    disposed += 1
  })
  reconciler.release('a')
  assert.equal(disposed, 1)

  // 重复 release 幂等。
  reconciler.release('a')
  assert.equal(disposed, 1)
  assert.deepEqual(warnings, [])
})

test('入队后立刻 release，排队的那一轮不会给已销毁的主体复活资源', async () => {
  const { warnings, warn } = recorder()
  const reconciler = createReconciler(warn)
  let built = 0
  let disposed = 0

  const pending = reconciler.apply('a', () => {
    built += 1
    return () => {
      disposed += 1
    }
  })
  reconciler.release('a')

  // 世代号在入队时取过，release 之后这一轮直接作废：build 不跑，也就没有资源可放。
  assert.equal(await pending, false)
  assert.equal(built, 0)
  assert.equal(disposed, 0)

  // 作废的那一轮不该把 key 弄坏：后面的落地照常生效。
  assert.equal(
    await reconciler.apply('a', () => () => {
      disposed += 1
    }),
    true,
  )
  reconciler.release('a')
  assert.equal(disposed, 1)
  assert.deepEqual(warnings, [])
})
