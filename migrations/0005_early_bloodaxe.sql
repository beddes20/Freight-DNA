CREATE TABLE "account_contact_lane_pattern_responsibilities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"lane_pattern_id" varchar NOT NULL,
	"is_responsible_for_pattern" boolean DEFAULT true NOT NULL,
	"responsibility_type" text,
	"confidence_score" integer DEFAULT 0 NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"primary_source_type" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_reviewed_at" timestamp,
	"last_reviewed_by_user_id" varchar,
	"evidence_event_keys" text[] DEFAULT '{}',
	"source_types" text[] DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "account_contact_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"email_address" text NOT NULL,
	"suggested_name" text,
	"suggested_title" text,
	"suggested_phone" text,
	"suggestion_source" text DEFAULT 'email_thread' NOT NULL,
	"confidence_score" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"thread_count" integer DEFAULT 1 NOT NULL,
	"email_message_id" varchar,
	"thread_id" text,
	"snoozed_until" timestamp,
	"acted_by_user_id" varchar,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_growth_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"score" integer NOT NULL,
	"band" text NOT NULL,
	"previous_score" integer,
	"previous_band" text,
	"drivers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_look_alikes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"source_company_id" varchar NOT NULL,
	"target_company_id" varchar,
	"target_company_name" text,
	"similarity_score" integer NOT NULL,
	"match_factors" jsonb,
	"expansion_opportunity" text,
	"status" text DEFAULT 'identified' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_reviews" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"rep_user_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"week_of" text NOT NULL,
	"body" text NOT NULL,
	"sections" jsonb,
	"source_snapshots" jsonb,
	"library_item_id" varchar,
	"follow_up_thread_id" varchar,
	"generated_by" text DEFAULT 'scheduled' NOT NULL,
	"rating" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adapter_status" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"adapter_key" text NOT NULL,
	"mode" text DEFAULT 'dry_run' NOT NULL,
	"credentials_configured" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp,
	"notes" text,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_activity" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"conversation_ref" text,
	"direction" text NOT NULL,
	"tool" text,
	"capability" text,
	"summary" text,
	"input_json" jsonb,
	"output_json" jsonb,
	"related_company_id" varchar,
	"related_contact_id" varchar,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"error_message" text,
	"confidence" numeric(4, 3),
	"source_ids" text[],
	"route" text,
	"action_outcome" text,
	"feedback_rating" text,
	"message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"capability" text NOT NULL,
	"effect" text NOT NULL,
	"note" text,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_channel_access" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_facts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"fact" text NOT NULL,
	"source" text DEFAULT 'rep' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"kind" text DEFAULT 'episodic' NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"related_company_id" varchar,
	"related_contact_id" varchar,
	"importance" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "agent_org_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"module_enabled" boolean DEFAULT true NOT NULL,
	"default_access_for_new_users" text DEFAULT 'allow' NOT NULL,
	"default_model" text DEFAULT 'gpt-4o-mini' NOT NULL,
	"auto_approve_personal_memory" boolean DEFAULT true NOT NULL,
	"allow_external_outreach" boolean DEFAULT false NOT NULL,
	"valueiq_landing_enabled" boolean DEFAULT true NOT NULL,
	"valueiq_today_seed_enabled" boolean DEFAULT true NOT NULL,
	"valueiq_today_timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"quote_no_response_timeout_hours" integer DEFAULT 2 NOT NULL,
	"quote_autopilot_started_at" timestamp,
	"notes" text,
	"updated_by" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_outcomes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"workflow_agent_id" varchar NOT NULL,
	"suggestion_id" varchar,
	"hitl_action_id" varchar,
	"override_kind" text DEFAULT 'none' NOT NULL,
	"realized_outcome" text,
	"metric_value" numeric(14, 4),
	"notes" text,
	"recorded_by" varchar,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_personas" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar NOT NULL,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_plays" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar NOT NULL,
	"name" text NOT NULL,
	"when_to_use" text NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"workflow_agent_id" varchar NOT NULL,
	"pod_id" varchar,
	"loop_step" text NOT NULL,
	"input_context" jsonb,
	"suggestion" jsonb NOT NULL,
	"reasoning" text,
	"confidence" integer,
	"related_company_id" varchar,
	"related_lane_key" text,
	"adapter_mode" text DEFAULT 'dry_run' NOT NULL,
	"prompt_version" text,
	"model" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar NOT NULL,
	"capability" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_user_access" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar_url" text,
	"owner_id" varchar,
	"model" text,
	"access_scope" text DEFAULT 'everyone' NOT NULL,
	"allowed_roles" text[],
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_engagement_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"surface" text NOT NULL,
	"feature" text,
	"event_type" text NOT NULL,
	"target_id" text,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_response_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"response" jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"source" text DEFAULT 'sonar' NOT NULL,
	"response_data" jsonb,
	"cached_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "capture_leak_reviews" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"leak_type" text NOT NULL,
	"decision" text NOT NULL,
	"decided_by_user_id" varchar,
	"note" text,
	"decided_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_claimed_lanes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_id" varchar NOT NULL,
	"origin_state" text,
	"origin_city" text,
	"dest_state" text,
	"dest_city" text,
	"equipment" text,
	"lane_type" text DEFAULT 'prefer' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_id" varchar NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'dispatcher' NOT NULL,
	"email" text,
	"phone" text,
	"extension" text,
	"preferred_method" text,
	"notes" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_email_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_id" varchar NOT NULL,
	"email_message_id" varchar NOT NULL,
	"thread_id" text,
	"suggestion_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"confidence" integer DEFAULT 50 NOT NULL,
	"payload_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_import_batches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"lane_id" varchar,
	"source" text NOT NULL,
	"created_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"carrier_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"raw_input" text
);
--> statement-breakpoint
CREATE TABLE "carrier_intel_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"source_type" text NOT NULL,
	"email_signal_id" varchar,
	"market_signal_id" varchar,
	"suggestion_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_score" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"resolution_reason" text,
	"accepted_by_user_id" varchar,
	"rejected_by_user_id" varchar,
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_lane_fit" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"carrier_name" text NOT NULL,
	"origin_state" text NOT NULL,
	"destination_state" text NOT NULL,
	"equipment_type" text DEFAULT 'ALL' NOT NULL,
	"fit_score" integer DEFAULT 0 NOT NULL,
	"exact_lane_runs" integer DEFAULT 0 NOT NULL,
	"nearby_runs" integer DEFAULT 0 NOT NULL,
	"equipment_match" boolean DEFAULT false NOT NULL,
	"region_match" boolean DEFAULT false NOT NULL,
	"evidence_tier" text DEFAULT 'none' NOT NULL,
	"reason" text,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_lane_outcome_event_keys" (
	"org_id" varchar NOT NULL,
	"event_key" varchar NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "carrier_lane_outcome_event_keys_org_id_event_key_pk" PRIMARY KEY("org_id","event_key")
);
--> statement-breakpoint
CREATE TABLE "carrier_lane_outcomes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"carrier_id" varchar NOT NULL,
	"lane_signature" text NOT NULL,
	"origin" text,
	"origin_state" text,
	"destination" text,
	"destination_state" text,
	"equipment_type" text,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"yes_count" integer DEFAULT 0 NOT NULL,
	"quote_count" integer DEFAULT 0 NOT NULL,
	"cover_count" integer DEFAULT 0 NOT NULL,
	"loss_count" integer DEFAULT 0 NOT NULL,
	"first_event_at" timestamp DEFAULT now() NOT NULL,
	"last_event_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_market_nbas" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_id" varchar NOT NULL,
	"market_signal_id" varchar NOT NULL,
	"recommendation_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"urgency_score" integer DEFAULT 0 NOT NULL,
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suppression_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_action_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "carrier_outreach_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"lane_id" varchar,
	"company_id" varchar,
	"carrier_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"carrier_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"owner_user_id" varchar,
	"overseer_user_id" varchar,
	"outreach_mode" text DEFAULT 'lane_building' NOT NULL,
	"email_drafts" jsonb DEFAULT '[]'::jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"delivery_status" varchar DEFAULT 'draft',
	"failure_reason" text,
	"recipients" jsonb,
	"procurement_task_id" varchar,
	"procurement_lane" text,
	"thread_id" text,
	"reply_received_at" timestamp,
	"reply_snippet" text,
	"direction" varchar DEFAULT 'outbound',
	"provider_message_id" text,
	"conversation_id" text,
	"from_email" text,
	"to_email" text,
	"subject" text,
	"body_preview" text,
	"raw_payload_ref" text,
	"received_at" timestamp,
	"process_status" varchar,
	"matched_carrier_id" varchar,
	"matched_lane_id" varchar,
	"match_confidence" varchar,
	"source_module" varchar
);
--> statement-breakpoint
CREATE TABLE "carrier_overrides" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"carrier_id" varchar NOT NULL,
	"lane_signature" text NOT NULL,
	"origin" text,
	"origin_state" text,
	"destination" text,
	"destination_state" text,
	"equipment_type" text,
	"reason_code" text,
	"action" text NOT NULL,
	"notes" text,
	"rep_id" varchar NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"occurred_at_day" varchar(10) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_quote_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"carrier_id" varchar,
	"contact_id" varchar,
	"email_message_id" varchar,
	"lane_key" text,
	"origin_city" text,
	"origin_state" text,
	"dest_city" text,
	"dest_state" text,
	"equipment" text,
	"amount_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"qualifier" text,
	"pickup_date" date,
	"source_reference" text NOT NULL,
	"extraction_source" text DEFAULT 'regex' NOT NULL,
	"raw_snippet" text,
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_recommendation" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"load_fact_id" varchar NOT NULL,
	"rank" integer NOT NULL,
	"carrier_name" text NOT NULL,
	"total_score" integer DEFAULT 0 NOT NULL,
	"fit_score" integer DEFAULT 0 NOT NULL,
	"performance_score" integer DEFAULT 0 NOT NULL,
	"target_buy_rpm" numeric(8, 4),
	"pricing_confidence" text DEFAULT 'low' NOT NULL,
	"last_used_date" text,
	"avg_historical_buy_rpm" numeric(8, 4),
	"expected_margin_low_pct" numeric(5, 2),
	"expected_margin_high_pct" numeric(5, 2),
	"coverage_urgency" text DEFAULT 'green' NOT NULL,
	"reason" text,
	"rationale" jsonb,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_scorecard_fact" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"carrier_name" text NOT NULL,
	"equipment_type" text DEFAULT 'ALL' NOT NULL,
	"window_days" integer DEFAULT 180 NOT NULL,
	"loads" integer DEFAULT 0 NOT NULL,
	"loads_30d" integer DEFAULT 0 NOT NULL,
	"loads_90d" integer DEFAULT 0 NOT NULL,
	"revenue" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"margin" numeric(14, 2) DEFAULT '0' NOT NULL,
	"margin_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"avg_rpm" numeric(8, 4),
	"total_miles" numeric(14, 2) DEFAULT '0' NOT NULL,
	"revenue_per_load" numeric(12, 2),
	"on_time_pct" numeric(5, 2),
	"active_loads" integer DEFAULT 0 NOT NULL,
	"available_loads" integer DEFAULT 0 NOT NULL,
	"do_not_use" boolean DEFAULT false NOT NULL,
	"performance_score" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'new' NOT NULL,
	"days_since_last_load" integer,
	"last_load_date" text,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"mc_dot" text,
	"dot_number" text,
	"payee_code" text,
	"phone" text,
	"city" text,
	"state" text,
	"regions" text[] DEFAULT '{}'::text[],
	"states_served" text[] DEFAULT '{}'::text[],
	"metro_areas" text[] DEFAULT '{}'::text[],
	"equipment_types" text[] DEFAULT '{}'::text[],
	"equipment_notes" text,
	"tags" text[] DEFAULT '{}'::text[],
	"primary_email" text,
	"backup_email" text,
	"last_email_validated_at" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source_channel" text,
	"import_batch_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coaching_notes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"manager_id" varchar NOT NULL,
	"rep_id" varchar NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text,
	"subject_label" text,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "company_collaborators" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"added_by_user_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_financial_aliases" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"alias" text NOT NULL,
	"alias_normalized" text NOT NULL,
	"source" text NOT NULL,
	"confirmed_by_user_id" varchar,
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "company_outreach_policies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'exact_load' NOT NULL,
	"approval_required" boolean DEFAULT true NOT NULL,
	"max_carriers_per_opportunity" integer DEFAULT 25 NOT NULL,
	"lead_time_min_days" integer DEFAULT 2 NOT NULL,
	"lead_time_max_days" integer DEFAULT 7 NOT NULL,
	"approved_carrier_only" boolean DEFAULT false NOT NULL,
	"approved_carrier_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"do_not_automate" boolean DEFAULT false NOT NULL,
	"special_notes" text,
	"auto_send_enabled" boolean DEFAULT false NOT NULL,
	"auto_send_hour_ct" integer DEFAULT 8 NOT NULL,
	"auto_send_top_n" integer DEFAULT 3 NOT NULL,
	"auto_send_max_per_day" integer DEFAULT 10 NOT NULL,
	"auto_send_last_run_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_id" varchar,
	CONSTRAINT "company_outreach_policies_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE "competitive_signals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"signal_type" text NOT NULL,
	"competitor_name" text,
	"description" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"severity" text DEFAULT 'moderate' NOT NULL,
	"suggested_response" text,
	"status" text DEFAULT 'active' NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_base_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" varchar NOT NULL,
	"from_base" text,
	"to_base" text NOT NULL,
	"changed_by_id" varchar NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_geography_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"suggested_region" text,
	"suggested_lane" text,
	"confidence_score" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_evidence" jsonb DEFAULT '{}'::jsonb,
	"suggestion_source" text DEFAULT 'email_inference' NOT NULL,
	"acted_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_lane_attributions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"origin_city" text,
	"origin_state" text,
	"destination_city" text,
	"destination_state" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"notes" text,
	"created_by" varchar,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "contact_sentiment_tracking" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"sentiment_score" integer NOT NULL,
	"sentiment_trend" text DEFAULT 'stable' NOT NULL,
	"avg_response_time_hours" numeric,
	"response_time_change" numeric,
	"signals" jsonb,
	"analysis_date" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_note_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" varchar NOT NULL,
	"actor_id" varchar NOT NULL,
	"type" varchar(32) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_note_mentions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "context_note_replies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" varchar NOT NULL,
	"author_id" varchar NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_notes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"author_id" varchar NOT NULL,
	"anchor_type" varchar(32) NOT NULL,
	"anchor_id" text NOT NULL,
	"anchor_label" text,
	"route_payload" jsonb,
	"body" text NOT NULL,
	"action_type" varchar(32) DEFAULT 'fyi' NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" varchar,
	"converted_task_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_saved_views" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"bucket" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_suggestion_feedback_stats" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"action_type" text NOT NULL,
	"wrong_count" integer DEFAULT 0 NOT NULL,
	"good_count" integer DEFAULT 0 NOT NULL,
	"dismissed_count" integer DEFAULT 0 NOT NULL,
	"recent_wrong_reasons" jsonb DEFAULT '[]'::jsonb,
	"last_wrong_at" timestamp,
	"last_feedback_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_thread_capture_audits" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"thread_id" text NOT NULL,
	"mailbox_id" varchar,
	"triggered_by" text NOT NULL,
	"triggered_by_user_id" varchar,
	"messages_found_upstream" integer DEFAULT 0 NOT NULL,
	"messages_persisted" integer DEFAULT 0 NOT NULL,
	"root_cause_label" text DEFAULT 'nothing_missing' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_thread_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"thread_id" text NOT NULL,
	"actor_user_id" varchar,
	"actor_name" text,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_thread_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"thread_id" text NOT NULL,
	"action_type" text NOT NULL,
	"action_label" text NOT NULL,
	"action_reason" text NOT NULL,
	"action_params" jsonb DEFAULT '{}'::jsonb,
	"content_hash" text NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"dismissed_at" timestamp,
	"dismissed_by_user_id" varchar,
	"feedback_kind" text,
	"feedback_notes" text,
	"feedback_at" timestamp,
	"feedback_by_user_id" varchar
);
--> statement-breakpoint
CREATE TABLE "conversation_thread_summaries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"thread_id" text NOT NULL,
	"summary" text NOT NULL,
	"content_hash" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp,
	"model" text,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_actions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"confirmed_by_user_id" varchar NOT NULL,
	"conversation_ref" text,
	"message_id" integer,
	"tool" text NOT NULL,
	"args" jsonb,
	"result" text DEFAULT 'success' NOT NULL,
	"error_message" text,
	"related_company_id" varchar,
	"related_contact_id" varchar,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_adjustments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"factor" numeric(5, 3) DEFAULT '1.000' NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"win_rate" numeric(5, 4),
	"evidence" jsonb,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_feedback" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"conversation_ref" text,
	"message_id" integer,
	"rating" text NOT NULL,
	"comment" text,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_intelligence" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"document_id" varchar NOT NULL,
	"extraction_id" varchar,
	"lane_key" text,
	"customer_id" varchar,
	"lane_fit_score" integer,
	"customer_fit_score" integer,
	"carrier_fit_score" integer,
	"price_low" numeric(10, 2),
	"price_mid" numeric(10, 2),
	"price_high" numeric(10, 2),
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opportunities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" text DEFAULT 'low' NOT NULL,
	"scoring_version" integer DEFAULT 1 NOT NULL,
	"adjustments_applied" jsonb,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_outcomes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"recommendation_id" varchar NOT NULL,
	"user_id" varchar,
	"rep_action" text NOT NULL,
	"rep_edits" jsonb,
	"realized_outcome" text,
	"realized_dollar_impact" numeric(12, 2),
	"realized_at" timestamp,
	"signals" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_play_recommendations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"intelligence_id" varchar,
	"document_id" varchar,
	"lane_key" text,
	"customer_id" varchar,
	"carrier_id" varchar,
	"rfp_id" varchar,
	"freight_id" varchar,
	"play_id" text NOT NULL,
	"play_name" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"confidence" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_action" jsonb,
	"rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_by_user_id" varchar,
	"resolved_at" timestamp,
	"snoozed_until" timestamp,
	"override_note" text,
	"owner_user_id" varchar,
	"dedup_key" text,
	"nba_card_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_recommendations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"source_document_id" varchar,
	"source_kind" text DEFAULT 'rate_con' NOT NULL,
	"customer_company_id" varchar,
	"carrier_id" varchar,
	"opportunity_id" varchar,
	"lane_signature" text,
	"card_payload" jsonb NOT NULL,
	"suggested_plays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aggregate_confidence" text DEFAULT 'medium' NOT NULL,
	"fit_score" integer DEFAULT 0 NOT NULL,
	"generated_by_user_id" varchar,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"reaction" text DEFAULT 'pending' NOT NULL,
	"reaction_reason" text,
	"reacted_at" timestamp,
	"reacted_by_user_id" varchar,
	"downstream_outcome" jsonb,
	"outcome_resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_account_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"organization_id" varchar NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer,
	"company_id" varchar,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"record_type" text DEFAULT 'single_multi_lane' NOT NULL,
	"stage" text DEFAULT 'qualification' NOT NULL,
	"amount" text,
	"close_date" text,
	"probability" integer,
	"notes" text,
	"lost_reason" text,
	"outcome" text,
	"created_by_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_ownership_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"organization_id" varchar NOT NULL,
	"requester_id" varchar NOT NULL,
	"current_owner_id" varchar NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"admin_note" text,
	"reviewed_by_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cron_heartbeats" (
	"job_name" varchar PRIMARY KEY NOT NULL,
	"expected_interval_ms" integer NOT NULL,
	"last_started_at" timestamp,
	"last_finished_at" timestamp,
	"last_duration_ms" integer,
	"last_status" varchar DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"next_expected_at" timestamp,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_sell_opportunities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"opportunity_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"lane" text,
	"estimated_value" numeric,
	"confidence_score" integer,
	"peer_evidence" jsonb,
	"suggested_approach" text,
	"status" text DEFAULT 'identified' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_email_identities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"contact_id" varchar,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_entity_links" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"target_table" text NOT NULL,
	"target_id" text NOT NULL,
	"target_label" text,
	"match_score" numeric(4, 3) NOT NULL,
	"match_signal" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"candidate_rank" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_extraction_corrections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"field_path" text NOT NULL,
	"class_label" text NOT NULL,
	"original_value" jsonb,
	"corrected_value" jsonb,
	"corrected_by_id" varchar NOT NULL,
	"corrected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_extraction_findings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"rule_code" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"class_label" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"extractor" text NOT NULL,
	"payload" jsonb NOT NULL,
	"resolved_entities" jsonb,
	"needs_human_review" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_extractions_typed" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"class_label" text NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"needs_review_reason" text,
	"extractor_model" text,
	"extracted_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"page_number" integer NOT NULL,
	"text" text,
	"table_rows" jsonb,
	"bbox" jsonb
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"uploader_id" varchar NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"source_channel" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_url" text,
	"upload_context" jsonb,
	"class_label" text DEFAULT 'unknown' NOT NULL,
	"class_confidence" numeric(4, 3),
	"class_method" text,
	"status" text DEFAULT 'parsing' NOT NULL,
	"error_reason" text,
	"page_count" integer,
	"ocr_used" boolean DEFAULT false NOT NULL,
	"forwarded_from_email" text,
	"forwarded_subject" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"parsed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_feedback" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"user_name" text,
	"rating" text NOT NULL,
	"notes" text,
	"draft_text" text NOT NULL,
	"edited_text" text,
	"play_type" text NOT NULL,
	"play_label" text,
	"thread_id" text,
	"account_id" varchar,
	"account_name" text,
	"contact_id" varchar,
	"contact_name" text,
	"voice_profile_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_attachment_classifications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"attachment_name" text NOT NULL,
	"attachment_size" integer,
	"content_type" text,
	"kind" text NOT NULL,
	"confidence" integer DEFAULT 50 NOT NULL,
	"routed_to" text,
	"routed_ref_id" varchar,
	"features" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_bounce_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"contact_email" text NOT NULL,
	"contact_id" varchar,
	"bounce_type" text NOT NULL,
	"diagnostic_code" text,
	"ooo_until" timestamp,
	"alternate_contact_email" text,
	"alternate_contact_name" text,
	"raw_headers" jsonb,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_conversation_read_states" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"thread_id" text NOT NULL,
	"last_read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_conversation_threads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"thread_id" text NOT NULL,
	"linked_account_id" varchar,
	"linked_carrier_id" varchar,
	"owner_user_id" varchar,
	"waiting_state" text DEFAULT 'waiting_on_us' NOT NULL,
	"response_priority" text DEFAULT 'normal' NOT NULL,
	"last_message_id" varchar,
	"last_incoming_at" timestamp,
	"last_outgoing_at" timestamp,
	"last_email_at" timestamp,
	"waiting_since_at" timestamp,
	"overdue_at" timestamp,
	"archived_at" timestamp,
	"snoozed_until" timestamp,
	"snoozed_from_state" text,
	"snoozed_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"row_version_at" timestamp DEFAULT now() NOT NULL,
	"attribution_inference_source" text,
	"attribution_evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE "email_extracted_slots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"thread_id" text,
	"slot_name" text NOT NULL,
	"slot_value" text,
	"slot_value_numeric" numeric(14, 4),
	"slot_value_date" timestamp,
	"confidence" integer DEFAULT 50 NOT NULL,
	"evidence" text,
	"linked_account_id" varchar,
	"linked_lane_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"provider_message_id" text,
	"thread_id" text,
	"direction" text NOT NULL,
	"from_email" text,
	"to_email" text,
	"cc_email" text,
	"subject" text,
	"body" text,
	"linked_account_id" varchar,
	"linked_carrier_id" varchar,
	"linked_lane_id" varchar,
	"linked_load_id" varchar,
	"linked_task_id" varchar,
	"linked_nba_id" varchar,
	"linked_outreach_log_id" varchar,
	"processed_for_signals_at" timestamp,
	"provider_sent_at" timestamp,
	"ingested_via" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbound_quality_scores" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"rep_user_id" varchar,
	"linked_account_id" varchar,
	"clarity_score" integer DEFAULT 0 NOT NULL,
	"tone_score" integer DEFAULT 0 NOT NULL,
	"value_add_score" integer DEFAULT 0 NOT NULL,
	"objection_handling_score" integer DEFAULT 0 NOT NULL,
	"overall_score" integer DEFAULT 0 NOT NULL,
	"features" jsonb,
	"grader_version" text DEFAULT 'heuristic_v1' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outcome_links" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_signal_id" varchar NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" varchar NOT NULL,
	"outcome_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_participants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"thread_id" text,
	"email_address" text NOT NULL,
	"display_name" text,
	"role" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"contact_id" varchar,
	"company_id" varchar,
	"message_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_promises" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"thread_id" text,
	"rep_user_id" varchar,
	"linked_account_id" varchar,
	"linked_contact_id" varchar,
	"promise_text" text NOT NULL,
	"promise_due_at" timestamp,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_message_id" varchar,
	"confidence" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_questions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"thread_id" text,
	"linked_account_id" varchar,
	"linked_contact_id" varchar,
	"asked_by_email" text,
	"question_text" text NOT NULL,
	"status" text DEFAULT 'unanswered' NOT NULL,
	"answered_at" timestamp,
	"answered_by_message_id" varchar,
	"time_to_answer_sec" integer,
	"confidence" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_reply_latency_regression_settings" (
	"organization_id" varchar PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lookback_weeks" integer DEFAULT 4 NOT NULL,
	"p90_regression_pct" integer DEFAULT 25 NOT NULL,
	"min_replies" integer DEFAULT 10 NOT NULL,
	"business_hours" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar
);
--> statement-breakpoint
CREATE TABLE "email_response_time_sla_settings" (
	"organization_id" varchar PRIMARY KEY NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar
);
--> statement-breakpoint
CREATE TABLE "email_signals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" varchar NOT NULL,
	"intent_type" text NOT NULL,
	"intent_subtype" text,
	"actor_type" text NOT NULL,
	"entity_type" text,
	"entity_id" varchar,
	"confidence" integer DEFAULT 50 NOT NULL,
	"extracted_data" jsonb DEFAULT '{}'::jsonb,
	"linked_account_id" varchar,
	"linked_carrier_id" varchar,
	"linked_lane_id" varchar,
	"linked_opportunity_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_perf_samples" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar,
	"route_key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"status_code" integer NOT NULL,
	"cache_hint" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_contact_consent" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_kind" text NOT NULL,
	"identifier" text NOT NULL,
	"display_name" text,
	"related_company_id" varchar,
	"consent" text DEFAULT 'unknown' NOT NULL,
	"first_contact_by" varchar,
	"first_contact_at" timestamp,
	"last_contact_at" timestamp,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"flag_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_id" varchar
);
--> statement-breakpoint
CREATE TABLE "field_confidence_overrides" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"class_label" text NOT NULL,
	"field_path" text NOT NULL,
	"confidence_multiplier" numeric(4, 3) NOT NULL,
	"correction_rate" numeric(4, 3) NOT NULL,
	"sample_size" integer NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "follow_up_recommendations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"recommended_day" text,
	"recommended_time_of_day" text,
	"optimal_cadence_days" integer,
	"max_silence_days" integer,
	"next_follow_up_date" text,
	"reasoning" text,
	"confidence_score" integer,
	"data_points" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forced_focus" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assigned_to_user_id" varchar NOT NULL,
	"assigned_by_user_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar,
	"company_name" text,
	"contact_id" varchar,
	"contact_name" text,
	"related_opportunity_id" varchar,
	"related_task_id" varchar,
	"lever" text,
	"action_text" text NOT NULL,
	"context_reason" text,
	"due_date" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "forward_calendar_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar NOT NULL,
	"thread_id" text,
	"linked_account_id" varchar,
	"linked_lane_id" varchar,
	"event_type" text NOT NULL,
	"event_date" timestamp NOT NULL,
	"description" text,
	"confidence" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"nba_card_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_daily_upload_fact" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"upload_id" varchar NOT NULL,
	"load_key" text NOT NULL,
	"order_number" text,
	"customer" text,
	"origin_city" text,
	"origin_state" text,
	"dest_city" text,
	"dest_state" text,
	"equipment" text,
	"carrier_name" text,
	"carrier_payee_code" text,
	"ship_date" text,
	"delivery_date" text,
	"brokerage_status" text,
	"order_type" text,
	"moved" boolean DEFAULT false NOT NULL,
	"total_revenue" numeric(14, 2),
	"carrier_total" numeric(14, 2),
	"margin_pct" numeric(6, 2),
	"loaded_miles" integer,
	"ingested_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_opportunities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"mode" text NOT NULL,
	"recurring_lane_id" varchar,
	"geographic_lane_pattern_id" varchar,
	"origin" text NOT NULL,
	"origin_state" text,
	"destination" text NOT NULL,
	"destination_state" text,
	"equipment_type" text,
	"pickup_window_start" text NOT NULL,
	"pickup_window_end" text NOT NULL,
	"delivery_date" text,
	"load_count" integer DEFAULT 1 NOT NULL,
	"source_ref" jsonb,
	"urgency_score" integer DEFAULT 50 NOT NULL,
	"confidence_flag" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"policy_snapshot" jsonb,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_by_id" varchar,
	"notes" text,
	"owner_user_id" varchar,
	"delegated_to_user_id" varchar,
	"sender_mailbox" text,
	"template_override_subject" text,
	"template_override_body" text,
	"cadence_config" jsonb,
	"approved_at" timestamp,
	"approved_by_id" varchar,
	"source_file_name" text,
	"awaiting_approval_since" timestamp,
	"sla_notified_l1_at" timestamp,
	"sla_notified_l2_at" timestamp,
	"snoozed_until" timestamp,
	"source_quote_id" varchar,
	"quoted_rate" numeric(12, 2),
	"target_buy_rate" numeric(12, 2)
);
--> statement-breakpoint
CREATE TABLE "freight_opportunity_audit" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" varchar,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_opportunity_capture_failures" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"quote_id" varchar NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"error_message" text,
	"error_stack" text,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_retry_at" timestamp,
	"last_retry_error" text,
	"resolved_at" timestamp,
	"resolved_by_id" varchar,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "freight_opportunity_carriers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" varchar NOT NULL,
	"carrier_id" varchar NOT NULL,
	"rank" integer,
	"bucket" text,
	"fit_score" integer DEFAULT 0 NOT NULL,
	"history_match" text DEFAULT 'none' NOT NULL,
	"explanation" text,
	"explanation_structured" jsonb,
	"responsiveness_snapshot" jsonb,
	"excluded_reason" text,
	"outreach_log_id" varchar,
	"last_response_id" varchar,
	"wave" integer,
	"scheduled_for" timestamp,
	"sent_at" timestamp,
	"thread_id" text,
	"internet_message_id" text,
	"last_send_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_opportunity_rate_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" varchar NOT NULL,
	"field" text NOT NULL,
	"old_rate" numeric(12, 2),
	"new_rate" numeric(12, 2),
	"changed_by_id" varchar,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "freight_opportunity_responses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_carrier_id" varchar NOT NULL,
	"outcome" text NOT NULL,
	"quoted_rate" numeric(12, 2),
	"reply_source" text DEFAULT 'manual_log' NOT NULL,
	"email_message_id" varchar,
	"notes" text,
	"recorded_by_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_opportunity_saved_views" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freight_outreach_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_id" varchar
);
--> statement-breakpoint
CREATE TABLE "geographic_lane_patterns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar,
	"name" text NOT NULL,
	"origin_region" text NOT NULL,
	"destination_region" text NOT NULL,
	"named_corridor" text,
	"description" text,
	"is_baseline" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_tenant_consent" (
	"scope" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"last_checked_at" timestamp,
	"last_error" text,
	"mailbox" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hitl_actions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"workflow_agent_id" varchar NOT NULL,
	"pod_id" varchar,
	"suggestion_id" varchar,
	"action_kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"payload" jsonb NOT NULL,
	"reasoning" text,
	"adapter_mode" text DEFAULT 'dry_run' NOT NULL,
	"routed_to_user_id" varchar,
	"related_company_id" varchar,
	"related_lane_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" varchar,
	"decision_note" text,
	"decided_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_health_snapshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"connected" boolean NOT NULL,
	"health_state" text NOT NULL,
	"last_success_at" timestamp,
	"last_error_at" timestamp,
	"last_error_message" text,
	"breaker_state" text,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intel_lane_rates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_lane_id" varchar NOT NULL,
	"refreshed_at" timestamp DEFAULT now() NOT NULL,
	"spot_rpm" numeric(8, 4),
	"spot_rpm_high" numeric(8, 4),
	"spot_rpm_low" numeric(8, 4),
	"spot_rate" numeric(10, 2),
	"spot_rate_high" numeric(10, 2),
	"spot_rate_low" numeric(10, 2),
	"contract_rpm" numeric(8, 4),
	"contract_rate" numeric(10, 2),
	"contract_fsc_rpm" numeric(8, 4),
	"confidence_score" numeric(5, 2),
	"load_count" integer,
	"miles" integer,
	"avg_rpm_30d" numeric(8, 4),
	"avg_rpm_90d" numeric(8, 4),
	"forecast_json" jsonb,
	"rate_alert" text,
	"alert_reason" text,
	"driver_text" text
);
--> statement-breakpoint
CREATE TABLE "intel_tracked_lanes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"lane_id" varchar,
	"origin" text NOT NULL,
	"origin_label" text,
	"destination" text NOT NULL,
	"destination_label" text,
	"equipment_type" text DEFAULT 'VAN' NOT NULL,
	"source" text DEFAULT 'lwq' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_carrier_interest" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lane_id" varchar NOT NULL,
	"carrier_id" varchar,
	"carrier_name" text NOT NULL,
	"interest_status" text DEFAULT 'needs_follow_up' NOT NULL,
	"reply_snippet" text,
	"last_reply_snippet" text,
	"classified_at" text,
	"notes" text,
	"fit_score" integer,
	"fit_reason" text,
	"outreach_sent_at" text,
	"source_type" text DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_carriers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" varchar NOT NULL,
	"award_id" varchar NOT NULL,
	"lane" text NOT NULL,
	"carrier_name" text NOT NULL,
	"mc_number" text,
	"contact_name" text,
	"phone" text,
	"email" text,
	"rate" text,
	"capacity_per_week" integer,
	"notes" text,
	"status" text DEFAULT 'contacted' NOT NULL,
	"outreach_log" jsonb DEFAULT '[]'::jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_coverage_profile_carriers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" varchar NOT NULL,
	"carrier_id" varchar,
	"carrier_name" text NOT NULL,
	"incumbent_rank" integer DEFAULT 1 NOT NULL,
	"successful_load_count" integer DEFAULT 0 NOT NULL,
	"recent_load_count" integer DEFAULT 0 NOT NULL,
	"coverage_share" numeric(5, 4),
	"last_used_at" text,
	"last_success_at" text,
	"is_current_primary" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_coverage_profiles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"lane_id" varchar,
	"lane_key" text NOT NULL,
	"coverage_status" text DEFAULT 'unstable' NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"qualified_carrier_count" integer DEFAULT 0 NOT NULL,
	"top_carrier_coverage_share" numeric(5, 4),
	"computed_at" text,
	"manual_override_status" text,
	"manual_override_reason" text,
	"manually_confirmed_by_user_id" varchar,
	"manually_confirmed_at" text,
	"broaden_search_active" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_rate_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"origin_state" text NOT NULL,
	"destination_state" text NOT NULL,
	"equipment_type" text DEFAULT 'ALL' NOT NULL,
	"customer_name" text DEFAULT '__ANY__' NOT NULL,
	"window_days" integer DEFAULT 180 NOT NULL,
	"loads" integer DEFAULT 0 NOT NULL,
	"loads_30d" integer DEFAULT 0 NOT NULL,
	"loads_60d" integer DEFAULT 0 NOT NULL,
	"loads_90d" integer DEFAULT 0 NOT NULL,
	"avg_revenue_per_mile" numeric(8, 4),
	"avg_cost_per_mile" numeric(8, 4),
	"avg_margin_pct" numeric(7, 4),
	"median_cost_per_mile" numeric(8, 4),
	"min_cost_per_mile" numeric(8, 4),
	"max_cost_per_mile" numeric(8, 4),
	"p25_cost_per_mile" numeric(8, 4),
	"p75_cost_per_mile" numeric(8, 4),
	"avg_cost_30d" numeric(8, 4),
	"avg_cost_60d" numeric(8, 4),
	"avg_cost_90d" numeric(8, 4),
	"unique_carriers" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_summary_cache" (
	"lane_id" varchar PRIMARY KEY NOT NULL,
	"lane_score" integer,
	"priority" integer DEFAULT 0,
	"origin" text NOT NULL,
	"origin_state" text,
	"destination" text NOT NULL,
	"destination_state" text,
	"equipment_type" text,
	"avg_loads_per_week" numeric(6, 2),
	"company_id" varchar,
	"company_name" text,
	"owner_user_id" varchar,
	"owner_name" text,
	"carriers_contacted_count" integer DEFAULT 0,
	"contactable_count" integer DEFAULT 0,
	"total_bench_count" integer DEFAULT 0,
	"historical_count" integer DEFAULT 0,
	"missing_contact_count" integer DEFAULT 0,
	"org_id" varchar,
	"is_eligible" boolean DEFAULT true,
	"has_preferred_carrier_program" boolean DEFAULT false,
	"snoozed_until" text,
	"resolved_at" text,
	"drop_trailer_shipper" boolean DEFAULT false NOT NULL,
	"drop_trailer_receiver" boolean DEFAULT false NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leak_console_audit" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"lane_id" varchar,
	"lane_sig" text NOT NULL,
	"panel" text NOT NULL,
	"fix_kind" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leak_console_daily_snapshot" (
	"org_id" varchar NOT NULL,
	"snapshot_date" text NOT NULL,
	"no_contactable_under_demand" integer DEFAULT 0 NOT NULL,
	"unstable_spot_deployed" integer DEFAULT 0 NOT NULL,
	"recurring_covered_on_spot" integer DEFAULT 0 NOT NULL,
	"owned_untouched_under_pressure" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "leak_console_daily_snapshot_org_id_snapshot_date_pk" PRIMARY KEY("org_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"source_id" varchar,
	"title" text NOT NULL,
	"body" text,
	"embedding" vector(1536),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "load_fact" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"order_id" text NOT NULL,
	"company_id" varchar,
	"customer_name" text,
	"carrier_name" text,
	"carrier_payee_code" text,
	"origin_city" text,
	"origin_state" text,
	"origin_zip" text,
	"destination_city" text,
	"destination_state" text,
	"destination_zip" text,
	"account_manager" text,
	"dispatcher" text,
	"equipment_type" text,
	"pickup_date" text,
	"delivery_date" text,
	"pickup_appt_start" text,
	"pickup_appt_end" text,
	"delivery_appt_start" text,
	"delivery_appt_end" text,
	"arrived_at_pickup" text,
	"arrived_at_delivery" text,
	"total_stops" integer,
	"total_miles" numeric(10, 2),
	"month" text,
	"move_status" text,
	"bucket" text DEFAULT 'available' NOT NULL,
	"revenue" numeric(14, 2),
	"cost" numeric(14, 2),
	"margin" numeric(14, 2),
	"margin_pct" numeric(7, 4),
	"load_count" integer DEFAULT 1 NOT NULL,
	"raw_row" jsonb,
	"source_file_name" text,
	"source_kind" text DEFAULT 'powerbi' NOT NULL,
	"imported_at" timestamp DEFAULT now() NOT NULL,
	"last_changed_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"expired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "load_fact_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"load_fact_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"field_name" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"import_batch_id" varchar
);
--> statement-breakpoint
CREATE TABLE "load_fact_import_audit" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"file_name" text,
	"file_hash" text,
	"replay_token" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"transitioned" integer DEFAULT 0 NOT NULL,
	"expired" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"bucket_available" integer DEFAULT 0 NOT NULL,
	"bucket_realized" integer DEFAULT 0 NOT NULL,
	"bucket_cancelled" integer DEFAULT 0 NOT NULL,
	"bucket_unknown" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb,
	"actor_user_id" varchar,
	"triggered_by" text DEFAULT 'manual' NOT NULL,
	"kind" text DEFAULT 'powerbi' NOT NULL,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_health_alerts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"mailbox_id" varchar NOT NULL,
	"alert_key" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"reason" text NOT NULL,
	"first_fired_at" timestamp DEFAULT now() NOT NULL,
	"last_fired_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_historical_backfills" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"mailbox_id" varchar NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"messages_fetched" integer DEFAULT 0 NOT NULL,
	"messages_ingested" integer DEFAULT 0 NOT NULL,
	"messages_duplicate" integer DEFAULT 0 NOT NULL,
	"errors_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"triggered_by" text DEFAULT 'auto' NOT NULL,
	"triggered_by_user_id" varchar,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_sync_failures" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"mailbox_id" varchar NOT NULL,
	"folder" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"error_category" text NOT NULL,
	"error_message" text NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_events" (
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
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_signals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_type" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"equipment_type" text,
	"status" text DEFAULT 'active' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0' NOT NULL,
	"evidence_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"first_detected_at" timestamp DEFAULT now() NOT NULL,
	"last_evaluated_at" timestamp DEFAULT now() NOT NULL,
	"cooling_started_at" timestamp,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "meeting_prep_briefs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"generated_by_user_id" varchar NOT NULL,
	"brief_content" jsonb NOT NULL,
	"recent_activity" jsonb,
	"lane_highlights" jsonb,
	"talking_points" jsonb,
	"risk_alerts" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missed_inbound_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"cdr_id" text NOT NULL,
	"calling_number" text NOT NULL,
	"called_number" text,
	"ring_duration_seconds" integer DEFAULT 0 NOT NULL,
	"voicemail_left" boolean DEFAULT false NOT NULL,
	"start_time" text NOT NULL,
	"contact_id" varchar,
	"company_id" varchar,
	"attributed_user_id" varchar,
	"webex_person_id" text,
	"webex_user_email" text,
	"after_hours" boolean DEFAULT false NOT NULL,
	"nba_card_id" varchar,
	"callback_created_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitored_mailboxes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"email" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"subscription_id" text,
	"sent_items_subscription_id" text,
	"subscription_expires_at" timestamp,
	"last_sync_at" timestamp,
	"delta_sync_token" text,
	"sent_delta_sync_token" text,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"last_sent_items_notification_at" timestamp,
	"last_outbound_captured_at" timestamp,
	"last_inbox_notification_at" timestamp,
	"last_webhook_error_at" timestamp,
	"last_webhook_error_reason" text,
	"last_subscription_renewal_at" timestamp,
	"last_subscription_renewal_error" text,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_reason" text,
	"poll_cadence_seconds" integer DEFAULT 300 NOT NULL,
	"last_watchdog_action_at" timestamp,
	"last_watchdog_action" text,
	"monitor_mode" text DEFAULT 'monitored_active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nam_lm_checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"reviewer_id" varchar NOT NULL,
	"lm_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"check_date" date DEFAULT CURRENT_DATE NOT NULL,
	"check_type" varchar NOT NULL,
	"check_calls_done" boolean,
	"board_clean" boolean,
	"checkout_done" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "nba_card_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"reason" text,
	"actor_user_id" varchar,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nba_card_outcomes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"rule_type" text NOT NULL,
	"outcome" text NOT NULL,
	"basis" text,
	"dollar_impact" numeric(14, 2),
	"from_action" text,
	"attribution_window_days" integer,
	"classified_at" timestamp DEFAULT now() NOT NULL,
	"signals" jsonb
);
--> statement-breakpoint
CREATE TABLE "nba_cards" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"company_id" varchar,
	"contact_id" varchar,
	"company_name" text,
	"rule_type" text NOT NULL,
	"outcome_type" text DEFAULT 'protect' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"signal_count" integer DEFAULT 1 NOT NULL,
	"signal_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"why_this_now" text NOT NULL,
	"suggested_action" text NOT NULL,
	"expected_outcome" text NOT NULL,
	"growth_lever" text,
	"relationship_move" text,
	"account_tier" text,
	"urgency_score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"resolution_action" text,
	"dismiss_reason" text,
	"snooze_until" text,
	"alternate_action_note" text,
	"linked_commitment_id" varchar,
	"linked_touchpoint_id" varchar,
	"linked_task_id" varchar,
	"linked_lane_id" varchar,
	"market_signal_id" varchar,
	"play_label" text,
	"outcome_linked_at" text,
	"outcome_type_linked" text,
	"at_stake_amount" numeric(14, 2),
	"at_stake_basis" text,
	"primary_contact_id" varchar,
	"primary_lane_id" varchar,
	"created_at" text NOT NULL,
	"resolved_at" text,
	"first_viewed_at" text
);
--> statement-breakpoint
CREATE TABLE "opportunity_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"dismissed_by" varchar NOT NULL,
	"dismissed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"rep_id" varchar NOT NULL,
	"company_id" varchar,
	"type" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"estimated_loads" integer,
	"estimated_value" numeric,
	"logged_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_chart_gaps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"gap_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"suggested_contact_name" text,
	"suggested_contact_title" text,
	"suggested_contact_email" text,
	"evidence_sources" jsonb,
	"priority" text DEFAULT 'moderate' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_corpus_chunks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"metadata" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token" varchar(128) NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "pinned_companies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"pinned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_outcomes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"play_run_id" varchar NOT NULL,
	"outcome" text NOT NULL,
	"notes" text,
	"time_to_outcome_hours" integer,
	"recorded_by" varchar,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"classifier_label" text,
	"classifier_confidence" integer,
	"source_signal_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"evidence" jsonb,
	"window_expires_at" timestamp,
	"override_label" text,
	"override_user_id" varchar,
	"override_reason" text,
	"override_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "play_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"play_id" varchar NOT NULL,
	"play_version" integer NOT NULL,
	"rep_user_id" varchar,
	"account_id" varchar,
	"account_name" text,
	"lane_id" varchar,
	"contact_id" varchar,
	"reference_type" text,
	"reference_id" text,
	"status" text DEFAULT 'suggested' NOT NULL,
	"trigger_snapshot" jsonb,
	"suggested_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"sent_at" timestamp,
	"thread_id" text,
	"provider_message_id" text,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "play_versions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"play_id" varchar NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"published_at" timestamp,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plays" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"audience" text DEFAULT 'customer' NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb,
	"signal_type" text,
	"recommended_steps" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"template_body" text DEFAULT '' NOT NULL,
	"success_metric" text DEFAULT '' NOT NULL,
	"outcome_window_hours" integer DEFAULT 96 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"source_legacy_id" varchar,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_agents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" varchar NOT NULL,
	"workflow_agent_id" varchar NOT NULL,
	"autonomy_override" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_intake_emails" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"mailbox_id" varchar,
	"provider_message_id" text NOT NULL,
	"internet_message_id" text,
	"received_at" timestamp NOT NULL,
	"from_email" text,
	"from_name" text,
	"subject" text,
	"body_preview" text,
	"body_text" text,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachment_meta" jsonb DEFAULT '[]'::jsonb,
	"classification" text DEFAULT 'pending' NOT NULL,
	"classifier_method" text,
	"classifier_confidence" numeric(4, 3),
	"classifier_reason" text,
	"extracted_order_ids" text[] DEFAULT '{}',
	"matched_order_id" text,
	"matched_load_fact_id" varchar,
	"matched_company_id" varchar,
	"forward_status" text DEFAULT 'pending' NOT NULL,
	"forwarded_at" timestamp,
	"forwarded_to" jsonb,
	"forward_error" text,
	"delivery_method" text,
	"dispatcher_user_id" varchar,
	"account_owner_user_id" varchar,
	"manual_linked_by_user_id" varchar,
	"manual_linked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_intake_settings" (
	"org_id" varchar PRIMARY KEY NOT NULL,
	"monitored_mailbox_id" varchar,
	"team_fallback_email" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"use_ai_fallback" boolean DEFAULT true NOT NULL,
	"auto_forward_email" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pod_members" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"role" text DEFAULT 'rep' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pods" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"pod_type" text DEFAULT 'vertical' NOT NULL,
	"description" text,
	"manager_id" varchar,
	"scope" jsonb,
	"kpis" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"type" text NOT NULL,
	"notes" text NOT NULL,
	"created_by_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"prospect_id" integer NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"phone" text,
	"linkedin" text,
	"role" text DEFAULT 'other',
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"website" text,
	"estimated_spend" text,
	"shipping_modes" text[],
	"stage" text DEFAULT 'new_lead' NOT NULL,
	"owner_id" varchar NOT NULL,
	"assigned_nam_id" varchar,
	"primary_contact_name" text,
	"primary_contact_title" text,
	"primary_contact_email" text,
	"primary_contact_phone" text,
	"primary_contact_linkedin" text,
	"notes" text,
	"next_steps" text,
	"follow_up_date" text,
	"opportunity_type" text,
	"opportunity_notes" text,
	"converted_to_company_id" varchar,
	"converted_at" timestamp,
	"lost_reason" text,
	"lead_source" text,
	"priority" text,
	"expected_close_date" text,
	"deal_probability" integer,
	"est_loads_per_week" text,
	"top_lanes" text,
	"commodity" text,
	"current_carrier" text,
	"pain_points" text,
	"estimated_annual_revenue" text,
	"employee_count" text,
	"intel_brief" text,
	"stage_changed_at" timestamp,
	"tms_website" text,
	"tms_email" text,
	"scheduling_website" text,
	"scheduling_email" text,
	"tms_username" text,
	"tms_password" text,
	"phone" text,
	"billing_address" text,
	"account_status" text DEFAULT 'prospecting',
	"account_status_changed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proven_tactics" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"signal_type" text NOT NULL,
	"signal_subtype" text,
	"tactic_label" text NOT NULL,
	"tactic_summary" text NOT NULL,
	"example_response" text,
	"source_message_id" varchar,
	"source_signal_id" varchar,
	"linked_account_id" varchar,
	"account_name" text,
	"rep_user_id" varchar,
	"rep_name" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"outcome_confidence" integer DEFAULT 0,
	"times_used" integer DEFAULT 1 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"success_rate" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "quote_carriers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"mc_number" text
);
--> statement-breakpoint
CREATE TABLE "quote_customers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"segment" text,
	"notes" text,
	"party_type" text DEFAULT 'unknown' NOT NULL,
	"party_type_manual" boolean DEFAULT false NOT NULL,
	"owner_rep_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"actor" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "quote_lane_groups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"origin_region" text,
	"dest_region" text
);
--> statement-breakpoint
CREATE TABLE "quote_opportunities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"customer_id" varchar NOT NULL,
	"rep_id" varchar,
	"lane_group_id" varchar,
	"carrier_id" varchar,
	"outcome_reason_id" varchar,
	"request_date" timestamp NOT NULL,
	"origin_city" text NOT NULL,
	"origin_state" text NOT NULL,
	"dest_city" text NOT NULL,
	"dest_state" text NOT NULL,
	"equipment" text NOT NULL,
	"quoted_amount" numeric(12, 2),
	"valid_through" timestamp,
	"outcome_status" text DEFAULT 'pending' NOT NULL,
	"carrier_paid" numeric(12, 2),
	"response_time_hours" numeric(8, 2),
	"source" text DEFAULT 'email' NOT NULL,
	"source_reference" text,
	"notes" text,
	"score" numeric(6, 2),
	"sonar_benchmark" numeric(12, 2),
	"needs_new_contact_review" jsonb,
	"snoozed_until" timestamp,
	"routing_status" text DEFAULT 'auto_customer' NOT NULL,
	"routing_decision_at" timestamp,
	"routing_decision_by_user_id" varchar,
	"routing_note" text,
	"quote_hints" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_outcome_reasons" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_pattern_alerts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"customer_id" varchar NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"summary" text NOT NULL,
	"axes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"last_shifted_at" timestamp DEFAULT now() NOT NULL,
	"normalized_since" timestamp,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "quote_pipeline_drops" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"message_id" varchar,
	"stage" text NOT NULL,
	"reason_code" text NOT NULL,
	"detail" text,
	"error_message" text,
	"sender_email" text,
	"subject" text,
	"received_at" timestamp,
	"confidence" numeric(5, 4),
	"extracted_snapshot" jsonb,
	"quote_id" varchar,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_id" varchar,
	"resolution_note" text,
	"reprocess_count" integer DEFAULT 0 NOT NULL,
	"last_reprocess_at" timestamp,
	"last_reprocess_error" text,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "quote_pricing_settings" (
	"organization_id" varchar PRIMARY KEY NOT NULL,
	"margin_floors_rpm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_id" varchar
);
--> statement-breakpoint
CREATE TABLE "quote_reps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar,
	"name" text NOT NULL,
	"email" text,
	"suppressed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_saved_views" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_sender_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"sender_domain" text,
	"sender_email" text,
	"customer_id" varchar,
	"suppressed" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"sample_count" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_lanes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar,
	"company_name" text,
	"origin" text NOT NULL,
	"origin_state" text,
	"destination" text NOT NULL,
	"destination_state" text,
	"equipment_type" text,
	"avg_loads_per_week" numeric(6, 2),
	"weeks_active" integer DEFAULT 0,
	"lookback_weeks" integer DEFAULT 4,
	"has_preferred_carrier_program" boolean DEFAULT false,
	"owner_user_id" varchar,
	"overseer_user_id" varchar,
	"assigned_at" text,
	"assigned_by_user_id" varchar,
	"lane_score" integer,
	"lane_score_factors" jsonb,
	"eligibility_confidence" text DEFAULT 'medium' NOT NULL,
	"last_scored_at" text,
	"is_eligible" boolean DEFAULT false NOT NULL,
	"snoozed_until" text,
	"carriers_contacted_count" integer DEFAULT 0,
	"resolved_at" text,
	"is_manual" boolean DEFAULT false NOT NULL,
	"source_quote_id" varchar,
	"drop_trailer_shipper" boolean DEFAULT false NOT NULL,
	"drop_trailer_receiver" boolean DEFAULT false NOT NULL,
	"lifecycle_stage" text,
	"moves_last_30_days" integer,
	"last_moved_at" text,
	"qualification_reason" text,
	"supporting_customers" jsonb,
	"recent_carriers" jsonb,
	"last_eligible_at" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_coaching_insights" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"contact_id" varchar,
	"insight_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"priority" text DEFAULT 'moderate' NOT NULL,
	"suggested_action" text,
	"status" text DEFAULT 'active' NOT NULL,
	"data_context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sender_routing_rules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"scope_type" text NOT NULL,
	"scope_value" text NOT NULL,
	"decision" text NOT NULL,
	"remembered_by_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sent_email_corrections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"corrected_by_user_id" varchar NOT NULL,
	"corrected_by_name" text,
	"email_message_id" varchar,
	"outreach_log_id" varchar,
	"original_text" text NOT NULL,
	"corrected_text" text NOT NULL,
	"correction_notes" text,
	"thread_id" text,
	"account_id" varchar,
	"carrier_id" varchar,
	"subject" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sidebar_tooltips" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"item_key" text NOT NULL,
	"description" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_id" varchar
);
--> statement-breakpoint
CREATE TABLE "thread_attachments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar NOT NULL,
	"message_id" varchar,
	"user_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"parsed_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar NOT NULL,
	"role" text NOT NULL,
	"agent_id" varchar,
	"agent_name" text,
	"content" text NOT NULL,
	"attachments" jsonb,
	"rating" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_projects" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"pinned_context" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"project_id" varchar,
	"title" text DEFAULT 'New thread' NOT NULL,
	"default_agent_id" varchar,
	"surface" text DEFAULT 'valueiq' NOT NULL,
	"seed_kind" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"last_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "today_queue_snoozes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"snoozed_until" timestamp NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truck_load_matches" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"truck_posting_id" varchar NOT NULL,
	"freight_opportunity_id" varchar NOT NULL,
	"fit_score" integer DEFAULT 0 NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[],
	"state" text DEFAULT 'new' NOT NULL,
	"assigned_rep_id" varchar,
	"notified_at" timestamp,
	"contacted_at" timestamp,
	"booked_at" timestamp,
	"dismissed_at" timestamp,
	"dismissed_reason" text,
	"actor_user_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truck_postings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"carrier_id" varchar,
	"carrier_name_raw" text,
	"source" text NOT NULL,
	"email_message_id" varchar,
	"attachment_name" text,
	"row_index" integer,
	"origin_city" text,
	"origin_state" text,
	"dest_city" text,
	"dest_state" text,
	"dest_preference" text,
	"available_date" date,
	"available_through" date,
	"equipment" text,
	"rate_ask" numeric(12, 2),
	"notes" text,
	"raw_text" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_freight_cockpit_prefs" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"active_view_id" varchar,
	"layout" text DEFAULT 'table' NOT NULL,
	"grouping" text DEFAULT 'none' NOT NULL,
	"sort" text DEFAULT 'pickup_soonest' NOT NULL,
	"autopilot_muted_until" timestamp,
	"owner_filter" text,
	"pickup_scope" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_lane_inbox_prefs" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"group_by_lane" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_lifecycle_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"actor_user_id" varchar,
	"event" text NOT NULL,
	"reason" text,
	"prev_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_share_plays" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"play_title" text NOT NULL,
	"play_description" text NOT NULL,
	"target_lanes" jsonb,
	"target_contacts" jsonb,
	"pricing_strategy" text,
	"estimated_revenue" numeric,
	"timeline_weeks" integer,
	"steps" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warm_intro_suggestions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar NOT NULL,
	"target_contact_id" varchar,
	"target_contact_name" text,
	"bridge_contact_id" varchar,
	"bridge_contact_name" text,
	"connection_strength" text DEFAULT 'moderate' NOT NULL,
	"reasoning" text,
	"suggested_approach" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_call_analytics" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"call_id" text NOT NULL,
	"user_id" varchar,
	"webex_person_id" text,
	"webex_user_email" text,
	"direction" text,
	"remote_number" text,
	"start_time" timestamp,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"talk_time_seconds" integer DEFAULT 0 NOT NULL,
	"hold_time_seconds" integer DEFAULT 0 NOT NULL,
	"silence_seconds" integer DEFAULT 0 NOT NULL,
	"ring_time_seconds" integer DEFAULT 0 NOT NULL,
	"mos_score" numeric(4, 2),
	"jitter_ms" numeric(8, 2),
	"packet_loss_pct" numeric(6, 3),
	"quality_grade" text,
	"after_hours" boolean DEFAULT false NOT NULL,
	"company_id" varchar,
	"contact_id" varchar,
	"touchpoint_id" varchar,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_call_enrichment_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"call_id" text NOT NULL,
	"user_id" varchar,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_inventory" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"payload" jsonb,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_sync_state" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar,
	"data_source" text NOT NULL,
	"last_success_at" timestamp,
	"last_attempt_at" timestamp,
	"last_error_at" timestamp,
	"last_error" text,
	"cursor" text,
	"backfill_started_at" timestamp,
	"backfill_completed_at" timestamp,
	"backfill_total_days" integer DEFAULT 0 NOT NULL,
	"backfill_completed_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_user_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"webex_person_id" text,
	"webex_email" text,
	"webex_display_name" text,
	"user_id" varchar,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"match_source" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_user_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"webex_person_id" text,
	"webex_email" text,
	"webex_display_name" text,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"reauth_reason" text,
	"last_reauth_email_at" timestamp,
	"last_refresh_at" timestamp,
	"last_refresh_error" text,
	"scopes" text,
	"scope_version" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"disconnected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_voicemails" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar,
	"voicemail_id" text NOT NULL,
	"call_id" text,
	"caller_number" text,
	"caller_name" text,
	"received_at" timestamp,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"transcript" text,
	"transcription_status" text DEFAULT 'pending' NOT NULL,
	"audio_cached" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_webhook_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" varchar,
	"org_id" varchar,
	"user_id" varchar,
	"resource" text NOT NULL,
	"event" text NOT NULL,
	"resource_id" text,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"process_error" text,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webex_webhook_subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar,
	"scope" text DEFAULT 'org' NOT NULL,
	"resource" text NOT NULL,
	"event" text DEFAULT 'all' NOT NULL,
	"webhook_id" text,
	"target_url" text NOT NULL,
	"secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"last_event_at" timestamp,
	"events_received" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_commitments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar NOT NULL,
	"company_id" varchar,
	"contact_id" varchar,
	"company_name" text,
	"contact_name" text,
	"commitment_text" text NOT NULL,
	"lever" text DEFAULT 'Recovery' NOT NULL,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"week_start" text NOT NULL,
	"due_date" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "win_loss_patterns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"pattern_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"outcome" text NOT NULL,
	"frequency" integer DEFAULT 1 NOT NULL,
	"factors" jsonb,
	"recommendations" jsonb,
	"affected_accounts" jsonb,
	"confidence_score" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_agents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"loop" text NOT NULL,
	"autonomy" text DEFAULT 'off' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" jsonb,
	"guardrails" jsonb,
	"triggers" jsonb,
	"target_metric" text,
	"persona_overlay" text,
	"model" text DEFAULT 'gpt-4o' NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_suggestions" ADD COLUMN "admin_response" text;--> statement-breakpoint
ALTER TABLE "app_suggestions" ADD COLUMN "responded_at" timestamp;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "owner_rep_id" varchar;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "shared_reps" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "operating_hours" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "handoff_notes" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "onboarding_milestones" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "is_email_derived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email_derived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email_derived_seed_message_id" varchar;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "mobile" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_seen_at" timestamp;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "role_type" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "status" text DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_primary" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_by" varchar;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "company_id" varchar;--> statement-breakpoint
ALTER TABLE "one_on_one_sessions" ADD COLUMN "morale_score" integer;--> statement-breakpoint
ALTER TABLE "one_on_one_sessions" ADD COLUMN "session_summary" text;--> statement-breakpoint
ALTER TABLE "one_on_one_sessions" ADD COLUMN "closed_at" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_status" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_name" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "current_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "internal_domains" text[] DEFAULT ARRAY[]::text[];--> statement-breakpoint
ALTER TABLE "pto_passoff_items" ADD COLUMN "covering_notes" text;--> statement-breakpoint
ALTER TABLE "pto_passoff_items" ADD COLUMN "override_covering_user_id" varchar;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "org_id" varchar;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "opportunity_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lane_context" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lever" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_at" text;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD COLUMN "play_label" text;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_signature" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "valueiq_landing_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_to_today_queue" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_service_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_fixture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_quarantined" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_by" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_by" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivation_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_contact_lane_pattern_responsibilities" ADD CONSTRAINT "account_contact_lane_pattern_responsibilities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_lane_pattern_responsibilities" ADD CONSTRAINT "account_contact_lane_pattern_responsibilities_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_lane_pattern_responsibilities" ADD CONSTRAINT "account_contact_lane_pattern_responsibilities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_lane_pattern_responsibilities" ADD CONSTRAINT "account_contact_lane_pattern_responsibilities_lane_pattern_id_geographic_lane_patterns_id_fk" FOREIGN KEY ("lane_pattern_id") REFERENCES "public"."geographic_lane_patterns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_lane_pattern_responsibilities" ADD CONSTRAINT "account_contact_lane_pattern_responsibilities_last_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("last_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_suggestions" ADD CONSTRAINT "account_contact_suggestions_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_suggestions" ADD CONSTRAINT "account_contact_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_contact_suggestions" ADD CONSTRAINT "account_contact_suggestions_acted_by_user_id_users_id_fk" FOREIGN KEY ("acted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_growth_scores" ADD CONSTRAINT "account_growth_scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_growth_scores" ADD CONSTRAINT "account_growth_scores_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_look_alikes" ADD CONSTRAINT "account_look_alikes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_look_alikes" ADD CONSTRAINT "account_look_alikes_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_look_alikes" ADD CONSTRAINT "account_look_alikes_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_reviews" ADD CONSTRAINT "account_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_reviews" ADD CONSTRAINT "account_reviews_rep_user_id_users_id_fk" FOREIGN KEY ("rep_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_reviews" ADD CONSTRAINT "account_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_status" ADD CONSTRAINT "adapter_status_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity" ADD CONSTRAINT "agent_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channel_access" ADD CONSTRAINT "agent_channel_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_facts" ADD CONSTRAINT "agent_facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_facts" ADD CONSTRAINT "agent_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_org_settings" ADD CONSTRAINT "agent_org_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD CONSTRAINT "agent_outcomes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD CONSTRAINT "agent_outcomes_workflow_agent_id_workflow_agents_id_fk" FOREIGN KEY ("workflow_agent_id") REFERENCES "public"."workflow_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD CONSTRAINT "agent_outcomes_suggestion_id_agent_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."agent_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outcomes" ADD CONSTRAINT "agent_outcomes_hitl_action_id_hitl_actions_id_fk" FOREIGN KEY ("hitl_action_id") REFERENCES "public"."hitl_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_personas" ADD CONSTRAINT "agent_personas_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plays" ADD CONSTRAINT "agent_plays_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_suggestions" ADD CONSTRAINT "agent_suggestions_workflow_agent_id_workflow_agents_id_fk" FOREIGN KEY ("workflow_agent_id") REFERENCES "public"."workflow_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_access" ADD CONSTRAINT "agent_user_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_access" ADD CONSTRAINT "agent_user_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_engagement_events" ADD CONSTRAINT "ai_engagement_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_engagement_events" ADD CONSTRAINT "ai_engagement_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_leak_reviews" ADD CONSTRAINT "capture_leak_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_leak_reviews" ADD CONSTRAINT "capture_leak_reviews_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_claimed_lanes" ADD CONSTRAINT "carrier_claimed_lanes_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_contacts" ADD CONSTRAINT "carrier_contacts_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_email_suggestions" ADD CONSTRAINT "carrier_email_suggestions_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_email_suggestions" ADD CONSTRAINT "carrier_email_suggestions_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_import_batches" ADD CONSTRAINT "carrier_import_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_import_batches" ADD CONSTRAINT "carrier_import_batches_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_import_batches" ADD CONSTRAINT "carrier_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_intel_suggestions" ADD CONSTRAINT "carrier_intel_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_intel_suggestions" ADD CONSTRAINT "carrier_intel_suggestions_email_signal_id_email_signals_id_fk" FOREIGN KEY ("email_signal_id") REFERENCES "public"."email_signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_lane_fit" ADD CONSTRAINT "carrier_lane_fit_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_lane_outcome_event_keys" ADD CONSTRAINT "carrier_lane_outcome_event_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_lane_outcomes" ADD CONSTRAINT "carrier_lane_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_lane_outcomes" ADD CONSTRAINT "carrier_lane_outcomes_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_overseer_user_id_users_id_fk" FOREIGN KEY ("overseer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_matched_carrier_id_carriers_id_fk" FOREIGN KEY ("matched_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_outreach_logs" ADD CONSTRAINT "carrier_outreach_logs_matched_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("matched_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_overrides" ADD CONSTRAINT "carrier_overrides_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_overrides" ADD CONSTRAINT "carrier_overrides_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_overrides" ADD CONSTRAINT "carrier_overrides_rep_id_users_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_quote_events" ADD CONSTRAINT "carrier_quote_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_quote_events" ADD CONSTRAINT "carrier_quote_events_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_quote_events" ADD CONSTRAINT "carrier_quote_events_contact_id_carrier_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."carrier_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_quote_events" ADD CONSTRAINT "carrier_quote_events_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_recommendation" ADD CONSTRAINT "carrier_recommendation_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_recommendation" ADD CONSTRAINT "carrier_recommendation_load_fact_id_load_fact_id_fk" FOREIGN KEY ("load_fact_id") REFERENCES "public"."load_fact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_scorecard_fact" ADD CONSTRAINT "carrier_scorecard_fact_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carriers" ADD CONSTRAINT "carriers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_rep_id_users_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_collaborators" ADD CONSTRAINT "company_collaborators_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_collaborators" ADD CONSTRAINT "company_collaborators_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_collaborators" ADD CONSTRAINT "company_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_collaborators" ADD CONSTRAINT "company_collaborators_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_financial_aliases" ADD CONSTRAINT "company_financial_aliases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_financial_aliases" ADD CONSTRAINT "company_financial_aliases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_outreach_policies" ADD CONSTRAINT "company_outreach_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_outreach_policies" ADD CONSTRAINT "company_outreach_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_outreach_policies" ADD CONSTRAINT "company_outreach_policies_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_signals" ADD CONSTRAINT "competitive_signals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_signals" ADD CONSTRAINT "competitive_signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_base_history" ADD CONSTRAINT "contact_base_history_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_base_history" ADD CONSTRAINT "contact_base_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_geography_suggestions" ADD CONSTRAINT "contact_geography_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_geography_suggestions" ADD CONSTRAINT "contact_geography_suggestions_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_geography_suggestions" ADD CONSTRAINT "contact_geography_suggestions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_geography_suggestions" ADD CONSTRAINT "contact_geography_suggestions_acted_by_user_id_users_id_fk" FOREIGN KEY ("acted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lane_attributions" ADD CONSTRAINT "contact_lane_attributions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lane_attributions" ADD CONSTRAINT "contact_lane_attributions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lane_attributions" ADD CONSTRAINT "contact_lane_attributions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sentiment_tracking" ADD CONSTRAINT "contact_sentiment_tracking_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sentiment_tracking" ADD CONSTRAINT "contact_sentiment_tracking_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sentiment_tracking" ADD CONSTRAINT "contact_sentiment_tracking_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_events" ADD CONSTRAINT "context_note_events_note_id_context_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."context_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_events" ADD CONSTRAINT "context_note_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_mentions" ADD CONSTRAINT "context_note_mentions_note_id_context_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."context_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_mentions" ADD CONSTRAINT "context_note_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_replies" ADD CONSTRAINT "context_note_replies_note_id_context_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."context_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_note_replies" ADD CONSTRAINT "context_note_replies_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_notes" ADD CONSTRAINT "context_notes_converted_task_id_tasks_id_fk" FOREIGN KEY ("converted_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_saved_views" ADD CONSTRAINT "conversation_saved_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_saved_views" ADD CONSTRAINT "conversation_saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_suggestion_feedback_stats" ADD CONSTRAINT "conversation_suggestion_feedback_stats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_capture_audits" ADD CONSTRAINT "conversation_thread_capture_audits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_capture_audits" ADD CONSTRAINT "conversation_thread_capture_audits_mailbox_id_monitored_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."monitored_mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_capture_audits" ADD CONSTRAINT "conversation_thread_capture_audits_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_events" ADD CONSTRAINT "conversation_thread_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_events" ADD CONSTRAINT "conversation_thread_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_suggestions" ADD CONSTRAINT "conversation_thread_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_suggestions" ADD CONSTRAINT "conversation_thread_suggestions_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_suggestions" ADD CONSTRAINT "conversation_thread_suggestions_feedback_by_user_id_users_id_fk" FOREIGN KEY ("feedback_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_thread_summaries" ADD CONSTRAINT "conversation_thread_summaries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_actions" ADD CONSTRAINT "copilot_actions_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_adjustments" ADD CONSTRAINT "copilot_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_intelligence" ADD CONSTRAINT "copilot_intelligence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_intelligence" ADD CONSTRAINT "copilot_intelligence_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_intelligence" ADD CONSTRAINT "copilot_intelligence_extraction_id_document_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_outcomes" ADD CONSTRAINT "copilot_outcomes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_outcomes" ADD CONSTRAINT "copilot_outcomes_recommendation_id_copilot_play_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."copilot_play_recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_play_recommendations" ADD CONSTRAINT "copilot_play_recommendations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_play_recommendations" ADD CONSTRAINT "copilot_play_recommendations_intelligence_id_copilot_intelligence_id_fk" FOREIGN KEY ("intelligence_id") REFERENCES "public"."copilot_intelligence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_play_recommendations" ADD CONSTRAINT "copilot_play_recommendations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_customer_company_id_companies_id_fk" FOREIGN KEY ("customer_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_opportunity_id_freight_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."freight_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_recommendations" ADD CONSTRAINT "copilot_recommendations_reacted_by_user_id_users_id_fk" FOREIGN KEY ("reacted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_account_history" ADD CONSTRAINT "crm_account_history_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_account_history" ADD CONSTRAINT "crm_account_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_account_history" ADD CONSTRAINT "crm_account_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ownership_requests" ADD CONSTRAINT "crm_ownership_requests_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ownership_requests" ADD CONSTRAINT "crm_ownership_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ownership_requests" ADD CONSTRAINT "crm_ownership_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ownership_requests" ADD CONSTRAINT "crm_ownership_requests_current_owner_id_users_id_fk" FOREIGN KEY ("current_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ownership_requests" ADD CONSTRAINT "crm_ownership_requests_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_opportunities" ADD CONSTRAINT "cross_sell_opportunities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_opportunities" ADD CONSTRAINT "cross_sell_opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_email_identities" ADD CONSTRAINT "customer_email_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_email_identities" ADD CONSTRAINT "customer_email_identities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_email_identities" ADD CONSTRAINT "customer_email_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_entity_links" ADD CONSTRAINT "document_entity_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_entity_links" ADD CONSTRAINT "document_entity_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction_corrections" ADD CONSTRAINT "document_extraction_corrections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction_corrections" ADD CONSTRAINT "document_extraction_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction_corrections" ADD CONSTRAINT "document_extraction_corrections_corrected_by_id_users_id_fk" FOREIGN KEY ("corrected_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction_findings" ADD CONSTRAINT "document_extraction_findings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction_findings" ADD CONSTRAINT "document_extraction_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions_typed" ADD CONSTRAINT "document_extractions_typed_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions_typed" ADD CONSTRAINT "document_extractions_typed_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_feedback" ADD CONSTRAINT "draft_feedback_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_feedback" ADD CONSTRAINT "draft_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_feedback" ADD CONSTRAINT "draft_feedback_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_feedback" ADD CONSTRAINT "draft_feedback_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attachment_classifications" ADD CONSTRAINT "email_attachment_classifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attachment_classifications" ADD CONSTRAINT "email_attachment_classifications_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_bounce_events" ADD CONSTRAINT "email_bounce_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_bounce_events" ADD CONSTRAINT "email_bounce_events_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_bounce_events" ADD CONSTRAINT "email_bounce_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_read_states" ADD CONSTRAINT "email_conversation_read_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_read_states" ADD CONSTRAINT "email_conversation_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_threads" ADD CONSTRAINT "email_conversation_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_threads" ADD CONSTRAINT "email_conversation_threads_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_threads" ADD CONSTRAINT "email_conversation_threads_linked_carrier_id_carriers_id_fk" FOREIGN KEY ("linked_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_threads" ADD CONSTRAINT "email_conversation_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_threads" ADD CONSTRAINT "email_conversation_threads_last_message_id_email_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_conversation_threads" ADD CONSTRAINT "email_conversation_threads_snoozed_by_user_id_users_id_fk" FOREIGN KEY ("snoozed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extracted_slots" ADD CONSTRAINT "email_extracted_slots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extracted_slots" ADD CONSTRAINT "email_extracted_slots_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extracted_slots" ADD CONSTRAINT "email_extracted_slots_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extracted_slots" ADD CONSTRAINT "email_extracted_slots_linked_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("linked_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_linked_carrier_id_carriers_id_fk" FOREIGN KEY ("linked_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_linked_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("linked_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_linked_task_id_tasks_id_fk" FOREIGN KEY ("linked_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_linked_nba_id_nba_cards_id_fk" FOREIGN KEY ("linked_nba_id") REFERENCES "public"."nba_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_linked_outreach_log_id_carrier_outreach_logs_id_fk" FOREIGN KEY ("linked_outreach_log_id") REFERENCES "public"."carrier_outreach_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_quality_scores" ADD CONSTRAINT "email_outbound_quality_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_quality_scores" ADD CONSTRAINT "email_outbound_quality_scores_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_quality_scores" ADD CONSTRAINT "email_outbound_quality_scores_rep_user_id_users_id_fk" FOREIGN KEY ("rep_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_quality_scores" ADD CONSTRAINT "email_outbound_quality_scores_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outcome_links" ADD CONSTRAINT "email_outcome_links_email_signal_id_email_signals_id_fk" FOREIGN KEY ("email_signal_id") REFERENCES "public"."email_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_participants" ADD CONSTRAINT "email_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_participants" ADD CONSTRAINT "email_participants_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_participants" ADD CONSTRAINT "email_participants_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_participants" ADD CONSTRAINT "email_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_promises" ADD CONSTRAINT "email_promises_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_promises" ADD CONSTRAINT "email_promises_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_promises" ADD CONSTRAINT "email_promises_rep_user_id_users_id_fk" FOREIGN KEY ("rep_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_promises" ADD CONSTRAINT "email_promises_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_promises" ADD CONSTRAINT "email_promises_linked_contact_id_contacts_id_fk" FOREIGN KEY ("linked_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_promises" ADD CONSTRAINT "email_promises_resolved_by_message_id_email_messages_id_fk" FOREIGN KEY ("resolved_by_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_questions" ADD CONSTRAINT "email_questions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_questions" ADD CONSTRAINT "email_questions_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_questions" ADD CONSTRAINT "email_questions_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_questions" ADD CONSTRAINT "email_questions_linked_contact_id_contacts_id_fk" FOREIGN KEY ("linked_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_questions" ADD CONSTRAINT "email_questions_answered_by_message_id_email_messages_id_fk" FOREIGN KEY ("answered_by_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_reply_latency_regression_settings" ADD CONSTRAINT "email_reply_latency_regression_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_reply_latency_regression_settings" ADD CONSTRAINT "email_reply_latency_regression_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_response_time_sla_settings" ADD CONSTRAINT "email_response_time_sla_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_response_time_sla_settings" ADD CONSTRAINT "email_response_time_sla_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_signals" ADD CONSTRAINT "email_signals_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_signals" ADD CONSTRAINT "email_signals_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_signals" ADD CONSTRAINT "email_signals_linked_carrier_id_carriers_id_fk" FOREIGN KEY ("linked_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_signals" ADD CONSTRAINT "email_signals_linked_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("linked_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_contact_consent" ADD CONSTRAINT "external_contact_consent_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_confidence_overrides" ADD CONSTRAINT "field_confidence_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_recommendations" ADD CONSTRAINT "follow_up_recommendations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_recommendations" ADD CONSTRAINT "follow_up_recommendations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_recommendations" ADD CONSTRAINT "follow_up_recommendations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_focus" ADD CONSTRAINT "forced_focus_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_focus" ADD CONSTRAINT "forced_focus_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_focus" ADD CONSTRAINT "forced_focus_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_focus" ADD CONSTRAINT "forced_focus_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forced_focus" ADD CONSTRAINT "forced_focus_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_calendar_events" ADD CONSTRAINT "forward_calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_calendar_events" ADD CONSTRAINT "forward_calendar_events_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_calendar_events" ADD CONSTRAINT "forward_calendar_events_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_calendar_events" ADD CONSTRAINT "forward_calendar_events_linked_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("linked_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forward_calendar_events" ADD CONSTRAINT "forward_calendar_events_nba_card_id_nba_cards_id_fk" FOREIGN KEY ("nba_card_id") REFERENCES "public"."nba_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_daily_upload_fact" ADD CONSTRAINT "freight_daily_upload_fact_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_daily_upload_fact" ADD CONSTRAINT "freight_daily_upload_fact_upload_id_financial_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."financial_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_recurring_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("recurring_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_geographic_lane_pattern_id_geographic_lane_patterns_id_fk" FOREIGN KEY ("geographic_lane_pattern_id") REFERENCES "public"."geographic_lane_patterns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_delegated_to_user_id_users_id_fk" FOREIGN KEY ("delegated_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunities" ADD CONSTRAINT "freight_opportunities_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_audit" ADD CONSTRAINT "freight_opportunity_audit_opportunity_id_freight_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."freight_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_audit" ADD CONSTRAINT "freight_opportunity_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_capture_failures" ADD CONSTRAINT "freight_opportunity_capture_failures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_capture_failures" ADD CONSTRAINT "freight_opportunity_capture_failures_quote_id_quote_opportunities_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_capture_failures" ADD CONSTRAINT "freight_opportunity_capture_failures_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_carriers" ADD CONSTRAINT "freight_opportunity_carriers_opportunity_id_freight_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."freight_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_carriers" ADD CONSTRAINT "freight_opportunity_carriers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_carriers" ADD CONSTRAINT "freight_opportunity_carriers_outreach_log_id_carrier_outreach_logs_id_fk" FOREIGN KEY ("outreach_log_id") REFERENCES "public"."carrier_outreach_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_rate_history" ADD CONSTRAINT "freight_opportunity_rate_history_opportunity_id_freight_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."freight_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_rate_history" ADD CONSTRAINT "freight_opportunity_rate_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_responses" ADD CONSTRAINT "freight_opportunity_responses_opportunity_carrier_id_freight_opportunity_carriers_id_fk" FOREIGN KEY ("opportunity_carrier_id") REFERENCES "public"."freight_opportunity_carriers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_responses" ADD CONSTRAINT "freight_opportunity_responses_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_responses" ADD CONSTRAINT "freight_opportunity_responses_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_saved_views" ADD CONSTRAINT "freight_opportunity_saved_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_opportunity_saved_views" ADD CONSTRAINT "freight_opportunity_saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_outreach_templates" ADD CONSTRAINT "freight_outreach_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freight_outreach_templates" ADD CONSTRAINT "freight_outreach_templates_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geographic_lane_patterns" ADD CONSTRAINT "geographic_lane_patterns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_actions" ADD CONSTRAINT "hitl_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_actions" ADD CONSTRAINT "hitl_actions_workflow_agent_id_workflow_agents_id_fk" FOREIGN KEY ("workflow_agent_id") REFERENCES "public"."workflow_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_actions" ADD CONSTRAINT "hitl_actions_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."pods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intel_lane_rates" ADD CONSTRAINT "intel_lane_rates_tracked_lane_id_intel_tracked_lanes_id_fk" FOREIGN KEY ("tracked_lane_id") REFERENCES "public"."intel_tracked_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intel_tracked_lanes" ADD CONSTRAINT "intel_tracked_lanes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intel_tracked_lanes" ADD CONSTRAINT "intel_tracked_lanes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intel_tracked_lanes" ADD CONSTRAINT "intel_tracked_lanes_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_carrier_interest" ADD CONSTRAINT "lane_carrier_interest_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_carrier_interest" ADD CONSTRAINT "lane_carrier_interest_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_carriers" ADD CONSTRAINT "lane_carriers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_carriers" ADD CONSTRAINT "lane_carriers_award_id_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."awards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_coverage_profile_carriers" ADD CONSTRAINT "lane_coverage_profile_carriers_profile_id_lane_coverage_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."lane_coverage_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_coverage_profile_carriers" ADD CONSTRAINT "lane_coverage_profile_carriers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_coverage_profiles" ADD CONSTRAINT "lane_coverage_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_coverage_profiles" ADD CONSTRAINT "lane_coverage_profiles_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_coverage_profiles" ADD CONSTRAINT "lane_coverage_profiles_manually_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("manually_confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_rate_history" ADD CONSTRAINT "lane_rate_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_summary_cache" ADD CONSTRAINT "lane_summary_cache_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leak_console_audit" ADD CONSTRAINT "leak_console_audit_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leak_console_audit" ADD CONSTRAINT "leak_console_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leak_console_audit" ADD CONSTRAINT "leak_console_audit_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leak_console_daily_snapshot" ADD CONSTRAINT "leak_console_daily_snapshot_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_fact" ADD CONSTRAINT "load_fact_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_fact" ADD CONSTRAINT "load_fact_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_fact_history" ADD CONSTRAINT "load_fact_history_load_fact_id_load_fact_id_fk" FOREIGN KEY ("load_fact_id") REFERENCES "public"."load_fact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_fact_history" ADD CONSTRAINT "load_fact_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_health_alerts" ADD CONSTRAINT "mailbox_health_alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_health_alerts" ADD CONSTRAINT "mailbox_health_alerts_mailbox_id_monitored_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."monitored_mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_historical_backfills" ADD CONSTRAINT "mailbox_historical_backfills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_historical_backfills" ADD CONSTRAINT "mailbox_historical_backfills_mailbox_id_monitored_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."monitored_mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_historical_backfills" ADD CONSTRAINT "mailbox_historical_backfills_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sync_failures" ADD CONSTRAINT "mailbox_sync_failures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sync_failures" ADD CONSTRAINT "mailbox_sync_failures_mailbox_id_monitored_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."monitored_mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_prep_briefs" ADD CONSTRAINT "meeting_prep_briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_prep_briefs" ADD CONSTRAINT "meeting_prep_briefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_prep_briefs" ADD CONSTRAINT "meeting_prep_briefs_generated_by_user_id_users_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_inbound_calls" ADD CONSTRAINT "missed_inbound_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_inbound_calls" ADD CONSTRAINT "missed_inbound_calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_inbound_calls" ADD CONSTRAINT "missed_inbound_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_inbound_calls" ADD CONSTRAINT "missed_inbound_calls_attributed_user_id_users_id_fk" FOREIGN KEY ("attributed_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_mailboxes" ADD CONSTRAINT "monitored_mailboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_mailboxes" ADD CONSTRAINT "monitored_mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_events" ADD CONSTRAINT "nba_card_events_card_id_nba_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."nba_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_events" ADD CONSTRAINT "nba_card_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_events" ADD CONSTRAINT "nba_card_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_events" ADD CONSTRAINT "nba_card_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_outcomes" ADD CONSTRAINT "nba_card_outcomes_card_id_nba_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."nba_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_outcomes" ADD CONSTRAINT "nba_card_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_card_outcomes" ADD CONSTRAINT "nba_card_outcomes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_cards" ADD CONSTRAINT "nba_cards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_cards" ADD CONSTRAINT "nba_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_cards" ADD CONSTRAINT "nba_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_cards" ADD CONSTRAINT "nba_cards_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_cards" ADD CONSTRAINT "nba_cards_primary_contact_id_contacts_id_fk" FOREIGN KEY ("primary_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nba_cards" ADD CONSTRAINT "nba_cards_primary_lane_id_recurring_lanes_id_fk" FOREIGN KEY ("primary_lane_id") REFERENCES "public"."recurring_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_logs" ADD CONSTRAINT "opportunity_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_logs" ADD CONSTRAINT "opportunity_logs_rep_id_users_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_logs" ADD CONSTRAINT "opportunity_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_chart_gaps" ADD CONSTRAINT "org_chart_gaps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_chart_gaps" ADD CONSTRAINT "org_chart_gaps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_corpus_chunks" ADD CONSTRAINT "org_corpus_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_companies" ADD CONSTRAINT "pinned_companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_companies" ADD CONSTRAINT "pinned_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_outcomes" ADD CONSTRAINT "play_outcomes_play_run_id_play_runs_id_fk" FOREIGN KEY ("play_run_id") REFERENCES "public"."play_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_outcomes" ADD CONSTRAINT "play_outcomes_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_outcomes" ADD CONSTRAINT "play_outcomes_override_user_id_users_id_fk" FOREIGN KEY ("override_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_runs" ADD CONSTRAINT "play_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_runs" ADD CONSTRAINT "play_runs_play_id_plays_id_fk" FOREIGN KEY ("play_id") REFERENCES "public"."plays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_runs" ADD CONSTRAINT "play_runs_rep_user_id_users_id_fk" FOREIGN KEY ("rep_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_runs" ADD CONSTRAINT "play_runs_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_versions" ADD CONSTRAINT "play_versions_play_id_plays_id_fk" FOREIGN KEY ("play_id") REFERENCES "public"."plays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_versions" ADD CONSTRAINT "play_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_agents" ADD CONSTRAINT "pod_agents_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_agents" ADD CONSTRAINT "pod_agents_workflow_agent_id_workflow_agents_id_fk" FOREIGN KEY ("workflow_agent_id") REFERENCES "public"."workflow_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_emails" ADD CONSTRAINT "pod_intake_emails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_emails" ADD CONSTRAINT "pod_intake_emails_mailbox_id_monitored_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."monitored_mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_emails" ADD CONSTRAINT "pod_intake_emails_dispatcher_user_id_users_id_fk" FOREIGN KEY ("dispatcher_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_emails" ADD CONSTRAINT "pod_intake_emails_account_owner_user_id_users_id_fk" FOREIGN KEY ("account_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_emails" ADD CONSTRAINT "pod_intake_emails_manual_linked_by_user_id_users_id_fk" FOREIGN KEY ("manual_linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_settings" ADD CONSTRAINT "pod_intake_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_intake_settings" ADD CONSTRAINT "pod_intake_settings_monitored_mailbox_id_monitored_mailboxes_id_fk" FOREIGN KEY ("monitored_mailbox_id") REFERENCES "public"."monitored_mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_members" ADD CONSTRAINT "pod_members_pod_id_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."pods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pod_members" ADD CONSTRAINT "pod_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pods" ADD CONSTRAINT "pods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_activities" ADD CONSTRAINT "prospect_activities_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_activities" ADD CONSTRAINT "prospect_activities_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_contacts" ADD CONSTRAINT "prospect_contacts_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_assigned_nam_id_users_id_fk" FOREIGN KEY ("assigned_nam_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proven_tactics" ADD CONSTRAINT "proven_tactics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proven_tactics" ADD CONSTRAINT "proven_tactics_source_message_id_email_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proven_tactics" ADD CONSTRAINT "proven_tactics_source_signal_id_email_signals_id_fk" FOREIGN KEY ("source_signal_id") REFERENCES "public"."email_signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proven_tactics" ADD CONSTRAINT "proven_tactics_linked_account_id_companies_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proven_tactics" ADD CONSTRAINT "proven_tactics_rep_user_id_users_id_fk" FOREIGN KEY ("rep_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_carriers" ADD CONSTRAINT "quote_carriers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_customers" ADD CONSTRAINT "quote_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_customers" ADD CONSTRAINT "quote_customers_owner_rep_id_quote_reps_id_fk" FOREIGN KEY ("owner_rep_id") REFERENCES "public"."quote_reps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_quote_id_quote_opportunities_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lane_groups" ADD CONSTRAINT "quote_lane_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_customer_id_quote_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."quote_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_rep_id_quote_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."quote_reps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_lane_group_id_quote_lane_groups_id_fk" FOREIGN KEY ("lane_group_id") REFERENCES "public"."quote_lane_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_carrier_id_quote_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."quote_carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_outcome_reason_id_quote_outcome_reasons_id_fk" FOREIGN KEY ("outcome_reason_id") REFERENCES "public"."quote_outcome_reasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_opportunities" ADD CONSTRAINT "quote_opportunities_routing_decision_by_user_id_users_id_fk" FOREIGN KEY ("routing_decision_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_outcome_reasons" ADD CONSTRAINT "quote_outcome_reasons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pattern_alerts" ADD CONSTRAINT "quote_pattern_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pattern_alerts" ADD CONSTRAINT "quote_pattern_alerts_customer_id_quote_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."quote_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pipeline_drops" ADD CONSTRAINT "quote_pipeline_drops_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pipeline_drops" ADD CONSTRAINT "quote_pipeline_drops_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pipeline_drops" ADD CONSTRAINT "quote_pipeline_drops_quote_id_quote_opportunities_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pipeline_drops" ADD CONSTRAINT "quote_pipeline_drops_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pricing_settings" ADD CONSTRAINT "quote_pricing_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_pricing_settings" ADD CONSTRAINT "quote_pricing_settings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_reps" ADD CONSTRAINT "quote_reps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_reps" ADD CONSTRAINT "quote_reps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_saved_views" ADD CONSTRAINT "quote_saved_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_saved_views" ADD CONSTRAINT "quote_saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sender_mappings" ADD CONSTRAINT "quote_sender_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sender_mappings" ADD CONSTRAINT "quote_sender_mappings_customer_id_quote_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."quote_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_lanes" ADD CONSTRAINT "recurring_lanes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_lanes" ADD CONSTRAINT "recurring_lanes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_lanes" ADD CONSTRAINT "recurring_lanes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_lanes" ADD CONSTRAINT "recurring_lanes_overseer_user_id_users_id_fk" FOREIGN KEY ("overseer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_lanes" ADD CONSTRAINT "recurring_lanes_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_coaching_insights" ADD CONSTRAINT "relationship_coaching_insights_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_coaching_insights" ADD CONSTRAINT "relationship_coaching_insights_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_coaching_insights" ADD CONSTRAINT "relationship_coaching_insights_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_routing_rules" ADD CONSTRAINT "sender_routing_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_routing_rules" ADD CONSTRAINT "sender_routing_rules_remembered_by_user_id_users_id_fk" FOREIGN KEY ("remembered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_email_corrections" ADD CONSTRAINT "sent_email_corrections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_email_corrections" ADD CONSTRAINT "sent_email_corrections_corrected_by_user_id_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_email_corrections" ADD CONSTRAINT "sent_email_corrections_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidebar_tooltips" ADD CONSTRAINT "sidebar_tooltips_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidebar_tooltips" ADD CONSTRAINT "sidebar_tooltips_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_attachments" ADD CONSTRAINT "thread_attachments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_attachments" ADD CONSTRAINT "thread_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_projects" ADD CONSTRAINT "thread_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_projects" ADD CONSTRAINT "thread_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_queue_snoozes" ADD CONSTRAINT "today_queue_snoozes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_queue_snoozes" ADD CONSTRAINT "today_queue_snoozes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_load_matches" ADD CONSTRAINT "truck_load_matches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_load_matches" ADD CONSTRAINT "truck_load_matches_truck_posting_id_truck_postings_id_fk" FOREIGN KEY ("truck_posting_id") REFERENCES "public"."truck_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_load_matches" ADD CONSTRAINT "truck_load_matches_freight_opportunity_id_freight_opportunities_id_fk" FOREIGN KEY ("freight_opportunity_id") REFERENCES "public"."freight_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_load_matches" ADD CONSTRAINT "truck_load_matches_assigned_rep_id_users_id_fk" FOREIGN KEY ("assigned_rep_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_load_matches" ADD CONSTRAINT "truck_load_matches_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_postings" ADD CONSTRAINT "truck_postings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_postings" ADD CONSTRAINT "truck_postings_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_postings" ADD CONSTRAINT "truck_postings_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_freight_cockpit_prefs" ADD CONSTRAINT "user_freight_cockpit_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_freight_cockpit_prefs" ADD CONSTRAINT "user_freight_cockpit_prefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_freight_cockpit_prefs" ADD CONSTRAINT "user_freight_cockpit_prefs_active_view_id_freight_opportunity_saved_views_id_fk" FOREIGN KEY ("active_view_id") REFERENCES "public"."freight_opportunity_saved_views"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lane_inbox_prefs" ADD CONSTRAINT "user_lane_inbox_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lifecycle_events" ADD CONSTRAINT "user_lifecycle_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lifecycle_events" ADD CONSTRAINT "user_lifecycle_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lifecycle_events" ADD CONSTRAINT "user_lifecycle_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_share_plays" ADD CONSTRAINT "wallet_share_plays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_share_plays" ADD CONSTRAINT "wallet_share_plays_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warm_intro_suggestions" ADD CONSTRAINT "warm_intro_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warm_intro_suggestions" ADD CONSTRAINT "warm_intro_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warm_intro_suggestions" ADD CONSTRAINT "warm_intro_suggestions_target_contact_id_contacts_id_fk" FOREIGN KEY ("target_contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warm_intro_suggestions" ADD CONSTRAINT "warm_intro_suggestions_bridge_contact_id_contacts_id_fk" FOREIGN KEY ("bridge_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_call_analytics" ADD CONSTRAINT "webex_call_analytics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_call_analytics" ADD CONSTRAINT "webex_call_analytics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_call_enrichment_jobs" ADD CONSTRAINT "webex_call_enrichment_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_call_enrichment_jobs" ADD CONSTRAINT "webex_call_enrichment_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_inventory" ADD CONSTRAINT "webex_inventory_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_sync_state" ADD CONSTRAINT "webex_sync_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_sync_state" ADD CONSTRAINT "webex_sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_user_mappings" ADD CONSTRAINT "webex_user_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_user_mappings" ADD CONSTRAINT "webex_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_user_tokens" ADD CONSTRAINT "webex_user_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_user_tokens" ADD CONSTRAINT "webex_user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_voicemails" ADD CONSTRAINT "webex_voicemails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_voicemails" ADD CONSTRAINT "webex_voicemails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_webhook_events" ADD CONSTRAINT "webex_webhook_events_subscription_id_webex_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webex_webhook_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_webhook_events" ADD CONSTRAINT "webex_webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_webhook_events" ADD CONSTRAINT "webex_webhook_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_webhook_subscriptions" ADD CONSTRAINT "webex_webhook_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webex_webhook_subscriptions" ADD CONSTRAINT "webex_webhook_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_commitments" ADD CONSTRAINT "weekly_commitments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_commitments" ADD CONSTRAINT "weekly_commitments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_commitments" ADD CONSTRAINT "weekly_commitments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_commitments" ADD CONSTRAINT "weekly_commitments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "win_loss_patterns" ADD CONSTRAINT "win_loss_patterns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_agents" ADD CONSTRAINT "workflow_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aclpr_account_contact_pattern_idx" ON "account_contact_lane_pattern_responsibilities" USING btree ("account_id","contact_id","lane_pattern_id");--> statement-breakpoint
CREATE INDEX "aclpr_account_status_idx" ON "account_contact_lane_pattern_responsibilities" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "aclpr_contact_status_idx" ON "account_contact_lane_pattern_responsibilities" USING btree ("contact_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "account_contact_suggestions_account_email_idx" ON "account_contact_suggestions" USING btree ("account_id","email_address");--> statement-breakpoint
CREATE INDEX "ala_org_source_idx" ON "account_look_alikes" USING btree ("org_id","source_company_id");--> statement-breakpoint
CREATE INDEX "ala_score_idx" ON "account_look_alikes" USING btree ("org_id","similarity_score");--> statement-breakpoint
CREATE UNIQUE INDEX "account_reviews_rep_company_week_idx" ON "account_reviews" USING btree ("rep_user_id","company_id","week_of");--> statement-breakpoint
CREATE INDEX "account_reviews_company_idx" ON "account_reviews" USING btree ("company_id","week_of");--> statement-breakpoint
CREATE INDEX "account_reviews_rep_idx" ON "account_reviews" USING btree ("rep_user_id","week_of");--> statement-breakpoint
CREATE INDEX "account_reviews_org_idx" ON "account_reviews" USING btree ("organization_id","week_of");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_status_org_key_idx" ON "adapter_status" USING btree ("organization_id","adapter_key");--> statement-breakpoint
CREATE INDEX "agent_activity_user_idx" ON "agent_activity" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_activity_org_idx" ON "agent_activity" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_activity_tool_idx" ON "agent_activity" USING btree ("tool");--> statement-breakpoint
CREATE INDEX "agent_activity_company_idx" ON "agent_activity" USING btree ("related_company_id");--> statement-breakpoint
CREATE INDEX "agent_activity_outcome_idx" ON "agent_activity" USING btree ("organization_id","outcome","created_at");--> statement-breakpoint
CREATE INDEX "agent_activity_message_idx" ON "agent_activity" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_capabilities_user_cap_idx" ON "agent_capabilities" USING btree ("user_id","capability");--> statement-breakpoint
CREATE INDEX "agent_capabilities_org_idx" ON "agent_capabilities" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channel_access_agent_chan_idx" ON "agent_channel_access" USING btree ("agent_id","channel");--> statement-breakpoint
CREATE INDEX "agent_facts_user_idx" ON "agent_facts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_facts_pinned_idx" ON "agent_facts" USING btree ("user_id","pinned");--> statement-breakpoint
CREATE INDEX "agent_memories_user_idx" ON "agent_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_memories_user_company_idx" ON "agent_memories" USING btree ("user_id","related_company_id");--> statement-breakpoint
CREATE INDEX "agent_memories_created_idx" ON "agent_memories" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_org_settings_org_idx" ON "agent_org_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_outcomes_agent_idx" ON "agent_outcomes" USING btree ("workflow_agent_id","recorded_at");--> statement-breakpoint
CREATE INDEX "agent_personas_active_idx" ON "agent_personas" USING btree ("agent_id","channel","is_active");--> statement-breakpoint
CREATE INDEX "agent_personas_history_idx" ON "agent_personas" USING btree ("agent_id","channel","created_at");--> statement-breakpoint
CREATE INDEX "agent_plays_agent_idx" ON "agent_plays" USING btree ("agent_id","enabled");--> statement-breakpoint
CREATE INDEX "agent_suggestions_agent_idx" ON "agent_suggestions" USING btree ("workflow_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_suggestions_org_idx" ON "agent_suggestions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tools_agent_cap_idx" ON "agent_tools" USING btree ("agent_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_user_access_agent_user_idx" ON "agent_user_access" USING btree ("agent_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_user_access_user_idx" ON "agent_user_access" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_slug_idx" ON "agents" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "agents_org_default_idx" ON "agents" USING btree ("organization_id","is_default");--> statement-breakpoint
CREATE INDEX "ai_eng_org_surface_created_idx" ON "ai_engagement_events" USING btree ("organization_id","surface","created_at");--> statement-breakpoint
CREATE INDEX "ai_eng_org_created_idx" ON "ai_engagement_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_eng_user_created_idx" ON "ai_engagement_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "arc_source_idx" ON "api_response_cache" USING btree ("source");--> statement-breakpoint
CREATE INDEX "arc_fetched_idx" ON "api_response_cache" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_leak_reviews_org_msg_type_uidx" ON "capture_leak_reviews" USING btree ("organization_id","message_id","leak_type");--> statement-breakpoint
CREATE INDEX "capture_leak_reviews_org_decided_at_idx" ON "capture_leak_reviews" USING btree ("organization_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_lane_fit_uq" ON "carrier_lane_fit" USING btree ("org_id","carrier_name","origin_state","destination_state","equipment_type");--> statement-breakpoint
CREATE INDEX "carrier_lane_fit_org_fit_idx" ON "carrier_lane_fit" USING btree ("org_id","fit_score");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_lane_outcomes_uq" ON "carrier_lane_outcomes" USING btree ("org_id","carrier_id","lane_signature");--> statement-breakpoint
CREATE INDEX "carrier_lane_outcomes_org_carrier_idx" ON "carrier_lane_outcomes" USING btree ("org_id","carrier_id");--> statement-breakpoint
CREATE INDEX "carrier_lane_outcomes_org_lane_idx" ON "carrier_lane_outcomes" USING btree ("org_id","lane_signature");--> statement-breakpoint
CREATE INDEX "carrier_outreach_logs_lane_delivery_idx" ON "carrier_outreach_logs" USING btree ("lane_id","delivery_status","sent_at");--> statement-breakpoint
CREATE INDEX "carrier_outreach_logs_lane_sent_at_idx" ON "carrier_outreach_logs" USING btree ("lane_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_overrides_uq" ON "carrier_overrides" USING btree ("org_id","carrier_id","lane_signature","rep_id","occurred_at_day");--> statement-breakpoint
CREATE INDEX "carrier_overrides_org_lane_idx" ON "carrier_overrides" USING btree ("org_id","lane_signature");--> statement-breakpoint
CREATE INDEX "carrier_overrides_org_carrier_idx" ON "carrier_overrides" USING btree ("org_id","carrier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_quote_events_org_ref_uq" ON "carrier_quote_events" USING btree ("org_id","source_reference");--> statement-breakpoint
CREATE INDEX "carrier_quote_events_org_lane_idx" ON "carrier_quote_events" USING btree ("org_id","lane_key");--> statement-breakpoint
CREATE INDEX "carrier_quote_events_org_carrier_idx" ON "carrier_quote_events" USING btree ("org_id","carrier_id");--> statement-breakpoint
CREATE INDEX "carrier_quote_events_org_extracted_idx" ON "carrier_quote_events" USING btree ("org_id","extracted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_recommendation_load_rank_uq" ON "carrier_recommendation" USING btree ("load_fact_id","rank");--> statement-breakpoint
CREATE INDEX "carrier_recommendation_org_load_idx" ON "carrier_recommendation" USING btree ("org_id","load_fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_scorecard_org_carrier_eq_uq" ON "carrier_scorecard_fact" USING btree ("org_id","carrier_name","equipment_type");--> statement-breakpoint
CREATE INDEX "carrier_scorecard_org_score_idx" ON "carrier_scorecard_fact" USING btree ("org_id","performance_score");--> statement-breakpoint
CREATE INDEX "carriers_org_status_idx" ON "carriers" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "carriers_org_name_idx" ON "carriers" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "carriers_org_created_idx" ON "carriers" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "coaching_notes_rep_idx" ON "coaching_notes" USING btree ("rep_id","created_at");--> statement-breakpoint
CREATE INDEX "coaching_notes_manager_idx" ON "coaching_notes" USING btree ("manager_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_collaborators_company_user_uq" ON "company_collaborators" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "company_collaborators_user_idx" ON "company_collaborators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "company_collaborators_org_idx" ON "company_collaborators" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cfa_org_company_idx" ON "company_financial_aliases" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "cfa_org_alias_norm_idx" ON "company_financial_aliases" USING btree ("org_id","alias_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "cfa_org_alias_norm_uniq" ON "company_financial_aliases" USING btree ("org_id","alias_normalized") WHERE source <> 'heuristic';--> statement-breakpoint
CREATE INDEX "cfa_quarantine_idx" ON "company_financial_aliases" USING btree ("org_id") WHERE source = 'heuristic' AND confirmed_by_user_id IS NULL;--> statement-breakpoint
CREATE INDEX "company_outreach_policies_org_enabled_idx" ON "company_outreach_policies" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "company_outreach_policies_auto_send_idx" ON "company_outreach_policies" USING btree ("org_id","auto_send_enabled");--> statement-breakpoint
CREATE INDEX "cs_org_company_idx" ON "competitive_signals" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "cs_severity_idx" ON "competitive_signals" USING btree ("org_id","severity");--> statement-breakpoint
CREATE INDEX "cs_status_idx" ON "competitive_signals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "cgs_account_contact_idx" ON "contact_geography_suggestions" USING btree ("account_id","contact_id");--> statement-breakpoint
CREATE INDEX "cgs_contact_status_idx" ON "contact_geography_suggestions" USING btree ("contact_id","status");--> statement-breakpoint
CREATE INDEX "cgs_account_status_idx" ON "contact_geography_suggestions" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "cst_org_contact_idx" ON "contact_sentiment_tracking" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "cst_company_idx" ON "contact_sentiment_tracking" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "cst_trend_idx" ON "contact_sentiment_tracking" USING btree ("org_id","sentiment_trend");--> statement-breakpoint
CREATE INDEX "context_note_events_note_created_idx" ON "context_note_events" USING btree ("note_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "context_note_mentions_note_user_uq" ON "context_note_mentions" USING btree ("note_id","user_id");--> statement-breakpoint
CREATE INDEX "context_note_mentions_user_created_idx" ON "context_note_mentions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "context_note_replies_note_idx" ON "context_note_replies" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "context_notes_anchor_idx" ON "context_notes" USING btree ("anchor_type","anchor_id");--> statement-breakpoint
CREATE INDEX "context_notes_author_created_idx" ON "context_notes" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "context_notes_org_status_idx" ON "context_notes" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "conv_sug_fb_stats_org_acct_action_uq" ON "conversation_suggestion_feedback_stats" USING btree ("org_id","account_id","action_type");--> statement-breakpoint
CREATE INDEX "conversation_thread_capture_audits_org_thread_idx" ON "conversation_thread_capture_audits" USING btree ("org_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_thread_events_org_thread_idx" ON "conversation_thread_events" USING btree ("org_id","thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_thread_suggestions_org_thread_uq" ON "conversation_thread_suggestions" USING btree ("org_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_thread_summaries_org_thread_uq" ON "conversation_thread_summaries" USING btree ("org_id","thread_id");--> statement-breakpoint
CREATE INDEX "copilot_actions_org_idx" ON "copilot_actions" USING btree ("organization_id","completed_at");--> statement-breakpoint
CREATE INDEX "copilot_actions_user_idx" ON "copilot_actions" USING btree ("confirmed_by_user_id","completed_at");--> statement-breakpoint
CREATE INDEX "copilot_actions_company_idx" ON "copilot_actions" USING btree ("related_company_id","completed_at");--> statement-breakpoint
CREATE INDEX "copilot_actions_tool_idx" ON "copilot_actions" USING btree ("tool");--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_actions_turn_tool_unique" ON "copilot_actions" USING btree ("organization_id","message_id","tool") WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_adjustments_uq" ON "copilot_adjustments" USING btree ("organization_id","scope","scope_key");--> statement-breakpoint
CREATE INDEX "copilot_adjustments_scope_idx" ON "copilot_adjustments" USING btree ("organization_id","scope");--> statement-breakpoint
CREATE INDEX "copilot_feedback_org_idx" ON "copilot_feedback" USING btree ("organization_id","captured_at");--> statement-breakpoint
CREATE INDEX "copilot_feedback_user_idx" ON "copilot_feedback" USING btree ("user_id","captured_at");--> statement-breakpoint
CREATE INDEX "copilot_feedback_msg_idx" ON "copilot_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_intel_doc_lane_uq" ON "copilot_intelligence" USING btree ("document_id","lane_key");--> statement-breakpoint
CREATE INDEX "copilot_intel_org_idx" ON "copilot_intelligence" USING btree ("organization_id","computed_at");--> statement-breakpoint
CREATE INDEX "copilot_intel_customer_idx" ON "copilot_intelligence" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_outcomes_rec_uq" ON "copilot_outcomes" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "copilot_outcomes_org_idx" ON "copilot_outcomes" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "copilot_plays_org_status_idx" ON "copilot_play_recommendations" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "copilot_plays_owner_idx" ON "copilot_play_recommendations" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "copilot_plays_doc_idx" ON "copilot_play_recommendations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "copilot_plays_customer_idx" ON "copilot_play_recommendations" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "copilot_plays_lane_idx" ON "copilot_play_recommendations" USING btree ("lane_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_plays_dedup_uq" ON "copilot_play_recommendations" USING btree ("organization_id","dedup_key") WHERE dedup_key IS NOT NULL AND status = 'pending';--> statement-breakpoint
CREATE INDEX "copilot_recs_org_generated_idx" ON "copilot_recommendations" USING btree ("org_id","generated_at");--> statement-breakpoint
CREATE INDEX "copilot_recs_doc_idx" ON "copilot_recommendations" USING btree ("source_document_id","generated_at");--> statement-breakpoint
CREATE INDEX "copilot_recs_customer_idx" ON "copilot_recommendations" USING btree ("customer_company_id","generated_at");--> statement-breakpoint
CREATE INDEX "copilot_recs_carrier_idx" ON "copilot_recommendations" USING btree ("carrier_id","generated_at");--> statement-breakpoint
CREATE INDEX "copilot_recs_opp_idx" ON "copilot_recommendations" USING btree ("opportunity_id","generated_at");--> statement-breakpoint
CREATE INDEX "copilot_recs_lane_idx" ON "copilot_recommendations" USING btree ("org_id","lane_signature");--> statement-breakpoint
CREATE INDEX "copilot_recs_reaction_idx" ON "copilot_recommendations" USING btree ("org_id","reaction");--> statement-breakpoint
CREATE INDEX "cso_org_company_idx" ON "cross_sell_opportunities" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "cso_status_idx" ON "cross_sell_opportunities" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_email_identities_uq" ON "customer_email_identities" USING btree ("organization_id","kind","value");--> statement-breakpoint
CREATE INDEX "customer_email_identities_org_idx" ON "customer_email_identities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "customer_email_identities_company_idx" ON "customer_email_identities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "doc_entity_links_doc_idx" ON "document_entity_links" USING btree ("document_id","kind","candidate_rank");--> statement-breakpoint
CREATE INDEX "doc_entity_links_target_idx" ON "document_entity_links" USING btree ("organization_id","kind","target_id");--> statement-breakpoint
CREATE INDEX "doc_extraction_corrections_doc_idx" ON "document_extraction_corrections" USING btree ("document_id","corrected_at");--> statement-breakpoint
CREATE INDEX "doc_extraction_corrections_field_idx" ON "document_extraction_corrections" USING btree ("organization_id","class_label","field_path");--> statement-breakpoint
CREATE INDEX "doc_extraction_findings_doc_idx" ON "document_extraction_findings" USING btree ("document_id","severity");--> statement-breakpoint
CREATE INDEX "doc_extraction_findings_org_rule_idx" ON "document_extraction_findings" USING btree ("organization_id","rule_code","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_extractions_doc_ver_uq" ON "document_extractions" USING btree ("document_id","schema_version");--> statement-breakpoint
CREATE INDEX "doc_extractions_org_class_idx" ON "document_extractions" USING btree ("organization_id","class_label","extracted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_extractions_typed_doc_uq" ON "document_extractions_typed" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "doc_extractions_typed_org_status_idx" ON "document_extractions_typed" USING btree ("organization_id","extraction_status");--> statement-breakpoint
CREATE UNIQUE INDEX "document_pages_doc_page_idx" ON "document_pages" USING btree ("document_id","page_number");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_sha256_idx" ON "documents" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_org_status_idx" ON "documents" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "documents_uploader_idx" ON "documents" USING btree ("uploader_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_class_idx" ON "documents" USING btree ("organization_id","class_label");--> statement-breakpoint
CREATE INDEX "df_org_idx" ON "draft_feedback" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "df_user_idx" ON "draft_feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "df_rating_idx" ON "draft_feedback" USING btree ("org_id","rating");--> statement-breakpoint
CREATE UNIQUE INDEX "eac_msg_name_idx" ON "email_attachment_classifications" USING btree ("message_id","attachment_name");--> statement-breakpoint
CREATE INDEX "eac_org_kind_idx" ON "email_attachment_classifications" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ebe_message_email_idx" ON "email_bounce_events" USING btree ("message_id","contact_email");--> statement-breakpoint
CREATE INDEX "ebe_org_email_idx" ON "email_bounce_events" USING btree ("org_id","contact_email");--> statement-breakpoint
CREATE INDEX "ebe_org_type_idx" ON "email_bounce_events" USING btree ("org_id","bounce_type");--> statement-breakpoint
CREATE UNIQUE INDEX "email_conv_read_user_thread_uniq" ON "email_conversation_read_states" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "ect_org_updated_idx" ON "email_conversation_threads" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "ect_org_waiting_idx" ON "email_conversation_threads" USING btree ("org_id","waiting_state");--> statement-breakpoint
CREATE INDEX "ect_org_owner_idx" ON "email_conversation_threads" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "ect_org_archived_idx" ON "email_conversation_threads" USING btree ("org_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_ect_org_last_email_at" ON "email_conversation_threads" USING btree ("org_id","last_email_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "ees_msg_slot_idx" ON "email_extracted_slots" USING btree ("message_id","slot_name");--> statement-breakpoint
CREATE INDEX "ees_org_slot_idx" ON "email_extracted_slots" USING btree ("org_id","slot_name");--> statement-breakpoint
CREATE INDEX "ees_thread_slot_idx" ON "email_extracted_slots" USING btree ("thread_id","slot_name");--> statement-breakpoint
CREATE UNIQUE INDEX "eoqs_msg_idx" ON "email_outbound_quality_scores" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "eoqs_rep_idx" ON "email_outbound_quality_scores" USING btree ("rep_user_id","created_at");--> statement-breakpoint
CREATE INDEX "eoqs_account_idx" ON "email_outbound_quality_scores" USING btree ("linked_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ep_msg_email_role_idx" ON "email_participants" USING btree ("message_id","email_address","role");--> statement-breakpoint
CREATE INDEX "ep_thread_email_idx" ON "email_participants" USING btree ("thread_id","email_address");--> statement-breakpoint
CREATE INDEX "ep_org_email_idx" ON "email_participants" USING btree ("org_id","email_address");--> statement-breakpoint
CREATE INDEX "ep_company_email_idx" ON "email_participants" USING btree ("company_id","email_address");--> statement-breakpoint
CREATE UNIQUE INDEX "eprm_msg_text_idx" ON "email_promises" USING btree ("message_id","promise_text");--> statement-breakpoint
CREATE INDEX "eprm_status_due_idx" ON "email_promises" USING btree ("org_id","status","promise_due_at");--> statement-breakpoint
CREATE INDEX "eprm_rep_status_idx" ON "email_promises" USING btree ("rep_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "eq_msg_text_idx" ON "email_questions" USING btree ("message_id","question_text");--> statement-breakpoint
CREATE INDEX "eq_status_idx" ON "email_questions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "eq_thread_idx" ON "email_questions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "perf_samples_route_created_idx" ON "endpoint_perf_samples" USING btree ("route_key","created_at");--> statement-breakpoint
CREATE INDEX "perf_samples_created_idx" ON "endpoint_perf_samples" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ext_consent_identifier_idx" ON "external_contact_consent" USING btree ("organization_id","contact_kind","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_org_key" ON "feature_flags" USING btree ("org_id","flag_key");--> statement-breakpoint
CREATE UNIQUE INDEX "field_conf_overrides_org_class_field_uq" ON "field_confidence_overrides" USING btree ("organization_id","class_label","field_path");--> statement-breakpoint
CREATE INDEX "fur_org_contact_idx" ON "follow_up_recommendations" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "fur_next_date_idx" ON "follow_up_recommendations" USING btree ("org_id","next_follow_up_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fce_msg_type_idx" ON "forward_calendar_events" USING btree ("message_id","event_type");--> statement-breakpoint
CREATE INDEX "fce_org_date_idx" ON "forward_calendar_events" USING btree ("org_id","event_date");--> statement-breakpoint
CREATE INDEX "fce_status_idx" ON "forward_calendar_events" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "freight_daily_upload_fact_org_upload_idx" ON "freight_daily_upload_fact" USING btree ("org_id","upload_id");--> statement-breakpoint
CREATE INDEX "freight_daily_upload_fact_org_moved_ship_idx" ON "freight_daily_upload_fact" USING btree ("org_id","moved","ship_date");--> statement-breakpoint
CREATE INDEX "freight_daily_upload_fact_org_lane_idx" ON "freight_daily_upload_fact" USING btree ("org_id","origin_city","dest_city","equipment");--> statement-breakpoint
CREATE UNIQUE INDEX "freight_daily_upload_fact_load_key_uq" ON "freight_daily_upload_fact" USING btree ("org_id","upload_id","load_key");--> statement-breakpoint
CREATE INDEX "freight_opps_org_status_urgency_idx" ON "freight_opportunities" USING btree ("org_id","status","urgency_score");--> statement-breakpoint
CREATE INDEX "freight_opps_company_pickup_idx" ON "freight_opportunities" USING btree ("company_id","pickup_window_start");--> statement-breakpoint
CREATE INDEX "freight_opps_recurring_lane_idx" ON "freight_opportunities" USING btree ("recurring_lane_id");--> statement-breakpoint
CREATE INDEX "freight_opps_owner_idx" ON "freight_opportunities" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "freight_opps_delegated_idx" ON "freight_opportunities" USING btree ("delegated_to_user_id");--> statement-breakpoint
CREATE INDEX "freight_opps_awaiting_idx" ON "freight_opportunities" USING btree ("awaiting_approval_since");--> statement-breakpoint
CREATE INDEX "freight_opps_source_quote_idx" ON "freight_opportunities" USING btree ("source_quote_id");--> statement-breakpoint
CREATE INDEX "freight_opp_audit_opp_created_idx" ON "freight_opportunity_audit" USING btree ("opportunity_id","created_at");--> statement-breakpoint
CREATE INDEX "freight_opp_capture_failures_org_resolved_idx" ON "freight_opportunity_capture_failures" USING btree ("org_id","resolved_at");--> statement-breakpoint
CREATE INDEX "freight_opp_capture_failures_quote_idx" ON "freight_opportunity_capture_failures" USING btree ("quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "freight_opp_capture_failures_open_uq" ON "freight_opportunity_capture_failures" USING btree ("org_id","quote_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "freight_opp_carriers_opp_rank_idx" ON "freight_opportunity_carriers" USING btree ("opportunity_id","rank");--> statement-breakpoint
CREATE INDEX "freight_opp_carriers_carrier_created_idx" ON "freight_opportunity_carriers" USING btree ("carrier_id","created_at");--> statement-breakpoint
CREATE INDEX "freight_opp_carriers_scheduled_idx" ON "freight_opportunity_carriers" USING btree ("scheduled_for","sent_at");--> statement-breakpoint
CREATE INDEX "freight_opp_carriers_thread_idx" ON "freight_opportunity_carriers" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "freight_opp_rate_history_opp_idx" ON "freight_opportunity_rate_history" USING btree ("opportunity_id","changed_at");--> statement-breakpoint
CREATE INDEX "freight_saved_views_org_user_idx" ON "freight_opportunity_saved_views" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "freight_outreach_templates_org_kind_uq" ON "freight_outreach_templates" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "hitl_actions_org_status_idx" ON "hitl_actions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "hitl_actions_routed_idx" ON "hitl_actions" USING btree ("routed_to_user_id","status");--> statement-breakpoint
CREATE INDEX "hitl_actions_pod_idx" ON "hitl_actions" USING btree ("pod_id","status");--> statement-breakpoint
CREATE INDEX "hitl_actions_agent_idx" ON "hitl_actions" USING btree ("workflow_agent_id");--> statement-breakpoint
CREATE INDEX "integration_health_source_created_idx" ON "integration_health_snapshots" USING btree ("source","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intel_tracked_lanes_user_lane_idx" ON "intel_tracked_lanes" USING btree ("user_id","origin","destination","equipment_type");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_carrier_interest_lane_carrier" ON "lane_carrier_interest" USING btree ("lane_id","carrier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_carrier_interest_name_null_carrier" ON "lane_carrier_interest" USING btree ("lane_id","carrier_name") WHERE carrier_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lane_coverage_profile_carriers_profile_carrier" ON "lane_coverage_profile_carriers" USING btree ("profile_id","carrier_name");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_coverage_profiles_org_key" ON "lane_coverage_profiles" USING btree ("org_id","lane_key");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_rate_history_lane_uq" ON "lane_rate_history" USING btree ("org_id","origin_state","destination_state","equipment_type","customer_name");--> statement-breakpoint
CREATE INDEX "lane_rate_history_org_loads_idx" ON "lane_rate_history" USING btree ("org_id","loads");--> statement-breakpoint
CREATE INDEX "lane_summary_cache_owner_resolved_score" ON "lane_summary_cache" USING btree ("owner_user_id","resolved_at","lane_score");--> statement-breakpoint
CREATE INDEX "lane_summary_cache_org_resolved_score" ON "lane_summary_cache" USING btree ("org_id","resolved_at","lane_score");--> statement-breakpoint
CREATE INDEX "leak_console_audit_org_created_idx" ON "leak_console_audit" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "leak_console_audit_lane_idx" ON "leak_console_audit" USING btree ("lane_id");--> statement-breakpoint
CREATE INDEX "library_items_user_idx" ON "library_items" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "library_items_kind_idx" ON "library_items" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "load_fact_org_order_uq" ON "load_fact" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "load_fact_org_bucket_idx" ON "load_fact" USING btree ("org_id","bucket");--> statement-breakpoint
CREATE INDEX "load_fact_org_carrier_idx" ON "load_fact" USING btree ("org_id","carrier_name");--> statement-breakpoint
CREATE INDEX "load_fact_org_month_idx" ON "load_fact" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "load_fact_org_company_idx" ON "load_fact" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "load_fact_org_pickup_idx" ON "load_fact" USING btree ("org_id","pickup_date");--> statement-breakpoint
CREATE INDEX "load_fact_org_account_manager_idx" ON "load_fact" USING btree ("org_id","account_manager");--> statement-breakpoint
CREATE INDEX "load_fact_org_dispatcher_idx" ON "load_fact" USING btree ("org_id","dispatcher");--> statement-breakpoint
CREATE INDEX "load_fact_org_last_seen_idx" ON "load_fact" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "load_fact_history_load_changed_idx" ON "load_fact_history" USING btree ("load_fact_id","changed_at");--> statement-breakpoint
CREATE INDEX "load_fact_history_org_changed_idx" ON "load_fact_history" USING btree ("org_id","changed_at");--> statement-breakpoint
CREATE INDEX "load_fact_import_audit_org_created_idx" ON "load_fact_import_audit" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "load_fact_import_audit_org_replay_idx" ON "load_fact_import_audit" USING btree ("org_id","replay_token");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_health_alerts_open_idx" ON "mailbox_health_alerts" USING btree ("mailbox_id","alert_key") WHERE "mailbox_health_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mailbox_health_alerts_org_idx" ON "mailbox_health_alerts" USING btree ("org_id","resolved_at");--> statement-breakpoint
CREATE INDEX "mailbox_historical_backfills_mailbox_idx" ON "mailbox_historical_backfills" USING btree ("mailbox_id","created_at");--> statement-breakpoint
CREATE INDEX "mailbox_historical_backfills_org_status_idx" ON "mailbox_historical_backfills" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_sync_failures_unique_idx" ON "mailbox_sync_failures" USING btree ("mailbox_id","folder","provider_message_id");--> statement-breakpoint
CREATE INDEX "mailbox_sync_failures_mailbox_status_idx" ON "mailbox_sync_failures" USING btree ("mailbox_id","status");--> statement-breakpoint
CREATE INDEX "mailbox_sync_failures_due_idx" ON "mailbox_sync_failures" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mpb_org_company_idx" ON "meeting_prep_briefs" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "mpb_user_idx" ON "meeting_prep_briefs" USING btree ("generated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "missed_inbound_calls_org_cdr_unique" ON "missed_inbound_calls" USING btree ("org_id","cdr_id");--> statement-breakpoint
CREATE INDEX "missed_inbound_calls_org_start_idx" ON "missed_inbound_calls" USING btree ("org_id","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "monitored_mailboxes_org_email_idx" ON "monitored_mailboxes" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "monitored_mailboxes_org_enabled_idx" ON "monitored_mailboxes" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "idx_nam_lm_checkins_lm" ON "nam_lm_checkins" USING btree ("lm_id","check_date");--> statement-breakpoint
CREATE INDEX "idx_nam_lm_checkins_reviewer" ON "nam_lm_checkins" USING btree ("reviewer_id","check_date");--> statement-breakpoint
CREATE UNIQUE INDEX "nam_lm_checkins_unique" ON "nam_lm_checkins" USING btree ("reviewer_id","lm_id","check_date","check_type");--> statement-breakpoint
CREATE INDEX "nba_card_events_card_idx" ON "nba_card_events" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "nba_card_events_org_type_idx" ON "nba_card_events" USING btree ("org_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "nba_card_outcomes_card_unique" ON "nba_card_outcomes" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "nba_card_outcomes_org_user_idx" ON "nba_card_outcomes" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "nba_card_outcomes_rule_idx" ON "nba_card_outcomes" USING btree ("org_id","rule_type");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_dismissals_company_id_org_id_key" ON "opportunity_dismissals" USING btree ("company_id","org_id");--> statement-breakpoint
CREATE INDEX "ocg_org_company_idx" ON "org_chart_gaps" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "ocg_status_idx" ON "org_chart_gaps" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "org_corpus_kind_src_chunk_idx" ON "org_corpus_chunks" USING btree ("organization_id","source_kind","source_id","chunk_index");--> statement-breakpoint
CREATE INDEX "org_corpus_org_kind_idx" ON "org_corpus_chunks" USING btree ("organization_id","source_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "pinned_companies_user_company_idx" ON "pinned_companies" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_outcomes_run_idx" ON "play_outcomes" USING btree ("play_run_id");--> statement-breakpoint
CREATE INDEX "play_outcomes_status_window_idx" ON "play_outcomes" USING btree ("status","window_expires_at");--> statement-breakpoint
CREATE INDEX "play_runs_org_status_idx" ON "play_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "play_runs_rep_status_idx" ON "play_runs" USING btree ("rep_user_id","status");--> statement-breakpoint
CREATE INDEX "play_runs_play_idx" ON "play_runs" USING btree ("play_id");--> statement-breakpoint
CREATE INDEX "play_runs_thread_idx" ON "play_runs" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_versions_play_version_idx" ON "play_versions" USING btree ("play_id","version");--> statement-breakpoint
CREATE INDEX "plays_org_status_idx" ON "plays" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "plays_org_trigger_idx" ON "plays" USING btree ("org_id","trigger_type");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_agents_pod_agent_idx" ON "pod_agents" USING btree ("pod_id","workflow_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_intake_emails_org_msg_idx" ON "pod_intake_emails" USING btree ("org_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "pod_intake_emails_org_status_idx" ON "pod_intake_emails" USING btree ("org_id","forward_status","received_at");--> statement-breakpoint
CREATE INDEX "pod_intake_emails_org_classification_idx" ON "pod_intake_emails" USING btree ("org_id","classification","received_at");--> statement-breakpoint
CREATE INDEX "pod_intake_emails_matched_load_idx" ON "pod_intake_emails" USING btree ("matched_load_fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_members_pod_user_idx" ON "pod_members" USING btree ("pod_id","user_id");--> statement-breakpoint
CREATE INDEX "pod_members_user_idx" ON "pod_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pods_org_idx" ON "pods" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pt_org_signal_idx" ON "proven_tactics" USING btree ("org_id","signal_type");--> statement-breakpoint
CREATE INDEX "pt_outcome_idx" ON "proven_tactics" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "pt_signal_outcome_idx" ON "proven_tactics" USING btree ("signal_type","outcome");--> statement-breakpoint
CREATE INDEX "quote_events_quote_idx" ON "quote_events" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "quote_opportunities_org_idx" ON "quote_opportunities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quote_opportunities_customer_idx" ON "quote_opportunities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quote_opportunities_request_date_idx" ON "quote_opportunities" USING btree ("request_date");--> statement-breakpoint
CREATE INDEX "quote_opportunities_snoozed_idx" ON "quote_opportunities" USING btree ("organization_id","snoozed_until") WHERE snoozed_until IS NOT NULL;--> statement-breakpoint
CREATE INDEX "quote_opportunities_routing_idx" ON "quote_opportunities" USING btree ("organization_id","routing_status") WHERE routing_status = 'needs_routing';--> statement-breakpoint
CREATE INDEX "quote_pattern_alerts_org_idx" ON "quote_pattern_alerts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quote_pattern_alerts_customer_idx" ON "quote_pattern_alerts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quote_pattern_alerts_status_idx" ON "quote_pattern_alerts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quote_pipeline_drops_org_attempted_idx" ON "quote_pipeline_drops" USING btree ("org_id","attempted_at");--> statement-breakpoint
CREATE INDEX "quote_pipeline_drops_org_resolved_idx" ON "quote_pipeline_drops" USING btree ("org_id","resolved_at");--> statement-breakpoint
CREATE INDEX "quote_pipeline_drops_org_reason_idx" ON "quote_pipeline_drops" USING btree ("org_id","reason_code");--> statement-breakpoint
CREATE INDEX "quote_pipeline_drops_message_idx" ON "quote_pipeline_drops" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "quote_pipeline_drops_org_archived_idx" ON "quote_pipeline_drops" USING btree ("org_id","attempted_at") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quote_pipeline_drops_open_uq" ON "quote_pipeline_drops" USING btree ("org_id","message_id","reason_code") WHERE resolved_at IS NULL AND message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "quote_sender_mappings_org_idx" ON "quote_sender_mappings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quote_sender_mappings_customer_idx" ON "quote_sender_mappings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "rci_org_company_idx" ON "relationship_coaching_insights" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "rci_status_idx" ON "relationship_coaching_insights" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_routing_rules_uq" ON "sender_routing_rules" USING btree ("org_id","scope_type","scope_value");--> statement-breakpoint
CREATE INDEX "sender_routing_rules_org_idx" ON "sender_routing_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sec_org_idx" ON "sent_email_corrections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sec_email_msg_idx" ON "sent_email_corrections" USING btree ("email_message_id");--> statement-breakpoint
CREATE INDEX "sec_outreach_idx" ON "sent_email_corrections" USING btree ("outreach_log_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sidebar_tooltips_org_key" ON "sidebar_tooltips" USING btree ("org_id","item_key");--> statement-breakpoint
CREATE INDEX "thread_attachments_thread_idx" ON "thread_attachments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_attachments_message_idx" ON "thread_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "thread_messages_thread_idx" ON "thread_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_projects_user_idx" ON "thread_projects" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_user_idx" ON "threads" USING btree ("user_id","archived_at","last_message_at");--> statement-breakpoint
CREATE INDEX "threads_project_idx" ON "threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "threads_org_idx" ON "threads" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "today_queue_snoozes_user_item_uniq" ON "today_queue_snoozes" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "today_queue_snoozes_org_user_idx" ON "today_queue_snoozes" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "truck_load_matches_org_state_idx" ON "truck_load_matches" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "truck_load_matches_posting_idx" ON "truck_load_matches" USING btree ("truck_posting_id");--> statement-breakpoint
CREATE INDEX "truck_load_matches_opp_idx" ON "truck_load_matches" USING btree ("freight_opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "truck_load_matches_pair_uq" ON "truck_load_matches" USING btree ("truck_posting_id","freight_opportunity_id");--> statement-breakpoint
CREATE INDEX "truck_load_matches_rep_idx" ON "truck_load_matches" USING btree ("assigned_rep_id");--> statement-breakpoint
CREATE INDEX "truck_postings_org_status_idx" ON "truck_postings" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "truck_postings_carrier_idx" ON "truck_postings" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "truck_postings_available_date_idx" ON "truck_postings" USING btree ("available_date");--> statement-breakpoint
CREATE INDEX "user_freight_cockpit_prefs_org_idx" ON "user_freight_cockpit_prefs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "user_lifecycle_events_user_idx" ON "user_lifecycle_events" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "user_lifecycle_events_org_idx" ON "user_lifecycle_events" USING btree ("org_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "wsp_org_company_idx" ON "wallet_share_plays" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "wsp_status_idx" ON "wallet_share_plays" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "wis_org_company_idx" ON "warm_intro_suggestions" USING btree ("org_id","company_id");--> statement-breakpoint
CREATE INDEX "wis_status_idx" ON "warm_intro_suggestions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_analytics_org_call_idx" ON "webex_call_analytics" USING btree ("org_id","call_id");--> statement-breakpoint
CREATE INDEX "webex_analytics_user_time_idx" ON "webex_call_analytics" USING btree ("user_id","start_time");--> statement-breakpoint
CREATE INDEX "webex_analytics_org_time_idx" ON "webex_call_analytics" USING btree ("org_id","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_enrichment_org_call_idx" ON "webex_call_enrichment_jobs" USING btree ("org_id","call_id");--> statement-breakpoint
CREATE INDEX "webex_enrichment_status_next_idx" ON "webex_call_enrichment_jobs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_inventory_org_kind_id_idx" ON "webex_inventory" USING btree ("org_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "webex_inventory_kind_idx" ON "webex_inventory" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_sync_state_user_unique_idx" ON "webex_sync_state" USING btree ("org_id","data_source","user_id") WHERE "webex_sync_state"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webex_sync_state_org_unique_idx" ON "webex_sync_state" USING btree ("org_id","data_source") WHERE "webex_sync_state"."user_id" IS NULL;--> statement-breakpoint
CREATE INDEX "webex_sync_state_org_idx" ON "webex_sync_state" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_mappings_org_person_idx" ON "webex_user_mappings" USING btree ("org_id","webex_person_id");--> statement-breakpoint
CREATE INDEX "webex_mappings_org_email_idx" ON "webex_user_mappings" USING btree ("org_id","webex_email");--> statement-breakpoint
CREATE INDEX "webex_mappings_user_idx" ON "webex_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_user_tokens_user_idx" ON "webex_user_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webex_user_tokens_org_idx" ON "webex_user_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webex_user_tokens_person_idx" ON "webex_user_tokens" USING btree ("webex_person_id");--> statement-breakpoint
CREATE INDEX "webex_user_tokens_needs_reauth_idx" ON "webex_user_tokens" USING btree ("needs_reauth");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_voicemail_org_id_idx" ON "webex_voicemails" USING btree ("org_id","voicemail_id");--> statement-breakpoint
CREATE INDEX "webex_voicemail_user_idx" ON "webex_voicemails" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_webhook_event_id_unique_idx" ON "webex_webhook_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webex_webhook_event_org_received_idx" ON "webex_webhook_events" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "webex_webhook_event_resource_idx" ON "webex_webhook_events" USING btree ("resource","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webex_webhook_sub_user_unique_idx" ON "webex_webhook_subscriptions" USING btree ("org_id","user_id","resource","event") WHERE "webex_webhook_subscriptions"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webex_webhook_sub_org_unique_idx" ON "webex_webhook_subscriptions" USING btree ("org_id","resource","event") WHERE "webex_webhook_subscriptions"."user_id" IS NULL;--> statement-breakpoint
CREATE INDEX "webex_webhook_sub_org_idx" ON "webex_webhook_subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webex_webhook_sub_status_idx" ON "webex_webhook_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wlp_org_type_idx" ON "win_loss_patterns" USING btree ("org_id","pattern_type");--> statement-breakpoint
CREATE INDEX "wlp_outcome_idx" ON "win_loss_patterns" USING btree ("org_id","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_agents_org_slug_idx" ON "workflow_agents" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "workflow_agents_org_enabled_idx" ON "workflow_agents" USING btree ("organization_id","enabled");--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pto_passoff_items" ADD CONSTRAINT "pto_passoff_items_override_covering_user_id_users_id_fk" FOREIGN KEY ("override_covering_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_opportunity_id_crm_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."crm_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_org_idx" ON "companies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "companies_org_assigned_idx" ON "companies" USING btree ("organization_id","assigned_to");--> statement-breakpoint
CREATE INDEX "companies_org_name_idx" ON "companies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "companies_email_derived_idx" ON "companies" USING btree ("organization_id") WHERE is_email_derived = true;--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_deleted_at_idx" ON "contacts" USING btree ("deleted_at") WHERE "contacts"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_company_active_idx" ON "contacts" USING btree ("company_id") WHERE "contacts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE INDEX "tasks_assigned_to_status_idx" ON "tasks" USING btree ("assigned_to","status");--> statement-breakpoint
CREATE INDEX "tasks_company_idx" ON "tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tasks_org_status_idx" ON "tasks" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "touchpoints_external_id_uq" ON "touchpoints" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "touchpoints_company_date_idx" ON "touchpoints" USING btree ("company_id","date");--> statement-breakpoint
CREATE INDEX "touchpoints_logged_by_idx" ON "touchpoints" USING btree ("logged_by_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");