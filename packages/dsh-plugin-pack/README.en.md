# @dreanzy/dsh-plugin-pack

Disable plugins per workspace. Disabling one does two things: it drops the tools the plugin registers from what the model can see, and removes the prompt sections it injects from the system prompt.

**English** | [简体中文](README.md)

## What it solves

Two goals, usually at the same time:

1. **Save tokens.** A plugin's tool schemas and prompt sections are sent again on every request. The more you install, the larger the fixed cost, and the more candidates the model has to choose from.
2. **Keep one workspace away from one plugin.** A docs repository does not need an executor; a frontend repository does not need image generation. Left available, the capability sits in the candidate list forever.

The plugin is the **switch unit**: an npm package is either wholly available or wholly disabled. There is no "disable the plugin but keep one tool" — that needs a reverse switch, and the underlying capability only tightens (see [Known limits](#known-limits)).

## Packs and evaluation

```
bound pack item  ??  bound pack group  ??  default item  ??  default group  ??  on
```

The first ring that has a decision wins. A pack is a named policy table holding only override decisions and no membership list. A workspace stores exactly one binding: bound to one pack, or bound to nothing (which uses `default`). `default` is a built-in pack: it cannot be deleted or renamed, but its contents are editable — it is where the old global layer now lives.

A missing key means "follow"; `false` means "explicitly off". They are not the same thing. Every switch of an ordinary pack therefore has three states (on / off / follow), while `default` has two: it is the end of the evaluation chain and has no layer above it.

No state file is produced inside the workspace directory any more.

## Install

```sh
dsh plugin --profile <profile> add 'github:<owner>/<repo>#<sha>&path:/packages/dsh-plugin-pack'
```

Replace `<owner>/<repo>#<sha>` with the real repository and commit (use a commit, not a branch, so the install is reproducible). Restart the Host and refresh the page.

## Files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/packs/plugin/packs.json` | Pack catalogue and the `ui` section (`showChip`, `defaultTab`) |
| `$DSH_HOME/packs/plugin/groups.json` | Group definitions and membership, shared across workspaces |
| `$DSH_HOME/packs/plugin/workspaces.json` | Workspace → pack bindings, plus manually added paths |
| `$DSH_HOME/packs/plugin/catalog.json` | Attribution scan cache (safe to delete; it rebuilds) |

The three policy files transact independently: editing pressure lands on `packs.json`, while groups and bindings change rarely, so splitting them lets each file be written atomically on its own. After a pack is deleted, keys in the binding table that still point at it become dangling references: the read side evaluates them as `default`, and the write side cleans them up.

The old paths (`$DSH_HOME/plugin-manager/` and `<cwd>/.dsh/plugin-manager.json`) are still **read for compatibility**: when the new files are absent they are mapped to packs in memory, and the read path never writes. Migration is done by a separate script.

## The panel

- **Three pages**: `分组 | 分包 | 工作区` (groups / packs / workspace), fixed order, landing on `ui.defaultTab`. Switching pages only changes the current one and never writes; only the "打开设置时默认显示" radios at the top of the page change the default.
- **One switch, one entry point**. Switches belong to packs and appear only on the "分包" page; the "分组" page is structure only (create, rename, delete, re-assign) and carries no switches. An ordinary pack's switch has three states — on / off / follow — and follow is its own clickable option; `default` has two, where an unrecorded key means the built-in default (on).
- **The workspace page** only binds: one pack dropdown per row, and "未选" means follow `default`. A binding only affects **new** sessions in that directory; policy is evaluated when a session is created, so sessions already open keep their pack.
- **Sections**: official / third-party, split automatically by the package's npm scope (`@deepseek-ai/` is official). Presentation only — sections never take part in evaluation and cannot act as switch units. Click a section header to fold it.
- **Sorting**: descending by `toolVolume + sectionChars / 4`, so the expensive plugins come first. The header shows "已停用 N 个插件，约省 M token" and follows the draft live.
- **Rows**: the full package name (no stripping of the `@scope/` prefix — `@a/x` and `@b/x` would collide), an official/third-party tag, `N 工具`, `N 段`, `≈M token`, and the switch.
- **Search**: case-insensitive substring match on the package name. Deliberately not fuzzy: fragments like `dsh` appear everywhere, and fuzzy matching only makes the result harder to identify. Search force-expands every section.
- **Protected plugins**: the row is tagged "受保护". Disabling one asks for confirmation, and the dialog lists the package name. The list is fixed (file tools, executors, system-prompt, this plugin itself) and no pack can rewrite it.
- **Draft**: every toggle edits memory first; a bar with "保存 / 撤销" floats at the bottom and one request submits the whole batch. Ten quick flips still send exactly one request, and a failed save keeps the draft.
- **Groups are orthogonal to packs**: groups say which plugins belong together, packs say whether those plugins are on or off for these workspaces. Group switches live in packs alongside item switches; the "分组" page changes no switches.
- **No cwd row**: the workspace page identifies a workspace by its directory name; the binding keys are normalized paths.

### Probes

These appear above the list, in this order, and every one of them is seen before any switch:

| Condition | Text |
| --- | --- |
| `support.restrict === false` | Current host does not support tool restriction; disabling only affects prompts |
| `support.promptFilter === false` | Current host does not support prompt-section filtering; disabling only affects tools |
| `pending === true` | Identifying plugin attribution (about 1s on first run, then cached) |
| No official plugin found | No official plugins were identified; the attribution scan may have missed app.asar, and official plugins will not appear in the list |
| `stuck` non-empty | Lists the tools that cannot be turned off (dropped after the host rejected the batch over unknown names) |
| `outOfScope` non-empty | Collapsible list of names present in policy but absent from the catalogue; kept, not deleted |
| A row with `sectionKnown === false` | Prompt usage unknown |

## Write semantics

Every save submits a set of **intents** (`{ op: 'packItem' | 'packGroup', packId, name, value: boolean | null }`, `createPack` / `renamePack` / `deletePack`, `bind` / `addExtra` / `removeExtra`, the group commands `assign` / `createGroup` / `renameGroup` / `deleteGroup`, and `showChip` / `defaultTab`). The server reads, mutates and writes under a cross-process file lock, comparing no revisions at all. Intents are idempotent and commutative, and the last writer of one key wins, so conflicts such as `stale-revision` cannot occur. `null` deletes the key and returns to follow — writing the same value is not the same thing.

`bind` carries its own `cwd`, so writes no longer depend on a session; `sessionId` only selects which view `apply` returns. Binding explicitly to `default` is equivalent to `packId: null`, and no redundant key is persisted.


After a successful save the plugin re-applies explicitly: writing policy emits no host event, so this call is the only way a change becomes visible in the same session. A failed re-apply only degrades; it never turns a successful write into an error.

## Known limits

- **Section attribution relies on static scanning.** The host records neither tool nor section origin, so this plugin scans each package's source for literal `defineTool({ name: '…' })` and `.section({ name: '…' })`. Names built at runtime stay unattributed.
- **Unattributed means untouched.** Orphan sections still reach the system prompt and orphan tools still work; no switch can reach them. Saving a few hundred tokens is not worth deleting someone else's section — removing a 1300-character section destroys a plugin's capability and there is no fallback.
- **Fail-open.** If the catalogue, the policy, the tool inventory or the waterfall subscription is unavailable, the round changes nothing and only logs a warning. Losing a few hundred tokens is far cheaper than breaking the model.
- **Processes are not unloaded.** Disabling only affects the model side: the plugin still loads, its UI panels and commands still work, and other agents' scopes are untouched. Real enable/disable is the profile bundle switch, a different thing.
- **Tighten only.** The tool channel is a deny mask and intersects. Tools another plugin already denied cannot be brought back here.
- **`run_code` cannot enter the mask.** The host reserves it for the PTC transport, and including it makes the whole batch fail, so it is skipped.
- **Official plugins may be missing.** Official packages live inside `app.asar`, not in the profile's `node_modules`, and must be read from the archive header; when that fails the list keeps only third-party plugins and the panel says so with a warning.
- **Older hosts.** Without `tools.restrict()` or `system-prompt/assemble` the plugin still loads and still saves configuration, degrading to a single channel and flagging it in red. It does not fall back to shadow registration: two implementations of one feature mean two sets of bugs.
- Changing the working directory mid-session does not re-evaluate; reopening the session restores the expected state.
- Sizes are estimates: `toolVolume` divides schema projection characters by 4, sections divide characters by 4. This is not a bill.
