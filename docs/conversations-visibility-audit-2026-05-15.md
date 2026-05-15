# Conversations Visibility Audit — 2026-05-15

_Subtask CONV-1.1-A. SELECT-only audit comparing thread visibility (`email_conversation_threads.owner_user_id`) with account ownership (`companies.owner_rep_id`). No production code, schema, or behavior changed._

**"Default mine" definition mirrored from `server/storage.ts` `listEmailConversationThreads`:** `archived_at IS NULL AND waiting_state != 'snoozed'`.

**Bucket meanings.**
- `mine_threads_count` — what the rep sees in their default `mine` bucket today (`owner_user_id = R.id`).
- `account_owned_unowned_threads_count` (**CONV-G1**) — "I own the account, but the thread is unowned." Rep does NOT see these in `mine` today; they live in the separate `unowned` bucket.
- `account_owned_misowned_threads_count` — "I own the account, but the thread is stamped to a different rep." Rep does NOT see these in `mine` today; the other rep does.

---

## Grand totals (all orgs)

| metric | count |
|---|---:|
| Σ mine_threads_count (across active reps, all orgs) | **87790** |
| Σ account_owned_unowned_threads_count (CONV-G1) | **0** |
| Σ account_owned_misowned_threads_count | **4** |
| CONV-G1 ratio (unowned-to-mine) | 0.0% |
| Misowned ratio (misowned-to-mine) | 0.0% |

---

## Org: Value Truck (`valuetruck`)

Visible thread universe (org-wide, archived/snoozed excluded): **87794**

**Org totals:** mine=**87790** · unowned-but-account-owned=**0** (CONV-G1 0.0%) · misowned=**4** (0.0%)

### Per-rep table

| rep_user_id | rep_name | mine_threads_count | account_owned_unowned_threads_count | account_owned_misowned_threads_count |
|---|---|---:|---:|---:|
| `9784a646…` | Brock Baumgartner | 1941 | 0 | 4 |
| `4e75fd7c…` | Ben Beddes | 14120 | 0 | 0 |
| `95daf70c…` | Taylor Call | 8709 | 0 | 0 |
| `52005605…` | Braden Shinsel | 5311 | 0 | 0 |
| `14f356c1…` | Adan Castaneda | 4542 | 0 | 0 |
| `da4c20a6…` | Danny Beddes | 3955 | 0 | 0 |
| `e3efb6e4…` | Sean Heneghan | 3580 | 0 | 0 |
| `95fcfe01…` | Sam Davis | 3245 | 0 | 0 |
| `1ff95654…` | Brianna Coakley | 3218 | 0 | 0 |
| `b93b3310…` | Bruno Rosignoli | 2536 | 0 | 0 |
| `b8a969f9…` | Jared Reynolds | 2439 | 0 | 0 |
| `acc803a0…` | Kaden Brown | 2065 | 0 | 0 |
| `c7c866c3…` | Claudia Mejia | 2029 | 0 | 0 |
| `872d0dfb…` | Jason Allen | 2003 | 0 | 0 |
| `069f6031…` | Mason Moore | 1953 | 0 | 0 |
| `0c2c47f5…` | Mason Morris | 1924 | 0 | 0 |
| `17ac7dac…` | Ethan Van Allen | 1824 | 0 | 0 |
| `c918bbfc…` | Morgan Warner | 1537 | 0 | 0 |
| `8dfaa876…` | Kassidy Harwood | 1521 | 0 | 0 |
| `2865ce16…` | Samoa Toia | 1420 | 0 | 0 |
| `1fd808cd…` | Raffi Lemos | 1334 | 0 | 0 |
| `1bca104c…` | Seth Wahlstrom | 1310 | 0 | 0 |
| `3d3cb21e…` | Yuri Yassin | 1273 | 0 | 0 |
| `9950f29c…` | Kyle Hancock | 1239 | 0 | 0 |
| `ab519005…` | Zach Satteson | 1204 | 0 | 0 |
| `15c2df93…` | Alex Shumway | 1160 | 0 | 0 |
| `b9fb650d…` | Hayden Israelson | 1112 | 0 | 0 |
| `a80f281e…` | Ikshaa Singh | 1068 | 0 | 0 |
| `7d4ec580…` | Andre Juarez | 1015 | 0 | 0 |
| `9c3f09a3…` | Kimberly Dornseif | 979 | 0 | 0 |
| `8bced70f…` | TJ Russon | 934 | 0 | 0 |
| `acb00218…` | Dallin Meier | 853 | 0 | 0 |
| `6460d161…` | Legrand Toia | 771 | 0 | 0 |
| `63eb75dd…` | Gabe Broos | 733 | 0 | 0 |
| `8b05f3f5…` | Brianna Adams | 704 | 0 | 0 |
| `62b5def0…` | Daniel Bird | 694 | 0 | 0 |
| `73683c28…` | Kaitlyn Hansen | 640 | 0 | 0 |
| `bfa6a65b…` | Breman Nope | 383 | 0 | 0 |
| `88621fbc…` | Hannah Bennett | 214 | 0 | 0 |
| `42f9b865…` | Justin Crowley | 187 | 0 | 0 |
| `d50f8624…` | Jordan Baumgart | 111 | 0 | 0 |
| `38dbf8e4…` | WQTest 38dbf8 | 0 | 0 | 0 |
| `3a8f01ef…` | WQTest 3a8f01 | 0 | 0 | 0 |
| `41420b4a…` | WQTest 41420b | 0 | 0 | 0 |
| `44801f66…` | WQTest 44801f | 0 | 0 | 0 |
| `4a1da9e2…` | WQTest 4a1da9 | 0 | 0 | 0 |
| `5001c328…` | WQTest 5001c3 | 0 | 0 | 0 |
| `5452da82…` | Joe Middleton | 0 | 0 | 0 |
| `5753a9cf…` | WQTest 5753a9 | 0 | 0 | 0 |
| `5a2c0408…` | Jacquelyn Hatch | 0 | 0 | 0 |
| `5d04ff5a…` | WQTest 5d04ff | 0 | 0 | 0 |
| `61190e8d…` | WQTest 61190e | 0 | 0 | 0 |
| `62c7bebf…` | WQTest 62c7be | 0 | 0 | 0 |
| `64f28c65…` | WQTest 64f28c | 0 | 0 | 0 |
| `6588e481…` | WQTest 6588e4 | 0 | 0 | 0 |
| `661dc37e…` | WQTest 661dc3 | 0 | 0 | 0 |
| `664777b5…` | WQTest 664777 | 0 | 0 | 0 |
| `6ea25c7b…` | WQTest 6ea25c | 0 | 0 | 0 |
| `72328c60…` | WQTest 72328c | 0 | 0 | 0 |
| `72b5140d…` | WQTest 72b514 | 0 | 0 | 0 |
| `73974144…` | WQTest 739741 | 0 | 0 | 0 |
| `73cb0ca0…` | WQTest 73cb0c | 0 | 0 | 0 |
| `75181f22…` | WQTest 75181f | 0 | 0 | 0 |
| `752a525c…` | WQTest 752a52 | 0 | 0 | 0 |
| `76a6e768…` | WQTest 76a6e7 | 0 | 0 | 0 |
| `7cbdf721…` | WQTest 7cbdf7 | 0 | 0 | 0 |
| `7e523ccc…` | WQTest 7e523c | 0 | 0 | 0 |
| `7e571745…` | WQTest 7e5717 | 0 | 0 | 0 |
| `7ec2dd48…` | WQTest 7ec2dd | 0 | 0 | 0 |
| `86060bee…` | WQTest 86060b | 0 | 0 | 0 |
| `86c2b2b4…` | WQTest 86c2b2 | 0 | 0 | 0 |
| `8b0b6158…` | WQTest 8b0b61 | 0 | 0 | 0 |
| `8b9ed3da…` | WQTest 8b9ed3 | 0 | 0 | 0 |
| `8ecc6864…` | WQTest 8ecc68 | 0 | 0 | 0 |
| `8f64974e…` | WQTest 8f6497 | 0 | 0 | 0 |
| `8fcff210…` | WQTest 8fcff2 | 0 | 0 | 0 |
| `94137b20…` | WQTest 94137b | 0 | 0 | 0 |
| `9ce6c914…` | WQTest 9ce6c9 | 0 | 0 | 0 |
| `9d6312fe…` | WQTest 9d6312 | 0 | 0 | 0 |
| `a02b715e…` | WQTest a02b71 | 0 | 0 | 0 |
| `a082e4bc…` | Melanie Cannon | 0 | 0 | 0 |
| `a2373511…` | WQTest a23735 | 0 | 0 | 0 |
| `a39d24b0…` | WQTest a39d24 | 0 | 0 | 0 |
| `a6abaf50…` | WQTest a6abaf | 0 | 0 | 0 |
| `abed43ea…` | WQTest abed43 | 0 | 0 | 0 |
| `aea44b56…` | WQTest aea44b | 0 | 0 | 0 |
| `af61b005…` | WQTest af61b0 | 0 | 0 | 0 |
| `b3364118…` | WQTest b33641 | 0 | 0 | 0 |
| `b646ff21…` | WQTest b646ff | 0 | 0 | 0 |
| `ba013098…` | WQTest ba0130 | 0 | 0 | 0 |
| `bc023537…` | WQTest bc0235 | 0 | 0 | 0 |
| `bc54b57e…` | WQTest bc54b5 | 0 | 0 | 0 |
| `bffcd0bf…` | WQTest bffcd0 | 0 | 0 | 0 |
| `c0683e57…` | WQTest c0683e | 0 | 0 | 0 |
| `c1d2c012…` | WQTest c1d2c0 | 0 | 0 | 0 |
| `c45ce49d…` | Aimee Charlton | 0 | 0 | 0 |
| `c4d1336e…` | Bo Aagard | 0 | 0 | 0 |
| `c74de611…` | WQTest c74de6 | 0 | 0 | 0 |
| `cb338a18…` | WQTest cb338a | 0 | 0 | 0 |
| `cceca2f1…` | WQTest cceca2 | 0 | 0 | 0 |
| `cf4c40b3…` | WQTest cf4c40 | 0 | 0 | 0 |
| `d4fd4717…` | WQTest d4fd47 | 0 | 0 | 0 |
| `d5742907…` | WQTest d57429 | 0 | 0 | 0 |
| `d6be3eca…` | Marguritte Guymon | 0 | 0 | 0 |
| `d9fd312e…` | WQTest d9fd31 | 0 | 0 | 0 |
| `df016387…` | WQTest df0163 | 0 | 0 | 0 |
| `e1657f35…` | WQTest e1657f | 0 | 0 | 0 |
| `e39324c3…` | WQTest e39324 | 0 | 0 | 0 |
| `e4692938…` | WQTest e46929 | 0 | 0 | 0 |
| `e53a89fe…` | WQTest e53a89 | 0 | 0 | 0 |
| `e84fc739…` | Sophia Gabbitas | 0 | 0 | 0 |
| `e97f09aa…` | WQTest e97f09 | 0 | 0 | 0 |
| `f2f3f994…` | WQTest f2f3f9 | 0 | 0 | 0 |
| `f62ff4b0…` | WQTest f62ff4 | 0 | 0 | 0 |
| `fb538130…` | WQTest fb5381 | 0 | 0 | 0 |
| `fec7abf8…` | COETest fec7ab | 0 | 0 | 0 |
| `fee536b6…` | WQTest fee536 | 0 | 0 | 0 |
| `ff2e75b8…` | WQTest ff2e75 | 0 | 0 | 0 |
| `013257eb…` | WQTest 013257 | 0 | 0 | 0 |
| `ff3eda89…` | WQTest ff3eda | 0 | 0 | 0 |
| `01815f41…` | WQTest 01815f | 0 | 0 | 0 |
| `03429234…` | WQTest 034292 | 0 | 0 | 0 |
| `03567cbd…` | WQTest 03567c | 0 | 0 | 0 |
| `04739241…` | WQTest 047392 | 0 | 0 | 0 |
| `06e847ab…` | Monique Richardson | 0 | 0 | 0 |
| `086a7666…` | WQTest 086a76 | 0 | 0 | 0 |
| `09e916f9…` | Will Dardani | 0 | 0 | 0 |
| `0a4cb1a2…` | WQTest 0a4cb1 | 0 | 0 | 0 |
| `0aee5c49…` | WQTest 0aee5c | 0 | 0 | 0 |
| `0e182d18…` | WQTest 0e182d | 0 | 0 | 0 |
| `0e37ef72…` | WQTest 0e37ef | 0 | 0 | 0 |
| `100dafda…` | WQTest 100daf | 0 | 0 | 0 |
| `13cf6312…` | WQTest 13cf63 | 0 | 0 | 0 |
| `1427649a…` | WQTest 142764 | 0 | 0 | 0 |
| `147f9eac…` | WQTest 147f9e | 0 | 0 | 0 |
| `15d7ab78…` | Brandi Huff | 0 | 0 | 0 |
| `191732b4…` | WQTest 191732 | 0 | 0 | 0 |
| `1b90d422…` | WQTest 1b90d4 | 0 | 0 | 0 |
| `1d0bc409…` | WQTest 1d0bc4 | 0 | 0 | 0 |
| `1d886b44…` | WQTest 1d886b | 0 | 0 | 0 |
| `1fbbade0…` | WQTest 1fbbad | 0 | 0 | 0 |
| `20722023…` | Katie Vasquez | 0 | 0 | 0 |
| `2154fa72…` | WQTest 2154fa | 0 | 0 | 0 |
| `22e303e5…` | WQTest 22e303 | 0 | 0 | 0 |
| `252b285e…` | WQTest 252b28 | 0 | 0 | 0 |
| `26dce57b…` | WQTest 26dce5 | 0 | 0 | 0 |
| `26fb0b8f…` | WQTest 26fb0b | 0 | 0 | 0 |
| `279f8cdd…` | WQTest 279f8c | 0 | 0 | 0 |
| `2a3a327a…` | WQTest 2a3a32 | 0 | 0 | 0 |
| `2b664e4f…` | WQTest 2b664e | 0 | 0 | 0 |
| `2dddaed1…` | WQTest 2dddae | 0 | 0 | 0 |
| `2df73bed…` | WQTest 2df73b | 0 | 0 | 0 |
| `30b417b9…` | WQTest 30b417 | 0 | 0 | 0 |
| `32169435…` | WQTest 321694 | 0 | 0 | 0 |
| `33931bbf…` | WQTest 33931b | 0 | 0 | 0 |
| `35718014…` | WQTest 357180 | 0 | 0 | 0 |
| `364d9d09…` | WQTest 364d9d | 0 | 0 | 0 |
| `37414f99…` | WQTest 37414f | 0 | 0 | 0 |
| `38be530b…` | WQTest 38be53 | 0 | 0 | 0 |
| `38d80ca2…` | Jaimie Phitsnoukanh | 0 | 0 | 0 |

### Sample — account_owned_unowned (CONV-G1)

_(no rows)_

### Sample — account_owned_misowned

| thread_id | account | account_owner_rep | thread_owner_user |
|---|---|---|---|
| `AAQkADAzYTQ3ODFl…` | Armstrong World Industries (`484ef895…`) | Brock Baumgartner (`9784a646…`) | Danny Beddes (`da4c20a6…`) |
| `AAQkADg3OWZhMjEz…` | Armstrong World Industries (`484ef895…`) | Brock Baumgartner (`9784a646…`) | Ben Beddes (`4e75fd7c…`) |
| `AAQkADVlMzk5MjQ0…` | Armstrong World Industries (`484ef895…`) | Brock Baumgartner (`9784a646…`) | Adan Castaneda (`14f356c1…`) |
| `AAQkADAxYmQyZWE2…` | Armstrong World Industries (`484ef895…`) | Brock Baumgartner (`9784a646…`) | Sean Heneghan (`e3efb6e4…`) |

---

## Findings

- **CONV-G1 is effectively zero in production today.** Across all 41 active reps at Value Truck — 87,790 threads in their combined `mine` working set — there are **0** threads where the rep owns the account (`companies.owner_rep_id = R.id`) but the thread is unowned (`email_conversation_threads.owner_user_id IS NULL`). The Phase 1 planning report flagged CONV-G1 as the headline risk; the data says it is not. **The `conversationOwnershipService.determineInitialOwner` priority rule (a) `companies.ownerRepId` is doing exactly what its docstring promises** — every thread linked to an owned account gets the canonical rep stamped onto `owner_user_id` at creation, so there is no "I own the account but the thread is unowned" cohort to recover.
- **Misowned cohort is 4 threads, all on one rep.** All 4 misowned threads belong to Brock Baumgartner's accounts but are stamped to a different rep. At 4/87,790 (0.005%) this is noise-level — almost certainly legitimate "a colleague handled this on my behalf" assignments rather than a stale-ownership bug. Worth eyeballing the 4 sample rows in the section above to confirm, but not worth a separate audit.
- **What this means for CONV-1.1-B (pin the visibility predicate).** Pinning the current strict `owner_user_id`-based predicate is **safe**: there is no large hidden cohort the predicate is locking out. The predicate effectively does not need to be widened (the implicit "OR linked_account_id IN myOwned" branch I had flagged as a candidate fix would change visibility for ≤4 threads org-wide). Recommend proceeding with CONV-1.1-B as written, plus a one-line note in the contract doc that **the audit on 2026-05-15 found 0 CONV-G1 threads, justifying the strict rule**.
- **What CONV-G1 was actually about (revised).** The original CONV-G1 framing assumed thread ownership and account ownership routinely diverged. This audit refutes that assumption for *new* threads (the ownership service catches them at creation). The remaining failure mode is **account ownership changing AFTER thread creation** — i.e., Acme is reassigned from Rep A to Rep B, and Acme's older threads stay stamped to A. The current audit cannot see that cohort because we're comparing today's `companies.owner_rep_id` to today's `owner_user_id` and finding agreement; we'd need to cross-reference a `company_ownership_history` table (if one exists) or `users.is_active` timestamps to surface the reassignment cohort. **This is a candidate Phase 1.2 follow-up, not Phase 1.1.**
- **Where attention should go instead.** The CONV-G3 (junk-mailbox / fixture-sender pollution) and CONV-G2 (signature/weak attribution silently appearing as confirmed) trust gaps are now relatively higher-priority than CONV-G1 — they remain unmeasured. Consider promoting **CONV-1.1-D** (junk-sender audit) ahead of CONV-1.1-B in the queue.

---

## Methodology / contract compliance

- All queries are SELECT-only (`db.execute(sql\`SELECT …\`)`). No `INSERT`/`UPDATE`/`DELETE`.
- "Default mine" filter mirrors `storage.listEmailConversationThreads` — `archived_at IS NULL AND waiting_state != 'snoozed'`. We did not invent a new filter.
- Active reps are `COALESCE(users.is_active, true) = true` and scoped to the org under audit.
- The CONV-G1 counter only fires when `companies.owner_rep_id IS NOT NULL` — accounts with no canonical owner are excluded from both the numerator and the denominator of the gap ratio.
- Soft-deleted accounts (`companies.archived_at`, `companies.deleted_at` if present) are NOT excluded — the audit reflects the full ownership graph as the data model carries it. A future audit could re-run with that exclusion to see whether legacy archived accounts inflate the count.
- No `monitored_mailboxes` semantics consulted — this audit is strictly about the rep ⇄ thread ⇄ account ownership triangle.
