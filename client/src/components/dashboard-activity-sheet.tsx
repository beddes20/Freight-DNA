import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Phone, Mail, MessageSquare, Building2, Repeat2, UserPlus, Activity,
  MapPin, Star, ChevronRight,
} from "lucide-react";

export type PortletType = "relationships" | "touches" | "meaningful" | "contacts";

interface ActivePortlet {
  type: PortletType;
  personal: boolean;
  title: string;
  directorId?: string;
}

const TOUCH_TYPE_ICON: Record<string, React.ReactNode> = {
  call:       <Phone className="h-3.5 w-3.5" />,
  email:      <Mail className="h-3.5 w-3.5" />,
  text:       <MessageSquare className="h-3.5 w-3.5" />,
  site_visit: <MapPin className="h-3.5 w-3.5" />,
};
const TOUCH_TYPE_LABEL: Record<string, string> = {
  call: "Call", email: "Email", text: "Text", site_visit: "Site Visit",
};
const TOUCH_COLOR: Record<string, string> = {
  call:       "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  email:      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  text:       "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  site_visit: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

type RelRow    = { contactId: string; contactName: string; contactTitle: string | null; relationshipBase: string | null; baseAdvancedAt: string | null; companyId: string; companyName: string; repName: string | null };
type TouchRow  = { id: string; type: string; isMeaningful: boolean; notes: string | null; date: string; companyId: string; companyName: string; contactName: string | null; repName: string | null };
type ContactRow = { contactId: string; contactName: string; contactTitle: string | null; companyId: string; companyName: string; repName: string | null };

function RelationshipsList({ items }: { items: RelRow[] }) {
  if (!items.length) return <Empty text="No relationships moved up this month yet." />;
  return (
    <div className="divide-y divide-border">
      {items.map(item => (
        <div key={item.contactId} className="flex items-start gap-3 py-3 px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
            {item.contactName.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{item.contactName}</span>
              {item.relationshipBase && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 text-emerald-600 border-emerald-300">
                  {item.relationshipBase}
                </Badge>
              )}
            </div>
            {item.contactTitle && <p className="text-xs text-muted-foreground">{item.contactTitle}</p>}
            <Link href={`/companies/${item.companyId}`} className="text-xs text-primary hover:underline flex items-center gap-0.5 mt-0.5">
              <Building2 className="h-3 w-3" />{item.companyName}
            </Link>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
              {item.repName && <span>Rep: {item.repName}</span>}
              {item.baseAdvancedAt && <span>· {item.baseAdvancedAt}</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TouchesList({ items }: { items: TouchRow[] }) {
  if (!items.length) return <Empty text="No touches logged today yet." />;
  return (
    <div className="divide-y divide-border">
      {items.map(item => (
        <div key={item.id} className="flex items-start gap-3 py-3 px-4">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs ${TOUCH_COLOR[item.type] || "bg-muted text-muted-foreground"}`}>
            {TOUCH_TYPE_ICON[item.type] || <Activity className="h-3.5 w-3.5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{TOUCH_TYPE_LABEL[item.type] || item.type}</span>
              {item.isMeaningful && (
                <Badge className="text-xs px-1.5 py-0 h-4 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-0">
                  <Star className="h-2.5 w-2.5 mr-0.5" />Meaningful
                </Badge>
              )}
            </div>
            {item.contactName && <p className="text-xs text-muted-foreground">Contact: {item.contactName}</p>}
            <Link href={`/companies/${item.companyId}`} className="text-xs text-primary hover:underline flex items-center gap-0.5 mt-0.5">
              <Building2 className="h-3 w-3" />{item.companyName}
            </Link>
            {item.repName && <p className="text-xs text-muted-foreground mt-0.5">Rep: {item.repName}</p>}
            {item.notes && (
              <p className="text-xs text-muted-foreground mt-1 bg-muted/50 rounded px-2 py-1 line-clamp-2">
                {item.notes}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ContactsList({ items }: { items: ContactRow[] }) {
  if (!items.length) return <Empty text="No new contacts added today yet." />;
  return (
    <div className="divide-y divide-border">
      {items.map(item => (
        <div key={item.contactId} className="flex items-start gap-3 py-3 px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs font-bold">
            {item.contactName.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm">{item.contactName}</p>
            {item.contactTitle && <p className="text-xs text-muted-foreground">{item.contactTitle}</p>}
            <Link href={`/companies/${item.companyId}`} className="text-xs text-primary hover:underline flex items-center gap-0.5 mt-0.5">
              <Building2 className="h-3 w-3" />{item.companyName}
            </Link>
            {item.repName && <p className="text-xs text-muted-foreground mt-0.5">Rep: {item.repName}</p>}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center text-muted-foreground gap-2">
      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
        <Activity className="h-5 w-5" />
      </div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

const PORTLET_ICON: Record<PortletType, React.ReactNode> = {
  relationships: <Repeat2 className="h-4 w-4 text-emerald-500" />,
  meaningful:    <MessageSquare className="h-4 w-4 text-purple-500" />,
  contacts:      <UserPlus className="h-4 w-4 text-blue-500" />,
  touches:       <Activity className="h-4 w-4 text-amber-500" />,
};

interface Props {
  portlet: ActivePortlet | null;
  onClose: () => void;
  directorId?: string;
}

export function DashboardActivitySheet({ portlet, onClose, directorId }: Props) {
  const params = new URLSearchParams();
  if (portlet) {
    params.set("type", portlet.type);
    if (portlet.personal) params.set("personal", "true");
    if (directorId) params.set("directorId", directorId);
  }

  const { data, isLoading } = useQuery<any[]>({
    queryKey: ["/api/dashboard/activity-detail", portlet?.type, portlet?.personal, directorId],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard/activity-detail?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!portlet,
    staleTime: 60_000,
  });

  return (
    <Sheet open={!!portlet} onOpenChange={open => { if (!open) onClose(); }}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-4 py-4 border-b shrink-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            {portlet && PORTLET_ICON[portlet.type]}
            {portlet?.title}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex gap-3 items-start">
                  <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : portlet?.type === "relationships" ? (
            <RelationshipsList items={(data || []) as RelRow[]} />
          ) : portlet?.type === "touches" || portlet?.type === "meaningful" ? (
            <TouchesList items={(data || []) as TouchRow[]} />
          ) : portlet?.type === "contacts" ? (
            <ContactsList items={(data || []) as ContactRow[]} />
          ) : null}
        </div>
        {data && data.length > 0 && (
          <div className="px-4 py-2 border-t shrink-0 text-xs text-muted-foreground text-center">
            {data.length} {data.length === 1 ? "record" : "records"}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
