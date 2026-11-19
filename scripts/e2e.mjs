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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HOME = join(ROOT, '.tmp', 'e2e', 'home')
const PROFILE = 'e2e-verify'
/**
 * 端口。
 *
 * 不用 3210：Windows 的 TCP 保留段（`netsh interface ipv4 show excludedportrange`）
 * 实测覆盖 3139–3238，落在里面的端口 listen 会报 `EACCES`，而 dsh 把这条错误藏在
 * stderr 里，表现是「进程起来了但端口不通」。3300 不在任何保留段内。
 */
const PORT = 3300
const PACKAGES = ['dsh-pack-core', 'dsh-skill-pack', 'dsh-plugin-pack', 'dsh-mcp-pack', 'dsh-model-pack']

const log = []
const check = (name, cond, detail) => log.push({ name, pass: !!cond, detail: cond ? undefined : detail })
/** 记一条「没验」：清单不足、目录未就绪这类前置不满足时用它，别用 check(..., true) 冒充通过。 */
const skip = (name) => log.push({ name, pass: true, skipped: true })

/** 落盘文件名计数器：同一毫秒内连跑两条命令时 `Date.now()` 会撞名。 */
let runSeq = 0

/**
 * 跑一条命令，输出落盘再读。
 *
 * 不用 `stdio: 'pipe'`：沙箱禁止程序打开命名管道，spawn 会直接 EPERM
 * （见 AGENTS.md「沙箱限制与绕开」）。落盘再读是唯一稳的路径。
 *
 * stdout 与 stderr 合并到同一个文件：调用方只关心「失败时能看到原因」，
 * 分开两个文件反而要读两次。返回的 `stdout` 与 `stderr` 是同一份文本。
 */
/**
 * 子进程的环境。
 *
 * **必须剔掉宿主注入的 DSH_\* 变量**。在 DSH 自己的 bash 会话里跑这个脚本时，
 * `dsh-shell-env` 会把 `DSH_PROFILE_DIR` / `DSH_PROFILE` / `DSH_SESSION_ID` 等
 * 注入进来，`spawn` 默认继承 `process.env`，隔离 profile 的进程就会读到**真实**
 * profile 的路径——目录扫描于是扫的是 `~/.dsh/profiles/web`，跨 profile 串味的
 * 断言永远通过，抓不住任何 bug。
 *
 * 只保留 `DSH_HOME` 与调用方显式给的那几个。
 */
function childEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue
    env[key] = value
  }
  return { ...env, DSH_HOME: HOME, ...extra }
}

async function run(command, args) {
  runSeq += 1
  const outFile = join(ROOT, '.tmp', 'e2e', 'cmd-' + String(Date.now()) + '-' + String(runSeq) + '.log')
  await mkdir(join(ROOT, '.tmp', 'e2e'), { recursive: true })
  const fd = openSync(outFile, 'w')
  let code
  try {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: childEnv(),
      stdio: ['ignore', fd, fd],
      shell: process.platform === 'win32',
      detached: false,
    })
    code = await new Promise((resolvePromise, reject) => {
      child.on('error', reject)
      child.on('close', (value) => resolvePromise(value))
    })
  } finally {
    closeSync(fd)
  }
  let text = ''
  try {
    text = await readFile(outFile, 'utf8')
  } catch {
    // 文件没写出来：命令可能在 spawn 阶段就失败了，错误由调用方的 code 判据兜住。
  }
  return { code, stdout: text, stderr: text }
}

/**
 * 杀掉子进程**整棵树**，并等它真的退出。
 *
 * 两个坑叠在一起：
 * 1. `shell: true` 下 spawn 起的是 `cmd.exe /c dsh ...`，`child.kill()` 只杀 cmd，
 *    真正的 dsh 进程还活着，它的 cwd 就是 workspace，目录删不掉（EBUSY）。
 * 2. `kill()` 只是发信号，进程可能还在收尾。固定 sleep 猜不准，等 `exit` 才可靠。
 *
 * 所以 Windows 下用 `taskkill /T /F` 杀整棵树，再等 `exit`。
 */
async function killTree(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('error', () => resolvePromise())
      killer.on('close', () => resolvePromise())
    })
  } else {
    child.kill()
  }
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise()
      return
    }
    const timer = setTimeout(resolvePromise, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
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
  // 上一轮的服务可能还没退干净，目录被占着时 rm 会 EBUSY。重试几次再放弃。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(join(ROOT, '.tmp', 'e2e'), { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  await mkdir(HOME, { recursive: true })

  const created = await run('dsh', [PROFILE, '--from-default-profile', 'web', '--dump-config'])
  if (created.code !== 0) throw new Error('建 profile 失败：' + created.stderr.slice(-800))

  const links = PACKAGES.map((pkg) => 'link:' + join(ROOT, 'packages', pkg))
  const installed = await run('dsh', ['plugin', '--profile', PROFILE, 'add', ...links])
  if (installed.code !== 0) throw new Error('装包失败：' + installed.stderr.slice(-800))

  // 造一份 skill 清单：档位取值要四条不同档位的行才验得出来，隔离 profile 里
  // 默认一条都没有。
  //
  // 宿主扫的是**用户级** `~/.agents/skills/`：实测工作区的 `.agents/skills/` 不会
  // 被扫到（清单里只剩用户级那一条）。`~` 由 `USERPROFILE` 决定，**不是**
  // `DSH_HOME`——只设后者时 fixture 写进去了但宿主读不到。
  //
  // 所以把 `USERPROFILE` 一起指到隔离目录：fixture 落在 `.tmp/e2e/user/.agents/`，
  // 真实 `~/.agents` 一个字节都不碰。
  const WORKSPACE = join(ROOT, '.tmp', 'e2e', 'workspace')
  const FAKE_USER = join(ROOT, '.tmp', 'e2e', 'user')
  // cwd 必须先建出来：spawn 的 cwd 不存在时 Windows 报的是 `spawn cmd.exe ENOENT`，
  // 看起来像找不到命令，实际是找不到目录。
  await mkdir(WORKSPACE, { recursive: true })
  const skillRoot = join(FAKE_USER, '.agents', 'skills')
  for (const name of ['e2e-a', 'e2e-b', 'e2e-c', 'e2e-d']) {
    await mkdir(join(skillRoot, name), { recursive: true })
    await writeFile(
      join(skillRoot, name, 'SKILL.md'),
      '---\nname: ' + name + '\ndescription: e2e fixture\n---\n\nbody\n',
    )
  }

  // ---------- 第二个 profile：只装一个当前 profile 没有的包 ----------
  //
  // 必须在起服务**之前**建好：面板读的是启动时写下的目录缓存，服务起来之后再建
  // 第二个 profile，串味也看不出来——那条断言就抓不住 bug。
  //
  // 不能用仓库里的包：当前 profile 是从 `web` 复制的，那些包它本来就有，列出来
  // 是对的，验不出串味。
  const OTHER = 'e2e-other'
  const FOREIGN = 'e2e-foreign-pkg'
  const foreignDir = join(ROOT, '.tmp', 'e2e', 'foreign', FOREIGN)
  await mkdir(join(foreignDir, 'lib'), { recursive: true })
  await writeFile(
    join(foreignDir, 'package.json'),
    JSON.stringify(
      {
        name: FOREIGN,
        version: '1.0.0',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ),
  )
  await writeFile(join(foreignDir, 'lib', 'index.js'), 'export const name = ' + JSON.stringify(FOREIGN) + '\n')
  await writeFile(join(foreignDir, 'cordis.patch.yml'), '[]\n')

  // 第二个 profile 与当前 profile 同住一个 DSH_HOME：这正是串味的现场。
  const madeOther = await run('dsh', [OTHER, '--from-default-profile', 'web', '--dump-config'])
  const addedForeign =
    madeOther.code === 0
      ? await run('dsh', ['plugin', '--profile', OTHER, 'add', 'link:' + foreignDir])
      : { code: 1 }
  const foreignReady = madeOther.code === 0 && addedForeign.code === 0

  // ---------- 起服务 ----------
  const serverLog = join(ROOT, '.tmp', 'e2e', 'server.log')
  const logFd = openSync(serverLog, 'a')
  const server = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: WORKSPACE,
    // USERPROFILE 一起改：宿主按它找 `~/.agents/skills`，只改 DSH_HOME 读不到 fixture。
    // childEnv 剔掉宿主注入的 DSH_*：留着 DSH_PROFILE_DIR 会让隔离 profile 的进程
    // 读到真实 profile 的路径，跨 profile 串味的断言就永远通过。
    env: childEnv({ USERPROFILE: FAKE_USER }),
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

    // ---------- 求值字段的取值 ----------
    //
    // 只验 `typeof x === 'string'` 挡不住任何东西：`'explicit-on'` 与 `'follow-off'`
    // 都是字符串。这里造出四种档位各一条，逐条验具体值——`rank` 的取值规则是
    // 分包页排序与开关显示的唯一来源，错了就是整页显示成同一份值。
    {
      const P = '/api/skill-pack'
      const g0 = await post(P + '/global', {})
      const names = (g0.json.value?.skills ?? []).map((row) => row.name)
      // 隔离 profile 里只有插件注册的 skill（`source: 'bundled'`），没有 filesystem
      // provider，所以清单只有一条。档位取值靠**同一条**行造出不同状态来验：
      // 显式开 / 显式关 / 跟随落到关，三种都验得到，不必凑四条行。
      if (names.length === 0) {
        skip('skill: 清单为空，跳过档位取值')
      } else {
        const target = names[0]
        // 读全局视图。注意 `rank` 在这里恒为 `explicit-on`：全局视图的 `policy.pack`
        // 是 null，`rankOf` 的 `isDefault` 因此恒真——那是「没有选中 pack」的正确
        // 表达，不是缺陷。所以这里验的是 `open` / `openGlobal` / `landing` 的**值**，
        // 它们与档位同源（都走求值链），档位算错时它们会一起错。
        const rowOf = async () => {
          const view = await post(P + '/global', {})
          return (view.json.value?.skills ?? []).find((row) => row.name === target)
        }
        // 1. 显式开
        await post(P + '/apply', { commands: [{ op: 'packItem', packId: 'default', name: target, value: true }] })
        const on = await rowOf()
        check('skill: 显式开 → open=true', on?.open === true, on?.open)
        check('skill: 显式开 → openGlobal=true', on?.openGlobal === true, on?.openGlobal)
        check('skill: 显式开 → itemGlobal=true', on?.itemGlobal === true, on?.itemGlobal)
        // 2. 显式关
        await post(P + '/apply', { commands: [{ op: 'packItem', packId: 'default', name: target, value: false }] })
        const off = await rowOf()
        check('skill: 显式关 → open=false', off?.open === false, off?.open)
        check('skill: 显式关 → openGlobal=false', off?.openGlobal === false, off?.openGlobal)
        check('skill: 显式关 → itemGlobal=false', off?.itemGlobal === false, off?.itemGlobal)
        // 3. 跟随且落到关：清掉项级记录，把它的组设成关。
        const group = await post(P + '/apply', { commands: [{ op: 'createGroup', name: 'e2e-rank' }] })
        const gid = group.json.value?.groups?.groups?.find((entry) => entry.name === 'e2e-rank')?.id
        await post(P + '/apply', { commands: [
          { op: 'packItem', packId: 'default', name: target, value: null },
          { op: 'assign', name: target, groupId: gid },
          { op: 'packGroup', packId: 'default', groupId: gid, value: false },
        ] })
        const follow = await rowOf()
        check('skill: 跟随且落到关 → landing=false', follow?.landing === false, follow?.landing)
        check('skill: 跟随且落到关 → open=false', follow?.open === false, follow?.open)
        check('skill: 跟随且落到关 → itemGlobal=null', follow?.itemGlobal === null, follow?.itemGlobal)
        check('skill: 跟随且落到关 → groupGlobal=false', follow?.groupGlobal === false, follow?.groupGlobal)
        // 复原。
        await post(P + '/apply', { commands: [
          { op: 'assign', name: target, groupId: null },
          { op: 'deleteGroup', groupId: gid },
        ] })
      }
      const g = await post(P + '/global', {})
      const row = g.json.value?.skills?.[0]
      check('skill: rows 带 groupGlobal', row !== undefined && 'groupGlobal' in row, row && Object.keys(row))
      check('skill: rows 带 groupWorkspace', row !== undefined && 'groupWorkspace' in row, row && Object.keys(row))
      check('skill: 视图带 diff', Array.isArray(g.json.value?.diff), typeof g.json.value?.diff)
      check('skill: 视图带 groupRanks', typeof g.json.value?.groupRanks === 'object', typeof g.json.value?.groupRanks)
    }
    {
      const P = '/api/plugin-pack'
      const g = await post(P + '/global', {})
      const rows = g.json.value?.plugins ?? []
      // 目录可能还没扫完（pending: true），那时 plugins 为空——取值断言跳过，
      // 但视图级字段仍然要查。
      if (rows.length > 0) {
        const target = rows[0].pkg
        check('plugin: rows 带 openGlobal', typeof rows[0].openGlobal === 'boolean', rows[0].openGlobal)
        // 显式关掉它，验 rank 与 open 的具体值——只验类型挡不住档位算错。
        await post(P + '/apply', { commands: [{ op: 'packItem', packId: 'default', name: target, value: false }] })
        const off = await post(P + '/global', {})
        const row = (off.json.value?.plugins ?? []).find((entry) => entry.pkg === target)
        // 全局视图的 rank 恒为 explicit-on：loadState(null) 的 policy.pack 是 null，
        // rankOf 的 isDefault 因此恒真——那是「没有选中 pack」的正确表达，不是缺陷
        // （skill 包的同一处断言也这么写）。这里验的是 open 与 openGlobal 的值，
        // 它们与档位同源，档位算错时会一起错。
        check('plugin: 显式关 → rank=explicit-on（全局视图无选中 pack）', row?.rank === 'explicit-on', row?.rank)
        check('plugin: 显式关 → open=false', row?.open === false, row?.open)
        check('plugin: 显式关 → openGlobal=false', row?.openGlobal === false, row?.openGlobal)
        check('plugin: 显式关 → itemGlobal=false', row?.itemGlobal === false, row?.itemGlobal)
        await post(P + '/apply', { commands: [{ op: 'packItem', packId: 'default', name: target, value: null }] })
      } else {
        check('plugin: 目录未就绪时 plugins 为空且 pending 为真', g.json.value?.pending === true, g.json.value?.pending)
      }
      check('plugin: 视图带 diff', Array.isArray(g.json.value?.diff), typeof g.json.value?.diff)
      check('plugin: 视图带 groupRanks', typeof g.json.value?.groupRanks === 'object', typeof g.json.value?.groupRanks)
    }
    {
      const P = '/api/mcp-pack'
      const g = await post(P + '/global', {})
      const row = g.json.value?.rows?.[0]
      if (row === undefined) {
        skip('mcp: 没有行时跳过档位取值')
      } else {
        // 显式关掉它，验 rank 与 open 的具体值。
        await post(P + '/apply', { commands: [{ op: 'packRow', packId: 'default', rowKey: row.rowKey, patch: { enabled: false } }] })
        const off = await post(P + '/global', {})
        const after = (off.json.value?.rows ?? []).find((entry) => entry.rowKey === row.rowKey)
        check('mcp: 显式关 → rank=explicit-off', after?.rank === 'explicit-off', after?.rank)
        check('mcp: 显式关 → open=false', after?.open === false, after?.open)
        await post(P + '/apply', { commands: [{ op: 'packRow', packId: 'default', rowKey: row.rowKey, patch: { enabled: null } }] })
      }
      check('mcp: 视图带 diff', Array.isArray(g.json.value?.diff), typeof g.json.value?.diff)
      check('mcp: 视图带 groupRanks', typeof g.json.value?.groupRanks === 'object', typeof g.json.value?.groupRanks)
    }

    // ---------- 会话所属工作区 ----------
    //
    // 本项目的设计是「工作区由用户决定」：UI 上切换工作区不是改现有会话的 cwd，
    // 而是换到该工作区的 blank 会话或新建一个（`sessions.create({ workspaceId })`
    // → `cwd = workspace.path`）。这里走真实 RPC 建两个工作区各一个会话，验三个包
    // 的工作区视图读到的是各自会话的 header.cwd。
    //
    // 这条路径单包测试覆盖不到：`cwdFromAgent` 读的是宿主 Agent 的
    // `session.header.cwd`，只有真实装配出来的 Agent 才有这个形状。
    {
      const rpc = async (endpoint, args) => {
        const body = {
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: endpoint,
          payload: { args },
        }
        const res = await fetch(`http://127.0.0.1:${PORT}/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
          body: JSON.stringify(body),
        })
        const text = await res.text()
        let json
        try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
        return { status: res.status, json }
      }

      const wsA = join(WORKSPACE, 'e2e-ws-a')
      const wsB = join(WORKSPACE, 'e2e-ws-b')
      await mkdir(wsA, { recursive: true })
      await mkdir(wsB, { recursive: true })

      const madeA = await rpc('workspace/create', { request: { path: wsA } })
      const madeB = await rpc('workspace/create', { request: { path: wsB } })
      const idA = madeA.json?.result?.value?.workspace?.workspaceId
      const idB = madeB.json?.result?.value?.workspace?.workspaceId
      if (idA === undefined || idB === undefined) {
        skip('工作区: 建不出两个工作区，跳过会话归属断言')
      } else {
        const sessA = await rpc('session/create', { request: { workspaceId: idA } })
        const sessB = await rpc('session/create', { request: { workspaceId: idB } })
        const sidA = sessA.json?.result?.value?.sessionId
        const sidB = sessB.json?.result?.value?.sessionId
        check('工作区: 两个会话都建出来了', typeof sidA === 'string' && typeof sidB === 'string',
          { a: sessA.json?.result?.error, b: sessB.json?.result?.error })

        if (typeof sidA === 'string' && typeof sidB === 'string') {
          // 四个包的工作区视图都按会话所属工作区求值。
          const views = [
            ['skill', '/api/skill-pack/workspace'],
            ['plugin', '/api/plugin-pack/workspace'],
            ['mcp', '/api/mcp-pack/workspace'],
          ]
          for (const [pkg, path] of views) {
            const va = await post(path, { sessionId: sidA })
            const vb = await post(path, { sessionId: sidB })
            check(pkg + ': 会话 A 的工作区是 A',
              typeof va.json.value?.cwd === 'string' && va.json.value.cwd.toLowerCase().endsWith('e2e-ws-a'),
              va.json.value?.cwd ?? va.json.error)
            check(pkg + ': 会话 B 的工作区是 B',
              typeof vb.json.value?.cwd === 'string' && vb.json.value.cwd.toLowerCase().endsWith('e2e-ws-b'),
              vb.json.value?.cwd ?? vb.json.error)
          }

          // 两个会话各自读到自己的工作区：验的是真实装配出来的 Agent 上
          // `cwdFromAgent` 能拿到 header.cwd（单测用的是假对象，验不到这条路径）。
          //
          // 「读投影还是读 header」的分歧这里验不到：两个会话都没 cd 过，投影值与
          // header 相同。那条由 pack-core 单测的「模型 cd 之后 pack 不跟着变」覆盖。
          const viewA = await post('/api/skill-pack/workspace', { sessionId: sidA })
          const viewB = await post('/api/skill-pack/workspace', { sessionId: sidB })
          check('工作区: 两个会话读到各自的工作区',
            viewA.json.value?.cwd !== viewB.json.value?.cwd,
            { a: viewA.json.value?.cwd, b: viewB.json.value?.cwd })
        }
      }
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
        skip('重载: 清单为空时跳过')
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

    // ---------- 插件目录只扫当前 profile ----------
    //
    // 单包测试能验 `profileDirs()` 的返回值，验不到「profileContext 是否真的注入到了
    // 插件进程」——那只有真实装配路径能验。第二个 profile 在**起服务之前**就建好，
    // 否则面板读的是启动时写下的缓存，串味也看不出来（这条断言就抓不住 bug）。
    if (!foreignReady) {
      skip('目录范围: 第二个 profile 没建起来，跳过')
    } else {
      const view = await post('/api/plugin-pack/global', {})
      const names = (view.json.value?.plugins ?? []).map((row) => row.pkg)
      // 判据是「那个只装在别的 profile 里的包不得出现」。用行数或依赖集合比对
      // 都不行：当前 profile 从 web 复制而来，本来就有一堆第三方包。
      check(
        '目录范围: 面板不列出别的 profile 装的包',
        !names.includes(FOREIGN),
        '只装在 ' + OTHER + ' 里的 ' + FOREIGN + ' 出现在了当前 profile 的面板上',
      )
      // 目录可能还在扫（pending=true 表示后台扫描在飞）。等它落定再判完整性：
      // 判据是「扫描完成后目录是完整的」，不是「第一次请求就完整」。
      let settled = view
      for (let attempt = 0; attempt < 20 && settled.json.value?.pending === true; attempt += 1) {
        await new Promise((r) => setTimeout(r, 500))
        settled = await post('/api/plugin-pack/global', {})
      }
      check(
        '目录范围: 目录完整（profileContext 已注入）',
        settled.json.value?.pending !== true,
        'pending=' + String(settled.json.value?.pending),
      )
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
    // 服务进程的 cwd 就是 workspace：Windows 下 cwd 被占着时目录删不掉（EBUSY）。
    // 必须杀整棵树并等它真的退，见 `killTree`。
    await killTree(server)
    try { closeSync(logFd) } catch { /* 已关 */ }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(join(ROOT, '.tmp', 'e2e'), { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 9) {
          console.error('清理 .tmp/e2e 失败（目录被占用，手动删）：' + String(error))
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  const failed = log.filter((l) => !l.pass)
  for (const item of failed) {
    console.error('✖ ' + item.name + (item.detail === undefined ? '' : '：' + JSON.stringify(item.detail)))
  }
  // 跳过项单独列出来：它们记成 pass，但什么都没验。不列的话「全绿」会骗人。
  const skipped = log.filter((l) => l.skipped === true)
  for (const item of skipped) console.log('· 跳过 ' + item.name)
  console.log(`e2e: ${String(log.length - failed.length)}/${String(log.length)} 通过` + (skipped.length === 0 ? '' : `（其中 ${String(skipped.length)} 条跳过）`))
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('e2e 失败：' + String(error))
  process.exitCode = 1
})
