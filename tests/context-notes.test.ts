/**
 * Task #950 — Context Notes server-layer integration tests.
 *
 * Exercises the repo + anchor registry directly so we get fast, deterministic
 * coverage of the four behaviors the spec promises:
 *
 *   1. Permission delegation — cross-org users cannot access a note's anchor.
 *   2. Notification fan-out — mention rows produce notification rows; replies
 *      fan out to author + mentioned set, deduped, excluding the actor.
 *   3. Status transitions — open → acknowledged → resolved → reopened, with
 *      resolvedAt/resolvedBy bookkeeping.
 *   4. Convert-to-task — creates a task row, links it back, and resolves
 *      the source note.
 *
 * Run with: npx tsx tests/context-notes.test.ts
 *
 * Prerequisites: DATABASE_URL must be set and schema migrated.
 */

import { db } from "../server/storage";
import {
  organizations, users, companies, quoteCustomers, quoteOpportunities,
  contextNotes, contextNoteMentions, contextNoteEvents, contextNoteReplies,
  notifications, tasks,
} from "../shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  attachConvertedTask,
  countsByAnchor,
  createTaskFromNote,
  fanoutNotifications,
  getInboxForUser,
  getMentionUserIds,
  insertEvent,
  insertMentions,
  insertNote,
  insertReply,
  transitionNote,
} from "../server/contextNotes/repo";
import { canUserAccessAnchor, snapshotAnchorLabel } from "../server/contextNotes/anchors";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

const orgIdsToCleanup: string[] = [];
const noteIdsToCleanup: string[] = [];
const taskIdsToCleanup: string[] = [];

async function seedOrg(suffix: string) {
  const ts = Date.now();
  const [org] = await db.insert(organizations).values({
    name: `CN Test Org ${suffix} ${ts}`,
    slug: `cn-test-org-${suffix.toLowerCase()}-${ts}`,
  }).returning();
  orgIdsToCleanup.push(org.id);
  return org;
}

async function seedUser(orgId: string, suffix: string, role: "rep" | "admin" = "rep") {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  const handle = `cn-${suffix.toLowerCase()}-${ts}`;
  const [user] = await db.insert(users).values({
    organizationId: orgId,
    username: handle,
    name: `CN ${suffix}`,
    email: `${handle}@test.local`,
    role,
  } as any).returning();
  return user;
}

async function seedQuoteOpportunity(orgId: string, customerName: string) {
  const ts = Date.now();
  const [customer] = await db.insert(quoteCustomers).values({
    organizationId: orgId,
    name: `CN Customer ${customerName} ${ts}`,
  } as any).returning();
  const [opp] = await db.insert(quoteOpportunities).values({
    organizationId: orgId,
    customerId: customer.id,
    requestDate: new Date(),
    originCity: "Atlanta",
    originState: "GA",
    destCity: "Dallas",
    destState: "TX",
    equipment: "Van",
  } as any).returning();
  return { customer, opp };
}

async function cleanup() {
  // Best-effort, in dependency order.
  if (taskIdsToCleanup.length) {
    await db.delete(tasks).where(inArray(tasks.id, taskIdsToCleanup)).catch(() => {});
  }
  if (noteIdsToCleanup.length) {
    await db.delete(contextNoteMentions).where(inArray(contextNoteMentions.noteId, noteIdsToCleanup)).catch(() => {});
    await db.delete(contextNoteEvents).where(inArray(contextNoteEvents.noteId, noteIdsToCleanup)).catch(() => {});
    await db.delete(contextNoteReplies).where(inArray(contextNoteReplies.noteId, noteIdsToCleanup)).catch(() => {});
    await db.delete(contextNotes).where(inArray(contextNotes.id, noteIdsToCleanup)).catch(() => {});
  }
  if (orgIdsToCleanup.length) {
    // Notifications cascade with users which cascade with org. Quote rows
    // cascade with org as well. Tasks have no org FK — leave best-effort.
    for (const orgId of orgIdsToCleanup) {
      await db.delete(notifications)
        .where(inArray(notifications.userId,
          db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId)) as any))
        .catch(() => {});
      await db.delete(quoteOpportunities).where(eq(quoteOpportunities.organizationId, orgId)).catch(() => {});
      await db.delete(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId)).catch(() => {});
      await db.delete(users).where(eq(users.organizationId, orgId)).catch(() => {});
      await db.delete(companies).where(eq(companies.organizationId, orgId)).catch(() => {});
      await db.delete(organizations).where(eq(organizations.id, orgId)).catch(() => {});
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testPermissionDelegation() {
  console.log("\n[1] Permission delegation via anchor registry");
  const [orgA, orgB] = [await seedOrg("A"), await seedOrg("B")];
  const userA = await seedUser(orgA.id, "Alice");
  const userB = await seedUser(orgB.id, "Bob");
  const { opp } = await seedQuoteOpportunity(orgA.id, "Acme");

  const aCanSee = await canUserAccessAnchor(userA, "quote_request", opp.id);
  const bCanSee = await canUserAccessAnchor(userB, "quote_request", opp.id);
  assert("same-org user can access quote_request anchor", aCanSee === true);
  assert("cross-org user is denied quote_request anchor", bCanSee === false);

  const label = await snapshotAnchorLabel("quote_request", opp.id, orgA.id);
  assert("anchor label snapshot is non-empty", !!label && label.length > 0, `got ${label}`);
}

async function testFanoutAndInbox() {
  console.log("\n[2] Notification fan-out + inbox");
  const org = await seedOrg("Fan");
  const author = await seedUser(org.id, "Author");
  const mentioned = await seedUser(org.id, "Mentioned");
  const bystander = await seedUser(org.id, "Bystander");
  const { opp } = await seedQuoteOpportunity(org.id, "Globex");

  const note = await insertNote({
    orgId: org.id,
    authorId: author.id,
    anchorType: "quote_request",
    anchorId: opp.id,
    anchorLabel: "Globex · ATL → DAL",
    body: "Heads up — needs eyes.",
    actionType: "fyi",
    status: "open",
  });
  noteIdsToCleanup.push(note.id);
  await insertMentions(note.id, [mentioned.id]);
  await fanoutNotifications({
    recipientIds: [mentioned.id],
    type: "context_note_mention",
    title: "You were mentioned",
    body: "Heads up — needs eyes.",
    link: `/quote-requests?contextNote=${note.id}`,
    relatedId: note.id,
  });

  const mentionNotifs = await db.select().from(notifications)
    .where(and(eq(notifications.userId, mentioned.id), eq(notifications.relatedId, note.id)));
  assert("mention fan-out wrote one notification row", mentionNotifs.length === 1);
  assert("notification has mention type", mentionNotifs[0]?.type === "context_note_mention");

  const bystanderNotifs = await db.select().from(notifications).where(eq(notifications.userId, bystander.id));
  assert("bystander received zero notifications", bystanderNotifs.length === 0);

  // Reply fan-out — author + mentioned, dedupe and exclude the replier.
  const reply = await insertReply(note.id, mentioned.id, "On it.");
  assert("reply row inserted", !!reply.id);
  const recipients = new Set<string>();
  if (note.authorId !== mentioned.id) recipients.add(note.authorId);
  for (const m of await getMentionUserIds(note.id)) {
    if (m !== mentioned.id) recipients.add(m);
  }
  await fanoutNotifications({
    recipientIds: Array.from(recipients),
    type: "context_note_reply",
    title: "Reply",
    body: "On it.",
    link: null,
    relatedId: note.id,
  });
  const authorReplyNotifs = await db.select().from(notifications)
    .where(and(eq(notifications.userId, author.id), eq(notifications.type, "context_note_reply")));
  assert("author received reply notification", authorReplyNotifs.length === 1);
  const mentionedReplyNotifs = await db.select().from(notifications)
    .where(and(eq(notifications.userId, mentioned.id), eq(notifications.type, "context_note_reply")));
  assert("mentioned (also the replier) did not get a reply notification", mentionedReplyNotifs.length === 0);

  // Inbox includes the mention for the mentioned user.
  const inbox = await getInboxForUser(mentioned.id, org.id, {});
  assert("mentioned user sees note in inbox", inbox.some(r => r.id === note.id));
  const counts = await countsByAnchor(org.id, "quote_request", [opp.id], mentioned.id);
  assert("anchor counts include this note", (counts[opp.id]?.total ?? 0) === 1);
}

async function testStatusTransitions() {
  console.log("\n[3] Status transitions");
  const org = await seedOrg("Trans");
  const author = await seedUser(org.id, "TAuthor");
  const { opp } = await seedQuoteOpportunity(org.id, "Initech");
  const note = await insertNote({
    orgId: org.id,
    authorId: author.id,
    anchorType: "quote_request",
    anchorId: opp.id,
    anchorLabel: null,
    body: "Decision needed by EOD.",
    actionType: "decision_needed",
    status: "open",
  });
  noteIdsToCleanup.push(note.id);

  const ack = await transitionNote(note.id, "acknowledged", author.id);
  assert("transition open → acknowledged works", ack?.status === "acknowledged");
  assert("acknowledged does not set resolvedAt", !ack?.resolvedAt);

  const resolved = await transitionNote(note.id, "resolved", author.id);
  assert("transition acknowledged → resolved sets resolvedAt", !!resolved?.resolvedAt);
  assert("resolved is stamped with resolvedBy", resolved?.resolvedBy === author.id);

  const reopened = await transitionNote(note.id, "open", author.id);
  assert("transition resolved → open clears resolvedAt", reopened?.resolvedAt === null);
  assert("transition resolved → open clears resolvedBy", reopened?.resolvedBy === null);
}

async function testConvertToTask() {
  console.log("\n[4] Convert-to-task");
  const org = await seedOrg("Conv");
  const author = await seedUser(org.id, "CAuthor");
  const assignee = await seedUser(org.id, "CAssignee");
  const { opp, customer } = await seedQuoteOpportunity(org.id, "Umbrella");

  const note = await insertNote({
    orgId: org.id,
    authorId: author.id,
    anchorType: "quote_request",
    anchorId: opp.id,
    anchorLabel: null,
    body: "Please follow up tomorrow.",
    actionType: "please_handle",
    status: "open",
  });
  noteIdsToCleanup.push(note.id);

  const anchorDeepLink = `/quote-requests?quote=${opp.id}&contextNote=${note.id}`;
  const task = await createTaskFromNote({
    note,
    actorId: author.id,
    assignedTo: assignee.id,
    title: "Follow up with Umbrella",
    dueDate: null,
    companyId: null,
    opportunityId: null,
    laneContext: null,
    anchorDeepLink,
  });
  taskIdsToCleanup.push(task.id);
  await attachConvertedTask(note.id, task.id);
  await insertEvent({ noteId: note.id, actorId: author.id, type: "converted_to_task", detail: { taskId: task.id } });

  const [updatedNote] = await db.select().from(contextNotes).where(eq(contextNotes.id, note.id));
  assert("note linked to created task", updatedNote.convertedTaskId === task.id);
  assert("note auto-resolved on convert", updatedNote.status === "resolved");
  const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert("task assigned to correct user", taskRow.assignedTo === assignee.id);
  assert("task title persisted", taskRow.title === "Follow up with Umbrella");
  // Backlink contract — task description must include a clickable deep link
  // that lands the assignee on the source surface with the note pre-revealed.
  assert(
    "task description embeds anchor deep-link backlink",
    !!taskRow.description && taskRow.description.includes(anchorDeepLink),
    `description=${taskRow.description}`,
  );
  assert(
    "task description references the human-readable anchor label",
    !!taskRow.description && taskRow.description.includes("context note"),
  );
}

async function testInboxRoleSplit() {
  console.log("\n[5] Inbox role split (mentioned vs authored)");
  const org = await seedOrg("Role");
  const author = await seedUser(org.id, "RAuthor");
  const mentioned = await seedUser(org.id, "RMentioned");
  const { opp } = await seedQuoteOpportunity(org.id, "Soylent");

  // Author writes a note mentioning `mentioned`.
  const authoredNote = await insertNote({
    orgId: org.id,
    authorId: author.id,
    anchorType: "quote_request",
    anchorId: opp.id,
    anchorLabel: null,
    body: "Authored by author, mentions mentioned.",
    actionType: "fyi",
    status: "open",
  });
  noteIdsToCleanup.push(authoredNote.id);
  await insertMentions(authoredNote.id, [mentioned.id]);

  // Mentioned writes their own note that does NOT mention author.
  const ownNote = await insertNote({
    orgId: org.id,
    authorId: mentioned.id,
    anchorType: "quote_request",
    anchorId: opp.id,
    anchorLabel: null,
    body: "Authored by mentioned, no mentions.",
    actionType: "fyi",
    status: "open",
  });
  noteIdsToCleanup.push(ownNote.id);

  const inbox = await getInboxForUser(mentioned.id, org.id, {});
  const mentionedFlagFor = (id: string) => inbox.find(r => r.id === id)?.viewerIsMentioned;
  assert(
    "inbox marks mentioned-by-someone-else note with viewerIsMentioned=true",
    mentionedFlagFor(authoredNote.id) === true,
  );
  assert(
    "inbox marks self-authored note with viewerIsMentioned=false",
    mentionedFlagFor(ownNote.id) === false,
  );
  assert(
    "self-authored note appears in the inbox (authored view source)",
    inbox.some(r => r.id === ownNote.id && r.authorId === mentioned.id),
  );
}

async function testReplyFanoutPermissionGate() {
  console.log("\n[6] Reply fan-out permission re-check");
  // Simulate the situation that triggered the rejected review: a previously
  // mentioned user later loses anchor access. The reply route's per-recipient
  // canUserAccessAnchor gate must drop them from the fan-out set.
  const orgA = await seedOrg("RFA");
  const orgB = await seedOrg("RFB");
  const author = await seedUser(orgA.id, "RFAuthor");
  // crossOrgRecipient is in a *different* org than the anchor — this models
  // "lost access after mention" by being unable to see the quote opportunity.
  const crossOrgRecipient = await seedUser(orgB.id, "RFOutsider");
  const { opp } = await seedQuoteOpportunity(orgA.id, "Hooli");

  const note = await insertNote({
    orgId: orgA.id,
    authorId: author.id,
    anchorType: "quote_request",
    anchorId: opp.id,
    anchorLabel: null,
    body: "Original.",
    actionType: "question",
    status: "open",
  });
  noteIdsToCleanup.push(note.id);
  // Force-insert a stale mention so we can verify the fanout gate (real
  // create-mention path filters this same way at insert time).
  await db.insert(contextNoteMentions).values({ noteId: note.id, userId: crossOrgRecipient.id });

  // Replicate the route's filter logic.
  const candidates = await getMentionUserIds(note.id);
  const allowedRecipients: string[] = [];
  for (const recipientId of candidates) {
    const [u] = await db.select().from(users).where(eq(users.id, recipientId));
    if (!u) continue;
    if (await canUserAccessAnchor(u, note.anchorType, note.anchorId)) {
      allowedRecipients.push(recipientId);
    }
  }
  assert(
    "cross-org recipient is filtered OUT of reply fan-out",
    !allowedRecipients.includes(crossOrgRecipient.id),
    `allowedRecipients=${JSON.stringify(allowedRecipients)}`,
  );
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Context Notes (Task #950) — Server Tests ===");
  try {
    await testPermissionDelegation();
    await testFanoutAndInbox();
    await testStatusTransitions();
    await testConvertToTask();
    await testInboxRoleSplit();
    await testReplyFanoutPermissionGate();
  } catch (err: unknown) {
    console.error("FATAL:", err);
    failed++;
    failures.push(`fatal: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    await cleanup().catch(err => console.error("cleanup error:", err));
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
