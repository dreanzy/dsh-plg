import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCommands, globalPath, loadLayers, transact, workspacePath } from '../lib/store.js'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-'))
  return { dir, home: join(dir, 'home'), cwd: join(dir, 'project') }
}

test('transact 在父目录不存在时也能写', async () => {
  const { dir, cwd } = await scratch()
  try {
    const path = workspacePath(cwd)
    await transact(path, () => '{"version":1,"rows":{}}\n')
    assert.equal((await readFile(path, 'utf8')).trim(), '{"version":1,"rows":{}}')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('applyCommands 写入工作区层并可读回', async () => {
  const { dir, home, cwd } = await scratch()
  try {
    const layers = await applyCommands({ home, cwd }, [
      { op: 'enabled', layer: 'workspace', rowKey: 'global:a', value: false },
      { op: 'mode', layer: 'workspace', rowKey: 'global:a', value: 'lazy' },
    ])
    assert.equal(layers.workspace.rows['global:a'].enabled, false)
    assert.equal(layers.workspace.rows['global:a'].mode, 'lazy')
    const reread = await loadLayers({ home, cwd })
    assert.equal(reread.workspace.rows['global:a'].enabled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('null 值删键回到跟随', async () => {
  const { dir, home, cwd } = await scratch()
  try {
    await applyCommands({ home, cwd }, [{ op: 'enabled', layer: 'workspace', rowKey: 'global:a', value: false }])
    const layers = await applyCommands({ home, cwd }, [{ op: 'enabled', layer: 'workspace', rowKey: 'global:a', value: null }])
    assert.equal(layers.workspace.rows['global:a'], undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('全局层写在 home 下，与工作区层互不干扰', async () => {
  const { dir, home, cwd } = await scratch()
  try {
    await applyCommands({ home, cwd }, [{ op: 'mode', layer: 'global', rowKey: 'global:a', value: 'eager' }])
    const layers = await loadLayers({ home, cwd })
    assert.equal(layers.global.rows['global:a'].mode, 'eager')
    assert.deepEqual(layers.workspace.rows, {})
    assert.ok((await readFile(globalPath(home), 'utf8')).includes('eager'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('工作区命令缺 cwd 时报错', async () => {
  const { dir, home } = await scratch()
  try {
    await assert.rejects(
      () => applyCommands({ home, cwd: null }, [{ op: 'enabled', layer: 'workspace', rowKey: 'global:a', value: true }]),
      /工作目录/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
