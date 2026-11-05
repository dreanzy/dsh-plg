# @dreanzy/dsh-plugin-manager

Disable plugins per workspace. Disabling one does two things: it drops the tools the plugin registers from what the model can see, and removes the prompt sections it injects from the system prompt.

**English** | [简体中文](README.md)

## What it solves

Two goals, usually at the same time:

1. **Save tokens.** A plugin's tool schemas and prompt sections are sent again on every request. The more you install, the larger the fixed cost, and the more candidates the model has to choose from.
2. **Keep one workspace away from one plugin.** A docs repository does not need an executor; a frontend repository does not need image generation. Left available, the capability sits in the candidate list forever.

The plugin is the **switch unit**: an npm package is either wholly available or wholly disabled. There is no "disable the plugin but keep one tool" — that needs a reverse switch, and the underlying capability only tightens (see [Known limits](#known-limits)).

## Two layers

```
workspace item  ??  workspace group  ??  global item  ??  global group  ??  default on
```

The first ring that has a decision wins. **Any workspace decision beats any global decision**, otherwise you get the hardest failure class to diagnose: the panel says on, the toggle looks on, and the model still cannot see the plugin.

Each layer has exactly one editing surface:

| Surface | Layer |
| --- | --- |
| "Plugin 管理" in the sidebar | global |
| Settings → Plugin 管理 | global |
| "Plugins" overlay at the right of the composer | this workspace |

There is no layer switcher on the page: one mount point edits one layer, so the same place never shows two viewpoints.

## Install

```sh
dsh plugin --profile <profile> add 'github:<owner>/<repo>#<sha>&path:/packages/dsh-plugin-manager'
```

Replace `<owner>/<repo>#<sha>` with the real repository and commit (use a commit, not a branch, so the install is reproducible). Restart the Host and refresh the page.

## Files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/plugin-manager/global.json` | Global item-level and group-level decisions, `ui.showSidebarEntry` |
| `<cwd>/.dsh/plugin-manager.json` | The layer belonging to one workspace |
| `$DSH_HOME/plugin-manager/groups.json` | Group definitions and membership, shared across workspaces |
| `$DSH_HOME/plugin-manager/catalog.json` | Attribution scan cache (safe to delete; it rebuilds) |

The workspace file is a project convention: it sits beside the other files under `<cwd>/.dsh/` and states what this project needs, so it can be committed and shared. The plugin never touches `.gitignore` — if your repository ignores `.dsh/` wholesale, add an exception for this file.

## The panel

- **One mount point, one layer** (see the table above). Every row is labelled "本层" (this layer) or "跟随" (follow). Following is decided by whether this layer has the key, not by whether the value matches the layer above; `↺` clears this layer's decision and returns to follow.
- **Sections**: official / third-party, split automatically by the package's npm scope (`@deepseek-ai/` is official). Presentation only — sections never take part in evaluation and cannot act as switch units. Click a section header to fold it.
- **Sorting**: descending by `toolVolume + sectionChars / 4`, so the expensive plugins come first. The header shows "已停用 N 个插件，约省 M token" and follows the draft live.
- **Rows**: the full package name (no stripping of the `@scope/` prefix — `@a/x` and `@b/x` would collide), an official/third-party tag, `N 工具`, `N 段`, `≈M token`, and the switch.
- **Search**: case-insensitive substring match on the package name. Deliberately not fuzzy: fragments like `dsh` appear everywhere, and fuzzy matching only makes the result harder to identify. Search force-expands every section.
- **Protected plugins**: the row is tagged "受保护". Disabling one asks for confirmation, and the dialog lists the package name. The list is fixed (file tools, executors, system-prompt, this plugin itself) and no policy layer can rewrite it.
- **Draft**: every toggle edits memory first; a bar with "保存 / 撤销" floats at the bottom and one request submits the whole batch. Ten quick flips still send exactly one request, and a failed save keeps the draft.
- **No group UI**: the plugin already is the switch unit. `policy.groups` still participates in evaluation (older policies may carry group decisions), but the panel passes it through without rendering it.
- **No cwd row**: the workspace panel shows the policy file path, which already contains the working directory.

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

Every save submits a set of **intents** (`{op:'item', layer, name, value | null}`). The server reads, mutates and writes under a cross-process file lock, comparing no revisions at all. Intents are idempotent and commutative, and the last writer of one key wins, so conflicts such as `stale-revision` cannot occur. `null` deletes the key and returns to follow — writing the same value is not the same thing.

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
