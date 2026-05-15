# Customers Tab — Phase 0 Read-Only Bucket Audit

**Date:** 2026-05-15
**Mode:** READ-ONLY (no mutations; no schema changes; no app code touched)
**Source:** Production read replica via the database skill (`environment: "production"`)
**Scope:** Org-id `da3ed822-8846-4435-bb13-3cc4bf26f71d` (Value Truck — the only org with a real customer footprint; 304 of 320 default-visible companies system-wide)
**Subtask:** A — calibration data for Subtask B (Customers read-filter hardening)

---

## TL;DR (read this first)

1. **Bucket D dominates: 246 of 304 default-visible companies (≈81%) are thin-stub junk** — no owner, no manager, no salesperson, no industry, no notes, no contacts, no freight history. The Customers tab in production is overwhelmingly noise.
2. **Bucket A is zero by definition: production has zero rows in `freight_daily_upload_fact` for Value Truck.** The "we ship for them" half of the contract is currently unevaluable from data alone — every company that *should* qualify under (a) gets pushed into bucket B or D today.
3. **Bucket C (carriers showing as customers via name match) is zero — but misleading.** Only 9 carrier rows exist in production for this org, all clearly test fixtures. The *true* carrier pollution is hiding inside Bucket D under names like `Cargado`, `Chrobinson`, `Asaprotransinc`, `Bquickteam`, `Beyondfreightinc`, `Avisfreight`, `Cnwglobal`, `Daltruck`, `Deltaprimellc` — these are real-world carriers/freight-tech names that never made it into the `carriers` table, so a name-only carrier guard in `upsertCompany` (Subtask C) would *not* catch them.
4. **Bucket B = 58** — these are the real-looking customer rows (Mohawk Industries, Conagra, Honeywell, JBS, Dow Chemical, Nestle, Keurig, etc.) that just don't have freight history yet because the freight-fact table is empty. **The Subtask B filter must NOT cull these.**
5. **Implication for Subtask B:** the proposed thin-stub heuristic (D-shape) is correct and catches the right rows. The carrier-name guard (Subtask C) needs the carrier reference list it consults to grow before it provides real value — or it needs a fuzzy/keyword fallback (`*logistics`, `*freight`, `*trans*`, `*haul*`, …).

---

## Bucket counts (org `da3ed822-…`)

| Bucket | Definition | Count | Confidence | Auto-fix-safe? |
|---|---|---:|---|---|
| **A** — true customers we ship for | Default-visible company with ≥1 freight-fact row matching by `customer ↔ name`/`alias_normalized` | **0** | HIGH (data-empty) | YES — nothing to do |
| **B** — likely manual real customers | No freight history but has owner/manager/salesperson/industry/notes/contact | **58** | MEDIUM (heuristic) | NO — needs human review |
| **C** — carriers showing as customers (exact name match) | Default-visible company whose name matches a row in `carriers` for the same org | **0** | HIGH for exact match | YES — but irrelevant at this carrier-table size |
| **D** — thin-stub junk | Default-visible, no owner/manager/salesperson/industry/notes/contacts/freight | **246** | HIGH | YES — the Subtask B filter would hide these |
| **E** — only-bad-contacts | Company whose all non-deleted contacts have null/test/role-only emails | **3** | MEDIUM | NO — soft-delete contacts first, then re-bucket |
| **F** — contacts on non-customer companies | Active contacts whose parent is in C ∪ D | **0** | HIGH | N/A (none exist) |
| **G** — ambiguous (freight-fact customer name with no matching company) | Distinct `customer` values in fact table for this org with no company match | **0** | HIGH (data-empty) | N/A |

**Sanity totals (Value Truck):** companies = 315 · default-visible (not archived, not email-derived) = 304 · email-derived hidden by #1095 = 5 · archived = 6 · active contacts = 88 · carriers = 9 · freight-fact rows = 0.

**Sanity totals (system-wide):** companies = 331 · email-derived = 5 · archived = 6 · contacts (all orgs) = 135 · carriers = 9 · freight-fact rows = 9 (all 9 with `org_id IS NULL`, so they belong to no org's tab) · financial aliases = 0.

**Bucket-shape coverage check:** 0 (A) + 58 (B) + 246 (D) = 304 = default-visible total. Buckets A/B/D are mutually exclusive and exhaustive given the current data shape. C/E/F/G are overlay buckets that re-classify subsets of B/D.

---

## Exact queries run (verbatim)

All queries use `params: [ORG]` where `ORG = 'da3ed822-8846-4435-bb13-3cc4bf26f71d'`. None mutate.

### Schema discovery
```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('companies','contacts','carriers','freight_daily_upload_fact',
                      'company_financial_aliases','prospects','organizations','users');

SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name IN ('companies','contacts','carriers','freight_daily_upload_fact',
                      'company_financial_aliases')
 ORDER BY table_name, ordinal_position;
```
Confirmed: `companies.organization_id`, `carriers.org_id`, `freight_daily_upload_fact.org_id`,
`freight_daily_upload_fact.customer`, `company_financial_aliases.alias_normalized`,
`contacts.deleted_at`, `companies.archived_at` (text), `companies.is_email_derived`.
**No `companies.created_at` column exists** — the optional 14-day grace-period clause sketched in the prior audit is therefore not implementable as-is and will need a different signal (e.g., `email_derived_at`, or back-population of a real `created_at`) if Subtask B wants it.

### Bucket A — true customers we ship for
```sql
SELECT COUNT(*)::int AS bucket_a_count
FROM companies c
WHERE c.organization_id = $1
  AND (c.archived_at IS NULL OR c.archived_at = '')
  AND c.is_email_derived = false
  AND EXISTS (
    SELECT 1 FROM freight_daily_upload_fact f
     WHERE f.org_id = c.organization_id
       AND (
         lower(trim(f.customer)) = lower(trim(c.name))
         OR EXISTS (SELECT 1 FROM company_financial_aliases a
                     WHERE a.company_id = c.id
                       AND lower(a.alias_normalized) = lower(trim(f.customer)))
       )
  );
```

### Bucket B — likely manual real customers
```sql
SELECT COUNT(*)::int AS bucket_b_count
FROM companies c
WHERE c.organization_id = $1
  AND (c.archived_at IS NULL OR c.archived_at = '')
  AND c.is_email_derived = false
  AND NOT EXISTS (
    SELECT 1 FROM freight_daily_upload_fact f
     WHERE f.org_id = c.organization_id
       AND lower(trim(f.customer)) = lower(trim(c.name))
  )
  AND (
    c.owner_rep_id IS NOT NULL
    OR c.assigned_to IS NOT NULL
    OR c.sales_person_id IS NOT NULL
    OR c.industry IS NOT NULL
    OR c.notes IS NOT NULL
    OR EXISTS (SELECT 1 FROM contacts ct
                WHERE ct.company_id = c.id AND ct.deleted_at IS NULL)
  );
```

### Bucket C — carrier-name collisions (exact)
```sql
SELECT c.id, c.name, ca.id AS carrier_id, ca.name AS carrier_name,
       c.is_email_derived, c.archived_at, c.owner_rep_id
FROM companies c
JOIN carriers ca
  ON ca.org_id = c.organization_id
 AND lower(trim(ca.name)) = lower(trim(c.name))
WHERE c.organization_id = $1
  AND (c.archived_at IS NULL OR c.archived_at = '')
  AND c.is_email_derived = false
ORDER BY c.name LIMIT 100;
```

### Bucket D — thin-stub junk
```sql
SELECT COUNT(*)::int AS bucket_d_count
FROM companies c
WHERE c.organization_id = $1
  AND (c.archived_at IS NULL OR c.archived_at = '')
  AND c.is_email_derived = false
  AND c.owner_rep_id IS NULL
  AND c.assigned_to IS NULL
  AND c.sales_person_id IS NULL
  AND c.industry IS NULL
  AND c.notes IS NULL
  AND NOT EXISTS (SELECT 1 FROM contacts ct
                   WHERE ct.company_id = c.id AND ct.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM freight_daily_upload_fact f
                   WHERE f.org_id = c.organization_id
                     AND lower(trim(f.customer)) = lower(trim(c.name)));
```

### Bucket E — only-bad-contacts
```sql
SELECT COUNT(*)::int AS bucket_e_count
FROM (
  SELECT c.id
  FROM companies c
  JOIN contacts ct ON ct.company_id = c.id AND ct.deleted_at IS NULL
  WHERE c.organization_id = $1
  GROUP BY c.id
  HAVING COUNT(*) FILTER (
    WHERE ct.email IS NULL
       OR ct.email = ''
       OR ct.email ~* '^(noreply|no-reply|donotreply|postmaster|mailer-daemon|abuse|notifications?|alerts?|info|support)@'
       OR ct.email ~* '@(localhost|example\.com|test\.com|invalid)$'
  ) = COUNT(*)
) sub;
```

### Bucket F — contacts on non-customer companies (carriers ∪ thin stubs)
```sql
SELECT COUNT(*)::int AS bucket_f_count
FROM contacts ct
JOIN companies c ON c.id = ct.company_id
WHERE c.organization_id = $1
  AND ct.deleted_at IS NULL
  AND (c.archived_at IS NULL OR c.archived_at = '')
  AND c.is_email_derived = false
  AND (
    EXISTS (SELECT 1 FROM carriers ca
             WHERE ca.org_id = c.organization_id
               AND lower(trim(ca.name)) = lower(trim(c.name)))
    OR (
      c.owner_rep_id IS NULL AND c.assigned_to IS NULL AND c.sales_person_id IS NULL
      AND c.industry IS NULL AND c.notes IS NULL
      AND NOT EXISTS (SELECT 1 FROM freight_daily_upload_fact f
                       WHERE f.org_id = c.organization_id
                         AND lower(trim(f.customer)) = lower(trim(c.name)))
    )
  );
```

### Bucket G — ambiguous freight-fact customers with no matching company
```sql
SELECT COUNT(DISTINCT lower(trim(f.customer)))::int AS bucket_g_count
FROM freight_daily_upload_fact f
WHERE f.org_id = $1
  AND f.customer IS NOT NULL AND f.customer <> ''
  AND NOT EXISTS (
    SELECT 1 FROM companies c
     WHERE c.organization_id = f.org_id
       AND (lower(trim(c.name)) = lower(trim(f.customer))
            OR EXISTS (SELECT 1 FROM company_financial_aliases a
                        WHERE a.company_id = c.id
                          AND lower(a.alias_normalized) = lower(trim(f.customer))))
  );
```

---

## Sample rows (for spot-checking the heuristics)

### Bucket D sample (first 50 of 246) — these would be hidden by Subtask B
```
786logistics, AARV VENTURES LLC, AETSA LLC, Aaafreight, Abrahatransportation,
Acetransform, Adamsmoncrief, Agunlimited, Alandfgroup, Alaskafreight,
Alexandria Freight, Alpha West, Amada, Ambertrucks, Amexloginc,
Amongusinc, Armstrong, Arrivelogistics, Artellogistics, Asaprotransinc,
Avisfreight, BLAS Express Trucking, Bb8freight, Best3logistics, Beyondfreightinc,
Bhtrans, Biagroup, Bobbindotsllc, Bookstreamline, Bquickteam,
Brigatransport, Brittslms, Bzexpress, CALL WAVE LLC, CT Carrier,
Cargado, Cargoinc, Cbfreightinc, Celzyp LLC, Chrobinson,
Cloudtrucks Zendesk, Cnwglobal, Colibrexinc, Colibrifreight, DORAT LOGISTICS LLC,
Daltruck, Dayalslogisticsllc, Deltaprimellc, Denvercargoinc, Deotransit
```
**Pattern recognition:** Substantially all of these are CARRIERS, broker fronts, or freight-tech vendors masquerading as customers (`Chrobinson` = CH Robinson, `Cargado`, `Cloudtrucks Zendesk`, `Arrive logistics`, `BLAS Express Trucking`, `Bb8freight`, etc.). The naming convention (lowercase concat, no spaces, common freight-suffix) suggests they were auto-materialized from a sender-domain or a carrier-import upload mis-routed to the customer ingest path. **None appear in the `carriers` table by exact name** — Subtask C as currently scoped will not catch these.

### Bucket B sample (first 50 of 58) — these would NOT be hidden by Subtask B
```
Mohawk Industries (75 contacts), Apex Freight E2E Test, Browser Test Corp ABC,
ACUITY C/O RXO, Armstrong World Industries, 360 LION USA INC.,
ACH Food Companies Inc., ALF Inc, AMERICAN BOTTLING CO C/O RYDER LOGISTICS,
American Woodmark Corporation (AWC), BAE, BAY VALLEY FOODS, BLOOM ENERGY,
Ball Metal Beverage Container Corp, Brooklyn Bedding DBA Southerland,
CAL RANCH, Conagra, Covestro, DE WELL SUPPLY CHAIN MANAGEMENT, DOW CHEMICAL,
Ferrara, Ferrero, Food In Transit,
GMCCA (General Motors Customer Care & Aftermarket), HP HOOD CO,
Honeywell International Inc., Idahoan Foods, International Food Solutions,
J&J NURSURY, JBS FOODS, JCI (Johnson Control/Bosch), Keurig Green Mountain,
LX PANTOS, Lactalis American Group, MASONITE CORPORATION - MONTERREY,
MASONITE CORPORATION - US, MASONITE MEXICO SA DE CV, MKB Construction, MOHAWK,
MOTTS C/O RYDER FREIGHT BILL PROCESSING, MS International LLC, McCALL FARMS,
National Food Group, Nestle Purina Petcare C/O Cass, Nortek,
POOL CORP C/O CASS INFORMATION SYSTEMS, PRO PEAT, Rheem,
Rick Miles Produce Service Inc, Rock Run Industries
```
**Pattern recognition:** Real shipper names. The handful of obvious test rows (`Apex Freight E2E Test`, `Browser Test Corp ABC`) suggest a small fixture-cleanup task is also warranted, but it's tiny.

### Bucket E sample (3 rows)
```
ACUITY C/O RXO            → abc@example.com         (test data)
Armstrong World Industries → (null)                  (no email)
Browser Test Corp ABC     → (null) | (null)         (test data, no emails)
```
Two of the three are obvious test fixtures; the third is a real-named row with a contact missing an email.

### Carriers table (all 9 rows for Value Truck)
```
Cascade Logistics LLC, Dalmatian Inc E2E Test, Heartland Express Carriers,
Ironhorse Freight Lines, LWQ Test Carrier Alpha, LWQ Test Carrier Bravo,
LWQ Test Carrier Charlie, Patriot Haulers Inc, Summit Ridge Transport
```
All are LWQ test fixtures. None collide by exact name with anything in `companies`.

---

## What this means for Subtask B (don't act on this yet — awaiting approval)

1. **The thin-stub heuristic is the highest-value lever.** Hiding D removes ~81% of the noise (246/304) without touching any row that has any of the seven enrichment signals. Risk is low: a brand-new real customer with no enrichment yet would also be hidden, but reps can recover via the un-gated `POST /api/companies` (gotcha #1094).
2. **The exact-name carrier guard alone is insufficient.** With C=0 and the carrier table at 9 fixture rows, the guard would be a no-op against current pollution. The pollution is *carriers that were never registered as carriers in the first place.* Two follow-ups are worth considering for Subtask C — but only after Subtask B lands:
   - Add an `is_carrier` column on `companies` so that on a future carrier-import we can flip the flag for matching `companies` rows (rather than refusing the upsert that already happened).
   - Add a fuzzy / keyword fallback (`*logistics`, `*freight`, `*trans*`, `*haul*`) that surfaces matches in an admin review queue, not as a hard refusal.
3. **The Bucket B filter must stay broad.** Real customers without freight history (Mohawk, Conagra, Honeywell, JBS, Dow, Nestle, Keurig) all live in B today. Subtask B's filter is `keep IF (any-of-7-enrichment-signals) OR (has-freight-history)` — which is exactly what bucket B + bucket A together represent.
4. **Bucket E is small enough (3 rows) to address manually** after Subtask B lands. Two are obvious test fixtures; one needs a real contact email. No code change needed.
5. **Bucket F = 0 means we don't need a contact-cascade in this slice.** The contacts on non-customer parents simply don't exist today.
6. **Bucket G = 0 confirms the freight-fact table is genuinely empty for Value Truck**, not just unmatched. Subtask B's "we ship for them" half is currently a structural placeholder until production starts ingesting freight-fact rows again. Useful for Phase 4 (`created_via` design) but not blocking for Subtask B.

---

## Method audit

- **Read-only.** Every query above is `SELECT` only. No `UPDATE` / `INSERT` / `DELETE` / DDL was issued. Production environment was accessed via the database skill's `environment: "production"` (read-replica, SELECT-only by skill enforcement).
- **Org-scoped.** Every query carries `WHERE organization_id = $1` (or `org_id = $1` on tables that use that name). No cross-org data was returned.
- **Parameterized.** Every query that takes the org-id passes it via `params: [ORG]` — no string interpolation.
- **Reproducible.** Re-run any block above against `environment: "production"` to verify; counts will drift only as data changes.
- **Contracts unaffected.** No changes to `server/services/customerQuotes.ts`, `freight_daily_upload_fact` writers, `processUserMailboxEmail`, the `is_email_derived` filter, or any guardrail Section.
