import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface State { hasError: boolean; message: string }

export class PortletErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  State
> {
  constructor(props: { children: React.ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message ?? "Unknown error" };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 px-4 py-3 text-sm"
          data-testid={`portlet-error-${this.props.label ?? "unknown"}`}
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <span>
              <span className="font-medium">{this.props.label ?? "This section"}</span> encountered an error and couldn't load.
            </span>
          </div>
          <button
            onClick={() => this.setState({ hasError: false, message: "" })}
            className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
