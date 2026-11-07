import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { catalogPath, defaultCatalogFeed, fingerprint } from '../lib/catalog.js'

/**
 * 假 profile：`package.json` 带 `dsh.profile.bundles`（识别 profile 的唯一判据），
 * `dependencies` 列出要扫的包。包内容按相对路径写，方便造 lib/** 的多层结构。
 */
async function writePackage(profile, name, spec) {
  const dir = join(profile, 'node_modules', ...name.split('/'))
  await mkdir(join(dir, 'lib'), { recursive: true })
  const manifest = { name, version: spec.version ?? '1.0.0' }
  if (spec.main !== null) manifest.main = spec.main ?? 'lib/index.js'
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const [relative, body] of Object.entries(spec.files ?? {})) {
    const target = join(dir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return dir
}

async function makeProfile(dir, packages) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-test',
        private: true,
        dependencies: Object.fromEntries(Object.keys(packages).map((name) => [name, '1.0.0'])),
        dsh: { profile: { bundles: [] } },
      },
      null,
      2,
    ),
  )
  for (const [name, spec] of Object.entries(packages)) await writePackage(dir, name, spec)
  return dir
}

/**
 * 每个用例一套独立的 DSH_HOME，避免缓存互相污染。
 *
 * `DSH_APP_ASAR` 显式指向一个不存在的文件：官方包这一路在测试里恒为空，
 * 不会去摸本机真的 app.asar。
 */
async function freshHome(tag) {
  const home = await mkdtemp(join(tmpdir(), 'dpm-catalog-' + tag + '-'))
  process.env['DSH_HOME'] = home
  process.env['DSH_APP_ASAR'] = join(home, 'absent.asar')
  delete process.env['DSH_PROFILE_DIR']
  return home
}

const tool = (name) => "export const t = defineTool({ name: '" + name + "', description: '' })\n"

const section = (name, text) =>
  'export const s = systemPrompt.section({ name: ' + JSON.stringify(name) + ', text: ' + JSON.stringify(text) + ' })\n'

/** 三个包：多工具多文件、同名工具被两个包注册、无 main。外加一个不在依赖里的干扰包。 */
async function standardProfile(home) {
  const profile = join(home, 'profile')
  await makeProfile(profile, {
    '@fake/alpha': {
      version: '1.2.3',
      files: {
        'lib/index.js': tool('alpha_tool') + tool('alpha_second') + section('tool:alpha', 'x'.repeat(20)),
        'lib/nested/deep.js': tool('alpha_nested'),
        // 240 字符窗口之外的 name 不该被算到这个注册头上；普通注释也不该命中。
        'lib/notes.js':
          'export const helper = 1\n' +
          'defineTool({' + ' '.repeat(300) + 'name: "far_tool" })\n' +
          'systemPrompt.section({' + ' '.repeat(300) + 'name: "far_section", text: "hi" })\n' +
          '// 这里只是说明：defineTool 注册的工具有名字。\n',
      },
    },
    'fake-beta': {
      version: '2.0.0',
      // 同名工具两个包都注册：两个包都要记，取交集就不会漏掉一个合法来源。
      files: {
        'lib/index.js': tool('beta_tool') + tool('alpha_tool') + section('deployment:beta', 'yyy'),
      },
    },
    // 没有 main：只剩 lib/** 可扫，仍然要能扫到。
    'fake-gamma': { version: '0.0.1', main: null, files: { 'lib/entry.js': tool('gamma_tool') } },
  })
  // 干扰包：住在 node_modules 里，但不在 profile 的 dependencies 中（传递依赖不挂载）。
  await writePackage(profile, 'fake-unused', { version: '9.9.9', files: { 'lib/index.js': tool('ghost_tool') } })
  process.env['DSH_PROFILE_DIR'] = profile
  return profile
}

test('工具与段都归属到包，同名注册两个包都记', async () => {
  const home = await freshHome('scan')
  await standardProfile(home)

  const catalog = await defaultCatalogFeed.load({ force: true })
  const byPkg = Object.fromEntries(catalog.plugins.map((plugin) => [plugin.pkg, plugin]))

  assert.deepEqual(byPkg['@fake/alpha'].tools, ['alpha_nested', 'alpha_second', 'alpha_tool'])
  assert.deepEqual(byPkg['@fake/alpha'].sections, ['tool:alpha'])
  assert.equal(byPkg['@fake/alpha'].sectionChars, 20)
  assert.equal(byPkg['@fake/alpha'].toolsKnown, true)
  assert.equal(byPkg['@fake/alpha'].sectionsKnown, true)

  assert.deepEqual(byPkg['fake-beta'].tools, ['alpha_tool', 'beta_tool'])
  assert.deepEqual(byPkg['fake-beta'].sections, ['deployment:beta'])
  assert.equal(byPkg['fake-beta'].sectionChars, 3)

  // 无 main 的包只剩 lib/**，照样要扫到。
  assert.deepEqual(byPkg['fake-gamma'].tools, ['gamma_tool'])

  assert.match(catalog.key, /^[0-9a-f]{16}$/)
  // 孤儿要跟运行期清单求差，扫描给不出来，恒为空数组。
  assert.deepEqual(catalog.orphanTools, [])
  assert.deepEqual(catalog.orphanSections, [])
})

test('240 字符窗口之外的 name 不误抓', async () => {
  const home = await freshHome('window')
  await standardProfile(home)

  const catalog = await defaultCatalogFeed.load({ force: true })
  const alpha = catalog.plugins.find((plugin) => plugin.pkg === '@fake/alpha')
  assert.equal(alpha.tools.includes('far_tool'), false)
  assert.equal(alpha.sections.includes('far_section'), false)
})

test('依赖之外的传递依赖不被扫描', async () => {
  const home = await freshHome('transitive')
  await standardProfile(home)

  const catalog = await defaultCatalogFeed.load({ force: true })
  const names = catalog.plugins.map((plugin) => plugin.pkg)
  assert.equal(names.includes('fake-unused'), false)
  for (const plugin of catalog.plugins) {
    assert.equal(plugin.tools.includes('ghost_tool'), false)
  }
})

test('入口 mtime 变化触发重扫并更新缓存', async () => {
  const home = await freshHome('cache')
  const profile = await standardProfile(home)

  const first = await defaultCatalogFeed.load()
  assert.equal(first.plugins.some((plugin) => plugin.tools.includes('alpha_third')), false)

  const entry = join(profile, 'node_modules', '@fake', 'alpha', 'lib', 'index.js')
  await writeFile(entry, tool('alpha_tool') + section('tool:alpha', 'x'.repeat(20)) + tool('alpha_third'))
  // 显式把 mtime 推到未来：同一毫秒内两次写盘时 mtime 可能相同，靠时间戳断言会抖。
  const future = new Date(Date.now() + 60_000)
  await utimes(entry, future, future)

  const second = await defaultCatalogFeed.load()
  assert.notEqual(second.key, first.key)
  assert.equal(second.plugins.find((plugin) => plugin.pkg === '@fake/alpha').tools.includes('alpha_third'), true)

  const onDisk = JSON.parse(await readFile(catalogPath(), 'utf8'))
  assert.equal(onDisk.key, second.key)
  assert.equal(onDisk.plugins.find((plugin) => plugin.pkg === '@fake/alpha').tools.includes('alpha_third'), true)
})

test('manual: true 的缓存直接采用，不重扫也不覆盖', async () => {
  const home = await freshHome('manual')
  await standardProfile(home)

  await mkdir(dirname(catalogPath()), { recursive: true })
  const handmade = {
    key: 'manual-key',
    manual: true,
    plugins: [
      {
        pkg: 'hand/pkg',
        tools: ['hand_tool'],
        sections: ['hand:section'],
        toolVolume: 0,
        sectionChars: 12,
        toolsKnown: true,
        sectionsKnown: true,
      },
    ],
    orphanTools: [],
    orphanSections: [],
  }
  await writeFile(catalogPath(), JSON.stringify(handmade, null, 2))

  // force 也不行：手写表是最高优先级，否则用户没有稳定的覆盖入口。
  const catalog = await defaultCatalogFeed.load({ force: true })
  assert.equal(catalog.key, 'manual-key')
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.pkg), ['hand/pkg'])
  assert.equal(defaultCatalogFeed.read().key, 'manual-key')

  const onDisk = JSON.parse(await readFile(catalogPath(), 'utf8'))
  assert.equal(onDisk.manual, true)
  assert.equal(onDisk.key, 'manual-key')
  assert.deepEqual(onDisk.plugins.map((plugin) => plugin.pkg), ['hand/pkg'])
})

test('坏缓存降级为空目录，不抛错', async () => {
  const home = await freshHome('broken')
  await standardProfile(home)

  await mkdir(dirname(catalogPath()), { recursive: true })
  await writeFile(catalogPath(), '{ not json')
  assert.equal(defaultCatalogFeed.read(), null)

  // 坏缓存不阻断扫描：重建一份就好了。
  const catalog = await defaultCatalogFeed.load()
  assert.equal(catalog.plugins.some((plugin) => plugin.pkg === 'fake-beta'), true)
})

test('缓存写不成时走 warn，扫描结果照样返回', async () => {
  const home = await freshHome('nowrite')
  // 把 DSH_HOME 指到一个**文件**上：packs/plugin 目录建不出来，写盘必然失败。
  const blocked = join(home, 'blocked')
  await writeFile(blocked, '')
  process.env['DSH_HOME'] = blocked

  await makeProfile(join(home, 'profile'), {
    '@fake/ok': { files: { 'lib/index.js': tool('ok_tool') } },
  })
  process.env['DSH_PROFILE_DIR'] = join(home, 'profile')

  const warnings = []
  const catalog = await defaultCatalogFeed.load({ force: true, warn: (message) => warnings.push(message) })

  // 写不进去只影响下次冷启动要重扫；这一轮刚扫到的结果不能因此作废。
  assert.equal(catalog.plugins.find((item) => item.pkg === '@fake/ok').tools.includes('ok_tool'), true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /缓存没写成/)
  assert.match(warnings[0], /重扫/)
})

test('缓存命中时不做文件扫描', async () => {
  const home = await freshHome('hit')
  await standardProfile(home)

  const first = await defaultCatalogFeed.load()
  // 重扫必然重写缓存文件，所以 mtime 是「有没有扫」的可观测点。
  // 先把 mtime 推回过去：否则同毫秒内的两次读写分不出来。
  const past = new Date(Date.now() - 60_000)
  await utimes(catalogPath(), past, past)
  const stampBefore = await stat(catalogPath())

  const second = await defaultCatalogFeed.load()
  // 命中只允许 stat 与读 package.json：缓存文件一个字节都不该重写。
  const stampAfter = await stat(catalogPath())
  assert.equal(stampAfter.mtimeMs, stampBefore.mtimeMs)
  assert.ok(stampBefore.mtimeMs < Date.now() - 30_000)
  assert.equal(second.key, first.key)
  assert.deepEqual(
    second.plugins.map((plugin) => plugin.pkg),
    first.plugins.map((plugin) => plugin.pkg),
  )
})

test('模板段名只记静态前缀，且前缀必须是包名的一个词', async () => {
  const home = await freshHome('template')
  const templateSection = (nameExpr) => 'export const s = systemPrompt.section({ name: ' + nameExpr + ", text: 'z' })\n"
  await makeProfile(join(home, 'profile'), {
    'dsh-mcp-client': {
      version: '1.0.0',
      files: { 'lib/index.js': templateSection('`mcp:${server}`') },
    },
    'fake-subagent': {
      version: '1.0.0',
      files: { 'lib/index.js': templateSection('`tool:${toolName}`') },
    },
  })
  process.env['DSH_PROFILE_DIR'] = join(home, 'profile')

  const catalog = await defaultCatalogFeed.load({ force: true })
  const byPkg = Object.fromEntries(catalog.plugins.map((plugin) => [plugin.pkg, plugin]))

  // mcp 是 dsh-mcp-client 的一个词，前缀认给自己。
  assert.deepEqual(byPkg['dsh-mcp-client'].sections, ['mcp:'])
  // 段名是运行期拼的，清单天然不完整。
  assert.equal(byPkg['dsh-mcp-client'].sectionsKnown, false)

  // tool 不是 fake-subagent 的词：不认，免得把别人的段算到自己头上。
  assert.deepEqual(byPkg['fake-subagent'].sections, [])
})
test('模板段名不算残缺：仍然写盘，第二次命中缓存', async () => {
  const home = await freshHome('template')
  const profile = join(home, 'profile')
  await makeProfile(profile, {
    '@fake/tpl': {
      files: {
        // 模板段名：运行期才长出真名，归属天然不完整（sectionsKnown=false）。
        'lib/index.js':
          tool('alpha_tool') +
          'const n = 1\nexport const s = systemPrompt.section({ name: ' +
          "`tpl:${n}`" +
          ', text: "x" })\n',
      },
    },
  })
  process.env['DSH_PROFILE_DIR'] = profile

  const first = await defaultCatalogFeed.load({ force: true })
  assert.equal(first.plugins.length, 1)
  assert.equal(first.plugins[0].sectionsKnown, false)

  // 缓存必须已经落盘：再读一次不能再扫。
  const cached = defaultCatalogFeed.read()
  assert.notEqual(cached, null)
  // 同上：mtime 不动就是没有重扫。模板段名让 sectionsKnown=false，但它不能撞掉 cache。
  const past = new Date(Date.now() - 60_000)
  await utimes(catalogPath(), past, past)
  const stampBefore = await stat(catalogPath())
  await defaultCatalogFeed.load()
  const stampAfter = await stat(catalogPath())
  assert.equal(stampAfter.mtimeMs, stampBefore.mtimeMs)
})

test('complete: false 的缓存不短路扫描：残缺不会被固化', async () => {
  const home = await freshHome('partial')
  await standardProfile(home)

  const first = await defaultCatalogFeed.load()
  const raw = JSON.parse(await readFile(catalogPath(), 'utf8'))
  raw.complete = false
  await writeFile(catalogPath(), JSON.stringify(raw, null, 2) + '\n')

  const second = await defaultCatalogFeed.load()
  // 残缺缓存必须触发重扫，否则一次超时就把「少几个包」永久固定下来。
  // 重扫会连磁盘一起重写，所以「盘上重新变成 complete: true」就是它没被短路的证据。
  const onDisk = JSON.parse(await readFile(catalogPath(), 'utf8'))
  assert.equal(onDisk.complete, true)
  assert.equal(second.complete, true)
  assert.equal(second.plugins.length, first.plugins.length)
})

test('单包文件数超过上限时该包不完整：落盘 complete=false', async () => {
  const home = await freshHome('cap-files')
  const files = {}
  // MAX_FILES_PER_PACKAGE 是 200：201 个 js 必然撞上限。
  for (let index = 0; index < 201; index += 1) {
    files['lib/f' + String(index).padStart(3, '0') + '.js'] = tool('cap_tool_' + String(index))
  }
  await makeProfile(join(home, 'profile'), { '@fake/many': { files } })
  process.env['DSH_PROFILE_DIR'] = join(home, 'profile')

  const catalog = await defaultCatalogFeed.load({ force: true })
  const plugin = catalog.plugins.find((item) => item.pkg === '@fake/many')
  // 只扫到 200 个文件就说「齐全」，下游会照着半份清单去遮蔽与显示。
  assert.equal(plugin.toolsKnown, false)
  assert.equal(catalog.complete, false)

  const onDisk = JSON.parse(await readFile(catalogPath(), 'utf8'))
  assert.equal(onDisk.plugins.find((item) => item.pkg === '@fake/many').toolsKnown, false)
  assert.equal(onDisk.complete, false)
})

test('lib 深度超过上限时该包不完整：落盘 complete=false', async () => {
  const home = await freshHome('cap-depth')
  // MAX_LIB_DEPTH 是 6：从 lib 数到 g 已经第 7 层，那棵子树整个不扫。
  const deep = 'lib/a/b/c/d/e/f/g/hidden.js'
  await makeProfile(join(home, 'profile'), {
    '@fake/deep': { files: { 'lib/index.js': tool('deep_tool'), [deep]: tool('far_deep_tool') } },
  })
  process.env['DSH_PROFILE_DIR'] = join(home, 'profile')

  const catalog = await defaultCatalogFeed.load({ force: true })
  const plugin = catalog.plugins.find((item) => item.pkg === '@fake/deep')
  assert.equal(plugin.tools.includes('far_deep_tool'), false)
  assert.equal(plugin.toolsKnown, false)

  const onDisk = JSON.parse(await readFile(catalogPath(), 'utf8'))
  assert.equal(onDisk.plugins.find((item) => item.pkg === '@fake/deep').toolsKnown, false)
  assert.equal(onDisk.complete, false)
})

test('超过 4 KB 的段体积不再记 0', async () => {
  const home = await freshHome('long-section')
  await makeProfile(join(home, 'profile'), {
    '@fake/long': { files: { 'lib/index.js': section('long:part', 'x'.repeat(6000)) } },
  })
  process.env['DSH_PROFILE_DIR'] = join(home, 'profile')

  const catalog = await defaultCatalogFeed.load({ force: true })
  const plugin = catalog.plugins[0]
  assert.deepEqual(plugin.sections, ['long:part'])
  // 旧上限 4 K 会让配对括号找不到，体积直接记 0。
  assert.ok(plugin.sectionChars > 1000, '长段体积应被计入，实际 ' + plugin.sectionChars)
})

function candidateOf(overrides = {}) {
  const file = (path, size, mtime) => ({ path, size, mtime, read: async () => '' })
  return {
    name: 'plug-a',
    version: '1.0.0',
    entry: file('/p/a.js', 10, 100),
    lib: [file('/p/lib/b.js', 20, 50), file('/p/lib/c.js', 30, 40)],
    ...overrides,
  }
}

test('指纹对「删掉非最新文件」敏感', () => {
  const base = fingerprint([candidateOf()])
  // c.js 的 mtime 40 不是最大（50），只比 max mtime 的话删掉它指纹不变。
  const dropped = fingerprint([candidateOf({ lib: [candidateOf().lib[0]] })])
  assert.notEqual(base, dropped)
})

test('指纹对「同 mtime 但字节数变化」敏感', () => {
  const base = fingerprint([candidateOf()])
  const file = (path, size, mtime) => ({ path, size, mtime, read: async () => '' })
  const grown = fingerprint([
    candidateOf({ lib: [file('/p/lib/b.js', 21, 50), file('/p/lib/c.js', 30, 40)] }),
  ])
  assert.notEqual(base, grown)
})

test('指纹对同一批候选稳定', () => {
  assert.equal(fingerprint([candidateOf()]), fingerprint([candidateOf()]))
})

test('归属缓存在 $DSH_HOME/packs/plugin/ 下，与三份策略文件同目录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dpp-catalog-path-'))
  process.env['DSH_HOME'] = home
  assert.equal(catalogPath(), join(home, 'packs', 'plugin', 'catalog.json'))
})

