# AM Playbook — File Format & App Surface Reference

This directory contains the Value Truck Account Manager Playbook in two formats:

| File | Description |
|---|---|
| `am-playbook.md` | Full playbook in Markdown — human-readable, one section per `##` heading |
| `am-playbook.json` | Structured JSON — machine-readable, consumed by the app by section |

---

## JSON Structure

The JSON file (`am-playbook.json`) follows this top-level shape:

```json
{
  "version": "1.0",
  "role": "AM",
  "lastUpdated": "<ISO date>",
  "sections": { ... }
}
```

### Section Descriptions

| Section key | Description |
|---|---|
| `purpose` | Playbook mission statement with `summary` and `body` |
| `roleExpectations` | Core responsibilities and performance levels (Good / Great / Elite) as `items` array |
| `newAccountHandoff` | `checklist` for the first 48 hours + `scripts` for onboarding call and follow-up email |
| `plan306090` | Actions and scorecards for days `30`, `60`, and `90` of a new account |
| `cadence` | Operating rhythm broken into `daily`, `weekly`, and `monthly` action lists |
| `relationshipStages` | Baseball-diamond model — array of `{ stage, signals[], actions[] }` objects |
| `growthLevers` | The 5 levers for account expansion as a flat string array |
| `qbr` | QBR `agenda` array + `scripts` array for talk tracks |
| `escalation` | `triggers` array (what to escalate) + `steps` array (how to respond by tier) |
| `crmStandards` | `fields` (required CRM data) + `rules` (daily logging requirements) |
| `kpiScorecard` | Array of `{ metric, target, cadence }` objects for all tracked KPIs |
| `coachingCadence` | Manager coaching structure with `frequency`, `agenda`, and `managerActions` |
| `scripts` | All standalone scripts as `{ id, context, label, body }` — lookup by `context` or `id` |

---

## App Surface Mapping

| Section | App Surface |
|---|---|
| `cadence.daily` | Dashboard — daily checklist portlet |
| `kpiScorecard` | Dashboard — KPI scorecard widget; Manager coaching pages |
| `newAccountHandoff` | Account page — handoff checklist + scripts panel |
| `relationshipStages` | Account page — relationship stage indicator; Contact relationship view |
| `growthLevers` | Account page — growth levers panel; Contact relationship view |
| `scripts` | Pre-call planner — script lookup by `context` field |
| `qbr` | QBR workflow — agenda builder + talk tracks |
| `coachingCadence`, `plan306090` | Manager coaching pages |
| `escalation` | Account page — escalation playbook panel |
| `crmStandards` | CRM standards reference (account + contact pages) |

---

## Content Not in the JSON Schema

The playbook source contains two additional sections that are fully represented in `am-playbook.md` but do not have dedicated JSON keys in `v1.0`:

- **Section 10 — Internal Communication & Collaboration** (daily LM/LC sync, weekly leadership sync, PTO handoff protocol)
- **The Value Truck Standard** closing statement

These sections are preserved verbatim in the Markdown file. If app surfaces need to consume them, add new keys (e.g., `internalCoordination`, `closingStatement`) in a future version bump and update the app surface mapping table below.

---

## Updating This Playbook

- The Markdown file (`am-playbook.md`) is the source of truth for content edits.
- After any content change to `am-playbook.md`, update `am-playbook.json` to reflect the same changes.
- Update the `lastUpdated` field in the JSON whenever either file is modified.
- Do not add keys to the JSON that are not listed in this README without updating the app surface mapping table.
