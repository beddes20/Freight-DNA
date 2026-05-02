/**
 * Email Intelligence v1.5 — Tier 2.2 / 2.3 staleness sweep (Task #943).
 *
 * Runs on a daily cadence and:
 *   1. Finds open `email_promises` past their `promise_due_at` and creates
 *      a coaching task for the rep so they don't break it silently.
 *   2. Finds inbound `email_questions` still `unanswered` after 48h and
 *      creates a coaching task for the assigned rep so the question gets
 *      answered before the customer escalates.
 *
 * Both flows are idempotent — generated tasks carry `forwardedFrom`
 * = `promise:<id>` / `question:<id>` so re-running the sweep doesn't
 * spam the rep's queue.
 */

import { db } from "../../storage";
import { eq, and, sql, lte } from "drizzle-orm";
import {
  companies,
  emailQuestions,
  type EmailPromise,
  type EmailQuestion,
  type InsertTask,
} from "@shared/schema";
import {
  listOverdueOpenPromises,
} from "./emailFactsStorage";
import type { IStorage } from "../../storage";

const QUESTION_STALE_HOURS = 48;

async function existingTaskFor(orgId: string, key: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM tasks
     WHERE org_id = ${orgId}
       AND forwarded_from = ${key}
     LIMIT 1
  `);
  return ((rows.rows ?? rows) as Array<{ id: string }>).length > 0;
}

async function resolveAccountManagerId(orgId: string, companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const rows = await db
    .select({ assignedTo: companies.assignedTo, salesPersonId: companies.salesPersonId })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, orgId)))
    .limit(1);
  return rows[0]?.assignedTo ?? rows[0]?.salesPersonId ?? null;
}

export interface StalenessSweepResult {
  promiseTasksCreated: number;
  questionTasksCreated: number;
  skipped: number;
  errors: number;
}

async function listStaleQuestionsForOrg(orgId: string, now: Date): Promise<EmailQuestion[]> {
  const cutoff = new Date(now.getTime() - QUESTION_STALE_HOURS * 3600 * 1000);
  return db
    .select()
    .from(emailQuestions)
    .where(and(
      eq(emailQuestions.orgId, orgId),
      eq(emailQuestions.status, "unanswered"),
      lte(emailQuestions.createdAt, cutoff),
    ));
}

async function createPromiseFollowupTask(
  orgId: string,
  promise: EmailPromise,
  storage: Pick<IStorage, "createTask">,
  now: Date,
): Promise<boolean> {
  if (!promise.repUserId) return false;
  const key = `promise:${promise.id}`;
  if (await existingTaskFor(orgId, key)) return false;
  const dueStr = promise.promiseDueAt?.toISOString().slice(0, 10) ?? null;
  const taskInput: InsertTask = {
    title: `Follow through on email promise${dueStr ? ` (due ${dueStr})` : ""}`,
    notes: `Email promise detected on thread ${promise.threadId ?? "?"} is past due. Promise text: "${promise.promiseText.slice(0, 200)}"`,
    status: "open",
    dueDate: dueStr,
    assignedTo: promise.repUserId,
    assignedBy: promise.repUserId,
    companyId: promise.linkedAccountId ?? null,
    contactId: promise.linkedContactId ?? null,
    orgId,
    forwardedFrom: key,
    createdAt: now.toISOString(),
  };
  await storage.createTask(taskInput);
  return true;
}

async function createQuestionFollowupTask(
  orgId: string,
  question: EmailQuestion,
  storage: Pick<IStorage, "createTask">,
  now: Date,
): Promise<boolean> {
  const key = `question:${question.id}`;
  if (await existingTaskFor(orgId, key)) return false;
  const assignedTo = await resolveAccountManagerId(orgId, question.linkedAccountId);
  if (!assignedTo) return false;
  const taskInput: InsertTask = {
    title: `Answer customer question (open ${QUESTION_STALE_HOURS}h+)`,
    notes: `Inbound question still unanswered: "${question.questionText.slice(0, 200)}"${question.askedByEmail ? ` — from ${question.askedByEmail}` : ""}`,
    status: "open",
    dueDate: now.toISOString().slice(0, 10),
    assignedTo,
    assignedBy: assignedTo,
    companyId: question.linkedAccountId ?? null,
    contactId: question.linkedContactId ?? null,
    orgId,
    forwardedFrom: key,
    createdAt: now.toISOString(),
  };
  await storage.createTask(taskInput);
  return true;
}

export async function runStalenessSweepForOrg(
  orgId: string,
  storage: Pick<IStorage, "createTask">,
  now: Date = new Date(),
): Promise<StalenessSweepResult> {
  const result: StalenessSweepResult = { promiseTasksCreated: 0, questionTasksCreated: 0, skipped: 0, errors: 0 };

  try {
    const promises = await listOverdueOpenPromises(orgId);
    for (const p of promises) {
      try {
        const created = await createPromiseFollowupTask(orgId, p, storage, now);
        if (created) result.promiseTasksCreated += 1; else result.skipped += 1;
      } catch (err) {
        result.errors += 1;
        console.error(`[emailFacts.stale] promise ${p.id} sweep failed:`, err);
      }
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[emailFacts.stale] org ${orgId} promise listing failed:`, err);
  }

  try {
    const questions = await listStaleQuestionsForOrg(orgId, now);
    for (const q of questions) {
      try {
        const created = await createQuestionFollowupTask(orgId, q, storage, now);
        if (created) result.questionTasksCreated += 1; else result.skipped += 1;
      } catch (err) {
        result.errors += 1;
        console.error(`[emailFacts.stale] question ${q.id} sweep failed:`, err);
      }
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[emailFacts.stale] org ${orgId} question listing failed:`, err);
  }

  return result;
}

export async function runStalenessSweepAllOrgs(
  storage: Pick<IStorage, "createTask">,
  now: Date = new Date(),
): Promise<{ orgs: number; totals: StalenessSweepResult }> {
  const rows = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT org_id FROM (
      SELECT org_id FROM email_promises WHERE status = 'open'
      UNION
      SELECT org_id FROM email_questions WHERE status = 'unanswered'
    ) s
  `);
  const totals: StalenessSweepResult = { promiseTasksCreated: 0, questionTasksCreated: 0, skipped: 0, errors: 0 };
  let orgs = 0;
  for (const row of rows.rows ?? rows) {
    const orgId = (row as { org_id: string }).org_id;
    if (!orgId) continue;
    orgs += 1;
    const out = await runStalenessSweepForOrg(orgId, storage, now);
    totals.promiseTasksCreated += out.promiseTasksCreated;
    totals.questionTasksCreated += out.questionTasksCreated;
    totals.skipped += out.skipped;
    totals.errors += out.errors;
  }
  return { orgs, totals };
}
