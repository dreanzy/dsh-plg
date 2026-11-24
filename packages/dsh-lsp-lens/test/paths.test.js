import assert from 'node:assert/strict'
import { test } from 'node:test'
import { argumentPath, isSupportedPath, normalizePath, WRITE_TOOLS } from '../lib/paths.js'

test('argumentPath 读 file_path，也接受 path', () => {
  assert.equal(argumentPath({ file_path: 'a.ts' }), 'a.ts')
  assert.equal(argumentPath({ path: 'b.py' }), 'b.py')
  assert.equal(argumentPath({ file_path: '' }), null)
  assert.equal(argumentPath(null), null)
  assert.equal(argumentPath('x'), null)
})

test('isSupportedPath 按扩展名判定且大小写不敏感', () => {
  const exts = ['.ts', '.py']
  assert.equal(isSupportedPath('a/b.ts', exts), true)
  assert.equal(isSupportedPath('a/b.TS', exts), true)
  assert.equal(isSupportedPath('a/b.md', exts), false)
  assert.equal(isSupportedPath('noext', exts), false)
  assert.equal(isSupportedPath('trailing.', exts), false)
})

test('normalizePath 统一分隔符并去引号', () => {
  assert.equal(normalizePath('"C:\\a\\b.ts"'), 'C:/a/b.ts')
})

test('写入工具名单覆盖原生与 PTC 版本', () => {
  for (const name of ['write', 'edit', 'ops_write_file', 'ops_edit_file', 'ops_replace']) {
    assert.equal(WRITE_TOOLS.has(name), true, name)
  }
})
