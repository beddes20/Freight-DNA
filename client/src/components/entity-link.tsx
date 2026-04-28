import { type ReactNode, type MouseEvent, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Loader2, Building2, Truck, Map } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDetailDrawer, type DrawerKind } from "@/components/detail-drawer";

interface EntityLinkProps {
  kind: DrawerKind;
  id: string;
  name: string;
  children?: ReactNode;
  className?: string;
  fullPagePath?: string;
}

const KIND_ICON: Record<DrawerKind, ReactNode> = {
  customer: <Building2 className="h-3.5 w-3.5 text-muted-foreground" />,
  carrier:  <Truck    className="h-3.5 w-3.5 text-muted-foreground" />,
  lane:     <Map      className="h-3.5 w-3.5 text-muted-foreground" />,
};

function fullPath(kind: DrawerKind, id: string): string {
  switch (kind) {
    case "customer": return `/companies/${id}`;
    case "carrier":  return `/carrier-hub/${id}`;
    case "lane":     return `/lane-inbox?laneId=${encodeURIComponent(id)}`;
  }
}

interface PreviewData {
  title?: string;
  subtitle?: string;
  stats?: Array<{ label: string; value: string }>;
}

interface CompanyLite {
  id: string;
  name: string;
  city?: string | null;
  state?: string | null;
  industry?: string | null;
  tier?: string | null;
}

function previewFromCompany(c: CompanyLite | undefined, fallback: string): PreviewData {
  if (!c) return { title: fallback };
  const subtitle = [c.city, c.state].filter(Boolean).join(", ");
  const stats: PreviewData["stats"] = [];
  if (c.industry) stats.push({ label: "Industry", value: c.industry });
  if (c.tier) stats.push({ label: "Tier", value: c.tier });
  return { title: c.name, subtitle: subtitle || undefined, stats };
}

function PreviewBody({ kind, id, name }: { kind: DrawerKind; id: string; name: string }) {
  const endpoint = kind === "customer" ? `/api/companies/${id}` : null;

  const { data: raw, isLoading } = useQuery<CompanyLite>({
    queryKey: endpoint ? [endpoint] : ["__entity_preview_disabled__", kind, id],
    staleTime: 60_000,
    retry: false,
    enabled: Boolean(endpoint),
  });

  const data: PreviewData = endpoint
    ? previewFromCompany(raw, name)
    : { title: name };

  return (
    <div className="space-y-2" data-testid={`entity-preview-${kind}-${id}`}>
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {KIND_ICON[kind]}
        <span>{kind}</span>
      </div>
      <div className="text-sm font-semibold leading-tight">{data?.title ?? name}</div>
      {data?.subtitle && <div className="text-xs text-muted-foreground">{data.subtitle}</div>}
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      ) : data?.stats?.length ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-xs">
          {data.stats.map((s) => (
            <div key={s.label} className="contents">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="text-right font-medium tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="text-xs text-muted-foreground pt-1">
          Click to open the side panel.
        </div>
      )}
      <div className="text-[11px] text-muted-foreground pt-1 border-t">
        Click → side panel · Cmd-click → full page
      </div>
    </div>
  );
}

export function EntityLink({ kind, id, name, children, className, fullPagePath }: EntityLinkProps) {
  const drawer = useDetailDrawer();
  const [, navigate] = useLocation();
  const [hoverArmed, setHoverArmed] = useState(false);

  function handleClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      navigate(fullPagePath ?? fullPath(kind, id));
      return;
    }
    drawer.open({ kind, id, name, fullPagePath });
  }

  return (
    <HoverCard openDelay={400} closeDelay={120} onOpenChange={(o) => o && setHoverArmed(true)}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            "inline-flex items-center text-left underline-offset-2 hover:underline focus-visible:underline outline-none",
            "max-w-full truncate",
            className,
          )}
          data-testid={`entity-link-${kind}-${id}`}
          data-entity-kind={kind}
          data-entity-id={id}
        >
          {children ?? name}
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 p-3" sideOffset={6} data-testid={`entity-hovercard-${kind}-${id}`}>
        {hoverArmed ? <PreviewBody kind={kind} id={id} name={name} /> : null}
      </HoverCardContent>
    </HoverCard>
  );
}
