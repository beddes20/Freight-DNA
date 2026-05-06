-- Migration: Add lane_summary_cache table and performance indexes
-- Task #200: LWQ Data Flow & Performance Optimization

-- Pre-computed lane summary cache for lean list endpoints.
-- Populated by scoreAllEligibleLanes() and kept current by write mutations.
CREATE TABLE IF NOT EXISTS "lane_summary_cache" (
  "lane_id"                    varchar PRIMARY KEY REFERENCES "recurring_lanes"("id") ON DELETE CASCADE,
  "lane_score"                 integer,
  "priority"                   integer DEFAULT 0,
  "origin"                     text NOT NULL,
  "origin_state"               text,
  "destination"                text NOT NULL,
  "destination_state"          text,
  "equipment_type"             text,
  "avg_loads_per_week"         decimal(6, 2),
  "company_id"                 varchar,
  "company_name"               text,
  "owner_user_id"              varchar,
  "carriers_contacted_count"   integer DEFAULT 0,
  "contactable_count"          integer DEFAULT 0,
  "total_bench_count"          integer DEFAULT 0,
  "historical_count"           integer DEFAULT 0,
  "missing_contact_count"      integer DEFAULT 0,
  "org_id"                     varchar,
  "is_eligible"                boolean DEFAULT true,
  "has_preferred_carrier_program" boolean DEFAULT false,
  "snoozed_until"              text,
  "resolved_at"                text,
  "updated_at"                 timestamp DEFAULT now() NOT NULL
);

-- Patch: add new columns to existing table if already created
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "contactable_count" integer DEFAULT 0;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "total_bench_count" integer DEFAULT 0;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "historical_count" integer DEFAULT 0;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "missing_contact_count" integer DEFAULT 0;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "org_id" varchar;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "is_eligible" boolean DEFAULT true;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "has_preferred_carrier_program" boolean DEFAULT false;
ALTER TABLE "lane_summary_cache" ADD COLUMN IF NOT EXISTS "snoozed_until" text;

-- Index for personal procurement list queries (owner + unresolved + score ordering)
CREATE INDEX IF NOT EXISTS "lane_summary_cache_owner_resolved_score"
  ON "lane_summary_cache" ("owner_user_id", "resolved_at", "lane_score");

-- Index for org-wide LWQ queries (org + unresolved + score ordering)
CREATE INDEX IF NOT EXISTS "lane_summary_cache_org_resolved_score"
  ON "lane_summary_cache" ("org_id", "resolved_at", "lane_score");

-- Performance indexes for recurring_lanes query patterns
CREATE INDEX IF NOT EXISTS "recurring_lanes_owner_resolved"
  ON "recurring_lanes" ("owner_user_id", "resolved_at");

CREATE INDEX IF NOT EXISTS "recurring_lanes_lane_score_desc"
  ON "recurring_lanes" ("lane_score" DESC);

-- Performance index for tasks (assigned_to + status, for carrier_procurement task lookups)
CREATE INDEX IF NOT EXISTS "tasks_assigned_status"
  ON "tasks" ("assigned_to", "status");

-- Performance index for lane_carrier_interest (lane_id lookups)
CREATE INDEX IF NOT EXISTS "lane_carrier_interest_lane_id_idx"
  ON "lane_carrier_interest" ("lane_id");
