# 01 包骨架

Status: ready-for-agent
Type: task

## 目标

建出可被 `dsh plugin add` 装上、加载不报错的空包。此 ticket 之后，插件在设置页可见但没有功能。

## 范围

新建 `packages/dsh-model-scheme/`：`package.json`（`dsh.bundle.patch` 与 `dsh.client`）、`cordis.patch.yml`（一条 insert，id `model-scheme`）、`tsconfig.json`（自包含，不 extends 根）、`src/index.ts`（`export const name`、`export const inject = ['tools']`、`export function apply`）、`locale/{zh,en}.json`（含 `meta.title`/`meta.description`）、`icon.svg`、`README.md`。

只读参考：同仓库 `packages/dsh-plugin-manager/` 的同名文件。

## 验收

`pnpm --filter @dreanzy/dsh-model-scheme build` 通过；`pnpm typecheck` 通过；`dsh plugin --profile desktop add ./packages/dsh-model-scheme` 后进程无报错，插件列表出现标题与图标。

## 边界

不实现任何行为；不改共享文件。