import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone, Mail, MessageSquare, MapPin, ChevronDown, ChevronUp,
  ThumbsUp, ThumbsDown, Minus, Star, Activity,
} from "lucide-react";

type TodayTouchpoint = {
  id: string;
  contactId: string | null;
  companyId: string;
  type: string;
  date: string;
  notes: string | null;
  sentiment: string | null;
  isMeaningful: boolean | null;
  loggedById: string;
  createdAt: string;
  repName: string;
  companyName: string;
  contactName: string | null;
};

function typeIcon(type: string) {
  switch (type) {
    case "call": return <Phone className="h-3.5 w-3.5" />;
    case "email": return <Mail className="h-3.5 w-3.5" />;
    case "text": return <MessageSquare className="h-3.5 w-3.5" />;
    case "site_visit": return <MapPin className="h-3.5 w-3.5" />;
    default: return <Activity className="h-3.5 w-3.5" />;
  }
}

function typeLabel(type: string) {
  switch (type) {
    case "call": return "Call";
    case "email": return "Email";
    case "text": return "Text";
    case "site_visit": return "Site Visit";
    default: return type;
  }
}

function typeColors(type: string) {
  switch (type) {
    case "call": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "email": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300";
    case "text": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "site_visit": return "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300";
    default: return "bg-muted text-muted-foreground";
  }
}

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  if (sentiment === "positive") return (
    <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
      <ThumbsUp className="h-3 w-3" />
      Positive
    </span>
  );
  if (sentiment === "negative") return (
    <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
      <ThumbsDown className="h-3 w-3" />
      Negative
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium bg-muted text-muted-foreground">
      <Minus className="h-3 w-3" />
      Neutral
    </span>
  );
}

function formatTime(createdAt: string) {
  try {
    return new Date(createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function TouchpointRow({ tp }: { tp: TodayTouchpoint }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="border border-border rounded-lg overflow-hidden"
      data-testid={`touchpoint-today-row-${tp.id}`}
    >
      <button
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setExpanded(e => !e)}
        data-testid={`button-expand-touchpoint-${tp.id}`}
      >
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${typeColors(tp.type)}`}>
          {typeIcon(tp.type)}
          {typeLabel(tp.type)}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate" data-testid={`text-tp-rep-${tp.id}`}>
              {tp.repName}
            </span>
            <span className="text-xs text-muted-foreground">→</span>
            <span className="text-sm font-semibold truncate" data-testid={`text-tp-company-${tp.id}`}>
              {tp.companyName}
            </span>
            {tp.contactName && (
              <>
                <span className="text-xs text-muted-foreground">/</span>
                <span className="text-xs text-muted-foreground truncate" data-testid={`text-tp-contact-${tp.id}`}>
                  {tp.contactName}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <SentimentBadge sentiment={tp.sentiment} />
          {tp.isMeaningful && (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" data-testid={`badge-meaningful-${tp.id}`}>
              <Star className="h-3 w-3" />
            </span>
          )}
          <span className="text-xs text-muted-foreground" data-testid={`text-tp-time-${tp.id}`}>
            {formatTime(tp.createdAt)}
          </span>
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border bg-muted/20" data-testid={`touchpoint-today-detail-${tp.id}`}>
          <div className="flex flex-wrap gap-3 mb-2">
            {tp.isMeaningful && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                <Star className="h-3 w-3" />
                Marked Meaningful
              </span>
            )}
            <SentimentBadge sentiment={tp.sentiment} />
          </div>
          {tp.notes ? (
            <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-line" data-testid={`text-tp-notes-${tp.id}`}>
              {tp.notes}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic" data-testid={`text-tp-no-notes-${tp.id}`}>No notes recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

interface TouchpointsTodayPortletProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function TouchpointsTodayPortlet({ collapsed, onToggle }: TouchpointsTodayPortletProps) {
  const { data: touchpoints = [], isLoading, isError } = useQuery<TodayTouchpoint[]>({
    queryKey: ["/api/touchpoints/today"],
    refetchInterval: 120000,
  });

  return (
    <Card data-testid="portlet-touchpoints-today">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-touchpoints-today"
      >
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">
            Today's Touchpoints
          </span>
          {!isLoading && (
            <Badge variant="secondary" className="text-xs" data-testid="badge-touchpoints-today-count">
              {touchpoints.length}
            </Badge>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground" data-testid="error-touchpoints-today">
              <Activity className="h-8 w-8 opacity-30" />
              <p className="text-sm">Unable to load today's touchpoints.</p>
            </div>
          ) : touchpoints.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground" data-testid="empty-touchpoints-today">
              <Activity className="h-8 w-8 opacity-30" />
              <p className="text-sm">No touchpoints logged yet today.</p>
              <p className="text-xs opacity-70">Get out there and make some calls!</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="list-touchpoints-today">
              {touchpoints.map(tp => (
                <TouchpointRow key={tp.id} tp={tp} />
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
