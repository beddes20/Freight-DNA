/**
 * Contact Geography Inference Service (Task #225)
 *
 * Cross-references email participants against financial upload corridors and RFP lanes
 * to detect which contacts are active on which geographies. Produces geography
 * suggestions with confidence scores and source evidence.
 */

import { storage as defaultStorage, type IStorage } from "./storage";
import type { EmailMessage, Contact } from "@shared/schema";

interface GeographyInference {
  contactId: string;
  suggestedRegion: string | null;
  suggestedLane: string | null;
  confidenceScore: number;
  sourceEvidence: {
    emailThreadIds: string[];
    loadReferences: string[];
    rfpIds: string[];
    evidenceSummary: string;
  };
}

export async function inferContactGeography(
  msg: EmailMessage,
  storageInstance?: IStorage,
): Promise<void> {
  const store = storageInstance ?? defaultStorage;

  if (!msg.linkedAccountId || !msg.orgId) return;

  const fromEmail = msg.fromEmail?.toLowerCase();
  if (!fromEmail) return;

  const contacts = await store.getContactsByCompany(msg.linkedAccountId);
  const matchedContact = contacts.find(c => c.email?.toLowerCase() === fromEmail);
  if (!matchedContact) return;

  const lanes = await store.getRecurringLanesByCompany(msg.linkedAccountId);
  if (lanes.length === 0) return;

  const regionSet = new Set<string>();
  const laneDescriptions = new Set<string>();
  const loadRefs: string[] = [];

  for (const lane of lanes) {
    if (lane.originState) regionSet.add(lane.originState);
    if (lane.destinationState) regionSet.add(lane.destinationState);

    const origin = lane.origin || lane.originState || "";
    const dest = lane.destination || lane.destinationState || "";
    if (origin && dest) {
      laneDescriptions.add(`${origin} → ${dest}`);
    }
    loadRefs.push(lane.id);
  }

  if (regionSet.size === 0 && laneDescriptions.size === 0) return;

  const threadId = msg.threadId ?? msg.id;
  const regions = Array.from(regionSet);
  const laneDescs = Array.from(laneDescriptions);

  const inferences: GeographyInference[] = [];

  for (const region of regions.slice(0, 5)) {
    const confidence = Math.min(35 + lanes.length * 5, 80);
    inferences.push({
      contactId: matchedContact.id,
      suggestedRegion: region,
      suggestedLane: null,
      confidenceScore: confidence,
      sourceEvidence: {
        emailThreadIds: [threadId],
        loadReferences: loadRefs.slice(0, 10),
        rfpIds: [],
        evidenceSummary: `Contact active in email thread linked to ${lanes.length} lane(s) touching ${region}`,
      },
    });
  }

  for (const lane of laneDescs.slice(0, 5)) {
    const confidence = Math.min(40 + lanes.length * 5, 85);
    inferences.push({
      contactId: matchedContact.id,
      suggestedRegion: null,
      suggestedLane: lane,
      confidenceScore: confidence,
      sourceEvidence: {
        emailThreadIds: [threadId],
        loadReferences: loadRefs.slice(0, 10),
        rfpIds: [],
        evidenceSummary: `Contact active in email thread linked to lane ${lane}`,
      },
    });
  }

  for (const inf of inferences) {
    try {
      await store.upsertContactGeographySuggestion({
        orgId: msg.orgId,
        accountId: msg.linkedAccountId,
        contactId: inf.contactId,
        suggestedRegion: inf.suggestedRegion,
        suggestedLane: inf.suggestedLane,
        confidenceScore: inf.confidenceScore,
        status: "pending",
        sourceEvidence: inf.sourceEvidence,
        suggestionSource: "email_inference",
      });
    } catch (err) {
      console.error(`[contactGeographyInference] upsert error for contact ${inf.contactId}:`, err);
    }
  }
}

