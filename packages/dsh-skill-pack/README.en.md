# @dreanzy/dsh-skill-pack

Per-workspace skill availability for the DeepSeek Harness. A workspace binds exactly one pack; a pack is a named table of switches. Unbound workspaces evaluate against `default`.

**English** | [简体中文](README.md)

## What it solves

Once you install enough skills, every request pays for the whole catalogue again: the skill directory re-enters the context, too many candidates make the model pick wrong, and one project's private capability keeps occupying space in another.

This plugin turns "which skills may the model auto-discover, and which ones a user may still name with `/name`" into a set of switches, and makes each workspace choose once:

```
bound pack  ??  default pack  ??  default on
```

`??` means the first ring that has a decision wins. A pack stores explicit decisions only: a missing key means follow, and `false` is a real value, not follow.

A batch of workspaces — say five art projects — shares one pack, and one edit applies everywhere.

## Groups

A group declares "which items belong together"; it is not a switch by itself:

- A skill belongs to at most one group; anything unassigned is simply ungrouped.
- A pack can switch a whole group, and members added later follow that decision.
- Group definitions are shared across workspaces; renaming a group invalidates nothing.

## Install

```sh
dsh plugin --profile <profile> add @dreanzy/dsh-skill-pack
```

Restart the Host and refresh the page. Two entry points: the chip at the right of the composer, and Settings → Skill Pack. The chip itself can be turned off in Settings.

## Editing and saving

Edits queue up in the panel; nothing is written until you press Save ([ADR 0006](../../docs/adr/0006-pending-changes-before-commit.md)):

- Flipping a switch, changing a binding, renaming, creating — all of it only enqueues. The panel immediately renders what the change would look like, using a host-side **dry run**.
- A bar pinned to the bottom of the panel shows the count and offers Undo (drops the last change), Discard all, and Save.
- While changes are pending the list order is frozen; it re-sorts only after saving. Pending rows carry a vertical rule on the left.
- Closing the panel discards pending changes. That is deliberate: by the time you come back you usually no longer remember what you clicked.

Deleting is the exception: it takes effect immediately and cannot be undone, so the button turns into a red-outlined "确认" and needs a second click.
Pending changes that reference the deleted object are dropped with it, and the panel says how many.

## Interface

- Settings → Skill Pack has three pages: `分组` / `分包` / `工作区`.
- Groups fold by group; expand one to reassign members inline. Search matches both skill names and group names.
- Packs edits the pack list and the switches inside a pack. On `default` there are only on and off — it is the end of the chain, with no layer above.
- Workspaces lists directories that have sessions, one pack dropdown per row. Directories come from the host; this page only decides bindings, it never adds or removes them.

## Files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/packs/skill/packs.json` | Pack list: item- and group-level decisions per pack, plus UI switches (chip visibility, default page) |
| `$DSH_HOME/packs/skill/groups.json` | Group definitions and membership, shared across workspaces |
| `$DSH_HOME/packs/skill/workspaces.json` | Workspace → pack bindings, plus manually added paths |

Workspace directories produce no files at all: the binding table lives in the global home, so project directories stay clean.

## Write semantics

Every toggle submits a set of **intents** (`{key, value|null}`); the server reads, mutates, and writes under a cross-process file lock, comparing no revisions at all. Intents are idempotent and commutative, and the last writer of one key wins, so conflicts such as `stale-revision` cannot occur. `null` deletes the key, returning to follow — writing a same value is not the same thing.

See [docs/adr/0001-intent-writes.md](docs/adr/0001-intent-writes.md).

## Known limits

- **Skills only.** Per-workspace MCP switching is out of scope; DSH offers no clean narrowing point for MCP tools. See [docs/adr/0004-skill-only-scope.md](docs/adr/0004-skill-only-scope.md).
- Changing the working directory mid-session does not re-evaluate; reopening the session restores the expected state.
- Same-layer first-wins: if another plugin registered a skill of the same name into the same layer first, that skill cannot be hidden. The panel greys it out and states the reason.
- Official `@deepseek-ai` skills are hidden from the panel by default (the rule lives in `src/inventory.ts`) but stay model-invokable; turn "显示官方技能" on to switch them individually. Once switched off they follow the same rule as custom skills: the model cannot see them and `/name` stops working.
- **The `/` menu hides a closed skill automatically.** The remote `skills.list` filters by `isUserInvocable`, so a `userInvocable: false` entry never reaches the client. Typing `/name` by hand does nothing and shows no hint either: in that workspace the skill simply does not exist.
- **This package cannot customise the `/` menu itself.** The official `dsh-client-ui-skill` owns the `("/", "skill")` trigger source, and `registerSource` throws on a duplicate key, so the plugin can neither replace nor filter its candidates — the hiding comes from the host filter, not from this package.
- **The `/` candidates can lag behind a Session switch.** The host caches the skill catalog per `sessionId` and only invalidates it on `agent-preset/selected` and `plugin-manager/changed`; reusing an old Session or re-enabling the plugin can still list a skill you just closed. **Refresh the page** to recover.

## Relationship to dsh-skill-scope

Both plugins register shadow copies into the same Agent layer, so they **cannot coexist**. Remove dsh-skill-scope first. This plugin does not read its configuration; migration is manual.
