import { Link } from "wouter";
import { Video } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useWebexConnectionStatus } from "@/hooks/use-webex";
import { cn } from "@/lib/utils";

interface WebexDisabledHintProps {
  className?: string;
  compact?: boolean;
  testId?: string;
}

export function WebexDisabledHint({ className, compact, testId }: WebexDisabledHintProps) {
  const { data, isLoading, isError } = useWebexConnectionStatus();
  const { user } = useAuth();

  // Don't surface a misleading "not connected" message while loading or if the
  // status check itself failed transiently — only render once we have data.
  if (isLoading || isError || !data) return null;
  const enabled = !!(data.configured && data.authorized);
  if (enabled) return null;

  const reason = !data.configured ? "Webex not connected" : "Webex not authorized";
  const isAdmin = user?.role === "admin";
  const adminLabel = isAdmin ? "Open connection settings" : "Ask an admin to enable";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] text-muted-foreground/80 italic",
        className,
      )}
      data-testid={testId ?? "hint-webex-disabled"}
      title={`${reason} — ${adminLabel}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Video className="h-3 w-3 opacity-60" />
      <span>{reason} —</span>
      {isAdmin ? (
        <Link
          href="/admin/users"
          className="underline underline-offset-2 hover:text-foreground"
          data-testid="link-webex-connection-card"
        >
          {compact ? "connect" : adminLabel}
        </Link>
      ) : (
        <span>ask an admin to enable</span>
      )}
    </span>
  );
}
