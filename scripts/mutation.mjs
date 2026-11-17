#!/usr/bin/env node
/**
 * 变异测试：把已知的 bug 重新注入代码，看测试能不能抓住。
 *
 * 为什么要有它：「测试全绿」只说明没测到的地方没报错，不说明已知的错误会被抓住。
 * 2026-11-17 那轮分包页 bug（开关全显示成开、排序错、新建的包丢失）全是用户发现的，
 * 测试一条都没红——补完测试之后，用这个脚本量了一遍才敢说「下次能抓住」。
 *
 * 用法：
 *   node scripts/mutation.mjs          跑全部
 *   node scripts/mutation.mjs client   只跑客户端那组
 *   node scripts/mutation.mjs server   只跑服务端那组
 *
 * 每个变异：改文件 → 跑指定层 → 恢复。**恢复在 finally 里**，中途失败也不会留下
 * 改坏的文件。服务端变异要先 `tsc`，因为 e2e 与单测跑的是 `lib/` 产物。
 *
 * 判据：每个变异至少被一层抓住。全被抓 = 退出 0；有漏网 = 退出 1 并列出是哪几个。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TSC = 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc'

/**
 * 跑一条命令，返回退出码。
 *
 * `stdio: 'ignore'`：沙箱禁止程序打开命名管道，`pipe` 会直接 EPERM
 * （见 AGENTS.md「沙箱限制与绕开」）。这里只需要退出码，不需要输出。
 */
function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', shell: process.platform === 'win32' })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/**
 * 一个变异。
 *
 * 两种定位方式：
 * - `from` / `to`：字面量替换，适合单行、无转义的片段；
 * - `lines` + `repl`：按行号替换（1-based，含两端），适合多行片段。
 *
 * 多行片段一律用行号：`from` 里要写 `\n` 与嵌套引号，JS 字符串转义与源码转义
 * 叠在一起，锚点几乎必然失配（踩过：三个变异全部「锚点未命中」）。
 */
const CLIENT_LAYERS = [
  { name: 'check-panels', run: () => run('node', ['scripts/check-panels.mjs'], ROOT) },
  {
    name: '渲染测试',
    run: () => run('node', ['--test', '--test-isolation=none', 'test/pack-page.test.js'], join(ROOT, 'packages/dsh-skill-pack')),
  },
]

const SERVER_LAYERS = [
  { name: '单测', run: (pkg) => run('node', ['--test', '--test-isolation=none', 'test/'], join(ROOT, 'packages', pkg)) },
  { name: 'e2e', run: () => run('node', ['scripts/e2e.mjs'], ROOT) },
]

/**
 * 客户端变异：分包页的开关取值、排序、新建选中。
 *
 * 这几条全是 2026-11-17 那轮真出过的 bug，不是编出来的。
 */
const CLIENT = [
  {
    name: '分包页读工作区字段（row.itemWorkspace）',
    file: 'packages/dsh-skill-pack/client/client.js',
    from: '                const value = packItemOf(pack, row.name)',
    to: '                const value = row.itemWorkspace',
  },
  {
    name: '分包页 isDefault 判 sortPack === null',
    file: 'packages/dsh-skill-pack/client/client.js',
    from: 'packRankOf(packItemOf(sortPack, row.name), isDefault, landingOf(sortPack, sortDefault, row.name, gid))',
    to: 'packRankOf(packItemOf(sortPack, row.name), sortPack === null, landingOf(sortPack, sortDefault, row.name, gid))',
  },
  {
    name: '分组显示值读冻结视图（groupRanks）',
    file: 'packages/dsh-skill-pack/client/client.js',
    lines: [2558, 2561],
    repl: [
      '                const rank = groupRanks[group.id]',
      '                const value =',
      "                  rank === 'explicit-on' ? true : rank === 'explicit-off' ? false : null",
      "                const inherited = rank === 'follow-off' ? false : true",
    ],
  },
  {
    name: '新建 pack 后不自动选中',
    file: 'packages/dsh-skill-pack/client/client.js',
    lines: [2433, 2433],
    repl: [],
  },
  {
    name: '排序档位顺序对调（follow-on / follow-off）',
    file: 'packages/dsh-skill-pack/client/client.js',
    lines: [26, 27],
    repl: ["  'follow-on': 3,", "  'follow-off': 2,"],
  },
  {
    name: '三态按钮把「关」传成 null',
    file: 'packages/dsh-skill-pack/client/client.js',
    from: "props.onChange(option.value === 'on' ? true : option.value === 'off' ? false : null)",
    to: "props.onChange(option.value === 'on' ? true : null)",
  },
  {
    // 待保存期间不冻结 pack 序：改一张 pack 的名字，它立刻跳到新位置，
    // 下一次点击就落在别的 pack 上。
    name: '待保存期间不冻结 pack 序',
    file: 'packages/dsh-skill-pack/client/client.js',
    from: '      if (!frozen) return packs',
    to: '      return packs',
  },
]

/** 服务端变异：求值链与显示态。 */
const SERVER = [
  {
    // 2026-11-17 实测故障：服务端 30 分钟空闲超时回收 session，此后每个请求都
    // 返回 404 `Session not found`。SDK 不清 `_sessionId`、不触发 `onclose`，
    // 连接看起来一直活着——一次超时就让这台 server 永久废掉。
    name: '连接失效后不自愈',
    file: 'packages/dsh-mcp-pack/src/mcp-connection.ts',
    from: '      if (!isConnectionLost(error)) throw error',
    to: '      throw error',
  },
  {
    name: 'landing 恒为 true',
    file: 'packages/dsh-skill-pack/src/effective.ts',
    from: '      landing: groupValueOf(policy.pack, resolver.groupOf(name)) ?? globalResolver.decide(name).value,',
    to: '      landing: true,',
  },
  {
    name: 'open 恒为 true',
    file: 'packages/dsh-skill-pack/src/effective.ts',
    from: '      open: complete ? decision.value : null,',
    to: '      open: complete ? true : null,',
  },
  {
    name: '求值链丢掉 default 层',
    file: 'packages/dsh-pack-core/src/policy.ts',
    from: '    const top = defaultPack.items[name]',
    to: '    const top = undefined',
  },
  {
    // pack 名册退回按 id 排：id 与名字脱钩，用户看到的顺序就成了「创建顺序」。
    name: 'pack 名册退回按 id 排',
    file: 'packages/dsh-skill-pack/src/routes.ts',
    from: '    const byName = nameOf(a).localeCompare(nameOf(b), \'zh\')',
    to: '    const byName = a.localeCompare(b)',
  },
]

/**
 * 写文件。
 *
 * 先写临时文件再 rename：沙箱下对同一路径连续 `writeFileSync` 会偶发
 * `UNKNOWN: unknown error`（实测：连跑几个变异后必现）。rename 是原子的，
 * 也不会留下半截文件。
 */
function writeAtomic(path, text) {
  const temp = path + '.mutation-tmp'
  writeFileSync(temp, text)
  renameSync(temp, path)
}

/**
 * 把变异应用到源码上；锚点对不上时返回 `null`。
 *
 * 返回 `null` 而不是抛错：锚点失配是「代码改过了，这条变异过期了」，
 * 该报出来让人更新脚本，不该让整轮跑挂掉。
 */
function applyMutation(source, mutation) {
  if (mutation.lines !== undefined) {
    const lines = source.split('\n')
    const [from, to] = mutation.lines
    if (from < 1 || to > lines.length || from > to) return null
    const next = lines.slice()
    next.splice(from - 1, to - from + 1, ...mutation.repl)
    const result = next.join('\n')
    return result === source ? null : result
  }
  if (!source.includes(mutation.from)) return null
  return source.replace(mutation.from, mutation.to)
}

/**
 * 跑一组变异。
 *
 * 恢复用 `finally`：变异中途抛错（编译失败、测试超时）也必须把文件写回去，
 * 否则下一次跑会基于改坏的源码，报一堆看不懂的错。
 */
async function runGroup(label, mutations, layers, needsBuild) {
  const results = []
  for (const mutation of mutations) {
    const path = join(ROOT, mutation.file)
    const original = readFileSync(path, 'utf8')
    const mutated = applyMutation(original, mutation)
    if (mutated === null) {
      results.push({ name: mutation.name, error: '锚点未命中（代码改过，变异没注入）' })
      continue
    }
    const pkg = mutation.file.split('/')[1]
    const caught = {}
    try {
      writeAtomic(path, mutated)
      if (needsBuild) {
        const built = await run('node', [TSC, '-p', 'packages/' + pkg + '/tsconfig.json'], ROOT)
        if (built !== 0) {
          results.push({ name: mutation.name, error: '编译失败' })
          continue
        }
      }
      for (const layer of layers) {
        caught[layer.name] = (await layer.run(pkg)) !== 0
      }
      results.push({ name: mutation.name, caught })
    } finally {
      writeAtomic(path, original)
      if (needsBuild) await run('node', [TSC, '-p', 'packages/' + pkg + '/tsconfig.json'], ROOT)
    }
  }
  return results
}

const which = process.argv[2]
const groups = []
if (which === undefined || which === 'client') groups.push(['客户端', CLIENT, CLIENT_LAYERS, false])
if (which === undefined || which === 'server') groups.push(['服务端', SERVER, SERVER_LAYERS, true])

if (groups.length === 0) {
  console.error('用法：node scripts/mutation.mjs [client|server]')
  process.exit(1)
}

let missed = 0
let total = 0
for (const [label, mutations, layers, needsBuild] of groups) {
  console.log('== ' + label + ' ==')
  const results = await runGroup(label, mutations, layers, needsBuild)
  for (const result of results) {
    total += 1
    if (result.error !== undefined) {
      missed += 1
      console.error('✖ ' + result.name + '：' + result.error)
      continue
    }
    const caughtBy = Object.entries(result.caught).filter(([, hit]) => hit).map(([name]) => name)
    if (caughtBy.length === 0) {
      missed += 1
      console.error('✖ ' + result.name + '：没有一层抓住（' + Object.keys(result.caught).join(' / ') + ' 全绿）')
    } else {
      console.log('✔ ' + result.name + '（' + caughtBy.join(' + ') + '）')
    }
  }
}

console.log('')
if (missed > 0) {
  console.error('mutation: ' + String(missed) + '/' + String(total) + ' 个变异没被抓住——测试对这类错误没有防线')
  process.exit(1)
}
console.log('mutation: ' + String(total) + '/' + String(total) + ' 个变异全部被抓住')
