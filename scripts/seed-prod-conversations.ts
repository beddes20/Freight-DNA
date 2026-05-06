/**
 * Seed a small set of demo conversation threads in PRODUCTION so the
 * "Conversations" sidebar badge shows a real count.
 *
 * Run with:
 *   PRODUCTION_DATABASE_URL='postgres://...' npx tsx scripts/seed-prod-conversations.ts
 *
 * Optional env vars:
 *   OWNER_EMAIL     - email of the user who should own the seeded threads
 *                     (default: ben.beddes@valuetruck.com)
 *   THREAD_COUNT    - how many waiting_on_us threads to create (default: 3)
 *
 * Every seeded row uses a thread_id prefixed with "demo-conv-" and a subject
 * prefixed with "[DEMO]" so they are easy to find and delete later:
 *   DELETE FROM email_messages
 *     WHERE thread_id LIKE 'demo-conv-%';
 *   DELETE FROM email_conversation_threads
 *     WHERE thread_id LIKE 'demo-conv-%';
 */

import { Pool } from "pg";
import { randomUUID } from "crypto";

const PROD_URL =
  process.env.PRODUCTION_DATABASE_URL || process.env.PROD_DATABASE_URL;

if (!PROD_URL) {
  console.error(
    "ERROR: Set PRODUCTION_DATABASE_URL to your production database connection string.",
  );
  process.exit(1);
}

const OWNER_EMAIL = (
  process.env.OWNER_EMAIL || "ben.beddes@valuetruck.com"
).toLowerCase();
const THREAD_COUNT = Math.max(1, Number(process.env.THREAD_COUNT || 3));

const SAMPLES = [
  {
    subject: "[DEMO] Pricing request — Atlanta to Dallas reefer",
    from: "logistics@acme-foods.example.com",
    body: "Hi Ben — can you send pricing for 5 loads/week ATL → DAL on reefer? Need to lock in by Friday. Thanks, Sarah",
  },
  {
    subject: "[DEMO] Capacity check — Chicago lanes next week",
    from: "ops@midwest-distrib.example.com",
    body: "Need vans out of Chicago next Tue/Wed to Memphis & Nashville. Can you cover? — Mike",
  },
  {
    subject: "[DEMO] RFP follow-up — Q3 lane awards",
    from: "procurement@summit-mfg.example.com",
    body: "Hi Ben, following up on the Q3 RFP we sent over. Any update on the awarded lanes? — Jen",
  },
  {
    subject: "[DEMO] Rate increase question",
    from: "shipping@pacific-goods.example.com",
    body: "Got your note on the LAX → PHX rate. Can we hop on a quick call to discuss?",
  },
  {
    subject: "[DEMO] New lane opportunity — Heartland",
    from: "buyer@heartland-co.example.com",
    body: "We have a new lane opening up out of Kansas City. Can you take a look at the volumes and quote?",
  },
];

async function main() {
  const pool = new Pool({ connectionString: PROD_URL });
  const client = await pool.connect();

  try {
    console.log(`\n→ Connecting to production DB…`);
    console.log(`→ Owner email: ${OWNER_EMAIL}`);
    console.log(`→ Thread count: ${THREAD_COUNT}\n`);

    // 1. Find owner user
    const ownerRes = await client.query(
      `SELECT id, name, organization_id FROM users WHERE LOWER(username) = $1 LIMIT 1`,
      [OWNER_EMAIL],
    );
    if (ownerRes.rows.length === 0) {
      throw new Error(`No user found with username = ${OWNER_EMAIL}`);
    }
    const owner = ownerRes.rows[0];
    console.log(
      `✓ Found owner: ${owner.name} (id=${owner.id}, org=${owner.organization_id})`,
    );

    const orgId: string = owner.organization_id;
    const ownerId: string = owner.id;

    // 2. Insert N threads + 1 inbound message each, all in waiting_on_us state.
    const created: { threadId: string; subject: string }[] = [];
    const now = new Date();

    for (let i = 0; i < THREAD_COUNT; i++) {
      const sample = SAMPLES[i % SAMPLES.length];
      const threadKey = `demo-conv-${Date.now()}-${i}`;
      const messageId = randomUUID();
      const threadRowId = randomUUID();
      // Stagger waiting times so the dashboard sort has variety
      const incomingAt = new Date(
        now.getTime() - (i + 1) * 30 * 60 * 1000, // 30, 60, 90 min ago
      );

      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO email_messages
            (id, org_id, provider_message_id, thread_id, direction,
             from_email, to_email, subject, body, created_at)
           VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7, $8, $9)`,
          [
            messageId,
            orgId,
            `demo-${messageId}`,
            threadKey,
            sample.from,
            OWNER_EMAIL,
            sample.subject,
            sample.body,
            incomingAt,
          ],
        );

        await client.query(
          `INSERT INTO email_conversation_threads
            (id, org_id, thread_id, owner_user_id, waiting_state,
             response_priority, last_message_id, last_incoming_at,
             waiting_since_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'waiting_on_us',
                   'normal', $5, $6, $6, $7, $7)`,
          [threadRowId, orgId, threadKey, ownerId, messageId, incomingAt, now],
        );

        await client.query("COMMIT");
        created.push({ threadId: threadKey, subject: sample.subject });
        console.log(`✓ Created thread ${i + 1}: ${sample.subject}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }

    console.log(`\n✓ Done. Created ${created.length} demo threads.`);
    console.log(`\nTo clean up later, run in psql:`);
    console.log(`  DELETE FROM email_messages WHERE thread_id LIKE 'demo-conv-%';`);
    console.log(
      `  DELETE FROM email_conversation_threads WHERE thread_id LIKE 'demo-conv-%';`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("\n✗ Seed failed:", err);
  process.exit(1);
});
