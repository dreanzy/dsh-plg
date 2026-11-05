/**
 * 计算要罩住的工具名。
 *
 * 为什么是「按名字罩住」而不是「拦挂载」：宿主 `tools.restrict()` 只作用于继承来的
 * 全局工具，**scope 自己的注册不受影响**。于是 `mcp-client` 挂在全局层的那一份被
 * 罩住，而 `mcp_load` 注册进 agent scope 的同名工具照常可见——正好是我们要的分层。
 *
 * 代价是进程照样起、token 照省但启动开销不省。拦挂载要走 Loader 私有事件，
 * 那是社区实现反复出事故的地方（issue #6 就出在那条线上），另行处理。
 */
export function denyNamesFor(restrictable: Iterable<string>, serverNames: readonly string[]): readonly string[] {
  if (serverNames.length === 0) return []
  const prefixes = serverNames.map((name) => `mcp__${name}__`)
  const out: string[] = []
  for (const toolName of restrictable) {
    if (prefixes.some((prefix) => toolName.startsWith(prefix))) out.push(toolName)
  }
  return out.sort((left, right) => left.localeCompare(right))
}
