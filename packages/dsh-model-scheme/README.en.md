# dsh-model-scheme

Per-workspace model routing for new sessions: which provider/model a session uses, and how each subagent tier is routed.

## What it does

A **scheme** names one session route plus up to four tier routes. Bind a scheme to a workspace, and every session created in that directory uses it; existing sessions keep their own model selection.

- **Session route**: `provider` / `model` / optional `reasoningEffort`.
- **Tier routes**: one primary plus an ordered fallback list. A fallback is tried only on deterministic failure (route or model missing, adapter not registered, quota exhausted). A subagent that failed to *run* is never re-run on another model.
- **Effort follows the model**: omitting `reasoningEffort` uses the model's own default instead of inheriting the session route's effort.

## Resolution

```
workspace  <cwd>/.dsh/model-scheme.json   { schemeId }
   ▼
global     $DSH_HOME/model-scheme/schemes.json   { defaultSchemeId, schemes }
   ▼
builtin    empty scheme (session follows the official default)
```

A binding that points at a deleted scheme falls back to the global layer and is flagged in the panel.

## Configuration

```jsonc
// $DSH_HOME/model-scheme/schemes.json
{
  "version": 1,
  "defaultSchemeId": "standard",
  "schemes": {
    "standard": {
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

Settings → **模型方案** defines schemes and the global default. The chip in the composer opens the scheme overlay, where you bind the current workspace, switch the session's scheme, or pull the session back to its scheme route.

## Degradation

- No `subagents` service: `subagent_tier` is not registered, the delegation prompt section is not injected, and the official `subagent` tool stays visible.
- No `tools.restrict`: the tool is registered but the official `subagent` is not hidden; the panel reports it.
- Malformed JSON: the file is treated as empty, and the warning carries the file path plus the parser error.
- The built-in prompt section is overridable through `$DSH_HOME/model-scheme/prompts.json`; empty strings are rejected rather than silently ignored.

## Install

```sh
dsh plugin --profile <profile> add ./packages/dsh-model-scheme
```

Restart the host afterwards. A newly installed plugin does not change behaviour until a scheme is bound to a workspace or set as the global default.
