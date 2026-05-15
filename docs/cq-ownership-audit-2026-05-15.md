# Customer Quotes Ownership Audit (Phase 1.1-A, 2026-05-15)

> **Read-only audit.** No production code, schema, or data was
> modified by this script (`tools/audit-cq-ownership.ts`). The
> queries are SELECT-only.

## What this measures

Every `quote_opportunities` row that passes today's CQ-2
customer-only chokepoint (`party_type='customer'` AND
`routing_status NOT IN ('auto_carrier','needs_routing')`) is
classified by comparing two ownership rules applied to the
same CRM company (bridged via canonical `companies.name = 
quote_customers.name` — the exact match `loadContext` uses):

- **CQ rule (CQ-3 strict):** `companies.owner_rep_id` only.
  This is what `enrich()`'s `ownerRepNameByCustomerId` map
  surfaces in `/quote-requests` today.
- **Canonical rule (Customers tab + auth visibility):**
  `COALESCE(owner_rep_id, assigned_to, sales_person_id)` —
  the chain pinned by `getCanonicalCompanyOwnerId(c)` in
  `server/lib/companyOwner.ts`.

Buckets:

- `agree` — both rules return the same user id (or both null).
  In practice this means `owner_rep_id` is set; the canonical
  rule's first arm is the CQ rule, so when CQ has an answer
  the canonical rule must agree.
- `customers_only` — CQ shows no owner (`owner_rep_id IS NULL`)
  but the canonical chain resolves to a user via `assigned_to`
  or `sales_person_id`. **This is the cross-surface divergence
  we're quantifying** (CQ-G1, CQ-G10).
- `cq_only` — sanity check; should be 0 by construction.
- `both_unowned` — neither rule resolves an owner. CQ shows
  "Unowned"; Customers tab shows "Unowned". The two
  surfaces agree (and the underlying account has no owner
  on any column).
- `no_company_link` — `quote_customers.name` doesn't match any
  `companies.name` in the same org. The divergence question
  doesn't apply (no CRM company exists), but the count is
  reported as a denominator-of-truth.

## Grand totals across all orgs

Total visible quote rows: **21961**

| Bucket | Count | % |
|---|---:|---:|
| agree | 3 | 0.0% |
| customers_only | 337 | 1.5% |
| cq_only | 0 | 0.0% |
| both_unowned | 13749 | 62.6% |
| no_company_link | 7872 | 35.8% |

## Per-org breakdown

### Value Truck (`valuetruck`)

Total visible quote rows (CQ-2 customer-only): **21961**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 3 | 0.0% |
| customers_only | 337 | 1.5% |
| cq_only | 0 | 0.0% |
| both_unowned | 13749 | 62.6% |
| no_company_link | 7872 | 35.8% |

**Sample — customers_only** (up to 8):

  - `5efda7c1` cust=`a7a87c07` name="Linamar" comp=`06f95571` cq=∅ can=ab519005 routing=auto_customer outcome=no_response src=email rep=∅
  - `80437b9a` cust=`a7a87c07` name="Linamar" comp=`06f95571` cq=∅ can=ab519005 routing=auto_customer outcome=no_response src=email rep=∅
  - `dbe0d14b` cust=`a7a87c07` name="Linamar" comp=`06f95571` cq=∅ can=ab519005 routing=auto_customer outcome=no_response src=email rep=∅
  - `b37a111c` cust=`d7a07635` name="Potandon" comp=`1fc29e44` cq=∅ can=d6be3eca routing=auto_customer outcome=won src=email rep=5a3bf386
  - `f9f146ca` cust=`d7a07635` name="Potandon" comp=`1fc29e44` cq=∅ can=d6be3eca routing=auto_customer outcome=pending src=email rep=b0212a4c
  - `cfb28d5a` cust=`a7a87c07` name="Linamar" comp=`06f95571` cq=∅ can=ab519005 routing=auto_customer outcome=no_response src=email rep=∅
  - `ea049fe0` cust=`a7a87c07` name="Linamar" comp=`06f95571` cq=∅ can=ab519005 routing=auto_customer outcome=no_response src=email rep=∅
  - `26fee4e2` cust=`a7a87c07` name="Linamar" comp=`06f95571` cq=∅ can=ab519005 routing=auto_customer outcome=no_response src=email rep=∅

**Sample — both_unowned** (up to 8):

  - `88a49134` cust=`05073866` name="Nybctruckingllc" comp=`26200c9a` cq=∅ can=∅ routing=auto_customer outcome=pending src=email rep=∅
  - `879c8b6e` cust=`8f6b8daa` name="Igtransportation" comp=`5bebde15` cq=∅ can=∅ routing=auto_customer outcome=pending src=email rep=de87dd99
  - `12ff2848` cust=`3461099c` name="Valuetruck" comp=`51cf299f` cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=7395e935
  - `f81d38ac` cust=`41b4f77a` name="Rxo" comp=`7d2bca02` cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=88279e84
  - `2db3e066` cust=`2270317b` name="Tms Blujaysolutions" comp=`5b2bae00` cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=74e9e7ca
  - `db706efd` cust=`8f6b8daa` name="Igtransportation" comp=`5bebde15` cq=∅ can=∅ routing=auto_customer outcome=pending src=email rep=de87dd99
  - `68451f51` cust=`7d91f604` name="Bzexpress" comp=`dbbe0be9` cq=∅ can=∅ routing=auto_customer outcome=pending src=email rep=b0212a4c
  - `20ba15ac` cust=`41b4f77a` name="Rxo" comp=`7d2bca02` cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=d8eb1b25

**Sample — no_company_link** (up to 8):

  - `d19bea81` cust=`6c1b2745` name="Ff Haulers" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=∅
  - `ddf9cf3f` cust=`ed4440d2` name="Echo" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=97337081
  - `f907812e` cust=`6b694e70` name="Totalmaterials" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=∅
  - `79117cfb` cust=`6c1b2745` name="Ff Haulers" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=∅
  - `788195f7` cust=`23fc9e85` name="Topbulltrucking" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=7cf30910
  - `7bdc677c` cust=`226d523d` name="Englandlogistics" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=30c78578
  - `9efbc504` cust=`ed4440d2` name="Echo" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=97337081
  - `f519d245` cust=`d65e0354` name="Roguecarrierinc" comp=∅ cq=∅ can=∅ routing=auto_customer outcome=no_response src=email rep=de87dd99

### Hero Loop Test 1778076248475 (`hero-loop-test-1778076248475`)

Total visible quote rows (CQ-2 customer-only): **0**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 0 | — |
| customers_only | 0 | — |
| cq_only | 0 | — |
| both_unowned | 0 | — |
| no_company_link | 0 | — |

### Hero Loop Test 1778076248538 (`hero-loop-test-1778076248538`)

Total visible quote rows (CQ-2 customer-only): **0**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 0 | — |
| customers_only | 0 | — |
| cq_only | 0 | — |
| both_unowned | 0 | — |
| no_company_link | 0 | — |

### Hero Loop Test 1778076248320 (`hero-loop-test-1778076248320`)

Total visible quote rows (CQ-2 customer-only): **0**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 0 | — |
| customers_only | 0 | — |
| cq_only | 0 | — |
| both_unowned | 0 | — |
| no_company_link | 0 | — |

### Hero Loop Test 1778076222051 (`hero-loop-test-1778076222051`)

Total visible quote rows (CQ-2 customer-only): **0**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 0 | — |
| customers_only | 0 | — |
| cq_only | 0 | — |
| both_unowned | 0 | — |
| no_company_link | 0 | — |

### Hero Loop Test 1778076222109 (`hero-loop-test-1778076222109`)

Total visible quote rows (CQ-2 customer-only): **0**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 0 | — |
| customers_only | 0 | — |
| cq_only | 0 | — |
| both_unowned | 0 | — |
| no_company_link | 0 | — |

### Hero Loop Test 1778076221906 (`hero-loop-test-1778076221906`)

Total visible quote rows (CQ-2 customer-only): **0**

| Bucket | Count | % of total |
|---|---:|---:|
| agree | 0 | — |
| customers_only | 0 | — |
| cq_only | 0 | — |
| both_unowned | 0 | — |
| no_company_link | 0 | — |


---

## Out of scope for this audit

- No production code paths were changed.
- No data was written.
- No tests / guardrails were modified.
- The Mine Only resolver semantics (CQ-G2) were not exercised
  here — that lands in P1.1-D.
- Cross-surface owner-display parity beyond Customers vs
  Quote Requests (e.g. Top Opps, Dashboard) is out of scope.
- No recommendation is made here whether to document the
  divergence as intentional (P1.1-F) or schedule unification
  under Task #1169. Decision is the human's based on the
  numbers above.
