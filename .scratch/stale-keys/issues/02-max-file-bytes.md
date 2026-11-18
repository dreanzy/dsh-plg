# 02 超限文件不再拖垮整包

Status: resolved

## 问题

`catalog.ts:345-358` 的 `candidateFile()` 在 `stat` 失败或超过 `MAX_FILE_BYTES`（8 MB）时返回 `null`，`listLibJs` 一律置 `truncated`。

`dsh-experimental-inspector` 的 `lighthouse_worker.js` 是 9.2 MB 的产物文件，被跳过 → 整包判残缺 → 目录 `complete: false` → `effective.ts:164` 所有行 `open = null` → **面板全部显示「未生效」**，且每次打开都触发重扫（60 秒退避）。

## 要做

超限文件只把该包的 `toolsKnown` 置 `false`，不影响目录级的 `complete`。`stat` 失败仍置 `truncated`——那是真的读不到，不是「太大不读」。

## 判据

- 单测：造一个含超限文件的假包，断言 `catalog.complete === true` 且该包 `toolsKnown === false`。
- 单测：造一个 `stat` 失败的假包，断言 `catalog.complete === false`。
- 本机实测：`dsh-experimental-inspector` 存在时，`catalog.json` 的 `complete` 为 `true`。

## 参考

- ADR 0002
- `catalog.ts:344-395`
