-- Task #1126 Phase 1 — append-only audit log for user lifecycle changes.
--
-- Every Phase 1 admin action (classify, deactivate, reactivate,
-- soft-delete, restore, mark/unmark service, etc.) writes one row
-- here. Reads stay free of this table for now — it exists so the
-- admin lifecycle routes (Phase 1 step 7) can land with audit
-- guarantees from day one.
--
-- prev_state / next_state hold partial snapshots of the lifecycle
-- columns affected by the event (jsonb so we don't ossify the event
-- shape across future flag additions).

CREATE TABLE IF NOT EXISTS user_lifecycle_events (
    id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        varchar      NOT NULL REFERENCES users(id),
    org_id         varchar      NOT NULL REFERENCES organizations(id),
    actor_user_id  varchar      NULL     REFERENCES users(id),
    event          text         NOT NULL,
    reason         text         NULL,
    prev_state     jsonb        NOT NULL DEFAULT '{}'::jsonb,
    next_state     jsonb        NOT NULL DEFAULT '{}'::jsonb,
    source         text         NULL,
    created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_lifecycle_events_user_idx
    ON user_lifecycle_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_lifecycle_events_org_idx
    ON user_lifecycle_events (org_id, created_at DESC);
