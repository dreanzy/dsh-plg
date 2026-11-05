import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { catalogPath, loadCatalog, readCachedCatalog, scanStats } from '../lib/catalog.js'

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

  const catalog = await loadCatalog({ force: true })
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

  const catalog = await loadCatalog({ force: true })
  const alpha = catalog.plugins.find((plugin) => plugin.pkg === '@fake/alpha')
  assert.equal(alpha.tools.includes('far_tool'), false)
  assert.equal(alpha.sections.includes('far_section'), false)
})

test('依赖之外的传递依赖不被扫描', async () => {
  const home = await freshHome('transitive')
  await standardProfile(home)

  const catalog = await loadCatalog({ force: true })
  const names = catalog.plugins.map((plugin) => plugin.pkg)
  assert.equal(names.includes('fake-unused'), false)
  for (const plugin of catalog.plugins) {
    assert.equal(plugin.tools.includes('ghost_tool'), false)
  }
})

test('入口 mtime 变化触发重扫并更新缓存', async () => {
  const home = await freshHome('cache')
  const profile = await standardProfile(home)

  const first = await loadCatalog()
  assert.equal(first.plugins.some((plugin) => plugin.tools.includes('alpha_third')), false)

  const entry = join(profile, 'node_modules', '@fake', 'alpha', 'lib', 'index.js')
  await writeFile(entry, tool('alpha_tool') + section('tool:alpha', 'x'.repeat(20)) + tool('alpha_third'))
  // 显式把 mtime 推到未来：同一毫秒内两次写盘时 mtime 可能相同，靠时间戳断言会抖。
  const future = new Date(Date.now() + 60_000)
  await utimes(entry, future, future)

  const second = await loadCatalog()
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
  const catalog = await loadCatalog({ force: true })
  assert.equal(catalog.key, 'manual-key')
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.pkg), ['hand/pkg'])
  assert.equal(readCachedCatalog().key, 'manual-key')

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
  assert.equal(readCachedCatalog(), null)

  // 坏缓存不阻断扫描：重建一份就好了。
  const catalog = await loadCatalog()
  assert.equal(catalog.plugins.some((plugin) => plugin.pkg === 'fake-beta'), true)
})

test('缓存命中时不做文件扫描', async () => {
  const home = await freshHome('hit')
  await standardProfile(home)

  const first = await loadCatalog()
  const afterFirst = { scans: scanStats.scans, filesRead: scanStats.filesRead }
  assert.ok(afterFirst.scans > 0)
  assert.ok(afterFirst.filesRead > 0)

  const second = await loadCatalog()
  // 命中只允许 stat 与读 package.json：内容一次都不许读。
  assert.equal(scanStats.scans, afterFirst.scans)
  assert.equal(scanStats.filesRead, afterFirst.filesRead)
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

  const catalog = await loadCatalog({ force: true })
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

  const first = await loadCatalog({ force: true })
  const scanned = scanStats.scans
  assert.equal(first.plugins.length, 1)
  assert.equal(first.plugins[0].sectionsKnown, false)

  // 缓存必须已经落盘：再读一次不能再扫。
  const cached = readCachedCatalog()
  assert.notEqual(cached, null)
  await loadCatalog()
  assert.equal(scanStats.scans, scanned)
})
