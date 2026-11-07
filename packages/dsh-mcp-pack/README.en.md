# dsh-mcp-pack

Per-workspace control over MCP servers: which projects see which server, and when its tools enter the context.

## What it does

In the host, one `@deepseek-ai/dsh-mcp-client` entry is one MCP server, declared in the profile's `cordis.patch.yml` or an agent preset. Those entries mount by default: the connection opens, tools register globally, and the model sees every schema on every turn.

This plugin takes over that decision:

- **On-demand loading** — rows set to `dynamic` or `lazy` do not mount at all. No connection, no tool registration, and the host's `mcp-resources` has no target. The model reads a roster in the system prompt, then `mcp_load`s what it needs.
- **Tool filtering** — a server that publishes fifty tools and is used for three pays for all fifty. `!`/wildcard rules narrow what reaches the model.
- **Packs and groups** — one project can disable or defer a server without touching another.

## Loading modes

| Mode | Connection | How tools enter the context | Carrier |
|---|---|---|---|
| `eager` | Host start, mounted by `mcp-client` | Full schemas live in the tool section | none |
| `dynamic` (default) | First `mcp_load` | Visible tools are registered natively into the calling agent's scope | `native` |
| `lazy` | First `mcp_load` | Nothing is registered; `mcp_load` returns schemas and calls go through `mcp_call` | `proxy` |

Trade-off: `dynamic` binds arguments best, but every `mcp_load` rewrites the tool section and invalidates the request prefix cache. `lazy` keeps the tool list fixed — the prefix never breaks — at the cost of one proxy hop per call.

## Packs and groups

- A **pack** is a named policy table. A workspace binds exactly one pack; an unbound workspace follows the built-in `default`. Policies no longer live inside the project: `<cwd>/.dsh/mcp-manager.json` is legacy and is no longer read either.
- A **group** says which rows belong together; it is orthogonal to a pack. `groups.json` keys assignments by row key (`own:<name>` / `global:<name>`).
- Every field resolves **independently**:

  ```
  enabled:     pack.rows[row].enabled ?? pack.groups[group] ?? default.rows[row].enabled ?? default.groups[group] ?? true
  mode:        pack.rows[row].mode ?? default.rows[row].mode ?? dynamic
  tools:       pack.rows[row].tools ?? default.rows[row].tools ?? []
  description: pack.rows[row].description ?? default.rows[row].description ?? ''
  ```

  The group level carries a single on/off boolean. If a group could also set a mode, the next question would be "the group says dynamic, the row says disabled — which wins", and that merge rule has no cheap answer. So mode, tool rules and description stay at the row level.
- State lives in three independently atomic files under `$DSH_HOME/packs/mcp/`: `packs.json`, `groups.json`, `workspaces.json`.
- Changing `workingDirectory` mid-session recomputes that session's policy.

## Panel

Settings page → **MCP Pack**: three tabs, Groups / Packs / Workspace. The Groups tab edits structure only; switches live on the Packs tab, because one switch with two entry points drifts apart sooner or later.

The footer's runtime self-check reports whether the host adapters were found, whether the on-demand tools registered, which rows the gate suppressed, and which connections the pool holds.

## Install

```sh
dsh plugin --profile <profile> add @dreanzy/dsh-mcp-pack
```

From source (pnpm must be allowed to run the package's build):

```sh
dsh plugin --profile <profile> add "github:dreanzy/dsh-plg#<sha>&path:/packages/dsh-mcp-pack"
```

## Managed area or your patch

The plugin manages two sources, keyed `global:` and `own:` respectively:

| | Rows in your patch | Panel-managed |
|---|---|---|
| Definition lives in | your `cordis.patch.yml` | `$DSH_HOME/packs/mcp/servers.json` |
| Mounted by | the host's Loader composition | `ctx.plugin` at runtime |
| Lifetime | follows the host | follows the plugin — disconnects if the plugin is disabled or reloaded |
| Editable in the panel | no (read-only) | yes |

**Split by how often you change them, do not migrate everything.** Servers whose URL / args / env you touch belong in the managed area; servers that never change can stay in the patch. New servers added through the panel land there by default.

**One hard rule**: do not put your only working server in the managed area and set it to `eager`. That path is tied to the plugin's lifetime; a patch row is not.

**Security note**: `servers.json` stores connection parameters in clear text, tokens in URLs included — same as your `cordis.patch.yml`. It sits under `$DSH_HOME`, outside any repository's `.gitignore`; do not commit it.

## Known limits

1. **Row definitions are not created by this plugin** — it controls visibility and loading for existing rows; `command`/`url`/`env` still live in your `cordis.patch.yml`. Servers you add through the panel are stored separately and mounted at runtime.
2. **The gate only consults the global layer.** Mounting is a process-level decision; per-workspace differences are handled by a per-agent restriction instead.
3. **Switching modes interrupts the connection once** — the gate really does kill the child process or drop the HTTP connection.
4. **`eager` rows ignore tool filters** — the host mounts them whole and there is no seam to intercept.
5. **On-demand modes lose server instructions** — that section is only registered on the mount path. Use `eager` if you need it.
6. The connection pool does not survive a host restart; reload after restarting.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

Decisions live in `docs/adr/`; vocabulary in `GLOSSARY.md`.