CREATE TABLE IF NOT EXISTS "carrier_market_nbas" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "carrier_id" varchar NOT NULL,
        "market_signal_id" varchar NOT NULL,
        "recommendation_type" text NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "urgency_score" integer DEFAULT 0 NOT NULL,
        "explanation" jsonb DEFAULT '{}' NOT NULL,
        "suppression_reason" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        "first_seen_at" timestamp DEFAULT now() NOT NULL,
        "last_action_at" timestamp,
        CONSTRAINT "carrier_market_nbas_status_check" CHECK (status IN ('pending','in_progress','completed','dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_carrier_market_nbas_dedup" ON "carrier_market_nbas" ("carrier_id", "market_signal_id", "recommendation_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_carrier_market_nbas_signal" ON "carrier_market_nbas" USING btree ("market_signal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_carrier_market_nbas_carrier" ON "carrier_market_nbas" USING btree ("carrier_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_carrier_market_nbas_status" ON "carrier_market_nbas" USING btree ("status");
