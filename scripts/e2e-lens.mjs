#!/usr/bin/env node
/**
 * lsp-lens 的行为级端到端验收。
 *
 * 与 `e2e.mjs`（装配层）互补：这里用**假模型**产生一次真实的 `write` 工具调用，
 * 断言诊断回灌真的进了会话上下文。假模型是 Anthropic Messages 协议的本地服务，
 * 通过 `DEEPSEEK_BASE_URL` 指过去，不需要任何 API key。
 *
 * 依赖真实 web profile 里的 `dsh-lsp-actions`（语言服务器与它自己的客户端都在那边）。
 * 该目录不存在时整体跳过并退出 0——CI 上没有它，跳过比假绿好。
 *
 * 用法：node scripts/e2e-lens.mjs
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASE = join(ROOT, '.tmp', 'e2e-lens')
const HOME = join(BASE, 'home')
const WORK = join(BASE, 'workspace')
const PROFILE = 'lens-e2e'
const PORT = 3500
const WEB_PROFILE = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web')
const LSP_ACTIONS = join(WEB_PROFILE, 'node_modules', 'dsh-lsp-actions')
const WEB_PATCH = join(WEB_PROFILE, 'cordis.patch.yml')

const failures = []
const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }) }

/** 子进程环境：剔掉宿主注入的 DSH_*，只留隔离 HOME 与假模型地址。 */
function childEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_') || key.startsWith('DEEPSEEK_')) continue
    env[key] = value
  }
  return { ...env, DSH_HOME: HOME, ...extra }
}

let seq = 0
async function run(command, args, env = {}, cwd = ROOT) {
  seq += 1
  const outFile = join(BASE, 'cmd-' + String(seq) + '.log')
  await mkdir(BASE, { recursive: true })
  const fd = openSync(outFile, 'w')
  let code
  try {
    const child = spawn(command, args, { cwd, env: childEnv(env), stdio: ['ignore', fd, fd], shell: process.platform === 'win32' })
    code = await new Promise((r, j) => { child.on('error', j); child.on('close', r) })
  } finally { closeSync(fd) }
  let text = ''
  try { text = await readFile(outFile, 'utf8') } catch { text = '' }
  return { code, text }
}

/** 假模型：第一次返回 write 的 tool_use，拿到 tool_result 后返回结束文本。 */
function startFakeModel(target) {
  let turn = 0
  const send = (res, event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed = {}
      try { parsed = body === '' ? {} : JSON.parse(body) } catch { parsed = {} }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const hasToolResult = messages.some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === 'tool_result'))
      // 轮次不能按请求计数：会话标题也会走这里，一条无关请求就会把轮次带偏。
      // 按「最后一条 tool_use 是谁」判定，标题请求落在首轮分支、返回的 tool_use 被丢弃。
      let toolResults = 0
      for (const message of messages) {
        if (!Array.isArray(message?.content)) continue
        for (const block of message.content) if (block?.type === 'tool_result') toolResults += 1
      }
      turn += 1
      const toolUse = (name, input) => {
        send(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + String(turn), name, input: {} } })
        send(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
        send(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        send(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
      }
      const emitText = () => {
        send(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
        send(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        send(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
      }
      const emit = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        send(res, 'message_start', { type: 'message_start', message: { id: 'msg_' + String(turn), type: 'message', role: 'assistant', content: [], model: 'fake', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        if (!hasToolResult) {
          // 1. 写一个必然有类型错误的文件。
          if (target === '') { emitText() } else {
            toolUse('write', { file_path: target, content: 'const fakeProbe: number = "fake"\\nexport { fakeProbe }\\n' })
          }
        } else if (toolResults === 1) {
          // 2. 直接调一次 lsp_diagnostics：第一次诊断要冷启动 typescript-language-server
          //    与 tsserver（数秒），这一步把服务器焐热。
          toolUse('lsp_diagnostics', { file_path: target })
        } else if (toolResults === 2) {
          // 3. 读回同一文件：fs/observed 会再观测到它，但版本没变，
          //    seen 应当挡住重复诊断——这正是「同一版本只回灌一次」的验收点。
          toolUse('read', { file_path: target })
        } else {
          emitText()
        }
        send(res, 'message_stop', { type: 'message_stop' })
        res.end()
      }
      // 预热那一轮拖 2.6s：真实会话里模型请求本身就要几秒，这里把它显式化，
      // 否则本地假模型 20ms 一步，跨步异步的诊断永远追不上。
      if (hasToolResult && toolResults <= 2) setTimeout(emit, 2600)
      else emit()
    })
  })
  return new Promise((resolvePromise) => server.listen(PORT, '127.0.0.1', () => resolvePromise(server)))
}

/** 递归找会话转录。 */
async function transcripts(dir) {
  const out = []
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await transcripts(full)))
    else if (entry.name.endsWith('.zstd')) out.push(full)
  }
  return out
}

/** 从 web profile 的 patch 里取 lsp-actions 那一段，包成 insert。 */
async function lspActionsPatch() {
  const text = await readFile(WEB_PATCH, 'utf8')
  const start = text.indexOf('- id: lsp-actions')
  if (start < 0) return null
  const rest = text.slice(start)
  const next = rest.indexOf('\n- id: ', 5)
  const block = next < 0 ? rest : rest.slice(0, next)
  const indented = block.trimEnd().split('\n').map((line) => '    ' + line).join('\n')
  // 验收关心的是「回灌能不能发生」，不是等多久：把 settle 压到 400ms，
  // 让诊断在下一步之前落定。生产配置仍是默认 2000。
  const fast = indented.replace(/\n( +)typescript:\n/, '\n$1typescript:\n$1  diagnosticsSettleMs: 1500\n')
  return '- insert:\n' + fast + '\n'
}

async function main() {
  if (!existsSync(LSP_ACTIONS)) {
    console.log('e2e-lens: 跳过（本机没有 ' + LSP_ACTIONS + '）')
    return
  }
  const patch = await lspActionsPatch()
  if (patch === null) {
    console.log('e2e-lens: 跳过（web profile 的 patch 里没有 lsp-actions 段）')
    return
  }

  await rm(BASE, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })
  await mkdir(HOME, { recursive: true })

  const made = await run('dsh', [PROFILE, '--from-default-profile', 'headless', '--dump-config'])
  check('建隔离 headless profile', made.code === 0, made.text.slice(-400))
  if (made.code !== 0) throw new Error('建 profile 失败')

  const added = await run('dsh', ['plugin', '--profile', PROFILE, 'add', 'link:' + join(ROOT, 'packages', 'dsh-lsp-lens')])
  check('装 lsp-lens', added.code === 0, added.text.slice(-400))
  const addedActions = await run('dsh', ['plugin', '--profile', PROFILE, 'add', 'link:' + LSP_ACTIONS])
  check('装 lsp-actions', addedActions.code === 0, addedActions.text.slice(-400))

  await writeFile(join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), patch)

  const target = join(WORK, 'probe.ts')
  const server = await startFakeModel(target)
  try {
    const ran = await run('dsh', [PROFILE, 'write the probe file'], {
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + String(PORT),
      DEEPSEEK_API_KEY: 'fake-key',
      LSP_LENS_DEBUG: join(BASE, 'debug.log'),
    }, WORK)
    check('headless 跑完', ran.code === 0, ran.text.slice(-600))

    const files = (await transcripts(join(HOME, 'sessions'))).sort()
    let feedbackCount = 0
    let pending = false
    for (const file of files) {
      const text = zstdDecompressSync(await readFile(file)).toString('utf8')
      feedbackCount += (text.match(/dsh-lsp-lens:feedback/g) ?? []).length
      if (text.includes('🔴 Pending')) pending = true
    }
    check('回灌进入会话上下文', feedbackCount > 0, '会话里没有 Diagnostic feedback')
    check('回灌包含真实诊断', pending, '会话里没有 Pending 条目')
    check('同一版本只回灌一次', feedbackCount === 1, 'feedback 出现 ' + String(feedbackCount) + ' 次')
  } finally {
    await new Promise((r) => server.close(r))
  }

  if (failures.length > 0) {
    for (const item of failures) console.error('✖ ' + item.name + '：' + String(item.detail))
    console.error('e2e-lens: 失败 ' + String(failures.length) + ' 条')
    process.exitCode = 1
  } else {
    console.log('e2e-lens: 通过')
  }
}

main()
  .catch((error) => { console.error('e2e-lens 失败：' + String(error)); process.exitCode = 1 })
  .finally(async () => {
    // 失败时保留现场：转录与调试日志是唯一的证据。
    if (failures.length > 0) { console.error('e2e-lens: 现场保留在 ' + BASE); return }
    try { await rm(BASE, { recursive: true, force: true }) } catch { /* 目录被占时留给人删 */ }
  })
