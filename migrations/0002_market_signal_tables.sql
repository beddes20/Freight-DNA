CREATE TABLE IF NOT EXISTS "market_events" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "event_type" text NOT NULL,
        "scope_type" text NOT NULL,
        "scope_key" text NOT NULL,
        "equipment_type" text,
        "origin_region" text,
        "destination_region" text,
        "account_id" varchar,
        "carrier_id" varchar,
        "event_value" numeric(14, 4),
        "metadata" jsonb,
        "occurred_at" timestamp DEFAULT now() NOT NULL,
        "recorded_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "market_events_event_type_check" CHECK (event_type IN ('demand_request','carrier_capacity_declaration','quote_submission','load_posted','load_covered')),
        CONSTRAINT "market_events_scope_type_check" CHECK (scope_type IN ('region','corridor','equipment_region','national'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_signals" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "signal_type" text NOT NULL,
        "scope_type" text NOT NULL,
        "scope_key" text NOT NULL,
        "equipment_type" text,
        "status" text DEFAULT 'active' NOT NULL,
        "severity" text DEFAULT 'medium' NOT NULL,
        "confidence" numeric(5, 4) DEFAULT 0 NOT NULL,
        "evidence_payload" jsonb DEFAULT '{}' NOT NULL,
        "explanation" text DEFAULT '' NOT NULL,
        "first_detected_at" timestamp DEFAULT now() NOT NULL,
        "last_evaluated_at" timestamp DEFAULT now() NOT NULL,
        "cooling_started_at" timestamp,
        "resolved_at" timestamp,
        CONSTRAINT "market_signals_signal_type_check" CHECK (signal_type IN ('demand_surge','capacity_shortage','demand_capacity_imbalance','quote_activity_spike','carrier_capacity_declaration')),
        CONSTRAINT "market_signals_scope_type_check" CHECK (scope_type IN ('region','corridor','equipment_region','national')),
        CONSTRAINT "market_signals_status_check" CHECK (status IN ('active','cooling','resolved','suppressed')),
        CONSTRAINT "market_signals_severity_check" CHECK (severity IN ('low','medium','high','critical'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_events_scope" ON "market_events" USING btree ("scope_type","scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_events_occurred_at" ON "market_events" USING btree ("occurred_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_events_event_type" ON "market_events" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_signals_scope" ON "market_signals" USING btree ("scope_type","scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_signals_status" ON "market_signals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_signals_signal_type" ON "market_signals" USING btree ("signal_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_market_signals_last_evaluated" ON "market_signals" USING btree ("last_evaluated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_market_signals_active_dedup" ON "market_signals" (signal_type, scope_type, scope_key, COALESCE(equipment_type, '')) WHERE status IN ('active', 'cooling');
