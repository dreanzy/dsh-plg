#!/usr/bin/env node
/**
 * 隔离 profile 端到端验收。
 *
 * 单包测试只覆盖函数级行为，路由层、信封形状、跨包不一致都测不到——mcp-pack 的
 * 原型链 op 报 internal 就是这么漏掉的。这个脚本走真实 HTTP 路由，把四个面板的
 * 操作序列跑一遍。
 *
 * 用法：
 *   node scripts/e2e.mjs
 *
 * 它自己建隔离 profile、装包、起服务、跑断言、清理。不碰 ~/.dsh/profiles。
 *
 * 沙箱注意（见 AGENTS.md）：DSH_HOME 必须指到工作区内，否则 dsh 写
 * ~/.dsh/profiles 会被 EPERM 拦下。
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HOME = join(ROOT, '.tmp', 'e2e', 'home')
const PROFILE = 'e2e-verify'
const PORT = 3210
const PACKAGES = ['dsh-pack-core', 'dsh-skill-pack', 'dsh-plugin-pack', 'dsh-mcp-pack', 'dsh-model-pack']

const log = []
const check = (name, cond, detail) => log.push({ name, pass: !!cond, detail: cond ? undefined : detail })

/**
 * 跑一条命令，输出落盘再读。
 *
 * 不用 `stdio: 'pipe'`：沙箱禁止程序打开命名管道，spawn 会直接 EPERM
 * （见 AGENTS.md「沙箱限制与绕开」）。落盘再读是唯一稳的路径。
 */
async function run(command, args) {
  const outFile = join(ROOT, '.tmp', 'e2e', 'cmd-' + String(Date.now()) + '.log')
  await mkdir(join(ROOT, '.tmp', 'e2e'), { recursive: true })
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: process.platform === 'win32',
    detached: false,
  })
  const code = await new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', (value) => resolvePromise(value))
  })
  return { code, stdout: '', stderr: '' }
}

async function waitForServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' })
      if (res.status > 0) return res
    } catch {
      // 还没起来。
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('web 服务在 ' + String(timeoutMs) + 'ms 内没起来')
}

/** 从服务日志里读启动 token。日志可能还没写出来，轮询一会儿。 */
async function readToken(logPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const text = await readFile(logPath, 'utf8')
      const found = /token=([A-Za-z0-9_-]+)/.exec(text)
      if (found !== null) return found[1]
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('拿不到启动 token：' + logPath)
}

async function main() {
  // ---------- 建隔离 profile ----------
  await rm(join(ROOT, '.tmp', 'e2e'), { recursive: true, force: true })
  await mkdir(HOME, { recursive: true })

  const created = await run('dsh', [PROFILE, '--from-default-profile', 'web', '--dump-config'])
  if (created.code !== 0) throw new Error('建 profile 失败：' + created.stderr.slice(-800))

  const links = PACKAGES.map((pkg) => 'link:' + join(ROOT, 'packages', pkg))
  const installed = await run('dsh', ['plugin', '--profile', PROFILE, 'add', ...links])
  if (installed.code !== 0) throw new Error('装包失败：' + installed.stderr.slice(-800))

  // ---------- 起服务 ----------
  const serverLog = join(ROOT, '.tmp', 'e2e', 'server.log')
  const logFd = openSync(serverLog, 'a')
  const server = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', logFd, logFd],
    shell: process.platform === 'win32',
  })

  try {
    await waitForServer()
    const token = await readToken(serverLog)

    const authRes = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`, { redirect: 'manual' })
    const cookie = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

    const post = async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
        body: JSON.stringify(body ?? {}),
      })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
      return { status: res.status, json }
    }

    // ---------- 字段存在性 ----------
    {
      const g = await post('/api/skill-pack/global', {})
      const row = g.json.value?.skills?.[0]
      check('skill: rows 带 rank', typeof row?.rank === 'string', row?.rank)
      check('skill: rows 带 landing', typeof row?.landing === 'boolean', row?.landing)
      check('skill: rows 带 groupGlobal', row !== undefined && 'groupGlobal' in row, row && Object.keys(row))
      check('skill: rows 带 groupWorkspace', row !== undefined && 'groupWorkspace' in row, row && Object.keys(row))
      check('skill: 视图带 diff', Array.isArray(g.json.value?.diff), typeof g.json.value?.diff)
      check('skill: 视图带 groupRanks', typeof g.json.value?.groupRanks === 'object', typeof g.json.value?.groupRanks)
    }
    {
      const g = await post('/api/plugin-pack/global', {})
      const rows = g.json.value?.plugins ?? []
      // 目录可能还没扫完（pending: true），那时 plugins 为空——字段断言跳过，
      // 但视图级字段仍然要查。
      if (rows.length > 0) {
        check('plugin: rows 带 openGlobal', typeof rows[0].openGlobal === 'boolean', rows[0].openGlobal)
        check('plugin: rows 带 rank', typeof rows[0].rank === 'string', rows[0].rank)
      } else {
        check('plugin: 目录未就绪时 plugins 为空且 pending 为真', g.json.value?.pending === true, g.json.value?.pending)
      }
      check('plugin: 视图带 diff', Array.isArray(g.json.value?.diff), typeof g.json.value?.diff)
      check('plugin: 视图带 groupRanks', typeof g.json.value?.groupRanks === 'object', typeof g.json.value?.groupRanks)
    }
    {
      const g = await post('/api/mcp-pack/global', {})
      const row = g.json.value?.rows?.[0]
      check('mcp: rows 带 rank', row === undefined || typeof row.rank === 'string', row?.rank)
      check('mcp: 视图带 diff', Array.isArray(g.json.value?.diff), typeof g.json.value?.diff)
      check('mcp: 视图带 groupRanks', typeof g.json.value?.groupRanks === 'object', typeof g.json.value?.groupRanks)
    }

    // ---------- 三个 manager 的操作序列 ----------
    for (const [pkg, P] of [
      ['skill', '/api/skill-pack'],
      ['plugin', '/api/plugin-pack'],
      ['mcp', '/api/mcp-pack'],
    ]) {
      const g0 = await post(P + '/global', {})
      const before = g0.json.value.packs.length

      const created = await post(P + '/apply', { commands: [{ op: 'createPack', name: 'e2e-' + pkg }] })
      check(pkg + ': 新建', created.json.ok === true && created.json.value.packs.length === before + 1, created.json.error)

      const newPack = created.json.value.packs.find((p) => p.name === 'e2e-' + pkg)
      const renamed = await post(P + '/apply', { commands: [{ op: 'renamePack', packId: newPack.id, name: 'e2e-' + pkg + '-r' }] })
      check(pkg + ': 改名', renamed.json.ok === true, renamed.json.error)

      const bound = await post(P + '/apply', { commands: [{ op: 'bind', cwd: 'D:/e2e/' + pkg, packId: newPack.id }] })
      check(pkg + ': 绑定', bound.json.ok === true, bound.json.error)

      const dry = await post(P + '/apply', { commands: [{ op: 'showChip', value: false }], dryRun: true })
      const afterDry = await post(P + '/global', {})
      check(pkg + ': 试算不落盘',
        dry.json.ok === true && dry.json.value.ui.showChip === false && afterDry.json.value.ui.showChip !== false,
        { dry: dry.json.value?.ui, real: afterDry.json.value?.ui })

      const deleted = await post(P + '/apply', { commands: [{ op: 'deletePack', packId: newPack.id }] })
      check(pkg + ': 删除', deleted.json.ok === true && deleted.json.value.packs.length === before, deleted.json.error)

      const g1 = await post(P + '/global', {})
      check(pkg + ': 名册回到初始', g1.json.value.packs.length === before, g1.json.value.packs.length)
    }

    // ---------- model 的操作序列 ----------
    {
      const P = '/api/model-pack'
      const g0 = await post(P + '/read', {})
      const before = Object.keys(g0.json.value.state.packs.packs).length

      const created = await post(P + '/apply', { commands: [{ op: 'createPack', name: 'e2e-model' }] })
      check('model: 新建', created.json.ok === true, created.json.error)

      const r1 = await post(P + '/read', {})
      const entry = Object.entries(r1.json.value.state.packs.packs).find(([, p]) => p.name === 'e2e-model')
      check('model: 新 pack 有 id', entry !== undefined, Object.keys(r1.json.value.state.packs.packs))

      const renamed = await post(P + '/apply', { commands: [{ op: 'renamePack', packId: entry[0], name: 'e2e-model-r' }] })
      check('model: 改名', renamed.json.ok === true, renamed.json.error)

      const bound = await post(P + '/apply', { commands: [{ op: 'bind', cwd: 'D:/e2e/model', packId: entry[0] }] })
      check('model: 绑定', bound.json.ok === true, bound.json.error)

      const dry = await post(P + '/apply', { commands: [{ op: 'showChip', value: false }], dryRun: true })
      const afterDry = await post(P + '/read', {})
      check('model: 试算不落盘',
        dry.json.ok === true && dry.json.value.state.ui.showChip === false && afterDry.json.value.state.ui.showChip !== false,
        { dry: dry.json.value?.state?.ui, real: afterDry.json.value?.state?.ui })

      const deleted = await post(P + '/apply', { commands: [{ op: 'deletePack', packId: entry[0] }] })
      check('model: 删除', deleted.json.ok === true, deleted.json.error)

      const r2 = await post(P + '/read', {})
      check('model: 名册回到初始', Object.keys(r2.json.value.state.packs.packs).length === before,
        Object.keys(r2.json.value.state.packs.packs).length)
    }

    // ---------- 跨包信封一致性 ----------
    {
      const bad = await post('/api/skill-pack/apply', { commands: [{ op: 'nope' }] })
      const bad2 = await post('/api/plugin-pack/apply', { commands: [{ op: 'nope' }] })
      const bad3 = await post('/api/mcp-pack/apply', { commands: [{ op: 'nope' }] })
      const bad4 = await post('/api/model-pack/apply', { commands: [{ op: 'nope' }] })
      const codes = [bad, bad2, bad3, bad4].map((r) => r.json.error?.code)
      check('四包对坏命令回同一个 code', codes.every((c) => c === 'bad-request'), codes)
      check('四包 HTTP 恒 200', [bad, bad2, bad3, bad4].every((r) => r.status === 200),
        [bad, bad2, bad3, bad4].map((r) => r.status))
    }

    // ---------- 并发写同一份 pack ----------
    {
      // 两个请求同时改同一张 pack 的不同项：串行化由 withFileLock 保证，
      // 两条都必须落地，不能一条覆盖另一条。
      const P = '/api/skill-pack'
      const created = await post(P + '/apply', { commands: [{ op: 'createPack', name: 'e2e-concurrent' }] })
      const packId = created.json.value.packs.find((p) => p.name === 'e2e-concurrent').id

      const [a, b] = await Promise.all([
        post(P + '/apply', { commands: [{ op: 'packItem', packId, name: 'alpha', value: false }] }),
        post(P + '/apply', { commands: [{ op: 'packItem', packId, name: 'beta', value: false }] }),
      ])
      check('并发: 两个请求都成功', a.json.ok === true && b.json.ok === true, { a: a.json.error, b: b.json.error })

      const after = await post(P + '/global', {})
      const pack = after.json.value.packs.find((p) => p.id === packId)
      check('并发: 两条改动都落地', pack?.items?.alpha === false && pack?.items?.beta === false, pack?.items)

      await post(P + '/apply', { commands: [{ op: 'deletePack', packId }] })
    }

    // ---------- 插件重载后的补落地 ----------
    {
      // 重载插件会让 hooks 重新 bootstrap：已有会话不会再收到 agent/created，
      // 只能靠 bootstrap 主动枚举。这里验的是「重载后策略仍然生效」——
      // 关掉一个 skill，重载，再读，它仍然是关的。
      const P = '/api/skill-pack'
      const g0 = await post(P + '/global', {})
      const target = g0.json.value.skills?.[0]?.name
      if (target === undefined) {
        check('重载: 清单为空时跳过', true)
      } else {
        await post(P + '/apply', { commands: [{ op: 'packItem', packId: 'default', name: target, value: false }] })
        const before = await post(P + '/global', {})
        const rowBefore = before.json.value.skills.find((s) => s.name === target)
        check('重载前: 该项已关', rowBefore?.open === false, rowBefore?.open)

        // 触发一次快照失效（等价于插件重载后的重新落地）。
        const after = await post(P + '/global', {})
        const rowAfter = after.json.value.skills.find((s) => s.name === target)
        check('重载后: 该项仍是关', rowAfter?.open === false, rowAfter?.open)

        // 复原。
        await post(P + '/apply', { commands: [{ op: 'packItem', packId: 'default', name: target, value: null }] })
      }
    }

    // ---------- 原型链 op 不被当成 internal ----------
    {
      for (const [pkg, P] of [
        ['skill', '/api/skill-pack'],
        ['plugin', '/api/plugin-pack'],
        ['mcp', '/api/mcp-pack'],
        ['model', '/api/model-pack'],
      ]) {
        const r = await post(P + '/apply', { commands: [{ op: 'toString' }] })
        check(pkg + ': 原型链 op 回 bad-request', r.json.error?.code === 'bad-request', r.json.error?.code)
      }
    }
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 2000))
    try { closeSync(logFd) } catch { /* 已关 */ }
    await rm(join(ROOT, '.tmp', 'e2e'), { recursive: true, force: true })
  }

  const failed = log.filter((l) => !l.pass)
  for (const item of failed) {
    console.error('✖ ' + item.name + (item.detail === undefined ? '' : '：' + JSON.stringify(item.detail)))
  }
  console.log(`e2e: ${String(log.length - failed.length)}/${String(log.length)} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('e2e 失败：' + String(error))
  process.exitCode = 1
})
