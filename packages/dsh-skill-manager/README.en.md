# @dreanzy/dsh-skill-manager

Per-workspace skill visibility for the DeepSeek Harness. A global layer provides defaults; every workspace can override any skill or any group, in both directions.

**English** | [简体中文](README.md)

## What it solves

Once you install enough skills, every request pays for the whole catalogue again: the skill directory re-enters the context, too many candidates make the model pick wrong, and one project's private capability keeps occupying space in another.

This plugin turns "which skills may the model auto-invoke right now" into a set of switches across two layers:

```
workspace item  ??  workspace group  ??  global item  ??  global group  ??  default on
```

The first ring that has a decision wins. **Any workspace decision beats any global decision** — otherwise you get the hardest failure class to diagnose: the panel says on, the toggle looks on, and the model still cannot see the skill.

## Groups

A group is a layer of policy, not a shortcut that expands into batch writes:

- A skill belongs to at most one group; anything unassigned is simply ungrouped.
- Flipping a group switch writes exactly one decision, and members added later follow it automatically.
- A group switch shows the group-level value only (follow / on / off); item-level overrides inside it are reported as "N overridden", never folded into the switch.
- Group definitions are shared across workspaces; switch decisions live per layer. Renaming a group invalidates nothing.

## Install

```sh
dsh plugin --profile <profile> add @dreanzy/dsh-skill-manager
```

Restart the Host and refresh the page. Three entry points: "Skill 管理" in the sidebar, "Skills" at the right of the composer, and Settings → Skill 管理. All three can toggle; the sidebar entry itself can be turned off in Settings.

## Editing and saving

Flipping a switch only edits a local draft; a bar with "保存 / 撤销" appears at the bottom:

- Ten quick flips still send exactly one request, so the view is never overwritten by an out-of-order response.
- A failed save keeps the draft, so a retry is one click away.
- Closing the modal is the same as discarding.
- Creating, renaming, and deleting groups, and moving a skill between groups, apply immediately. They edit group definitions shared by every workspace, so a draft would wrongly suggest they can be rolled back.

See [docs/adr/0005-draft-and-save.md](docs/adr/0005-draft-and-save.md).

## The panel

- "未分组" always sits first; other groups sort by their effective value — on before off. Members sort the same way, then by name.
- Each row labels its origin on the right: `.agents`, `.dsh`, `官方`, a plugin name, or `运行时`.
- A group row shows its group-level value plus how many members are overridden; a row with an override gets ↺ to return to follow.

## Files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/skill-manager/global.json` | Global item-level and group-level decisions, `showOfficialSkills`, `showSidebarEntry` |
| `$DSH_HOME/skill-manager/groups.json` | Group definitions and membership, shared across workspaces |
| `<cwd>/.dsh/skill-manager.json` | The layer belonging to one workspace |

The workspace file is a project convention: it sits beside `.dsh/skills` and states what this project needs, so it can be committed and shared. The plugin never touches `.gitignore` — if your repository ignores `.dsh/` wholesale, add an exception for this file (`!/.dsh/skill-manager.json`).

## Write semantics

Every toggle submits a set of **intents** (`{layer, key, value|null}`); the server reads, mutates, and writes under a cross-process file lock, comparing no revisions at all. Intents are idempotent and commutative, and the last writer of one key wins, so conflicts such as `stale-revision` cannot occur. `null` deletes the key, returning to follow — writing a same value is not the same thing.

See [docs/adr/0001-intent-writes.md](docs/adr/0001-intent-writes.md).

## Known limits

- **Skills only.** Per-workspace MCP switching is out of scope; DSH offers no clean narrowing point for MCP tools. See [docs/adr/0004-skill-only-scope.md](docs/adr/0004-skill-only-scope.md).
- Changing the working directory mid-session does not re-evaluate; reopening the session restores the expected state.
- Same-layer first-wins: if another plugin registered a skill of the same name into the same layer first, that skill cannot be hidden. The panel greys it out and states the reason.
- Official `@deepseek-ai` skills are hidden from the panel by default (the rule lives in `src/inventory.ts`) but stay model-invokable; turn "显示官方技能" on to switch them individually.

## Relationship to dsh-skill-scope

Both plugins register shadow copies into the same Agent layer, so they **cannot coexist**. Remove dsh-skill-scope first. This plugin does not read its configuration; migration is manual.
