# Query intent: design note for Phase 1.1

Status: for review (2026-09-29). Prerequisite for Phase 1 of
`viewer-filters-and-guide.md`; Phases 4 and 5 build on it. Line numbers
are against `main` at `77cc3a5`.

## Problem

What the graph is "about" is spread over five places that nothing keeps
consistent:

| Where | Written by | Read by |
|---|---|---|
| `filters.sourceQuery` / `sinkQuery` | inputs, Guide, crate dropdowns, crate map event, VS Code, URL | `compileQuery`, `hasSearchFilters`, URL codec |
| `filters.focusNodeIds` | `loadFocusSet` (async), reset, clear focus | `noTraversal` branch and `removeIsolated` in `executeQuery`, `hasSearchFilters`, URL codec |
| `filters.selectedNodes` | node clicks (`graph.ts:645`, `blueprint.ts:456`) | `compileQuery` (`depthFromSelected`), `hasSearchFilters` |
| `selectedNodeId` (`main.ts:145`) | VS Code `loadGraph` | `resolveNodeMatcher` exact override |
| `selectedSourceCrate` / `selectedTargetCrate` (`main.ts:549`) | crate dropdowns, URL | URL codec, crate map; rebuild source/sink on load (`main.ts:2262`) |

Every writer sets only its own fields, so the others leak into the next
query. Examples on `main`: the Guide crate-boundary chip leaves
`crate:` source/sink behind for the next chip; VS Code `setQuery`
(`main.ts:3689`) never clears `selectedNodeId`, so a new source string
still resolves to the old node; the crate dropdowns stay set after a chip
replaces the boundary query.

## Type

New module `src/intent.ts`, pure (no DOM), unit-tested in the node
environment.

```ts
export type QueryIntent =
  | { kind: 'none' }
  | { kind: 'text'; source: string; sink: string }
  | { kind: 'ids'; ids: string[]; dir: IdDirection; label: string; origin: IdOrigin }
  | { kind: 'boundary'; sourceGroup: string; targetGroup: string };

export type IdDirection = 'none' | 'callers' | 'callees' | 'both';
export type IdOrigin =
  | { type: 'focus'; url: string }   // ?focus= set
  | { type: 'guide' }
  | { type: 'vscode' }
  | { type: 'drilldown' };           // Phase 5
```

- `text` is what the user typed, including `crate:` patterns, with today's
  semantics (substring/glob, case-insensitive).
- `ids` is exact. `dir: 'none'` shows the set itself (today's focus set);
  the other directions traverse from it. `label` is for the toast, the
  query label and the input boxes; `origin` decides URL serialization.
- `boundary` names two groups exactly (Phase 1.2). Typing `crate:a` into
  both inputs stays a `text` intent with substring matching.
- IDs are an array, not a `Set`, so intents compare and serialize simply;
  the compiler builds the `Set`.

`FilterOptions` (`types.ts:258`) gains `intent: QueryIntent` and loses
`sourceQuery`, `sinkQuery` and `focusNodeIds`. `selectedNodeId` and
`SelectedNodeOptions` are removed; VS Code produces an `ids` intent.
`selectedSourceCrate` / `selectedTargetCrate` stay as dropdown UI state,
but on the Call Graph the dropdowns are written from the intent (both set
iff `intent.kind === 'boundary'`), never read back into source/sink.
The Crate Map keeps using them for its one-sided highlight.

`selectedNodes` is not part of the intent. It is click state that also
drives highlighting. It compiles to `depthFromSelected` only when
`intent.kind === 'none'`, as today. Every intent transition clears it and
`state.selectedNode`.

## Transitions

One entry point in `main.ts`:

```ts
function setIntent(intent: QueryIntent, opts: { history: 'push' | 'replace' }): void
```

It clears `selectedNodes`/`selectedNode`, bumps `intentGeneration`, syncs
the inputs and crate dropdowns from the intent, calls
`resumeDeferredEntrypoints()` when leaving a focus intent, and applies.

| Writer | New intent | History |
|---|---|---|
| Source/sink input typing | `text` from both inputs (`none` if both empty) | replace |
| Crate dropdowns, both set (Call Graph) | `boundary` | replace |
| Crate map "View in Call Graph" (`main.ts:874`) | `boundary` if both groups, else `text` | replace |
| `?focus=` resolved | `ids`, `dir: 'none'`, origin focus | replace |
| Clear focus / Reset | `none` | replace |
| VS Code `loadGraph` with `selectedNodeId` | `ids` from source/sink presence: source only `callees`, sink only `callers`, both `both` | replace |
| VS Code `setQuery` | `text` | replace |
| Guide action | from the action (below) | push |
| `popstate` | from URL (below) | none |

Guide actions become one transition each:

```ts
interface GuideTransition {
  intent: QueryIntent;
  status: StatusSelection | null;  // null: keep the user's status filter
  depth?: number | null;           // absent: keep the user's depth; null: unlimited
  view?: ActiveView;
  label: string;
}
```

`GuideActions` (`guide/types.ts`) shrinks to `apply(t: GuideTransition)`.
`setSource`/`setSink`/`setFilters` go away, so a chip cannot set a partial
state. "Show only verified" is `{ intent: none, status: verified }`;
"View namespace map" is `{ intent: none, view: 'crate-map' }`. Kind,
language, include/exclude patterns and hidden nodes are never touched.
Directional transitions (`ids` with a direction, `boundary`) set
`depth: null`, as the chips do today (`guide-panel.ts:58`): with the
default depth of 1, "callers of GF16" would show direct callers only, and
Phase 4's BFS truncation assumes an unlimited traversal. Other
transitions omit `depth`. This departs from the parent plan, which listed
depth as a kept preference.
`StatusSelection` is the exact status set of Phase 1.6; this note only
fixes that the transition carries it.

## Compiling

`compileQuery` switches on `filters.intent.kind`:

| Intent | `GraphQuery` |
|---|---|
| `none` | `depthFromSelected` if `selectedNodes` non-empty, finite depth, no include files; else `noTraversal` |
| `text` | unchanged dispatch on source/sink strings |
| `ids`, `dir: 'none'` | `noTraversal` with `focusConfig.focusNodeIds` = ids (today's focus path) |
| `ids`, `callers` / `callees` / `both` | `callers` / `callees` / `neighborhood` with `{ kind: 'nodeIds' }` matchers |
| `boundary` | `crateBoundary` with a new `exact: true` field |

`focusConfig` is derived from the intent, so a stale focus set cannot
restrict a later query. `resolveNodeMatcher` loses its `exactOverride`
parameter.

`hasSearchFilters()` (`main.ts:1492`) becomes
`intent.kind !== 'none' || selectedNodes.size > 0 || includeFiles !== ''`
plus the two language toggles, as today.

For the toast, `executeQuery` reports how many anchor IDs were requested
and how many survived the traversal predicates. When some did not, the
toast names the filter that hid them ("GF16 is hidden: Types are
unchecked") instead of showing an empty graph. Only `ids` and `boundary`
intents have anchors.

## URL mapping

| Intent | Params written | Notes |
|---|---|---|
| `none` | none | |
| `text` | `source`, `sink` | unchanged |
| `ids`, origin focus | `focus=<url>` | IDs are not serialized; the set can be thousands of nodes |
| `ids`, other origins | `id` (repeated, one per ID), `dir`, `label` | repeated params because Rust IDs can contain commas |
| `boundary` | `source-crate`, `target-crate` | no longer also written as `crate:` source/sink |

Reading precedence when an old or hand-edited URL has several:
`id` > `focus` > `source-crate`+`target-crate` > `source`/`sink`.

Codec fixes that land with this (Phase 1.1 items):

- `generateShareableURL` (`main.ts:347`) deletes every param it may set
  before setting it. Today `verified`, `failed`, `unverified`,
  `excludeName` and `excludePath` are missing from the delete list, and
  `label`, `id`, `dir` must be added. Test: every param round-trips from
  non-default back to default.
- `hidden` is written as repeated IDs. On read, a value that is not a node
  ID is treated as the old comma-joined display-name format and resolved
  as today, so existing links keep working.

One function builds the whole state from defaults plus the URL,
`stateFromURL(params, graph)`. `loadGraph` and the `popstate` handler both
call it, so reload and back behave the same. Today `loadGraph` merges URL
params over defaults inline (`main.ts:2231`).

## History

- `updateURLWithFilters` (`main.ts:2521`) keeps `replaceState` for
  ordinary edits. `setIntent(..., { history: 'push' })` sets a one-shot
  flag, and the next `updateURLWithFilters` uses `pushState` instead.
  One Guide click gives one history entry.
- A `popstate` handler calls `stateFromURL`, syncs the UI, restores the
  view, and applies without pushing. If the URL has a `focus` whose IDs
  are already cached (map from URL to resolved IDs, filled by
  `loadFocusSet`), it does not refetch.

## Async loads

`intentGeneration` is bumped by every `setIntent` and by `stateFromURL`.
`loadFocusSet` (`main.ts:1680`) records it before `fetch` and drops the
result if it changed, the same pattern as `graphLoadGeneration` in the
entry-point loader. Entry points need no token: they only feed the seeded
view, which is used only while `hasSearchFilters()` is false, so a late
response cannot override an intent.

## Tests

`src/intent.test.ts` (node env): URL round trip for each intent kind,
precedence with mixed params, old `hidden` names, the delete-before-set
fix, `compileQuery` mapping for each row of the table above.
`e2e/guide.spec.ts` gets the Phase 1.7 cases (chip after focus, after a
VS Code-style ID intent, after a finite-depth selection; back after a
chip; a delayed `?focus=` arriving after a chip). About 50 test call sites
in `filters.test.ts`, `query.test.ts` and `query.integration.test.ts`
construct `sourceQuery`/`sinkQuery`; they move to a `textIntent(source,
sink)` helper.

## Inputs while an `ids` intent is active

The source/sink inputs show `label`, marked as exact, with the full ID in
the tooltip. Editing either input switches to a `text` intent from the
input contents, matching how typing clears `selectedNodeId` today; the
marker disappears. No read-only mode: typing is already a signal for a
new query, and browser back restores the replaced intent when it came
from a Guide action.
