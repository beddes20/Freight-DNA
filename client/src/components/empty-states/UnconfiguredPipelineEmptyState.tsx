/**
 * Honesty empty-state for the carrier-intelligence pages
 * (scorecard / available-loads / lane-pricing).
 *
 * Renders only when *both* of these are true:
 *   1. The page query returned 0 rows.
 *   2. The shared `/api/admin/load-fact/pipeline-health` endpoint reports
 *      `urlConfigured === false`.
 *
 * The previous behaviour was a generic "no results" message that made an
 * unconfigured PowerBI source look identical to a healthy-but-quiet day.
 * This component instead names the root cause and links the right person
 * to the right admin page so the silence stops being mysterious.
 *
 * The pipeline-health fetch is admin-only; for non-admins this component
 * gracefully falls back to a neutral "no data yet — ask your admin" copy
 * without exposing the diagnostic details.
 */

import { useQuery } from "@tanstack/react-query";
import { DatabaseZap } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/hooks/use-auth";

interface PipelineHealthResponse {
  urlConfigured: boolean;
  credentialsPresent: boolean;
  scheduleEnabled: boolean;
  lastImportAt: string | null;
  lastImportRowCount: number;
  currentRowCount: number;
}

export interface UnconfiguredPipelineEmptyStateProps {
  /** Surface name for the test ID and message context (e.g. "scorecard"). */
  surface: "scorecard" | "available-loads" | "lane-pricing";
  /**
   * When true, only render anything when the pipeline is *unconfigured*.
   * For non-admins, configured pipelines, or while the health probe is
   * loading, the component returns null. Use this on surfaces where
   * generic "no data yet" copy would conflict with other UI (e.g. the
   * lane-pricing page already has a quote form above the placeholder).
   */
  onlyWhenUnconfigured?: boolean;
}

const SURFACE_LABEL: Record<UnconfiguredPipelineEmptyStateProps["surface"], string> = {
  "scorecard": "carrier scorecards",
  "available-loads": "available loads",
  "lane-pricing": "lane pricing data",
};

export function UnconfiguredPipelineEmptyState({ surface, onlyWhenUnconfigured }: UnconfiguredPipelineEmptyStateProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // Only admins can hit the pipeline-health endpoint. Skip the fetch for
  // everyone else and render the neutral fallback to avoid a 403.
  const { data, isLoading } = useQuery<PipelineHealthResponse>({
    queryKey: ["/api/admin/load-fact/pipeline-health"],
    enabled: isAdmin,
    staleTime: 60_000,
  });

  const pipelineUnconfigured = isAdmin && !!data && !data.urlConfigured;

  if (onlyWhenUnconfigured && !pipelineUnconfigured) {
    return null;
  }

  if (isAdmin && isLoading) {
    // Render the generic "no data" copy while we wait — flipping copy from
    // "no data" to "configure source" mid-render would be jarring.
    return (
      <EmptyState
        icon={DatabaseZap}
        title={`No ${SURFACE_LABEL[surface]} yet`}
        description="Loading pipeline status…"
        testId={`empty-pipeline-${surface}`}
      />
    );
  }

  // Non-admin or pipeline is configured but quiet → neutral copy.
  if (!isAdmin || data?.urlConfigured) {
    return (
      <EmptyState
        icon={DatabaseZap}
        title={`No ${SURFACE_LABEL[surface]} yet`}
        description={
          isAdmin
            ? "The freight data source is configured but no rows have been imported yet. Try a manual import from the Load Fact admin page."
            : "Ask your admin to confirm the freight data source is connected."
        }
        action={
          isAdmin
            ? { label: "Open Load Fact admin", href: "/admin/load-fact" }
            : undefined
        }
        testId={`empty-pipeline-${surface}`}
      />
    );
  }

  // Admin + pipeline unconfigured → name the cause and link the fix.
  return (
    <EmptyState
      icon={DatabaseZap}
      title={`No ${SURFACE_LABEL[surface]} yet`}
      description="The freight data source URL hasn't been configured. Once an admin sets it on the Integrations Health page, scheduled imports will start populating this view."
      action={{ label: "Configure source URL", href: "/admin/integrations-health" }}
      testId={`empty-pipeline-${surface}`}
    />
  );
}
