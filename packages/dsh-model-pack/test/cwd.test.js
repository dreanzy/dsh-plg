import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cwdFromAgent, cwdFromObserved, projectedCwd } from '../lib/cwd.js'

/**
 * 会话当前目录的取法。
 *
 * 复现的 bug：`cd` 与切换工作区只改 `workingDirectory` 投影，`header.cwd` 是创建时的
 * 快照。读 header 会让清单、绑定与开关停在旧目录——skill-pack 在 a0357f0 修正过同一处，
 * 其余三包当时未同步。
 */

/** 带 workingDirectory 投影的会话：投影值就是「现在在哪」。 */
function sessionWith(projected) {
  return {
    header: { cwd: 'C:/created' },
    projections: {
      faceOf(key) {
        if (key !== 'workingDirectory') return null
        return { getSnapshot: () => projected }
      },
    },
  }
}

test('切过目录后按投影求值，不按创建时的快照', () => {
  assert.equal(cwdFromAgent({ session: sessionWith('D:/current') }), 'D:/current')
})

test('投影还没写过时退回会话头', () => {
  assert.equal(cwdFromAgent({ session: sessionWith(undefined) }), 'C:/created')
})

test('投影读取抛错时退回会话头，不把异常抛给调用方', () => {
  const session = {
    header: { cwd: 'C:/created' },
    projections: {
      faceOf() {
        throw new Error('boom')
      },
    },
  }
  assert.equal(cwdFromAgent({ session }), 'C:/created')
})

test('拿不到会话或投影时返回 null', () => {
  assert.equal(cwdFromAgent(undefined), null)
  assert.equal(cwdFromAgent({}), null)
  assert.equal(projectedCwd(null), null)
  assert.equal(projectedCwd({ projections: { faceOf: () => ({}) } }), null)
})

test('历史会话的观察快照同样投影优先', () => {
  const observed = {
    header: { cwd: 'C:/created' },
    projections: { values: { workingDirectory: 'D:/current' } },
  }
  assert.equal(cwdFromObserved(observed), 'D:/current')
  assert.equal(cwdFromObserved({ header: { cwd: 'C:/created' } }), 'C:/created')
})
