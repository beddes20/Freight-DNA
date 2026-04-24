import { Inbox, UserCircle2, AlertCircle, Mail, Archive, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationBucket } from "./types";

interface BucketSidebarProps {
  bucket: ConversationBucket;
  onChange: (bucket: ConversationBucket) => void;
  counts: Partial<Record<ConversationBucket, number>>;
}

const BUCKETS: { id: ConversationBucket; label: string; icon: typeof Inbox; description: string }[] = [
  { id: "mine", label: "Waiting on me", icon: UserCircle2, description: "Threads I own that need a reply" },
  { id: "unowned", label: "Unassigned", icon: Inbox, description: "Threads with no owner yet" },
  { id: "quote_requests", label: "Quote requests", icon: DollarSign, description: "Threads where the customer is asking for pricing" },
  { id: "high_priority", label: "High priority", icon: AlertCircle, description: "Urgent waiting on us" },
  { id: "all", label: "All open", icon: Mail, description: "Everything except archived" },
  { id: "archived", label: "Archived", icon: Archive, description: "Resolved & archived threads" },
];

export function BucketSidebar({ bucket, onChange, counts }: BucketSidebarProps) {
  return (
    <nav className="flex flex-col gap-0.5 p-2" data-testid="bucket-sidebar">
      {BUCKETS.map(b => {
        const Icon = b.icon;
        const active = bucket === b.id;
        const count = counts[b.id];
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => onChange(b.id)}
            className={cn(
              "group flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors text-left w-full",
              active
                ? "bg-primary/10 text-primary font-medium"
                : "hover:bg-muted text-foreground"
            )}
            title={b.description}
            data-testid={`bucket-${b.id}`}
            aria-pressed={active}
          >
            <Icon className={cn("w-4 h-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
            <span className="flex-1 truncate">{b.label}</span>
            {typeof count === "number" && count > 0 && (
              <span className={cn(
                "text-xs px-1.5 py-0.5 rounded-full font-medium",
                active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              )} data-testid={`count-${b.id}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
