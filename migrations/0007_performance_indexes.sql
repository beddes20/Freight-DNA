-- Task #272 — Performance indexes for Intel / Dashboard / Tasks / Carrier Hub hot paths.
-- All idempotent (IF NOT EXISTS). Safe to re-run.

-- ── tasks: the dashboard / tasks page filter by orgId + (assignedTo | assignedBy) + status.
CREATE INDEX IF NOT EXISTS tasks_org_status_idx         ON tasks (org_id, status);
CREATE INDEX IF NOT EXISTS tasks_org_assigned_to_idx    ON tasks (org_id, assigned_to);
CREATE INDEX IF NOT EXISTS tasks_org_assigned_by_idx    ON tasks (org_id, assigned_by);
CREATE INDEX IF NOT EXISTS tasks_company_status_idx     ON tasks (company_id, status);
CREATE INDEX IF NOT EXISTS tasks_due_date_idx           ON tasks (due_date);

-- ── touchpoints: dashboard portlets group by user + date, by company + date.
CREATE INDEX IF NOT EXISTS touchpoints_logged_by_date_idx   ON touchpoints (logged_by_id, date DESC);
CREATE INDEX IF NOT EXISTS touchpoints_company_date_idx     ON touchpoints (company_id, date DESC);
CREATE INDEX IF NOT EXISTS touchpoints_date_idx             ON touchpoints (date DESC);

-- ── contacts: company_id is the dominant filter; created_at for new-contact portlets.
CREATE INDEX IF NOT EXISTS contacts_company_id_idx          ON contacts (company_id);
CREATE INDEX IF NOT EXISTS contacts_created_at_idx          ON contacts (created_at);
CREATE INDEX IF NOT EXISTS contacts_base_advanced_at_idx    ON contacts (base_advanced_at)
    WHERE base_advanced_at IS NOT NULL;

-- ── companies: organisation scoping + assignment lookups.
CREATE INDEX IF NOT EXISTS companies_organization_id_idx    ON companies (organization_id);
CREATE INDEX IF NOT EXISTS companies_assigned_to_idx        ON companies (assigned_to);
CREATE INDEX IF NOT EXISTS companies_sales_person_id_idx    ON companies (sales_person_id);

-- ── task_comments: count / list by task_id for comment-count aggregation.
CREATE INDEX IF NOT EXISTS task_comments_task_id_idx        ON task_comments (task_id);

-- ── intel_tracked_lanes: lookup by org + active for the TRAC rate map build on every
--    Intel load.  Composite on (org_id, active) keeps the very common filter fast.
CREATE INDEX IF NOT EXISTS intel_tracked_lanes_org_active_idx
    ON intel_tracked_lanes (org_id, active);

-- ── intel_lane_rates: dominant lookup is by tracked_lane_id.
CREATE INDEX IF NOT EXISTS intel_lane_rates_tracked_lane_idx
    ON intel_lane_rates (tracked_lane_id);

-- ── notifications: dashboard polls unread by user.
CREATE INDEX IF NOT EXISTS notifications_user_read_idx
    ON notifications (user_id, read);

-- ── goals: AM comparison portlet filters by namId / amId.
CREATE INDEX IF NOT EXISTS goals_am_id_idx                  ON goals (am_id);
CREATE INDEX IF NOT EXISTS goals_nam_id_idx                 ON goals (nam_id);
