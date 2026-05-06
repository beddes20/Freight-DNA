# Carrier-Facing Workflow OS — Spec

This is the authoritative product + interaction contract that the three core
carrier-facing work surfaces must conform to:

- **Available Freight** (AF) — `client/src/pages/available-freight.tsx`
- **Lane Work Queue** (LWQ) — `client/src/pages/lane-work-queue.tsx`
- **Available Loads** (Carrier Intelligence) — `client/src/pages/carrier-intelligence-available-loads.tsx`

Every cross-cutting concern below — filter grammar, selection grammar, bulk
action bar, outreach composer, guardrail copy, saved views, keyboard model —
is identical across all three surfaces. Only the status/bucket sets, the
per-surface header context, and the per-surface candidate-derivation logic
are context-specific. The doc is meant to be readable end-to-end in 15–20
minutes by an engineer or designer who is new to the platform.

> Product principles baked in:
>
> - The default view answers **"what should I work right now?"** — not "show
>   me every unresolved thing in the system."
> - A rep who learns a workflow in one surface should feel at home in the
>   other two: same selection grammar, same bulk-action grammar, same
>   outreach composer behavior, same guardrail language.
> - Manager visibility into stale / overdue / cross-team work is preserved
>   but does not dominate the rep's default queue.

The shared primitives that enforce this spec live under
`shared/workflowOs/*`, `client/src/components/workflow-os/*`,
`client/src/hooks/workflow-os/*`, and `client/src/lib/workflow-os/*`.

---

## A. Vocabulary & data model

### Row ownership envelope

Every actionable row exposes the same ownership envelope to the client.
Source of truth: `shared/cockpitOwnership.ts` (carries the historical
`CockpitRowOwnership` shape) and `shared/workflowOs/ownership.ts` (the
canonical re-export the new code imports from).

```ts
interface RowOwnership {
  ids: string[];      // ownerUserId, delegatedToUserId, createdById, approvedById
  emails: string[];   // lowercased usernames/emails of the resolved users
}
```

The one canonical predicate is `isRowOwnedByUser(ownership, identity, legacyOwnerId)`.
**No surface invents its own.** Server KPIs and client filters both go
through it (this is the lesson from Task #875: AF used to have two
parallel "is this mine?" definitions and they drifted).

### Owner vs Account Manager

- **Owner** is **row-level** — the person executing the work on this
  freight / lane / load. Captured by `ownerUserId` /
  `delegatedToUserId`.
- **Account Manager** is **account-level** — `companies.assignedTo`
  points at the AM (or NAM) who owns the customer relationship.

These are deliberately decoupled: a NAM can be the AM on Acme even when an
AF row for Acme is delegated to a load-mover. ADR-001 records the
chosen UX compromise (a single Owner control with an `My AM's book`
sub-scope) and supersedes the rejected "two filters" approach in #900's
UX recommendations and the rejected "splitter widget" approach.

### Pickup-freshness model

Source of truth: `shared/pickupFreshness.ts`.

- `upcoming` — pickup is today or in the future (org-local TZ).
- `past_recent` — pickup is in the past but inside the 14-day grace
  window. Still surface-able under the right scope.
- `past_stale` — past the grace window. Hidden by default; surfaced via
  the Stale-N recovery chip.
- `no_pickup` — no pickup date.

### SLA / age model

Surfaces use the existing freshness primitives in
`client/src/components/freight/freshness-pill.tsx` (signal pill rendering)
and `shared/pickupFreshness.ts` (date math). New code MUST go through
these — no per-surface re-implementations.

---

## B. Filter grammar

The filter bar across all three surfaces follows the same left-to-right
order and uses the same control names and copy:

```
[ Owner ] [ Customer ] [ Status / Bucket ] [ Pickup scope ] [ Sort ] [ Group ] [ Search ]
```

### Owner dropdown

Single ownership control. **No separate Account Manager filter.** The
canonical `OwnerFilterValue` union lives in
`shared/workflowOs/ownership.ts`:

```ts
type OwnerFilterValue =
  | "all"                              // default for managers
  | "me"                               // current user matches the row's ownership envelope
  | "am_book"                          // AM-aware sub-scope; see below
  | "unassigned"                       // no ownerUserId AND no delegatedToUserId
  | { specificUserId: string }
```

Options rendered in the dropdown:

1. `All owners` (default for managers)
2. `My freight` / `My lanes` / `My loads` — surface-specific copy,
   identical predicate (current user matches any id/email in the row's
   ownership envelope via `isRowOwnedByUser`).
3. `My AM's book` — Account Manager sub-scope. Matches rows whose company
   (`companyId → companies.assignedTo`) is the current user, OR the
   current user's `managerId`. So a NAM sees the books of the AMs that
   report to them, and an AM sees their own. This is the user's chosen
   compromise: AM-aware filtering lives **inside** the Owner dropdown
   rather than as a second filter, keeping the bar simple while preserving
   the AM dimension.
4. `Unassigned` — no `ownerUserId` AND no `delegatedToUserId`.
5. Divider, then `Specific user…` — list every org user whose role is in
   the canonical "rep-ish" set:
   `account_manager`, `national_account_manager`, `sales`,
   `sales_director`, `logistics_manager`, `logistics_coordinator`.
   Sorted by display name. Current user pinned to the top labeled `(me)`.

Implementation: `client/src/components/workflow-os/OwnerFilterSelect.tsx`.

### Pickup scope dropdown

`PickupScopeValue` union lives in `shared/workflowOs/actionability.ts`:

```ts
type PickupScopeValue = "actionable" | "upcoming" | "recent" | "all";
```

Options (first option is the new platform default):

- **Actionable** — surface-specific union of:
  - **Future** — `pickupFreshness === "upcoming"` (today or later,
    org-local TZ). Always visible.
  - **Soft-overdue** — `pickupFreshness === "past_recent"` AND pickup
    is within the last `SOFT_OVERDUE_HOURS` (default 24) AND status is
    in the canonical `ACTIONABLE_OPEN_STATUSES` set for the surface.
    Visible.
  - **Stale** — everything else past pickup. Hidden by default; surfaced
    via the recovery chip.
- **Upcoming only** — strict `pickupFreshness === "upcoming"`.
- **Recent (incl. soft-overdue)** — pre-spec default; preserved for
  callers that opt in.
- **All** — explicit escape hatch; used by the Stale-N recovery chip.

Implementation: `client/src/components/workflow-os/PickupScopeSelect.tsx`.

### Stale-N recovery chip

A `Stale: N` chip lives next to the pickup-scope select on every
surface whenever the actionable scope is hiding rows. Clicking it flips
the scope to `all` and reveals the suppressed rows in their stale-tinted
styling. Implementation: `client/src/components/workflow-os/StaleCountChip.tsx`.

The empty-state recovery chip (`Show stale / past-pickup (N)`) shares
the same wording across surfaces.

### Status / Bucket sets (context-specific)

Status is intentionally context-specific. The canonical bucket sets per
surface are:

| Surface          | Buckets |
| ---------------- | ------- |
| AF               | `pending_approval`, `ready_to_send`, `sent`, `awaiting_carrier_reply`, `partially_covered` |
| LWQ              | `unassigned`, `noContactable`, `assignedUntouched`, `inProgress` |
| Available Loads  | `available`, `pending`, `covered` |

Ad-hoc additions are forbidden. New buckets land in this table first.

---

## C. Selection grammar

- The same `useRowSelection<T>` hook
  (`client/src/hooks/workflow-os/useRowSelection.ts`) backs every
  surface's table.
- "Select all visible" / "Deselect all" / "Select page" / "Select
  shortlist only" controls live in the same position on every surface.
- Multi-select is always a `Set<string>` keyed by the row's stable id;
  **never by index, never by reference.**
- The selection bar appears as a sticky bottom bar at ≥1 selected, not as
  inline buttons in the table header. Same component on every surface
  (see section D).

---

## D. Bulk action bar

Source of truth: `client/src/components/workflow-os/BulkActionBar.tsx`
(generalized from the conversations bar; the conversations call site is
now a thin wrapper around it).

Standard slots:

- selection count (`N selected`)
- primary action
- secondary actions (in fixed left-to-right order)
- overflow (`…`) for surface-specific actions
- `Clear selection`

Bulk actions in the bar follow a fixed left-to-right order:

```
[ Outreach ] [ Reassign ] [ Snooze ] [ Tag / Status ] [ … ] [ Clear selection ]
```

Surface-specific actions go in the `…` overflow menu, never in front of
the canonical four. Standard copy: `N selected`, `Clear`,
`Select all visible (M)` expand affordance when only a page is selected.

---

## E. Outreach composer behavior

The shared `OutreachWorkspace` defined in Task #901 is the canonical
composer for any cross-surface bulk outreach.

- **Side-sheet vs full-workspace**: side-sheet at `<10` selected,
  full-workspace at `≥10` selected. Rep can override via the Expand
  control. Preference persisted in `localStorage.workflowOs.workspaceExpandPref`
  (key namespaced under `workflowOs` so future prefs share a root).
- Three-pane flow (`Recipients → Compose → Review & Send`) is
  mandatory.
- Segment vocabulary is fixed: **Shortlist**, **Pool**, **Rep-added**.
  Surfaces map their internal buckets onto these:

  | Surface          | Shortlist                                  | Pool                       | Rep-added            |
  | ---------------- | ------------------------------------------ | -------------------------- | -------------------- |
  | AF               | `proven` + `strong_fit_underused`          | `exploratory`              | `rep_added`          |
  | LWQ              | Ranked carriers                            | Bench carriers             | Manually imported    |
  | Available Loads  | Top-ranked union                           | Other suggested            | Manually added       |

`OutreachWorkspaceProps` is **frozen** by this spec (Task #901 owns the
component; #902 conforms). Future surfaces (Quote Requests, Carrier Hub,
etc.) MUST conform.

---

## F. Guardrail / suppression copy

Source of truth: `client/src/lib/workflow-os/guardrailCopy.ts`.

A single map keyed by reason:

| Reason                       | Short label              | Icon           |
| ---------------------------- | ------------------------ | -------------- |
| `recent_contact`             | Recently contacted       | `Clock`        |
| `daily_cap`                  | Daily cap reached        | `Clock`        |
| `not_approved`               | Not approved             | `ShieldAlert`  |
| `do_not_contact_lane`        | Do-not-contact (lane)    | `UserX`        |
| `customer_carrier_blocked`   | Customer-carrier blocked | `ShieldAlert`  |
| `throttled_too_soon`         | Throttled (too soon)     | `Clock`        |
| `throttled_daily_cap`        | Throttled (daily cap)    | `Clock`        |
| `dedup_skipped`              | Skipped (dedup)          | `Repeat`       |

Iconography rule: `ShieldAlert` for compliance, `UserX` for
do-not-contact, `Clock` for throttling, `Repeat` for dedup. **No surface
invents its own.**

---

## G. Saved views & URL state

Source of truth: `client/src/lib/workflow-os/savedViews.ts`.

Every filter in section B persists in the URL with the same query-param
names: `?owner=`, `?customer=`, `?status=`, `?pickupScope=`, `?sort=`,
`?group=`, `?q=`. Round-trip serializers (`serializeFiltersToUrl` /
`deserializeFiltersFromUrl`) are surface-agnostic.

Every filter persists in the per-user prefs row for the surface (AF
already has `cockpit_prefs`; LWQ and Available Loads will gain
equivalent rows in a future task — the spec defines the column shape but
this task does **not** create them).

`SavedView.filters` JSON shape accepts the same keys regardless of
surface; surface-specific keys go under a namespaced `surfaceSpecific`
object. The Zod schema in `savedViews.ts` enforces this.

Built-in saved view: every surface ships **"My work today"** with
`{ owner: "me", pickupScope: "actionable", sort: "pickup_soonest" (or surface-equivalent) }`.

---

## H. Keyboard model

One central registry: `client/src/hooks/useSharedLaneKeyboard.ts`. The
spec lists every shared key, marks it `shared: true`, and forbids
surface-local re-binding.

Canonical shared keys:

| Key   | Action                                                  |
| ----- | ------------------------------------------------------- |
| `j`   | Next row                                                |
| `k`   | Previous row                                            |
| `Enter` | Open the focused row                                  |
| `x`   | Toggle selection on focused row                         |
| `a`   | Select all visible                                      |
| `A`   | Deselect all (Shift+a)                                  |
| `b`   | Open bulk outreach                                      |
| `/`   | Focus search                                            |
| `g o` | Jump to Owner filter (chord — `g` then `o` within 1.5s) |
| `g p` | Jump to Pickup scope (chord — `g` then `p` within 1.5s) |
| `?`   | Show this cheat sheet                                   |

Chord sequences (`g o`, `g p`) are dispatched by the chord-aware
matcher in `useSharedLaneKeyboard`: the first key arms a 1.5s prefix,
the second completes the chord. If the second key isn't part of a
known chord, the matcher falls through to a single-key match for that
key. `g` itself is reserved as a chord prefix and never fires alone.

Plus the surface-shared keys carried over from Task #871 (`w` swap
surface, `c` open lane contacts, `n` add note, `L` open Lane Cockpit).

Every shortcut auto-appears in the existing
`keyboard-shortcuts-popover.tsx` cheat sheet on every surface (no
per-surface curation).

---

## I. Per-tab mapping table

Used as the checklist for the future cross-surface audit (Task D).

| Concern                          | Identical across AF / LWQ / Available Loads | Context-specific to surface |
| -------------------------------- | ------------------------------------------- | --------------------------- |
| Owner filter (control + values)  | ✅ via `OwnerFilterSelect`                   | Label only (`My freight` / `My lanes` / `My loads`) |
| Pickup scope (control + values)  | ✅ via `PickupScopeSelect`                   | `ACTIONABLE_OPEN_STATUSES` per surface |
| Stale-N recovery chip            | ✅ via `StaleCountChip`                      | — |
| Status / bucket set              | —                                           | ✅ per surface |
| Selection grammar                | ✅ via `useRowSelection`                     | — |
| Bulk action bar (slots + order)  | ✅ via `BulkActionBar`                       | Overflow menu items |
| Outreach composer                | ✅ via `OutreachWorkspace` (Task #901)       | Header context badge, candidate derivation |
| Guardrail copy + icons           | ✅ via `guardrailCopy`                       | — |
| Saved view shape + URL params    | ✅ via `savedViews`                          | `surfaceSpecific.*` keys |
| Keyboard registry                | ✅ via `useSharedLaneKeyboard`               | None (no per-surface re-binding allowed) |

---

## J. ADRs

### ADR-001 (2026-05-01) — Single Owner control with Account Manager-aware sub-scopes

Status: **Accepted**.

Context: AF (#900), LWQ, and Available Loads each had three slightly
different proposals for surfacing the Account Manager dimension —
either a second filter alongside Owner, or a "splitter widget" that
toggled the meaning of the existing Owner filter.

Decision: A **single Owner control** with five canonical options,
including an `My AM's book` sub-scope that matches rows whose company is
assigned to the current user **or** to a direct report of the current
user. Same control, same predicate, same copy across all three surfaces.

Consequence: The filter bar stays simple and identical across surfaces.
NAMs and AMs both get a one-click "everything tied to my book" view
without a second filter. Supersedes the "two filters" recommendation in
#900's UX notes and the "splitter widget" alternative.

### ADR-002 (2026-05-01) — Actionable as platform default pickup scope

Status: **Accepted**.

Context: The pre-spec default was `recent` (everything inside the 14-day
grace window). Operators consistently asked "what should I work right
now?" and the default queue answered "everything that hasn't aged out
yet" instead.

Decision: The platform default is **Actionable** = future pickups +
soft-overdue (within `SOFT_OVERDUE_HOURS = 24`, status in
`ACTIONABLE_OPEN_STATUSES`). Stale rows are hidden by default and
surfaced via the always-visible Stale-N chip and the empty-state
recovery chip.

Consequence: No separate `Actionable only` toggle — actionable is the
scope itself, not a modifier. Recovery is one click away. The chip count
is computed once on the server and shipped with the KPIs payload.

### ADR-003 (2026-05-01) — Outreach lives in a workspace, not a modal, once N≥10

Status: **Accepted**.

Context: Bulk outreach started life as a modal in conversations and a
side-sheet in AF. Reps with large selections (10–100 carriers) lost
context whenever the modal opened, and the side-sheet was too narrow to
review recipients + draft + audit in parallel.

Decision: Side-sheet at `<10` selected; full workspace at `≥10`. Rep can
override via the Expand control. Preference persisted under
`localStorage.workflowOs.workspaceExpandPref`.

Consequence: Three-pane workflow (`Recipients → Compose → Review & Send`)
becomes the canonical shape. Existing modal call sites migrate to the
workspace as part of #902.

### ADR-004 (2026-05-01) — Guardrail / suppression copy is centralized

Status: **Accepted**.

Context: Each surface had grown its own short labels for "this carrier
was throttled / blocked / deduped". Reps switching between surfaces saw
three different sentences for the same condition.

Decision: A single `guardrailCopy` map at
`client/src/lib/workflow-os/guardrailCopy.ts` owns the short label,
long explanation, and icon for every surface.

Consequence: No surface coins its own labels. Copy changes happen in one
place.

### ADR-005 (2026-05-01) — Saved views and URL state share a single key vocabulary

Status: **Accepted**.

Context: Saved views in AF used `ownerScope` / `statuses`; LWQ used
`bucket` / `assignee`. Sharing a saved view across surfaces was
impossible.

Decision: Shared keys are `owner`, `customer`, `status`, `pickupScope`,
`sort`, `group`, `q`. Surface-specific keys live under
`surfaceSpecific.<surface>.<key>` so cross-surface saved views still
round-trip cleanly.

Consequence: A "My work today" view authored on AF deserializes
correctly when applied on LWQ — only the surface-specific bits drop
gracefully.
