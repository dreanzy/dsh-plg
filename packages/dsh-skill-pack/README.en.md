# @dreanzy/dsh-skill-pack

Per-workspace skill visibility for the DeepSeek Harness. A workspace binds exactly one pack; a pack is a named table of switches. Unbound workspaces evaluate against `default`.

**English** | [简体中文](README.md)

## What it solves

Once you install enough skills, every request pays for the whole catalogue again: the skill directory re-enters the context, too many candidates make the model pick wrong, and one project's private capability keeps occupying space in another.

This plugin turns "which skills may the model auto-invoke right now" into a set of switches, and makes each workspace choose once:

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

The pack and workspace pages write immediately; there is no draft. Creating, renaming, and deleting groups, and moving a skill between groups, also write immediately.

> Earlier builds had a "保存 / 撤销" draft inside the sidebar panel. It was removed together with the sidebar entry. See [docs/adr/0005-draft-and-save.md](docs/adr/0005-draft-and-save.md) (no longer applicable).

## Interface

- Settings → Skill Pack has three pages: `分组` / `分包` / `工作区`.
- Groups fold by group; expand one to reassign members inline. Search matches both skill names and group names.
- Packs edits the pack list and the switches inside a pack. On `default` there are only on and off — it is the end of the chain, with no layer above.
- Workspaces lists directories that have sessions plus manually added paths, one pack dropdown per row.

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
- Official `@deepseek-ai` skills are hidden from the panel by default (the rule lives in `src/inventory.ts`) but stay model-invokable; turn "显示官方技能" on to switch them individually.

## Relationship to dsh-skill-scope

Both plugins register shadow copies into the same Agent layer, so they **cannot coexist**. Remove dsh-skill-scope first. This plugin does not read its configuration; migration is manual.
