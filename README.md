# dsh-plg

DeepSeek Harness 插件的单仓库。每个 `packages/*` 是一个**插件包**：一个 npm 包、一个 bundle、一个 entry，独立版本、独立发布、独立安装。

## 结构

```
packages/
  <包名>/               # 约定 @dreanzy/ 作用域；包名不强制带 plugin- 前缀
    package.json        # name, dsh.bundle.patch, exports, scripts
    cordis.patch.yml    # 一条 insert，id 与包名后缀一致
    tsconfig.json       # 自包含，不 extends 根文件
    src/index.ts        # 服务端入口
    test/*.test.js      # node --test，测编译产物
```

## 安装

```sh
dsh plugin --profile <profile> add @dreanzy/<包名>
```

从源码安装（可选，需要 pnpm 允许该包执行构建）：

```sh
dsh plugin --profile <profile> add "github:dreanzy/dsh-plg#<sha>&path:/packages/dsh-plugin-<name>"
```

> 源码安装会在你的机器上执行该包的 `prepare` 脚本。pnpm ≥10 需要在 profile 的 `pnpm-workspace.yaml` 里为它加 `allowBuilds`。只对锁定了 commit 的可信源码这么做。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 发布

```sh
# 改 packages/<pkg>/package.json 的 version
pnpm --filter @dreanzy/dsh-plugin-<name> publish --access public
git tag dsh-plugin-<name>@<version>
```

决策记录见 `docs/adr/`，术语见 `GLOSSARY.md`。
