# dsh-model-pack

Per-workspace model routing for new sessions: which provider/model a session uses, and how each subagent tier is routed.

## What it does

A **pack** names one session route plus up to four tier routes. Bind a pack to a workspace, and every session created in that directory uses it; existing sessions keep their own model selection.

- **Session route**: `provider` / `model` / optional `reasoningEffort`.
- **Tier routes**: one primary plus an ordered fallback list. A fallback is tried only on deterministic failure (route or model missing, adapter not registered, quota exhausted). A subagent that failed to *run* is never re-run on another model.
- **Effort follows the model**: omitting `reasoningEffort` uses the model's own default instead of inheriting the session route's effort.

## Resolution

```
workspace   $DSH_HOME/packs/model/workspaces.json   { bindings: { cwd: packId } }
   ▼
default     $DSH_HOME/packs/model/packs.json        packs.default
   ▼
builtin     empty pack (session follows the official default)
```

A binding that points at a deleted pack falls back to `default` and is flagged in the panel. `default` is built in: it cannot be deleted or renamed, but its content is editable.

`prompts.json` is orthogonal to packs: one global override set shared by every pack.

## Files

| Path | Content |
| --- | --- |
| `$DSH_HOME/packs/model/packs.json` | pack roster plus the `ui` section |
| `$DSH_HOME/packs/model/prompts.json` | prompt overrides, orthogonal to packs |
| `$DSH_HOME/packs/model/workspaces.json` | workspace → pack bindings, plus manually added paths |

Compatibility reads for the legacy paths (`$DSH_HOME/model-scheme/` and `<cwd>/.dsh/model-scheme.json`) have been removed: once the migration finished, those files and their read branches were deleted together. Only the three files above are read now.

```jsonc
// $DSH_HOME/packs/model/packs.json
{
  "version": 1,
  "ui": { "showChip": true, "defaultTab": "model" },
  "packs": {
    "default": { "name": "出厂方案", "tiers": {} },
    "p1": {
      "name": "Standard",
      "session": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
      "tiers": {
        "tier1": {
          "name": "Scout",
          "primary": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "low" },
          "fallbacks": []
        }
      }
    }
  }
}
```

## Panel and entry points

Settings has three tabs: **model | prompts | packs**. `ui.defaultTab` only decides which tab opens first; switching tabs does not write it. The packs tab creates, renames and deletes packs and edits the selected pack's session route and tiers; `default` has no delete or rename entry. When `ui.showChip === false` the composer chip is not registered.

Write commands on `api/model-pack/apply`: `createPack` / `renamePack` / `deletePack` / `bind` / `addExtra` / `removeExtra` / `showChip` / `defaultTab`, plus this package's content commands `putPack` / `packSession` / `packTier`.

## Degradation

- No `subagents` service: `subagent_tier` is not registered, the delegation prompt section is not injected, and the official `subagent` tool stays visible.
- No `tools.restrict`: the tool is registered but the official `subagent` is not hidden; the panel reports it.
- Malformed JSON: the file is treated as empty, and the warning carries the file path plus the parser error.
- The built-in prompt section is overridable through `$DSH_HOME/packs/model/prompts.json`; empty strings are rejected rather than silently ignored.

## Install

```sh
dsh plugin --profile <profile> add ./packages/dsh-model-pack
```

Restart the host afterwards. An unbound workspace uses `default`; with no `default` configured the plugin changes no behaviour.
