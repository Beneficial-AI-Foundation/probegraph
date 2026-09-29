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
  | { kind: 'ids'; ids: string[]; dir: 'none'; label: string; origin: FocusOrigin }
  | { kind: 'ids'; ids: [string, ...string[]]; dir: IdDirection; label: string; origin: ExactOrigin }
  | { kind: 'boundary'; sourceGroup: string; targetGroup: string };

export type IdDirection = 'none' | 'callers' | 'callees' | 'both';
export type FocusOrigin = { type: 'focus'; url: string };  // ?focus= set
export type ExactOrigin =
  | { type: 'guide' }
  | { type: 'vscode' }
  | { type: 'drilldown' };                                 // Phase 5
```

The two `ids` variants rule out shapes the URL cannot encode: a focus
set never traverses (only `focus=` is written, so a direction would be
lost), and a non-focus ID set is never empty (it writes no `id` param
and would reload as `none`).

- `text` is what the user typed, including `crate:` patterns, with today's
  semantics (substring/glob, case-insensitive).
- `ids` is exact. `dir: 'none'` shows the set itself (today's focus set);
  the other directions traverse from it. `label` is for the toast, the
  query label and the input boxes; `origin` decides URL serialization.
  Labels, IDs and group names can come from the URL, so they are always
  rendered as text (`textContent`), never through `innerHTML`; the query
  label does the latter today (#44).
  `ids: []` (focus origin only) shows nothing (today an empty focus
  set means "no restriction", `query.ts:764`); a focus set that resolves
  to no IDs yields this empty intent, not `none`.
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
Setting one dropdown is staged UI state: the intent does not change until
both are set. Clearing either dropdown while a `boundary` intent is active
sets `none`. The Crate Map keeps using them for its one-sided highlight.

`selectedNodes` is not part of the intent. It is click state that also
drives highlighting. It compiles to `depthFromSelected` only when
`intent.kind === 'none'`, as today. Every intent transition clears it and
`state.selectedNode`. Because it can drive a query, it is serialized
(`sel`, below), so back after "select a node, click a chip" restores the
selection's neighborhood.

## Transitions

One entry point in `main.ts`:

```ts
function setIntent(intent: QueryIntent, opts: { history: 'push' | 'replace' }): void
```

It clears `selectedNodes`/`selectedNode` and `pendingFocus`, bumps
`intentGeneration`, syncs the inputs and crate dropdowns from the
intent, calls `resumeDeferredEntrypoints()` when the new intent is not a
focus intent, applies, and writes history (see History).

Typing calls `setIntent` on every input event, so the intent, the
generation and the history entry are committed at once. On large graphs
only the apply is debounced, as `debouncedApplyFilters` does today
(`main.ts:1033`). The URL is built from state, not from the render, so
the debounced apply's own `replaceState` writes the same URL.

| Writer | New intent | History |
|---|---|---|
| Source/sink input typing | `text` from both inputs (`none` if both empty after trimming) | push on the first edit after a pushed intent, else replace |
| Crate dropdowns, both set (Call Graph) | `boundary` | replace |
| Crate dropdown cleared during `boundary` | `none` | replace |
| Crate map "View in Call Graph" (`main.ts:874`) | `boundary` if both groups, else `text` | replace |
| `?focus=` resolved | `ids`, `dir: 'none'`, origin focus (`ids: []` if none matched) | replace |
| Clear focus / Reset | `none` | replace |
| VS Code `loadGraph` with `selectedNodeId` | `ids`; `dir` from source/sink presence: source only `callees`, sink only `callers`, both `both`, neither `none` | replace |
| VS Code `setQuery` | `text` | replace |
| Guide action | from the action (below) | push |
| `popstate` | from URL (below) | none |

While `?focus=` is loading the intent is `none` and
`pendingFocus: { url, generation } | null` records the load. It replaces
`focusJsonUrl`. `generateShareableURL` writes `focus=<url>` from it, so an
unrelated edit during the load (depth slider) keeps `focus=` in the
address bar. A failed load clears `pendingFocus`, leaves `none`, shows
the error and drops `focus=` from the URL with `replaceState`: the URL
describes what is shown.

VS Code details. `initialQuery.depth`, when present, is applied as the
depth; otherwise a directional `ids` intent uses unlimited depth, as Guide
transitions do. Source and sink both present maps to `both`
(neighborhood) even when the strings differ; today that case runs `paths`
with both ends overridden to the same node, so this is a deliberate
change. `setQuery` builds a `text` intent from the message: after a text
intent an omitted side keeps its current string, as today; after an
`ids` intent an omitted side is empty, since the label is not a query.

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
state. `SuggestedAction` node payloads change from display names to
`NodeRank.id` plus the display name for the label
(`static-analysis.ts:172-182`):

| `SuggestedAction` | `GuideTransition` |
|---|---|
| `setSource` (id) | `ids: [id]`, `callees`, origin guide; `depth: null` |
| `setSink` (id) | `ids: [id]`, `callers`, origin guide; `depth: null` |
| `setSourceAndSink` | removed: no chip produces it |
| `setCrateBoundary` | `boundary`; `depth: null` |
| `filterVerification` | `none`, status from the action |
| `switchView` | `none`, `view` from the action |

Kind, language, include/exclude patterns and hidden nodes are never
touched. Every directional transition sets `depth: null`, as the chips
do today (`guide-panel.ts:58`): with the
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
| `ids`, `dir: 'none'` | `noTraversal` restricted to ids; `ids: []` gives an empty result |
| `ids`, `callers` / `callees` / `both` | `callers` / `callees` / `neighborhood` with `{ kind: 'nodeIds' }` matchers |
| `boundary` | `crateBoundary` with a new `exact: true` field |

`focusConfig` is derived from the intent, so a stale focus set cannot
restrict a later query. It gains an `active` flag so an empty restriction
is distinguishable from none. `resolveNodeMatcher` loses its
`exactOverride` parameter.

A query is directional when the intent is `text` with a non-empty
selector, `ids` with `dir` other than `none`, or `boundary`. This replaces
the source/sink string test behind `useFileAsResultFilter`
(`query.ts:573`): for directional queries `includeFiles` filters the
result after traversal, and the anchors stay exempt from it.

`hasSearchFilters()` (`main.ts:1492`) becomes
`intent.kind !== 'none' || selectedNodes.size > 0 || includeFiles !== ''`
plus the two language toggles, as today.

Anchors are the IDs of an `ids` intent. A `boundary` intent has none:
its result is the endpoints of the qualifying edges. `removeIsolated` (`query.ts:866`) keeps the
anchors as well as the focus set, so an exact node with no visible links
still shows. For the toast, `executeQuery` reports requested, matched
(present in the graph and passing the traversal predicates) and displayed
anchor counts; `main.ts` adds the count after the render cap
(`main.ts:2483`). Naming the filter that hid an anchor needs attribution
per predicate and is left to Phase 4.

## URL mapping

| Intent | Params written | Notes |
|---|---|---|
| `none` | none | `focus=<url>` while `pendingFocus` is set |
| `text` | `source`, `sink` | unchanged |
| `ids`, origin focus | `focus=<url>` | IDs are not serialized; the set can be thousands of nodes |
| `ids`, other origins | `id` (repeated, one per ID), `dir`, `label` | repeated params because Rust IDs can contain commas |
| `boundary` | `boundary-source`, `boundary-target` | no longer also written as `crate:` source/sink |

`source-crate` / `target-crate` keep meaning the Crate Map highlight only.
An old Call Graph link with both set and `crate:` source/sink still loads
as a `text` intent, with today's substring matching. A hand-written link
with only the two crate params and no source/sink no longer runs a
boundary query (today `main.ts:2271` builds `crate:` source/sink from
them); it only highlights on the Crate Map. This break is accepted:
links the viewer writes always carry source/sink. `QUERY_PIPELINE.md`
(line 338) is updated in the implementation PR.

Reading precedence when an old or hand-edited URL has several:
`id` > `focus` > `boundary-source`+`boundary-target` > `source`/`sink`.
When `id` wins, `focus` is not fetched.

State outside the intent that the URL also carries:

| State | Param | Notes |
|---|---|---|
| depth | `depth` | `0` for unlimited (the parser already reads it, `main.ts:255`); omitted only for the default of 1 |
| `selectedNodes` | `sel` (repeated IDs) | |
| language toggles | `rust=0`, `lean=0` | not serialized today |
| status | `status=verified,failed,...` | exact set from Phase 1.6; the old `verified`/`failed`/`unverified` booleans are still read |
| hidden nodes | `hide` (repeated IDs) | see below |

Codec fixes that land with this (Phase 1.1 items):

- `generateShareableURL` (`main.ts:347`) deletes every param it may set
  before setting it. Today `verified`, `failed`, `unverified`,
  `excludeName` and `excludePath` are missing from the delete list, and
  the new params above must be added. Test: every param round-trips from
  non-default back to default.
- Hidden nodes are written as `hide`, one param per ID. `hidden` is read
  only in the old comma-joined display-name format and resolved as today,
  so existing links keep working. The format is told apart by the param
  name, not by whether a value is a node ID in the loaded graph.

One function builds the whole state from defaults plus the URL,
`stateFromURL(params, graph)`. `loadGraph` and the `popstate` handler both
call it, so reload and back behave the same. Today `loadGraph` merges URL
params over defaults inline (`main.ts:2231`). What it does not restore:
expanded nodes and the node shown in the details panel.

## History

- Every `setIntent` does exactly one history write. It applies the new
  state with URL writes suppressed, then calls `pushState` or
  `replaceState` once with `generateShareableURL()`. A one-shot flag for
  the next `updateURLWithFilters` is not used: an early return in
  `applyFiltersAndUpdate` (`main.ts:2409`) would leave it set for an
  unrelated edit, and `switchView` writes the URL twice.
- `updateURLWithFilters` (`main.ts:2521`) keeps `replaceState` for
  ordinary edits outside `setIntent` (depth slider, kind toggles).
- Typing over a pushed intent pushes once. The marker lives in the
  history entry, not in memory: `setIntent` with `push` calls
  `pushState({ pushed: true }, ...)`, and every other write stores
  `{ pushed: false }`. An input edit pushes when `history.state?.pushed`
  is true and replaces otherwise. So state A, chip B, typing C gives three
  entries, and back from C returns to B. The rule holds after back or a
  reload of B, since `history.state` survives both: typing there pushes
  again (dropping the forward entries, as browsers do) instead of
  overwriting B.
- A `popstate` handler calls `stateFromURL`, syncs the UI, restores the
  view, and applies without writing history. `stateFromURL` also resets
  `seededRequestedDepth` (`main.ts:1519`) to `null`, as `loadGraph` does
  (`main.ts:2175`), so the seeded render derives it from the restored
  depth. Without this, "seeded view A at depth 1, chip B, slider to 5,
  back" renders A at depth 5 while the URL says 1. If the URL has a `focus`
  whose IDs are already cached (map from URL to resolved IDs, filled by
  `loadFocusSet`), it does not refetch. The cache is cleared on every
  `loadGraph`, since resolution depends on the graph (the name/path
  fallback, `main.ts:1698`).

## Async loads

`intentGeneration` is bumped by every `setIntent`, by `stateFromURL`,
and by a node click that changes `selectedNodes` while the intent is
`none` (it compiles to `depthFromSelected`, so it is a newer query; the
click wins over a pending focus set and clears `pendingFocus`).
`loadFocusSet` (`main.ts:1680`) sets `pendingFocus` with the current
generation before `fetch`. If the generation changed when the fetch
settles, the result is dropped: no intent change, no `pendingFocus`
change, no focus indicator update and no error toast. The `finally`
block still calls `resumeDeferredEntrypoints()`, which resumes only when
`pendingFocus` is null and the current intent is not a focus intent. So a
chip clicked during the load does not leave the entry points deferred,
and a stale fetch does not resume them while a newer focus load is
pending (back to another uncached `focus=` URL). A focus set with no
matches is an `ids: []` focus intent, so entry points stay deferred
until the focus set is cleared; today such a load hands over to them
(`main.ts:1779`). Entry points need no intent token: they only feed
the seeded view, which is used only while `hasSearchFilters()` is false,
so a late response cannot override an intent.

## Tests

`src/intent.test.ts` (node env): URL round trip for each intent kind and
for each param in the state table (depth finite, default and unlimited;
`sel`; language; status; `hide`), precedence with mixed params, old
`hidden` names, the delete-before-set fix, `compileQuery` mapping for each
row of the table above including `ids: []`, directional file-filter
placement, and markup in `label`, IDs and group names rendered as text. `e2e/guide.spec.ts` gets the Phase 1.7 cases (chip after
focus, after a VS Code-style ID intent, after a finite-depth selection;
back after a chip; back after typing over a chip; typing after back to
a chip; back from a chip to a seeded view after a depth change; a
delayed `?focus=` arriving after a chip or a node click, with entry
points resumed; a slider edit during a focus load keeping `focus=`). About 50 test call sites
in `filters.test.ts`, `query.test.ts` and `query.integration.test.ts`
construct `sourceQuery`/`sinkQuery`; they move to a `textIntent(source,
sink)` helper.

## Inputs for non-text intents

| Intent | Source input | Sink input |
|---|---|---|
| `ids`, `callees` | `label`, exact | empty |
| `ids`, `callers` | empty | `label`, exact |
| `ids`, `both` | `label`, exact | `label`, exact |
| `ids`, `none` (focus) | empty; the focus indicator shows the label | empty |
| `boundary` | empty; the crate dropdowns show the groups | empty |

An exact input is marked and has the full ID in the tooltip. Editing
either input switches to a `text` intent from the input contents. Focus
and boundary labels never sit in an input, and for `callers` / `callees`
the other input is empty, so no display-only label becomes a search
string. For `both`, editing one input clears the other, so the edit
gives `callees` (source) or `callers` (sink) of the typed text. Keeping
the label would turn it into a substring match on the display name, and
two different strings dispatch `paths` (`query.ts:587`). This departs
from today, where typing clears `selectedNodeId` but keeps the other
string. No read-only mode: typing is already a signal
for a new query, and the first edit after a Guide action pushes (see
History), so back returns to the chip's result.
