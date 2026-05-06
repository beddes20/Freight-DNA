import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface QueryErrorProps {
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function QueryError({ message, onRetry, compact = false }: QueryErrorProps) {
  if (compact) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm"
        data-testid="query-error-compact"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <span>{message || "Something went wrong loading this section."}</span>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="btn-retry-compact"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center justify-center py-16 px-4 text-center"
      data-testid="query-error-full"
    >
      <div className="rounded-full bg-amber-500/10 p-4 mb-4">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
      </div>
      <h3 className="text-lg font-semibold mb-1">Something went wrong</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-4">
        {message || "We couldn't load this page. This is usually temporary — try refreshing."}
      </p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} data-testid="btn-retry-full">
          <RefreshCw className="h-4 w-4 mr-2" />
          Try Again
        </Button>
      )}
    </div>
  );
}
