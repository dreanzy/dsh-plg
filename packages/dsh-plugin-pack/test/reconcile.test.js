import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReconciler } from '../lib/reconcile.js'

/** 记下 warn：降级路径不许静默吞掉失败。 */
function harness() {
  const warnings = []
  const reconciler = createReconciler((message) => warnings.push(message))
  return { reconciler, warnings }
}

test('同 key 再 apply：旧 dispose 先被调用，再换成新的', async () => {
  const { reconciler } = harness()
  const trace = []
  assert.equal(await reconciler.apply('a', () => () => trace.push('old')), true)
  assert.equal(await reconciler.apply('a', () => () => trace.push('new')), true)
  assert.deepEqual(trace, ['old'])
  reconciler.release('a')
  assert.deepEqual(trace, ['old', 'new'])
})

test('先释放后施加：下一轮 build 执行时上一轮资源已经释放', async () => {
  const { reconciler } = harness()
  const trace = []
  await reconciler.apply('a', () => {
    trace.push('build-1')
    return () => trace.push('dispose-1')
  })
  await reconciler.apply('a', () => {
    trace.push('build-2')
    return () => trace.push('dispose-2')
  })
  assert.deepEqual(trace, ['build-1', 'dispose-1', 'build-2'])
})

test('串行：同一 key 并发两次，被顶掉的那轮不落地，只有最新一轮生效', async () => {
  const { reconciler } = harness()
  const trace = []
  const first = reconciler.apply('a', () => {
    trace.push('build-1')
    return () => trace.push('dispose-1')
  })
  const second = reconciler.apply('a', () => {
    trace.push('build-2')
    return () => trace.push('dispose-2')
  })
  assert.deepEqual(await Promise.all([first, second]), [false, true])
  // 两块资源同时活着就是泄漏：被顶掉的一轮连 build 都不该跑。
  assert.deepEqual(trace, ['build-2'])
  reconciler.release('a')
  assert.deepEqual(trace, ['build-2', 'dispose-2'])
})

test('build 抛错：返回 false，旧资源已释放，主体退回没有资源', async () => {
  const { reconciler, warnings } = harness()
  const trace = []
  await reconciler.apply('a', () => () => trace.push('old'))
  const ok = await reconciler.apply('a', () => {
    throw new Error('boom')
  })
  assert.equal(ok, false)
  assert.deepEqual(trace, ['old'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /装配失败/)
  // 失败之后确实不再持有：再 release 不会多调一次。
  reconciler.release('a')
  assert.deepEqual(trace, ['old'])
})

test('release 放掉资源并忘记它：重复 release 不会再调一次', async () => {
  const { reconciler } = harness()
  const trace = []
  await reconciler.apply('a', () => () => trace.push('dispose'))
  reconciler.release('a')
  reconciler.release('a')
  assert.deepEqual(trace, ['dispose'])
})

test('入队后立刻 release：这一轮不落地，也不给已销毁的主体留资源', async () => {
  const { reconciler } = harness()
  const trace = []
  const pending = reconciler.apply('a', () => {
    trace.push('build')
    return () => trace.push('dispose')
  })
  reconciler.release('a')
  assert.equal(await pending, false)
  assert.deepEqual(trace, [])
})

test('build 返回 null：本轮不需要资源，上一轮照样释放', async () => {
  const { reconciler } = harness()
  const trace = []
  await reconciler.apply('a', () => () => trace.push('old'))
  assert.equal(await reconciler.apply('a', () => null), true)
  assert.deepEqual(trace, ['old'])
  reconciler.release('a')
  assert.deepEqual(trace, ['old'])
})

test('旧 dispose 抛错只 warn：新一轮照常落地', async () => {
  const { reconciler, warnings } = harness()
  const trace = []
  await reconciler.apply('a', () => () => {
    throw new Error('nope')
  })
  assert.equal(await reconciler.apply('a', () => () => trace.push('new')), true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /释放上一个装配失败/)
  assert.deepEqual(trace, [])
})

test('不同 key 各自记账：释放一个不动另一个', async () => {
  const { reconciler } = harness()
  const trace = []
  await reconciler.apply('a', () => () => trace.push('a'))
  await reconciler.apply('b', () => () => trace.push('b'))
  reconciler.release('a')
  assert.deepEqual(trace, ['a'])
  reconciler.release('b')
  assert.deepEqual(trace, ['a', 'b'])
})
