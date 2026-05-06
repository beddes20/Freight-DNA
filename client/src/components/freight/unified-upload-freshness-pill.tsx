/**
 * Task #1051 — Shared "last upload at" freshness pill.
 *
 * Single component used above Financials, Available Freight, and the Lane
 * Work Queue. Reads from `/api/unified-upload/latest` so all three rep
 * surfaces show the same canonical timestamp + row count derived from the
 * one ReplitDailyUpload that fed `freight_daily_upload_fact`.
 */

import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface LatestUpload {
  uploadId: string | null;
  uploadedAt: string | null;
  fileName: string | null;
  rowCount: number;
  factRowCount: number;
  movedRowCount: number;
}

export function UnifiedUploadFreshnessPill({ surface }: { surface: "financials" | "available-freight" | "lwq" }) {
  const { data, isLoading } = useQuery<LatestUpload>({
    queryKey: ["/api/unified-upload/latest"],
    staleTime: 60_000,
  });
  if (isLoading) {
    return (
      <Badge variant="outline" className="gap-1.5" data-testid={`pill-upload-freshness-${surface}-loading`}>
        <Clock className="w-3 h-3" />
        <span className="text-[11px]">Checking…</span>
      </Badge>
    );
  }
  if (!data || !data.uploadedAt) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground" data-testid={`pill-upload-freshness-${surface}`}>
        <Clock className="w-3 h-3" />
        <span className="text-[11px]">No upload yet</span>
      </Badge>
    );
  }
  const ageHours = (Date.now() - new Date(data.uploadedAt).getTime()) / 3_600_000;
  // Color shifts by freshness: <24h green, <48h amber, older red.
  const color = ageHours < 24
    ? "text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700"
    : ageHours < 48
      ? "text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-700"
      : "text-red-600 border-red-300 dark:text-red-400 dark:border-red-700";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={`gap-1.5 cursor-help ${color}`}
          data-testid={`pill-upload-freshness-${surface}`}
        >
          <Clock className="w-3 h-3" />
          <span className="text-[11px]">
            Synced {formatDistanceToNow(new Date(data.uploadedAt), { addSuffix: true })}
          </span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs max-w-[280px] space-y-1 p-3">
        <p className="font-semibold">Unified ReplitDailyUpload</p>
        <p className="text-muted-foreground">
          Financials, Available Freight, and the Lane Work Queue all read from this single upload.
        </p>
        {data.fileName && <p className="text-muted-foreground">File: <span className="text-foreground">{data.fileName}</span></p>}
        <p className="text-muted-foreground">
          Rows: <span className="text-foreground">{data.factRowCount.toLocaleString()}</span>
          {" "}({data.movedRowCount.toLocaleString()} moved)
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
