import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectedCwd } from '../lib/hooks.js'

/**
 * `workingDirectory` 投影的读取。
 *
 * 投影是工作目录的权威值：`cd` 与切换工作区只改它，`header.cwd` 是创建时的快照。
 * 这里钉住三个退化点：投影有值就赢、没写就是 null（交给调用方退回会话头）、读坏不抛。
 */

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

test('投影有值就返回它', () => {
  assert.equal(projectedCwd(sessionWith('D:/current')), 'D:/current')
})

test('投影没写过时返回 null，由调用方退回会话头', () => {
  assert.equal(projectedCwd(sessionWith(undefined)), null)
  assert.equal(projectedCwd(sessionWith('')), null)
})

test('读投影抛错时返回 null，不把异常抛给调用方', () => {
  const session = {
    projections: {
      faceOf() {
        throw new Error('boom')
      },
    },
  }
  assert.equal(projectedCwd(session), null)
  assert.equal(projectedCwd(null), null)
})
