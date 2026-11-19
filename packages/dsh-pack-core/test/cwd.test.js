import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cwdFromAgent, cwdFromObserved } from '../lib/cwd.js'

/**
 * 会话所属工作区。
 *
 * 权威值是 `header.cwd`：会话创建时的工作区路径，创建后不可变。宿主把它声明为
 * `readonly`，`workspace.attachSession` 也按它校验归属。
 *
 * 复现的 bug：曾经改读 `workingDirectory` 投影，理由是「切换工作区只改投影」。
 * 那个前提不成立——UI 切换工作区是换到该工作区的 blank 会话或新建一个
 * （`sessions.create({ workspaceId })` → `cwd = workspace.path`），header.cwd 就是新
 * 工作区。投影只被 `working_directory` 工具（模型调用 `cd`）改写，读它等于让模型
 * 一次 `cd` 就把 pack 换掉，与面板 chip 显示的内容不一致。
 */

/** 宿主 `Session` 的最小形状：只有 header。 */
function sessionWith(cwd) {
  return { header: cwd === undefined ? {} : { cwd } }
}

test('按 header.cwd 求值', () => {
  assert.equal(cwdFromAgent({ session: sessionWith('D:/current') }), 'D:/current')
})

test('header 没有 cwd 时返回 null', () => {
  assert.equal(cwdFromAgent({ session: sessionWith(undefined) }), null)
  assert.equal(cwdFromAgent({ session: { header: {} } }), null)
})

test('拿不到会话时返回 null', () => {
  assert.equal(cwdFromAgent(undefined), null)
  assert.equal(cwdFromAgent({}), null)
  assert.equal(cwdFromAgent({ session: null }), null)
})

test('空串按缺失处理', () => {
  assert.equal(cwdFromAgent({ session: sessionWith('') }), null)
})

test('模型 cd 之后 pack 不跟着变：投影值被忽略', () => {
  // 宿主 Session 上没有 projections 成员；即便有人塞了一个，也不该被读。
  // 这条断言挡住「改回读投影」的回归。
  const agent = {
    session: {
      header: { cwd: 'C:/created' },
      projections: { faceOf: () => ({ getSnapshot: () => 'D:/after-cd' }) },
    },
    ctx: {
      sessionProjections: {
        snapshot: () => ({ asOfSeq: 0, values: { workingDirectory: 'D:/after-cd' } }),
      },
    },
  }
  assert.equal(cwdFromAgent(agent), 'C:/created', '工作区由用户决定，模型 cd 不该改变它')
})

test('观察快照同样按 header 求值，与 live 路径同口径', () => {
  const observed = {
    header: { cwd: 'C:/created' },
    projections: { values: { workingDirectory: 'D:/after-cd' } },
  }
  assert.equal(cwdFromObserved(observed), 'C:/created')
  assert.equal(cwdFromObserved({ header: { cwd: 'C:/created' } }), 'C:/created')
  assert.equal(cwdFromObserved({}), null)
})
