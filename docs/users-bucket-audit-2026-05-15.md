# Users Roster Audit — 2026-05-15

**Subtask A of the Users Trust Cleanup Program.** Read-only snapshot from the existing Phase 0 `getRosterHealthSnapshot` classifier (`server/lib/userRosterClassification.ts`). No writes; no schema; no flag flips.

**"Default-roster leakage"** = users who currently pass the existing `GET /api/users` default filter (Section 1126 Phase 1 Step 4a-API: lifecycle-clean) BUT are classified as one of `likely_junk` / `likely_demo_fixture` / `likely_service_shared_inbox`. These are the rows Subtask B's read-time pattern filter would newly hide.

---

## All-org rollup

- orgs scanned: **18**
- total users (all orgs): **192**
- pass default filter (all orgs): **191**
- **leakage (all orgs)**: **138**

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 93 |
| `likely_demo_fixture` | Likely demo / fixture | 45 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 15 |
| `real_inactive` | Real but inactive | 3 |
| `uncertain` | Uncertain | 36 |

---

## Org: Value Truck  `valuetruck`

- organization_id: `da3ed822-8846-4435-bb13-3cc4bf26f71d`
- total users: **160**
- pass current default `GET /api/users` filter: **160**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **107**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 72 |
| `likely_demo_fixture` | Likely demo / fixture | 35 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 15 |
| `real_inactive` | Real but inactive | 3 |
| `uncertain` | Uncertain | 35 |

### Default-roster leakage examples (top 16)

  - `fec7abf8-117d-4eff-9fb1-0218d3f6a806` — **coe.test.fec7abf8@example.com** — name=`COETest fec7ab` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern
  - `013257eb-4825-4085-8b29-e539f4cb85e7` — **wq.test.013257eb@example.com** — name=`WQTest 013257` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `01815f41-c242-41e9-b0fe-d59a01259ef3` — **wq.test.01815f41@example.com** — name=`WQTest 01815f` role=admin lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `03567cbd-b71e-4d29-9ad4-344da71c4bfd` — **wq.test.03567cbd@example.com** — name=`WQTest 03567c` role=admin lastLogin=2026-04-08 created=2026-04-08 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `086a7666-8817-4fa4-90f7-833e01798896` — **wq.test.086a7666@example.com** — name=`WQTest 086a76` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `0a4cb1a2-f44f-4082-a9bf-c7f7ded2eddc` — **wq.test.0a4cb1a2@example.com** — name=`WQTest 0a4cb1` role=account_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `0aee5c49-bf0c-4687-99c5-dc78b9209b36` — **wq.test.0aee5c49@example.com** — name=`WQTest 0aee5c` role=admin lastLogin=2026-04-08 created=2026-04-08 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `0e182d18-17b7-43e5-9012-f5d3a1bea130` — **wq.test.0e182d18@example.com** — name=`WQTest 0e182d` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `100dafda-c0e0-43ce-a1db-ffc2c69c1138` — **wq.test.100dafda@example.com** — name=`WQTest 100daf` role=account_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `13cf6312-6d59-45d9-96ea-8d18e9d1979d` — **wq.test.13cf6312@example.com** — name=`WQTest 13cf63` role=admin lastLogin=never created=2026-04-23 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `1427649a-76fd-4861-922c-3bbf36d20b2b` — **wq.test.1427649a@example.com** — name=`WQTest 142764` role=account_manager lastLogin=never created=2026-04-23 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `147f9eac-2ff8-40f5-9f03-56b1ffa174d2` — **wq.test.147f9eac@example.com** — name=`WQTest 147f9e` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `191732b4-b6df-4f9b-b178-e215f2952eb9` — **wq.test.191732b4@example.com** — name=`WQTest 191732` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `1b90d422-7c15-4ba1-924c-72e267b467c4` — **wq.test.1b90d422@example.com** — name=`WQTest 1b90d4` role=account_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `2154fa72-635a-462a-bde2-bf5062012d7b` — **wq.test.2154fa72@example.com** — name=`WQTest 2154fa` role=admin lastLogin=2026-04-08 created=2026-04-08 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern
  - `22e303e5-11c7-4372-8779-f4fb1be977c5` — **wq.test.22e303e5@example.com** — name=`WQTest 22e303` role=admin lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 8 of 72)

  - `fec7abf8-117d-4eff-9fb1-0218d3f6a806` — **coe.test.fec7abf8@example.com** — name=`COETest fec7ab` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING
  - `013257eb-4825-4085-8b29-e539f4cb85e7` — **wq.test.013257eb@example.com** — name=`WQTest 013257` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING
  - `01815f41-c242-41e9-b0fe-d59a01259ef3` — **wq.test.01815f41@example.com** — name=`WQTest 01815f` role=admin lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING
  - `03567cbd-b71e-4d29-9ad4-344da71c4bfd` — **wq.test.03567cbd@example.com** — name=`WQTest 03567c` role=admin lastLogin=2026-04-08 created=2026-04-08 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING
  - `086a7666-8817-4fa4-90f7-833e01798896` — **wq.test.086a7666@example.com** — name=`WQTest 086a76` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING
  - `0a4cb1a2-f44f-4082-a9bf-c7f7ded2eddc` — **wq.test.0a4cb1a2@example.com** — name=`WQTest 0a4cb1` role=account_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING
  - `0aee5c49-bf0c-4687-99c5-dc78b9209b36` — **wq.test.0aee5c49@example.com** — name=`WQTest 0aee5c` role=admin lastLogin=2026-04-08 created=2026-04-08 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING
  - `0e182d18-17b7-43e5-9012-f5d3a1bea130` — **wq.test.0e182d18@example.com** — name=`WQTest 0e182d` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, zero-activity] reason=junk_email_pattern 🚨 LEAKING

#### `likely_demo_fixture` — Likely demo / fixture  (showing 8 of 35)

  - `03429234-cca7-4777-8d30-2a6c199be62c` — **wq.test.03429234@example.com** — name=`WQTest 034292` role=account_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `0e37ef72-4ce6-438d-9f68-e21a03b27283` — **wq.test.0e37ef72@example.com** — name=`WQTest 0e37ef` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `1fbbade0-8e38-467a-a803-fc7dd78bb83e` — **wq.test.1fbbade0@example.com** — name=`WQTest 1fbbad` role=account_manager lastLogin=never created=2026-04-23 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `33931bbf-c8f5-43bf-98a4-845850583064` — **wq.test.33931bbf@example.com** — name=`WQTest 33931b` role=account_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `35718014-ba3a-483e-a0e9-993a18c3fbed` — **wq.test.35718014@example.com** — name=`WQTest 357180` role=account_manager lastLogin=never created=2026-04-23 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `41420b4a-94c7-4e37-aaa2-ecb286b57a4e` — **wq.test.41420b4a@example.com** — name=`WQTest 41420b` role=account_manager lastLogin=never created=2026-04-25 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `5753a9cf-da48-43fa-9139-fb7613d70643` — **wq.test.5753a9cf@example.com** — name=`WQTest 5753a9` role=logistics_manager lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING
  - `64f28c65-2bba-4479-bade-c1f6fd53570c` — **wq.test.64f28c65@example.com** — name=`WQTest 64f28c` role=account_manager lastLogin=never created=2026-04-08 signals=[username:junk-domain, username:test-pattern, seed:wq.test, last-login:never] reason=seed_script_username 🚨 LEAKING

#### `real_active` — Real and active  (showing 8 of 15)

  - `14f356c1-ed8d-44d2-b32a-63a752199d21` — **adan.castaneda@valuetruck.com** — name=`Adan Castaneda` role=account_manager lastLogin=2026-05-12 created=? signals=[—] reason=recent_login_and_activity
  - `7d4ec580-ed4b-47fa-99f8-6a0d9dd638f1` — **andre.juarez@valuetruck.com** — name=`Andre Juarez` role=logistics_manager lastLogin=2026-05-09 created=? signals=[—] reason=recent_login_and_activity
  - `4e75fd7c-d462-42c5-a335-af327076416c` — **ben.beddes@valuetruck.com** — name=`Ben Beddes` role=admin lastLogin=2026-05-14 created=? signals=[no-manager, no-fin-rep-id] reason=recent_login_and_activity
  - `52005605-118e-4632-b93a-a1274392cd15` — **braden.shinsel@valuetruck.com** — name=`Braden Shinsel` role=national_account_manager lastLogin=2026-05-07 created=? signals=[—] reason=recent_login_and_activity
  - `da4c20a6-99a7-45a8-aff3-72e71573b769` — **danny.beddes@valuetruck.com** — name=`Danny Beddes` role=director lastLogin=2026-05-15 created=? signals=[—] reason=recent_login_and_activity
  - `17ac7dac-ca9f-43b5-b09e-181442dd0801` — **ethan.allen@valuetruck.com** — name=`Ethan Van Allen` role=national_account_manager lastLogin=2026-05-15 created=? signals=[—] reason=recent_login_and_activity
  - `b8a969f9-219d-4e32-9de5-e7af00783605` — **jared.reynolds@valuetruck.com** — name=`Jared Reynolds` role=national_account_manager lastLogin=2026-05-11 created=? signals=[—] reason=recent_login_and_activity
  - `872d0dfb-ef21-41b1-be11-b36c1e8d5db6` — **jason.allen@valuetruck.com** — name=`Jason Allen` role=national_account_manager lastLogin=2026-05-15 created=? signals=[—] reason=recent_login_and_activity

#### `real_inactive` — Real but inactive  (showing 3 of 3)

  - `1ff95654-faf0-43ba-b98a-0b5522dd886e` — **brianna.coakley@valuetruck.com** — name=`Brianna Coakley` role=national_account_manager lastLogin=never created=? signals=[last-login:never] reason=historical_activity_only
  - `acb00218-74ec-4a23-a3e0-2764e82ee56f` — **dallin.meier@valuetruck.com** — name=`Dallin Meier` role=account_manager lastLogin=never created=? signals=[last-login:never] reason=historical_activity_only
  - `e84fc739-2736-4f0c-9d9a-5f88c3a6a7b5` — **sophia.gabbitas@valuetruck.com** — name=`Sophia Gabbitas` role=logistics_coordinator lastLogin=never created=? signals=[last-login:never] reason=historical_activity_only

#### `uncertain` — Uncertain  (showing 8 of 35)

  - `c45ce49d-69cb-4926-ac3f-77378c1aef3c` — **aimee.charlton@valuetruck.com** — name=`Aimee Charlton` role=sales lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `c4d1336e-3b4c-4b21-ad11-375a51428cf6` — **bo.aagard@valuetruck.com** — name=`Bo Aagard` role=sales lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `15d7ab78-86da-43b3-8436-81b5a5c37d7e` — **brandi.huff@valuetruck.com** — name=`Brandi Huff` role=logistics_coordinator lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `bfa6a65b-cd2d-4b7e-930d-a3602c800230` — **breman.nope@valuetruck.com** — name=`Breman Nope` role=logistics_manager lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `8b05f3f5-5621-473a-9c36-2f37c9b91767` — **brianna.adams@valuetruck.com** — name=`Brianna Adams` role=logistics_manager lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `c7c866c3-5f60-47e0-bafb-b4e5e2d2ca4c` — **claudia.mejias@valuetruck.com** — name=`Claudia Mejia` role=logistics_manager lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `62b5def0-ac76-48e4-aad8-b9a36925939b` — **daniel.bird@valuetruck.com** — name=`Daniel Bird` role=logistics_manager lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern
  - `88621fbc-fbb8-43fc-9f8c-e4343466ca59` — **hannah.bennett@valuetruck.com** — name=`Hannah Bennett` role=account_manager lastLogin=never created=? signals=[zero-activity, last-login:never] reason=no_login_no_activity_no_pattern


---

## Org: Demo Org  `demo`

- organization_id: `d538857a-4619-41e2-b54e-79d87143f59a`
- total users: **10**
- pass current default `GET /api/users` filter: **10**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **10**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 4 |
| `likely_demo_fixture` | Likely demo / fixture | 6 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 10)

  - `6be94d4c-8403-4507-a87b-9204ec6fed1e` — **nam2@freightdna-demo.com** — name=`Derek Hollis` role=national_account_manager lastLogin=never created=2025-07-15 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern
  - `bfeb1a40-9f6c-4cb1-aeb2-4917bcd2075f` — **director@freightdna-demo.com** — name=`Marcus Webb` role=director lastLogin=never created=2025-06-15 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern
  - `9c2cba95-d289-4449-b088-f48e3ff1bd67` — **admin@freightdna-demo.com** — name=`Rachel Torres` role=admin lastLogin=never created=2025-06-01 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern
  - `b08c17a1-1fe1-4731-807d-34e7a4ef822d` — **nam1@freightdna-demo.com** — name=`Sandra Chen` role=national_account_manager lastLogin=never created=2025-07-01 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern
  - `a5770268-e78a-4961-9db1-8fc577872f19` — **am6@freightdna-demo.com** — name=`Brianna Okafor` role=account_manager lastLogin=never created=2025-10-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug
  - `40e9f371-5be3-44fc-97cd-7fa2eb5d1e01` — **am3@freightdna-demo.com** — name=`Jason Kowalski` role=account_manager lastLogin=never created=2025-09-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug
  - `fc39762e-7dc7-4d24-8ed8-f0b47c53c276` — **am4@freightdna-demo.com** — name=`Lexi Navarro` role=account_manager lastLogin=never created=2025-08-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug
  - `a78244e4-53dc-4318-ab3e-94b3988954df` — **am5@freightdna-demo.com** — name=`Marcus Dunn` role=account_manager lastLogin=never created=2025-09-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug
  - `6598b000-d6f5-4544-accb-ec8f3538043b` — **am2@freightdna-demo.com** — name=`Priya Patel` role=account_manager lastLogin=never created=2025-08-15 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug
  - `08c432ff-2e1b-4113-98d5-8e39701706f2` — **am1@freightdna-demo.com** — name=`Tyler Benson` role=account_manager lastLogin=never created=2025-08-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 4 of 4)

  - `6be94d4c-8403-4507-a87b-9204ec6fed1e` — **nam2@freightdna-demo.com** — name=`Derek Hollis` role=national_account_manager lastLogin=never created=2025-07-15 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING
  - `bfeb1a40-9f6c-4cb1-aeb2-4917bcd2075f` — **director@freightdna-demo.com** — name=`Marcus Webb` role=director lastLogin=never created=2025-06-15 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING
  - `9c2cba95-d289-4449-b088-f48e3ff1bd67` — **admin@freightdna-demo.com** — name=`Rachel Torres` role=admin lastLogin=never created=2025-06-01 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING
  - `b08c17a1-1fe1-4731-807d-34e7a4ef822d` — **nam1@freightdna-demo.com** — name=`Sandra Chen` role=national_account_manager lastLogin=never created=2025-07-01 signals=[username:test-pattern, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING

#### `likely_demo_fixture` — Likely demo / fixture  (showing 6 of 6)

  - `a5770268-e78a-4961-9db1-8fc577872f19` — **am6@freightdna-demo.com** — name=`Brianna Okafor` role=account_manager lastLogin=never created=2025-10-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug 🚨 LEAKING
  - `40e9f371-5be3-44fc-97cd-7fa2eb5d1e01` — **am3@freightdna-demo.com** — name=`Jason Kowalski` role=account_manager lastLogin=never created=2025-09-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug 🚨 LEAKING
  - `fc39762e-7dc7-4d24-8ed8-f0b47c53c276` — **am4@freightdna-demo.com** — name=`Lexi Navarro` role=account_manager lastLogin=never created=2025-08-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug 🚨 LEAKING
  - `a78244e4-53dc-4318-ab3e-94b3988954df` — **am5@freightdna-demo.com** — name=`Marcus Dunn` role=account_manager lastLogin=never created=2025-09-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug 🚨 LEAKING
  - `6598b000-d6f5-4544-accb-ec8f3538043b` — **am2@freightdna-demo.com** — name=`Priya Patel` role=account_manager lastLogin=never created=2025-08-15 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug 🚨 LEAKING
  - `08c432ff-2e1b-4113-98d5-8e39701706f2` — **am1@freightdna-demo.com** — name=`Tyler Benson` role=account_manager lastLogin=never created=2025-08-01 signals=[username:test-pattern, org:demo-or-fixture, last-login:never] reason=demo_org_slug 🚨 LEAKING


---

## Org: Fixture Guard Org 1777325756225  `fix-guard-1777325756225`

- organization_id: `4571474d-b31c-4c1f-b454-c1885b020821`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 0 |
| `likely_demo_fixture` | Likely demo / fixture | 2 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `7d8f70ef-46c8-4b22-af80-ad4db6464666` — **admin-1777325676409@valuetruck.com** — name=`Admin` role=admin lastLogin=never created=? signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug
  - `41a0481a-cac5-497a-88b7-7dcdf9c88271` — **real-1777325676386@valuetruck.com** — name=`Real` role=sales lastLogin=never created=2026-04-27 signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_demo_fixture` — Likely demo / fixture  (showing 2 of 2)

  - `7d8f70ef-46c8-4b22-af80-ad4db6464666` — **admin-1777325676409@valuetruck.com** — name=`Admin` role=admin lastLogin=never created=? signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug 🚨 LEAKING
  - `41a0481a-cac5-497a-88b7-7dcdf9c88271` — **real-1777325676386@valuetruck.com** — name=`Real` role=sales lastLogin=never created=2026-04-27 signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug 🚨 LEAKING


---

## Org: Fixture Guard Org 1777326047505  `fix-guard-1777326047505`

- organization_id: `28863228-cd9e-42ad-a3d0-ae6835a2ae0c`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 0 |
| `likely_demo_fixture` | Likely demo / fixture | 2 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `88e45f0f-9035-4248-ad7b-0f85d9a6938e` — **admin-1777325749082@valuetruck.com** — name=`Admin` role=admin lastLogin=never created=? signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug
  - `1628753c-a1ec-45fe-b66e-f9964958d56b` — **real-1777325749059@valuetruck.com** — name=`Real` role=sales lastLogin=never created=2026-04-27 signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_demo_fixture` — Likely demo / fixture  (showing 2 of 2)

  - `88e45f0f-9035-4248-ad7b-0f85d9a6938e` — **admin-1777325749082@valuetruck.com** — name=`Admin` role=admin lastLogin=never created=? signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug 🚨 LEAKING
  - `1628753c-a1ec-45fe-b66e-f9964958d56b` — **real-1777325749059@valuetruck.com** — name=`Real` role=sales lastLogin=never created=2026-04-27 signals=[org:demo-or-fixture, zero-activity, last-login:never, no-manager] reason=demo_org_slug 🚨 LEAKING


---

## Org: Hero Loop Test 1778076248320  `hero-loop-test-1778076248320`

- organization_id: `0a36c612-009e-4de8-af68-1c14cd7d942b`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 2 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `509fe307-ea22-408d-80c1-f98289346cb7` — **hero-loop-lm-1778076248356-meyiy7@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern
  - `524954dc-5f70-4476-8678-3ceae2f268fc` — **hero-loop-nam-1778076248362-tlw50e@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 2 of 2)

  - `509fe307-ea22-408d-80c1-f98289346cb7` — **hero-loop-lm-1778076248356-meyiy7@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING
  - `524954dc-5f70-4476-8678-3ceae2f268fc` — **hero-loop-nam-1778076248362-tlw50e@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING


---

## Org: Hero Loop Test 1778076248475  `hero-loop-test-1778076248475`

- organization_id: `080a2e18-3142-4303-bc8b-7d44fe8ed393`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 2 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `9b1da3cc-61b8-447d-8e17-3cab84873d34` — **hero-loop-lm-1778076248479-dshmxl@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern
  - `fa8c44c8-7013-4ab8-8a35-17be6cfacee7` — **hero-loop-nam-1778076248482-wmcl4z@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 2 of 2)

  - `9b1da3cc-61b8-447d-8e17-3cab84873d34` — **hero-loop-lm-1778076248479-dshmxl@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING
  - `fa8c44c8-7013-4ab8-8a35-17be6cfacee7` — **hero-loop-nam-1778076248482-wmcl4z@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING


---

## Org: Hero Loop Test 1778076248538  `hero-loop-test-1778076248538`

- organization_id: `100fdf93-aa70-4af8-933f-51fc869643e0`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 2 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `5647cdac-4774-4981-b67b-edf5e4da0206` — **hero-loop-lm-1778076248543-uccsza@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern
  - `67f0a531-8a6a-4ca3-ae41-2bd3e7c5ff0c` — **hero-loop-nam-1778076248547-a0gn9x@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 2 of 2)

  - `5647cdac-4774-4981-b67b-edf5e4da0206` — **hero-loop-lm-1778076248543-uccsza@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING
  - `67f0a531-8a6a-4ca3-ae41-2bd3e7c5ff0c` — **hero-loop-nam-1778076248547-a0gn9x@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING


---

## Org: Hero Loop Test 1778076222051  `hero-loop-test-1778076222051`

- organization_id: `0b082a21-6c06-4eb9-8e02-11813f22f24b`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 2 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `5995feee-ccee-40c3-ae85-1cc05fa60ce5` — **hero-loop-lm-1778076222055-am5g2x@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern
  - `9d457348-2d82-4f6b-b9f5-d66456314c34` — **hero-loop-nam-1778076222059-v4tshd@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 2 of 2)

  - `5995feee-ccee-40c3-ae85-1cc05fa60ce5` — **hero-loop-lm-1778076222055-am5g2x@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING
  - `9d457348-2d82-4f6b-b9f5-d66456314c34` — **hero-loop-nam-1778076222059-v4tshd@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING


---

## Org: Hero Loop Test 1778076221906  `hero-loop-test-1778076221906`

- organization_id: `a0fa93f7-dbe2-4065-b2ea-dfa005825fe2`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 2 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `464aea26-33d7-417a-8a7e-7625f6d3e737` — **hero-loop-lm-1778076221948-wstfav@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern
  - `19d3fe39-84e2-48ba-8fe4-8ecb58a24a92` — **hero-loop-nam-1778076221956-1lc73n@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 2 of 2)

  - `464aea26-33d7-417a-8a7e-7625f6d3e737` — **hero-loop-lm-1778076221948-wstfav@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING
  - `19d3fe39-84e2-48ba-8fe4-8ecb58a24a92` — **hero-loop-nam-1778076221956-1lc73n@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING


---

## Org: Hero Loop Test 1778076222109  `hero-loop-test-1778076222109`

- organization_id: `4e121699-e7da-4851-88c6-9a40ec3a17f2`
- total users: **2**
- pass current default `GET /api/users` filter: **2**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **2**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 2 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 2)

  - `73838c85-5e5b-4b93-b21d-09c60c9cca65` — **hero-loop-lm-1778076222112-b7wmfm@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern
  - `8358bffd-692d-47d2-87a7-c6edceeeca57` — **hero-loop-nam-1778076222117-skzrr8@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 2 of 2)

  - `73838c85-5e5b-4b93-b21d-09c60c9cca65` — **hero-loop-lm-1778076222112-b7wmfm@example.com** — name=`Hero Loop LM` role=logistics_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING
  - `8358bffd-692d-47d2-87a7-c6edceeeca57` — **hero-loop-nam-1778076222117-skzrr8@example.com** — name=`Hero Loop NAM` role=account_manager lastLogin=never created=? signals=[username:junk-domain, zero-activity, last-login:never, no-manager] reason=junk_email_pattern 🚨 LEAKING


---

## Org: customers-trust-test-4eef10eb  `customers-trust-test-4eef10eb`

- organization_id: `4eef10eb-b0e7-4311-ba20-e7a297a74130`
- total users: **1**
- pass current default `GET /api/users` filter: **0**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **0**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 0 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 1 |

### Bucket samples (top 8 per bucket by reviewPriority)

#### `uncertain` — Uncertain  (showing 1 of 1)

  - `577e4065-bdc5-4fe6-8920-af2d0f335f5e` — **trust-admin-4eef10eb** — name=`Trust Test Admin` role=admin lastLogin=never created=? signals=[zero-activity, last-login:never, no-manager, no-fin-rep-id] reason=no_login_no_activity_no_pattern


---

## Org: HF Test Org 7dfc4e  `hf-test-org-7dfc4e59`

- organization_id: `7dfc4e59-4e8d-499d-b7f0-3425e5ea329b`
- total users: **1**
- pass current default `GET /api/users` filter: **1**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **1**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 1 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 1)

  - `0508ceea-2773-4843-8c46-1722b35b80d9` — **hf.test.0508ceea@example.com** — name=`HFTest 0508ce` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 1 of 1)

  - `0508ceea-2773-4843-8c46-1722b35b80d9` — **hf.test.0508ceea@example.com** — name=`HFTest 0508ce` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING


---

## Org: HF Test Org e5a724  `hf-test-org-e5a724a7`

- organization_id: `e5a724a7-a66a-44ac-89cd-c174ce9cb9bf`
- total users: **1**
- pass current default `GET /api/users` filter: **1**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **1**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 1 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 1)

  - `0c4d4b66-1be8-4c8b-9424-32261b7eca1c` — **hf.test.0c4d4b66@example.com** — name=`HFTest 0c4d4b` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 1 of 1)

  - `0c4d4b66-1be8-4c8b-9424-32261b7eca1c` — **hf.test.0c4d4b66@example.com** — name=`HFTest 0c4d4b` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING


---

## Org: HF Test Org 080e7d  `hf-test-org-080e7d87`

- organization_id: `080e7d87-92d2-4a31-89b0-5c37146de2a5`
- total users: **1**
- pass current default `GET /api/users` filter: **1**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **1**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 1 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 1)

  - `df522360-492d-43e5-9429-726054878cd6` — **hf.test.df522360@example.com** — name=`HFTest df5223` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 1 of 1)

  - `df522360-492d-43e5-9429-726054878cd6` — **hf.test.df522360@example.com** — name=`HFTest df5223` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING


---

## Org: HF Test Org 264e16  `hf-test-org-264e1615`

- organization_id: `264e1615-0f48-43b0-9b7d-7293fd3b3f26`
- total users: **1**
- pass current default `GET /api/users` filter: **1**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **1**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 1 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 1)

  - `f9cf1c14-c2a3-41a1-ad66-9e05805f1b0e` — **hf.test.f9cf1c14@example.com** — name=`HFTest f9cf1c` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 1 of 1)

  - `f9cf1c14-c2a3-41a1-ad66-9e05805f1b0e` — **hf.test.f9cf1c14@example.com** — name=`HFTest f9cf1c` role=admin lastLogin=never created=2026-04-11 signals=[username:junk-domain, username:test-pattern, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING


---

## Org: Test Org A 1777221761441  `test-org-a-1777221761441`

- organization_id: `02ad7b2d-98df-45a1-9452-06c2ecc33f13`
- total users: **1**
- pass current default `GET /api/users` filter: **1**
- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **1**

### Bucket counts

| Bucket | Label | Count |
|---|---|---:|
| `likely_junk` | Likely junk | 1 |
| `likely_demo_fixture` | Likely demo / fixture | 0 |
| `likely_service_shared_inbox` | Likely service / shared-inbox | 0 |
| `real_active` | Real and active | 0 |
| `real_inactive` | Real but inactive | 0 |
| `uncertain` | Uncertain | 0 |

### Default-roster leakage examples (top 1)

  - `90e5e83a-f21c-4432-927b-83f847f0cc25` — **testuser-a-1777221761477@example.com** — name=`Test User A` role=sales lastLogin=never created=? signals=[username:junk-domain, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern

### Bucket samples (top 8 per bucket by reviewPriority)

#### `likely_junk` — Likely junk  (showing 1 of 1)

  - `90e5e83a-f21c-4432-927b-83f847f0cc25` — **testuser-a-1777221761477@example.com** — name=`Test User A` role=sales lastLogin=never created=? signals=[username:junk-domain, org:demo-or-fixture, zero-activity, last-login:never] reason=junk_email_pattern 🚨 LEAKING


---

## Notes

- Source classifier: `server/lib/userRosterClassification.ts` (read-only, Phase 0).
- Default filter shape mirrors `storage.getUsers` Section 1126 Phase 1 Step 4a-API.
- This audit does NOT mutate `is_fixture` / `is_demo` / any lifecycle flag.
- Subtask B will add a read-time pattern exclusion (no writes) for the leakage cohort, plus an admin-only `?includeJunkSuspects=true` opt-in.
