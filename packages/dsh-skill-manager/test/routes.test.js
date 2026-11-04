import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleApply, handleGlobal, parseCommands } from '../lib/routes.js'

const rows = [
  { name: 'alpha', description: 'a', provider: 'filesystem', source: 'custom', path: '/x/alpha/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'beta', description: 'b', provider: 'filesystem', source: 'custom', path: '/x/beta/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'cordis-x', description: 'c', provider: 'filesystem', source: 'custom', path: '/p/node_modules/@deepseek-ai/pkg/skills/cordis-x/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } },
]

function fakeSkills(list = rows) {
  return {
    async snapshot() {
      return { skills: list, complete: true }
    },
    async get(name) {
      return { content: `body of ${name}` }
    },
    register() {
      return () => {}
    },
  }
}

function fakeCtx(skills) {
  return {
    get: (name) => (name === 'skills' ? skills : undefined),
    logger: { warn() {} },
  }
}

async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsm-routes-'))
  process.env['DSH_HOME'] = home
  await mkdir(join(home, 'skill-manager'), { recursive: true })
  return home
}

test('parseCommands 拒绝非法形状', () => {
  assert.equal(parseCommands(undefined).ok, false)
  assert.equal(parseCommands([]).ok, false)
  assert.equal(parseCommands([{ op: 'nope' }]).ok, false)
  assert.equal(parseCommands([{ op: 'item', layer: 'global', name: 'x', value: 'yes' }]).ok, false)
  assert.equal(parseCommands([{ op: 'item', layer: 'x', name: 'x', value: true }]).ok, false)
  assert.equal(parseCommands([{ op: 'assign', name: 'x', groupId: 5 }]).ok, false)
})

test('parseCommands 接受每种合法命令', () => {
  const parsed = parseCommands([
    { op: 'item', layer: 'global', name: 'alpha', value: false },
    { op: 'item', layer: 'workspace', name: 'beta', value: null },
    { op: 'group', layer: 'global', groupId: 'g1', value: true },
    { op: 'assign', name: 'alpha', groupId: null },
    { op: 'createGroup', name: '新组' },
    { op: 'renameGroup', groupId: 'g1', name: '改名' },
    { op: 'deleteGroup', groupId: 'g1' },
    { op: 'showOfficialSkills', value: true },
    { op: 'showSidebarEntry', value: false },
  ])
  assert.equal(parsed.ok, true)
  // 这条数目断言是刻意的：新增一种命令却忘了登记进 OPS 白名单时，
  // 它会被当成未知操作拒掉，而只测「合法输入仍合法」是发现不了的。
  assert.equal(parsed.commands.length, 9)
})

test('全局面板默认不列官方技能，打开开关后列出', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())

  const off = await handleGlobal(ctx)
  assert.equal(off.ok, true)
  assert.deepEqual(off.value.skills.map((row) => row.name), ['alpha', 'beta'])

  await writeFile(join(home, 'skill-manager', 'global.json'), JSON.stringify({ ui: { showOfficialSkills: true } }))
  const on = await handleGlobal(ctx)
  assert.deepEqual(on.value.skills.map((row) => row.name), ['alpha', 'beta', 'cordis-x'])
  assert.equal(on.value.skills[2].official, true)
})

test('全局关掉的项在行里体现为 openGlobal=false', async () => {
  const home = await freshHome()
  await writeFile(join(home, 'skill-manager', 'global.json'), JSON.stringify({ items: { alpha: false } }))
  const view = await handleGlobal(fakeCtx(fakeSkills()))
  const alpha = view.value.skills.find((row) => row.name === 'alpha')
  assert.equal(alpha.openGlobal, false)
  assert.equal(alpha.itemGlobal, false)
})

test('apply 写盘后返回新状态，且意图不互相覆盖', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const deps = { reapply: async () => {}, stuck: () => [] }

  const first = await handleApply(ctx, { commands: [{ op: 'item', layer: 'global', name: 'alpha', value: false }] }, deps)
  assert.equal(first.ok, true)

  const second = await handleApply(ctx, { commands: [{ op: 'item', layer: 'global', name: 'beta', value: false }] }, deps)
  assert.equal(second.ok, true)

  const onDisk = JSON.parse(await readFile(join(home, 'skill-manager', 'global.json'), 'utf8'))
  assert.deepEqual(onDisk.items, { alpha: false, beta: false })
})

test('工作区命令缺少 sessionId 时拒绝，且不落盘', async () => {
  const home = await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const deps = { reapply: async () => {}, stuck: () => [] }
  const result = await handleApply(
    ctx,
    { commands: [{ op: 'item', layer: 'workspace', name: 'alpha', value: false }] },
    deps,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown-session')
  const exists = await readFile(join(home, 'skill-manager', 'global.json'), 'utf8').then(
    () => true,
    () => false,
  )
  assert.equal(exists, false)
})

test('reapply 失败不会把已成功的写入报成失败', async () => {
  await freshHome()
  const ctx = fakeCtx(fakeSkills())
  const deps = {
    reapply: async () => {
      throw new Error('boom')
    },
    stuck: () => [],
  }
  const result = await handleApply(ctx, { commands: [{ op: 'item', layer: 'global', name: 'alpha', value: false }] }, deps)
  assert.equal(result.ok, true)
})
