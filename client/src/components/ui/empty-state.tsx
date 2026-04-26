import { type LucideIcon, Inbox } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

type EmptyStateAction =
  | { label: string; onClick: () => void; href?: never; disabled?: boolean }
  | { label: string; href: string; onClick?: never; disabled?: never };

export interface EmptyStateProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: EmptyStateAction;
  compact?: boolean;
  className?: string;
  testId?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className = "",
  testId,
}: EmptyStateProps) {
  const wrapperPadding = compact ? "py-6" : "py-12";
  const iconSize = compact ? "h-6 w-6" : "h-8 w-8";
  const iconWrap = compact ? "p-2" : "p-3";

  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${wrapperPadding} px-4 ${className}`}
      data-testid={testId ?? "empty-state"}
    >
      <div className={`rounded-full bg-muted/40 ${iconWrap} mb-3`}>
        <Icon className={`${iconSize} text-muted-foreground`} />
      </div>
      {title && (
        <p className="text-sm font-semibold text-foreground" data-testid={testId ? `${testId}-title` : "empty-state-title"}>
          {title}
        </p>
      )}
      {description && (
        <p
          className="text-xs text-muted-foreground mt-1 max-w-sm"
          data-testid={testId ? `${testId}-description` : "empty-state-description"}
        >
          {description}
        </p>
      )}
      {action && (
        <div className="mt-4">
          {"href" in action && action.href ? (
            <Button asChild size="sm" variant="outline" data-testid={testId ? `${testId}-action` : "empty-state-action"}>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={action.onClick}
              disabled={action.disabled}
              data-testid={testId ? `${testId}-action` : "empty-state-action"}
            >
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
