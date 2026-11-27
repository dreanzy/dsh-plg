import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingKeyOf } from '@dreanzy/dsh-pack-core'
import { loadClient } from '../../../scripts/test-helpers/panel.mjs'

/**
 * 客户端面板的测试面。
 *
 * 这里不测渲染（仓库没有 DOM 环境），测三件会被结构漂移破坏、又真能回归的东西：
 * 1. factory 的测试出口还在——替代 scripts/check-panels.mjs 里的字符串计数；
 * 2. `apply` 在服务缺失时不抛：它抛错会把 web boot 判成 entry failed，桌面端起不来；
 * 3. 待保存队列的键规则：同键后写覆盖，不可覆盖的命令不落格。
 *
 * 宿主全程是假的：vm 里只有一个捕获 factory 的 window，React 是桩。
 */
const CLIENT = new URL('../client/client.js', import.meta.url)

test('factory 暴露测试出口', () => {
  const { __internals } = loadClient(CLIENT)
  assert.ok(__internals, '缺少 __internals 测试出口')
  for (const name of ["pendingKey","usePending","TABS","GroupsPage","PackSettings","WorkspacePage","PendingBar","CHIP_CSS","listWorkspaceCwds"]) assert.ok(__internals[name], '测试出口缺少 ' + name)
})

test('apply 在服务缺失时只降级，不抛错', () => {
  const { apply } = loadClient(CLIENT)
  const ctx = {
    get() {
      throw new Error('service unavailable')
    },
    on() {
      return () => undefined
    },
    effect() {
      return undefined
    },
    slots: {
      inject(_name, callback) {
        callback()
        return () => undefined
      },
      register() {
        return () => undefined
      },
    },
  }
  assert.doesNotThrow(() => apply(ctx))
})

test('待保存键覆盖每一类可覆盖命令', () => {
  const { pendingKey } = loadClient(CLIENT).__internals
  assert.equal(typeof pendingKey, 'function')
  const CASES = [
    [{ op: 'packRow', packId: 'p1', rowKey: 'r1' }, 'packRow:p1:r1'],
    [{ op: 'packGroup', packId: 'p1', groupId: 'g1' }, 'packGroup:p1:g1'],
    // Windows 下 normalizeCwd 转小写：这条分支以前在沙箱里永远走不到。
    [{ op: 'bind', cwd: 'C:/w' }, 'bind:c:/w'],
    [{ op: 'assign', rowKey: 'r1' }, 'assign:r1'],
    [{ op: 'renamePack', packId: 'p1' }, 'renamePack:p1'],
    [{ op: 'renameGroup', groupId: 'g1' }, 'renameGroup:g1'],
    // 复制与新建同类：每条都是独立一次决定，没有可覆盖的目标。
    [{ op: 'duplicatePack', packId: 'p1' }, null],
  ]
  for (const [command, expected] of CASES) {
    assert.equal(pendingKey(command), expected)
    // bind 是唯一例外：客户端按归一化后的 cwd 算键（渲染处也按它查），服务端按原值
    // 算（归一化发生在落盘时）。其余 op 两边必须逐字相同，否则同一格改动不会被去重。
    if (command.op === 'bind') continue
    assert.equal(pendingKeyOf(command), expected, '服务端规则与客户端漂移了：' + String(command.op))
  }
  assert.equal(pendingKey({ op: 'unknown-op' }), null, '可覆盖之外的命令不落格')
})

test('待保存键在非 Windows 平台不转小写', () => {
  // 同一份用例跑两遍：win32 转小写、linux 不转。两边算出来的键必须与服务端一致，
  // 否则「这一行有没有未保存改动」在某个平台上永远为假。
  const { pendingKey } = loadClient(CLIENT, { platform: 'linux' }).__internals
  assert.equal(pendingKey({ op: 'bind', cwd: 'C:/w' }), 'bind:C:/w')
})

test('待保存队列：同键后写覆盖，键为 null 的命令各占一条', () => {
  const { createQueue, pendingKey } = loadClient(CLIENT).__internals
  const queue = createQueue(pendingKey)
  queue.push({ op: 'bind', cwd: 'C:/a' })
  queue.push({ op: 'bind', cwd: 'C:/a' })
  assert.equal(queue.count, 1, '同键必须覆盖，不是追加')
  queue.push({ op: 'createPack', packId: 'p1' })
  queue.push({ op: 'createPack', packId: 'p1' })
  assert.equal(queue.count, 3, '没有可覆盖目标的命令每条都独立')
  assert.equal(queue.keys().size, 1, '只有带键的条目进 keys')
  assert.equal(queue.commands().length, 3)
})

test('待保存队列：undo / discard / drop', () => {
  const { createQueue, pendingKey } = loadClient(CLIENT).__internals
  const queue = createQueue(pendingKey)
  queue.push([{ op: 'bind', cwd: 'C:/a' }, { op: 'createPack', packId: 'p1' }, { op: 'createPack', packId: 'p1' }])
  assert.equal(queue.count, 3)
  queue.undo()
  assert.equal(queue.count, 2)
  assert.equal(queue.drop((command) => command.packId === 'p1'), 1)
  assert.equal(queue.count, 1)
  assert.equal(queue.drop(() => true), 1)
  assert.equal(queue.count, 0)
  queue.push({ op: 'bind', cwd: 'C:/b' })
  queue.discard()
  assert.equal(queue.count, 0)
})

test('待保存队列：touch 换引用但不改内容，试算才会重跑', () => {
  const { createQueue, pendingKey } = loadClient(CLIENT).__internals
  const queue = createQueue(pendingKey)
  queue.push({ op: 'bind', cwd: 'C:/a' })
  const before = queue.entries
  const after = queue.touch()
  assert.notEqual(after, before, '引用必须换，否则 effect 不会重跑')
  assert.equal(queue.count, 1)
})

test('冻结排序：待保存期间沿用改动前的组名，未冻结时返回空表', () => {
  const { frozenGroupNames } = loadClient(CLIENT).__internals
  const base = { groups: { groups: [{ id: 'g1', name: 'alpha' }, { id: 'g2', name: 'beta' }] } }
  assert.equal(frozenGroupNames(base, false).size, 0, '未冻结时不提供回溯表')
  const map = frozenGroupNames(base, true)
  assert.equal(map.get('g1'), 'alpha')
  assert.equal(map.get('g2'), 'beta')
  assert.equal(frozenGroupNames(null, true).size, 0, '没有 base 也不能抛')
  assert.equal(frozenGroupNames({}, true).size, 0)
})

test('工作区清单按路径排序，与最近更新无关', async () => {
  const { listWorkspaceCwds } = loadClient(CLIENT).__internals
  const host = {
    remote: {
      session: {
        list: async () => ({
          ok: true,
          value: {
            items: [
              { sessionId: 's1', cwd: 'D:/work/Zeta', updatedAt: 300 },
              { sessionId: 's2', cwd: 'C:/Users/Ann', updatedAt: 100 },
              { sessionId: 's3', cwd: 'D:/work/Alpha', updatedAt: 200 },
              // 同一目录的另一种写法：只留一条，取最近更新的那条。
              { sessionId: 's4', cwd: 'd:/work/alpha', updatedAt: 50 },
            ],
          },
        }),
      },
    },
  }
  const cwds = await listWorkspaceCwds(host)
  assert.equal(cwds.join(','), 'C:/Users/Ann,D:/work/Alpha,D:/work/Zeta')
})

test('工作区清单截断按最近使用取舍，展示仍按路径', async () => {
  const { listWorkspaceCwds } = loadClient(CLIENT).__internals
  const items = []
  for (let index = 0; index < 31; index += 1) {
    items.push({ sessionId: 's' + index, cwd: 'C:/w/' + String(index).padStart(2, '0'), updatedAt: index })
  }
  const host = { remote: { session: { list: async () => ({ ok: true, value: { items } }) } } }
  const cwds = await listWorkspaceCwds(host)
  assert.equal(cwds.length, 30)
  assert.equal(cwds[0], 'C:/w/01', '最早用过的目录被截掉，剩下的仍从路径最小开始')
  assert.equal(cwds.includes('C:/w/00'), false)
})
