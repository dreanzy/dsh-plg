# @dreanzy/dsh-pack-core

四个 pack 插件共用的服务端骨架：会话目录、装配记账、求值与落盘规则、协议类型。

边界见 [ADR-0007](https://github.com/dreanzy/dsh-plg/blob/main/docs/adr/0007-shared-core-package.md)。

## 它不是什么

- 不是插件。没有 `dsh.bundle.patch`，不进 profile 的 `bundles`，也不注册任何 entry。
- 不替四个包做决定。它提供的是**同一条**求值链、同一种落盘纪律、同一份协议，被管理的对象仍归各自的包（skill、插件的贡献、MCP 的行、模型路由）。

## 装法

四包对它写真实 semver 依赖：

```json
"dependencies": { "@dreanzy/dsh-pack-core": "^0.1.0" }
```

普通安装会把它放到 `~/.dsh/profiles/<name>/node_modules` 顶层，四个插件都能原生解析。开发期用 pnpm 的 workspace 链接（仓库根 `.npmrc` 已开 `link-workspace-packages`）；宿主认符号链接，但只有包名出现在插件的 `peerDependencies` 里才走拦截路由。

不要写 `workspace:` 协议：发布走 `npm publish`，npm 不认它。

## 对外接口

| 模块 | 导出 |
| --- | --- |
| `cwd` | `projectedCwd` · `cwdFromAgent` · `cwdFromObserved` |
| `reconcile` | `createReconciler` · `Dispose` · `Reconciler` |
| `protocol` | `Envelope` · `ErrorCode` |
| `store` | `storePaths` · `readText` |
| `policy` | `createResolver` · `normalizeCwd` · `Decision` · `Resolver` |

## 版本

`0.1.x` 是搬迁期：只收已经逐字相同的实现，不改任何一个包的行为。四个包的 `^0.1.0` 依赖意味着 core 必须先发，否则它们装不上。
