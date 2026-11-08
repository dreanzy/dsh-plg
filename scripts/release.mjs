#!/usr/bin/env node
/**
 * 发布四个包，并清掉 npm 12 的 staged publishing 占位版本。
 *
 * npm 11.6 起，`npm publish` 会先推一个 `0.0.0-stage` 占位包占住包名，再推真实
 * 版本。占位包没有命令行开关能关掉，只能发布后删。这个脚本把「发布 → 等真实版本
 * 上线 → 删占位版本」串成一步，避免每次手动补一刀。
 *
 * 发布失败或等待超时时，交互式询问重试还是退出。非 TTY 环境（CI）直接退出，
 * 不阻塞。
 *
 * 用法：
 *   node scripts/release.mjs                 发布全部四个包
 *   node scripts/release.mjs dsh-plugin-pack 只发一个
 *   node scripts/release.mjs --dry-run       只打印将要做什么
 *   node scripts/release.mjs --yes           失败时不询问，直接退出
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PLACEHOLDER = '0.0.0-stage'
const REGISTRY = 'https://registry.npmjs.org'
const POLL_INTERVAL_MS = 5000
/**
 * 等待上线的时间上限。staged publishing 的审核不是毫秒级的事：实测
 * mcp-pack 与 skill-pack 都在 60 秒后才出现在 registry 上，npm 侧的
 * staged 队列偶尔要十几分钟。默认给 5 分钟，够用又不至于让人干等。
 */
const POLL_TIMEOUT_MS = Number(process.env.DSH_PUBLISH_TIMEOUT_MS ?? 300000)
/**
 * npm 的调用方式。Windows 上直接 spawn `npm.cmd` 会 EINVAL（Node 20+ 禁止
 * 不经 shell 执行 .cmd），所以统一走 node + npm-cli.js，跨平台且不依赖 shell。
 * 路径从 npm 自己的安装位置推导，不写死。
 */
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const assumeYes = args.includes('--yes')
const only = args.filter((a) => !a.startsWith('-'))

/** 仓库里所有可发布的包，按目录名。 */
const ALL = ['dsh-plugin-pack', 'dsh-mcp-pack', 'dsh-skill-pack', 'dsh-model-pack']

/** 能否交互：非 TTY 或 --yes 时一律不询问。 */
const interactive = process.stdin.isTTY === true && !assumeYes

/** 跑 npm 子命令。Windows 上必须经 node + npm-cli.js，直接 spawn .cmd 会 EINVAL。 */
function npm(npmArgs, options = {}) {
  return run(process.execPath, [NPM_CLI, ...npmArgs], options)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  return result
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
}

/** registry 上这个包的全部版本，取不到时返回空数组。 */
async function publishedVersions(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`
  const response = await fetch(url)
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`registry 返回 ${response.status}：${url}`)
  const body = await response.json()
  return Object.keys(body.versions ?? {})
}

/** 等到真实版本出现在 registry 上。staged publishing 是异步的，PUT 返回 202 不代表已上线。 */
async function waitForVersion(name, version) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await publishedVersions(name)).includes(version)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

/** 从 npm 的 stderr 里挑出决定性的一行，避免把整段日志糊到终端。 */
function failureHint(stderr) {
  const text = stderr ?? ''
  if (text.includes('EOTP')) return '需要一次性密码：先在浏览器完成认证，或运行 npm login'
  if (text.includes('E401')) return '未登录或 token 过期：运行 npm login'
  if (text.includes('E403')) return '没有发布权限：确认作用域与账号匹配'
  if (text.includes('EPUBLISHCONFLICT')) return '该版本已存在：先改版本号'
  if (text.includes('cannot publish over the previously published versions')) {
    return '该版本已提交过，不能覆盖：等待上线或改版本号'
  }
  const line = text.split('\n').find((l) => l.includes('npm error code'))
  return line?.trim() ?? '见上方 npm 输出'
}

/** 询问重试还是退出。非交互环境返回 false。 */
async function askRetry(label) {
  if (!interactive) {
    console.error(`  ${label}：非交互环境，直接退出`)
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`  ${label}。重试？[y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** 发布一个包，失败或超时时询问是否重试。 */
async function publishOne(dir) {
  const manifest = readManifest(dir)
  const { name, version } = manifest
  console.log(`\n=== ${name}@${version} ===`)

  if (dryRun) {
    console.log(`  [dry-run] 会在 packages/${dir} 执行 npm publish`)
    console.log(`  [dry-run] 会删除 ${name}@${PLACEHOLDER}（若存在）`)
    return { name, version, ok: true }
  }

  // 第一步：确保版本已提交。只在「确实没发出去」时才重新 publish；
  // 已提交但还在审核中的，绝不重发——npm 会报 403 且覆盖不了。
  let submitted = (await publishedVersions(name)).includes(version)
  if (submitted) {
    console.log(`  ${version} 已在 registry 上，跳过发布`)
  }

  while (!submitted) {
    const published = npm(['publish'], { cwd: join(root, 'packages', dir), capture: true })
    if (published.status === 0) {
      process.stdout.write(published.stdout ?? '')
      submitted = true
      break
    }

    const output = `${published.stdout ?? ''}${published.stderr ?? ''}`

    // npm 打码了 auth URL，capture 模式下也不会自己打开浏览器，
    // 所以改用 inherit 模式重跑一次，让 npm 接管终端完成认证。
    if (output.includes('EOTP') && interactive) {
      console.log('  需要浏览器认证，npm 将接管此终端并打开授权页')
      console.log('  完成认证后会自动继续\n')
      const retried = npm(['publish'], { cwd: join(root, 'packages', dir) })
      if (retried.status === 0) {
        submitted = true
        break
      }
      process.stderr.write(`${retried.stdout ?? ''}${retried.stderr ?? ''}`)
      if (await askRetry('认证后发布仍失败')) continue
      return { name, version, ok: false }
    }

    // 这个错误说明版本早已提交（通常还在审核中），不是失败，转去等待。
    if (/cannot publish over the previously published versions|EPUBLISHCONFLICT/.test(output)) {
      console.log(`  ${version} 已提交过（可能在审核中），进入等待`)
      submitted = true
      break
    }

    process.stderr.write(output)
    const hint = failureHint(published.stderr)
    if (await askRetry(`发布失败（${hint}）`)) continue
    return { name, version, ok: false }
  }

  // 第二步：等它真正上线。重试只重新等待，不重新发布。
  for (;;) {
    if (await waitForVersion(name, version)) {
      console.log(`  ${version} 已上线`)
      break
    }
    if (await askRetry(`${version} 在 ${POLL_TIMEOUT_MS / 1000}s 内未上线（只重新检查，不重新发布）`)) continue
    return { name, version, ok: false }
  }

  const after = await publishedVersions(name)
  if (!after.includes(PLACEHOLDER)) {
    console.log(`  没有占位版本需要清理`)
    return { name, version, ok: true }
  }
  if (after.length === 1) {
    console.error(`  只剩占位版本，删除会锁住 24 小时，跳过`)
    return { name, version, ok: false }
  }
  // unpublish 同样要 OTP。capture 模式下 npm 不会拉起浏览器，所以检测到
  // EOTP 就用 inherit 模式重跑一次，让 npm 接管终端完成认证。
  let removed = npm(['unpublish', `${name}@${PLACEHOLDER}`], { capture: true })
  if (removed.status !== 0) {
    const output = `${removed.stdout ?? ''}${removed.stderr ?? ''}`
    if (output.includes('EOTP') && interactive) {
      console.log('  删除占位版本需要认证，npm 将接管此终端')
      removed = npm(['unpublish', `${name}@${PLACEHOLDER}`])
      if (removed.status === 0) {
        console.log(`  已删除 ${name}@${PLACEHOLDER}`)
        return { name, version, ok: true }
      }
    } else {
      process.stderr.write(output)
    }
    console.error(`  删除 ${name}@${PLACEHOLDER} 失败，可手动执行：npm unpublish ${name}@${PLACEHOLDER}`)
    return { name, version, ok: false }
  }
  console.log(`  已删除 ${name}@${PLACEHOLDER}`)
  return { name, version, ok: true }
}

const targets = only.length > 0 ? only : ALL
const unknown = targets.filter((dir) => !ALL.includes(dir))
if (unknown.length > 0) {
  console.error(`未知的包目录：${unknown.join(', ')}`)
  console.error(`可选：${ALL.join(', ')}`)
  process.exit(1)
}

const results = []
for (const dir of targets) results.push(await publishOne(dir))

const failed = results.filter((result) => !result.ok)
console.log('\n=== 汇总 ===')
for (const result of results) {
  console.log(`  ${result.ok ? '✓' : '✗'} ${result.name}@${result.version}`)
}
process.exit(failed.length > 0 ? 1 : 0)
