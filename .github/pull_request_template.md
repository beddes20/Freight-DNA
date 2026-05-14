## Summary
- What changed?
- Why was this needed?
- Which Freight-DNA surface(s) does this affect?

## Critical tabs impact
Check all that apply:

- [ ] Dashboard
- [ ] Available Freight
- [ ] User Roster
- [ ] Customer Quotes
- [ ] Conversations
- [ ] Lane Work Queue
- [ ] None of the critical tabs above

If any critical tab is affected, complete this section:

### Critical tabs contract
- [ ] I reviewed the Critical Tabs Contract before making this PR.
- [ ] This PR preserves trust, ownership, scoping, and freshness behavior.
- [ ] This PR does not weaken any existing guardrail or trust signal.
- [ ] If this PR changes a contract, I updated the relevant docs/tests/guardrails in the same PR.

### Trust / behavior notes
- Trust contract affected:
- What users will notice:
- Any risk of stale, misleading, or incorrectly scoped data:
- Any auth / org-scope / ownership implications:

## Stability checks
- [ ] Typecheck passed
- [ ] Build passed
- [ ] Relevant tests passed
- [ ] I verified no unrelated routes or shared contracts were changed accidentally

## Manual QA
List exactly what you tested.

- [ ] Landing page
- [ ] Login / auth behavior
- [ ] Dashboard
- [ ] Available Freight
- [ ] User Roster
- [ ] Customer Quotes
- [ ] Conversations
- [ ] Lane Work Queue

Notes:
- Environment tested:
- User role tested:
- URLs/routes tested:
- Screenshots or evidence:

## Shared-contract review
Check if this PR touches any shared contracts:

- [ ] `server/auth.ts`
- [ ] `client/src/hooks/use-auth.ts`
- [ ] `client/src/hooks/useLiveSync.ts`
- [ ] `freight_daily_upload_fact`
- [ ] `server/services/customerQuotes.ts`
- [ ] `processUserMailboxEmail`
- [ ] user lifecycle / Section 1126 guardrails
- [ ] none of the above

If any were touched:
- Explain exactly what changed:
- Why it is safe:
- What regression protection was added or updated:

## Rollout risk
- Risk level: Low / Medium / High
- Rollback plan:
- Anything that should block deploy:

## Reviewer focus
Please review especially:
- [ ] Trust / data honesty
- [ ] Ownership / access scope
- [ ] Freshness / stale-state behavior
- [ ] UI intuition / workflow clarity
- [ ] Regression risk on critical tabs
