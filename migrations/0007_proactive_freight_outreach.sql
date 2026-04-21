-- Migration: Proactive Available Freight Outreach Engine — Phase 2
-- Task #304
-- Adds the 5 orgId-scoped tables that back the opportunity-generation +
-- carrier-recommendation engine described in
-- docs/proactive-freight-outreach/phase1-audit.md §4.

-- 1) company_outreach_policies — per-shipper opt-in + guardrail config.
CREATE TABLE IF NOT EXISTS "company_outreach_policies" (
  "id"                            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                        varchar NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "company_id"                    varchar NOT NULL UNIQUE REFERENCES "companies"("id") ON DELETE CASCADE,
  "enabled"                       boolean NOT NULL DEFAULT false,
  "mode"                          text    NOT NULL DEFAULT 'exact_load',
  "approval_required"             boolean NOT NULL DEFAULT true,
  "max_carriers_per_opportunity"  integer NOT NULL DEFAULT 25,
  "lead_time_min_days"            integer NOT NULL DEFAULT 2,
  "lead_time_max_days"            integer NOT NULL DEFAULT 7,
  "approved_carrier_only"         boolean NOT NULL DEFAULT false,
  "approved_carrier_ids"          text[]  NOT NULL DEFAULT '{}'::text[],
  "do_not_automate"               boolean NOT NULL DEFAULT false,
  "special_notes"                 text,
  "updated_at"                    timestamp NOT NULL DEFAULT now(),
  "updated_by_id"                 varchar REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "company_outreach_policies_org_enabled_idx"
  ON "company_outreach_policies" ("org_id", "enabled");

-- 2) freight_opportunities — one open load OR small grouped lane sweep.
CREATE TABLE IF NOT EXISTS "freight_opportunities" (
  "id"                          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                      varchar NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "company_id"                  varchar NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "mode"                        text    NOT NULL,
  "recurring_lane_id"           varchar REFERENCES "recurring_lanes"("id") ON DELETE SET NULL,
  "geographic_lane_pattern_id"  varchar REFERENCES "geographic_lane_patterns"("id") ON DELETE SET NULL,
  "origin"                      text    NOT NULL,
  "origin_state"                text,
  "destination"                 text    NOT NULL,
  "destination_state"           text,
  "equipment_type"              text,
  "pickup_window_start"         text    NOT NULL,
  "pickup_window_end"           text    NOT NULL,
  "load_count"                  integer NOT NULL DEFAULT 1,
  "source_ref"                  jsonb,
  "urgency_score"               integer NOT NULL DEFAULT 50,
  "confidence_flag"             text    NOT NULL DEFAULT 'normal',
  "status"                      text    NOT NULL DEFAULT 'new',
  "policy_snapshot"             jsonb,
  "generated_at"                timestamp NOT NULL DEFAULT now(),
  "expires_at"                  timestamp,
  "created_by_id"               varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "notes"                       text
);
CREATE INDEX IF NOT EXISTS "freight_opps_org_status_urgency_idx"
  ON "freight_opportunities" ("org_id", "status", "urgency_score");
CREATE INDEX IF NOT EXISTS "freight_opps_company_pickup_idx"
  ON "freight_opportunities" ("company_id", "pickup_window_start");
CREATE INDEX IF NOT EXISTS "freight_opps_recurring_lane_idx"
  ON "freight_opportunities" ("recurring_lane_id");

-- 3) freight_opportunity_carriers — frozen ranked shortlist per opportunity.
CREATE TABLE IF NOT EXISTS "freight_opportunity_carriers" (
  "id"                       varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "opportunity_id"           varchar NOT NULL REFERENCES "freight_opportunities"("id") ON DELETE CASCADE,
  "carrier_id"               varchar NOT NULL REFERENCES "carriers"("id") ON DELETE CASCADE,
  "rank"                     integer,
  "bucket"                   text,
  "fit_score"                integer NOT NULL DEFAULT 0,
  "history_match"            text    NOT NULL DEFAULT 'none',
  "explanation"              text,
  "explanation_structured"   jsonb,
  "responsiveness_snapshot"  jsonb,
  "excluded_reason"          text,
  "outreach_log_id"          varchar REFERENCES "carrier_outreach_logs"("id") ON DELETE SET NULL,
  "last_response_id"         varchar,
  "created_at"               timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "freight_opp_carriers_opp_rank_idx"
  ON "freight_opportunity_carriers" ("opportunity_id", "rank");
CREATE INDEX IF NOT EXISTS "freight_opp_carriers_carrier_created_idx"
  ON "freight_opportunity_carriers" ("carrier_id", "created_at");

-- 4) freight_opportunity_responses — outcome-of-outreach (separate from
--    carrier-truth signals which live elsewhere).
CREATE TABLE IF NOT EXISTS "freight_opportunity_responses" (
  "id"                       varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "opportunity_carrier_id"   varchar NOT NULL REFERENCES "freight_opportunity_carriers"("id") ON DELETE CASCADE,
  "outcome"                  text    NOT NULL,
  "quoted_rate"              numeric(12,2),
  "reply_source"             text    NOT NULL DEFAULT 'manual_log',
  "email_message_id"         varchar REFERENCES "email_messages"("id") ON DELETE SET NULL,
  "notes"                    text,
  "recorded_by_id"           varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"               timestamp NOT NULL DEFAULT now()
);

-- 5) freight_opportunity_audit — append-only event log per opportunity.
CREATE TABLE IF NOT EXISTS "freight_opportunity_audit" (
  "id"               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "opportunity_id"   varchar NOT NULL REFERENCES "freight_opportunities"("id") ON DELETE CASCADE,
  "event_type"       text    NOT NULL,
  "actor_user_id"    varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "payload"          jsonb,
  "created_at"       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "freight_opp_audit_opp_created_idx"
  ON "freight_opportunity_audit" ("opportunity_id", "created_at");
