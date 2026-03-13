import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Pencil, MapPin, Route, DollarSign, FileText, PhoneCall } from "lucide-react";
import type { Contact, Touchpoint } from "@shared/schema";

interface OrgChartProps {
  contacts: Contact[];
  touchpoints?: Touchpoint[];
  onEditContact: (contact: Contact) => void;
  onViewContact?: (contact: Contact) => void;
}

interface ContactNode {
  contact: Contact;
  children: ContactNode[];
}

function buildOrgTree(contacts: Contact[]): ContactNode[] {
  const contactMap = new Map<string, Contact>();
  const childrenMap = new Map<string, Contact[]>();

  contacts.forEach((contact) => {
    contactMap.set(contact.id, contact);
    if (contact.reportsToId) {
      const children = childrenMap.get(contact.reportsToId) || [];
      children.push(contact);
      childrenMap.set(contact.reportsToId, children);
    }
  });

  function buildNode(contact: Contact): ContactNode {
    const children = childrenMap.get(contact.id) || [];
    return {
      contact,
      children: children.map(buildNode),
    };
  }

  const roots = contacts.filter(
    (c) => !c.reportsToId || c.reportsToId === "none" || !contactMap.has(c.reportsToId)
  );

  return roots.map(buildNode);
}

function getLastTouchDays(tps: Touchpoint[]): number | null {
  if (tps.length === 0) return null;
  const latest = tps.reduce((a, b) => a.date > b.date ? a : b);
  const today = new Date();
  const d = new Date(latest.date + "T00:00:00");
  return Math.floor((today.getTime() - d.getTime()) / 86400000);
}

function recencyDot(daysSince: number | null) {
  if (daysSince === null) return { color: "bg-muted-foreground/30", title: "No touchpoints" };
  if (daysSince <= 7)  return { color: "bg-green-500", title: `Last touched ${daysSince}d ago` };
  if (daysSince <= 30) return { color: "bg-amber-500", title: `Last touched ${daysSince}d ago` };
  return { color: "bg-red-500", title: `Last touched ${daysSince}d ago` };
}

function countMonth(tps: Touchpoint[]) {
  const now = new Date();
  const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return tps.filter(t => t.date >= startStr).length;
}

interface ContactCardProps {
  contact: Contact;
  tps: Touchpoint[];
  onEdit: (contact: Contact) => void;
  onView?: (contact: Contact) => void;
  level: number;
}

function ContactCard({ contact, tps, onEdit, onView, level }: ContactCardProps) {
  const initials = contact.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const formattedSpend = contact.freightSpend
    ? `$${Number(contact.freightSpend).toLocaleString()}`
    : null;

  const baseConfig: Record<string, { label: string; className: string }> = {
    "1st":     { label: "1st Base", className: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400" },
    "2nd":     { label: "2nd Base", className: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400" },
    "3rd":     { label: "3rd Base", className: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400" },
    "homerun": { label: "Home Run", className: "bg-green-700 text-white dark:bg-green-800 dark:text-green-100" },
  };
  const baseKey = contact.relationshipBase
    ? Object.keys(baseConfig).find((k) => contact.relationshipBase?.toLowerCase().startsWith(k))
    : null;
  const base = baseKey ? baseConfig[baseKey] : null;

  const days = getLastTouchDays(tps);
  const dot = recencyDot(days);
  const monthCount = countMonth(tps);

  return (
    <Card
      className={`hover-elevate ${onView ? "cursor-pointer" : ""}`}
      data-testid={`card-org-contact-${contact.id}`}
      onClick={onView ? () => onView(contact) : undefined}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                {initials}
              </AvatarFallback>
            </Avatar>
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background ${dot.color}`}
              title={dot.title}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-medium truncate" data-testid={`text-contact-name-${contact.id}`}>
                    {contact.name}
                  </h4>
                  {base && (
                    <Badge className={`text-[10px] px-1.5 py-0 shrink-0 ${base.className}`} data-testid={`badge-base-${contact.id}`}>
                      {base.label}
                    </Badge>
                  )}
                </div>
                {contact.title && (
                  <p className="text-sm text-muted-foreground truncate">
                    {contact.title}
                  </p>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); onEdit(contact); }}
                className="shrink-0"
                data-testid={`button-edit-contact-${contact.id}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </div>

            {monthCount > 0 && (
              <div className="mt-1 flex items-center gap-1.5">
                <PhoneCall className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{monthCount} touch{monthCount !== 1 ? "es" : ""} this month</span>
              </div>
            )}

            <div className="mt-3 space-y-2">
              {contact.regions && contact.regions.length > 0 && (
                <div className="flex items-start gap-2">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {contact.regions.map((region, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">
                        {region}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {contact.lanes && contact.lanes.length > 0 && (
                <div className="flex items-start gap-2">
                  <Route className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex flex-wrap gap-1">
                    {contact.lanes.map((lane, i) => (
                      <Badge key={i} variant="outline" className="text-xs">
                        {lane}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {formattedSpend && (
                <div className="flex items-center gap-2">
                  <DollarSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium">{formattedSpend}</span>
                  <span className="text-xs text-muted-foreground">/ year</span>
                </div>
              )}

              {contact.spotBiddingProcess && (
                <div className="flex items-start gap-2">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {contact.spotBiddingProcess}
                  </p>
                </div>
              )}
            </div>

            {(contact.email || contact.phone) && (
              <div className="mt-3 pt-3 border-t flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {contact.email && <span>{contact.email}</span>}
                {contact.phone && <span>{contact.phone}</span>}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface OrgNodeProps {
  node: ContactNode;
  tpMap: Map<string, Touchpoint[]>;
  onEdit: (contact: Contact) => void;
  onView?: (contact: Contact) => void;
  level: number;
}

function OrgNode({ node, tpMap, onEdit, onView, level }: OrgNodeProps) {
  const tps = tpMap.get(node.contact.id) ?? [];
  return (
    <div className="flex flex-col items-center">
      <div className="w-72">
        <ContactCard contact={node.contact} tps={tps} onEdit={onEdit} onView={onView} level={level} />
      </div>
      {node.children.length > 0 && (
        <>
          <div className="w-px h-6 bg-border" />
          <div className="relative flex justify-center">
            {node.children.length > 1 && (
              <div
                className="absolute top-0 h-px bg-border"
                style={{ left: "25%", right: "25%" }}
              />
            )}
            <div className="flex gap-8 pt-0">
              {node.children.map((child) => (
                <div key={child.contact.id} className="flex flex-col items-center">
                  <div className="w-px h-6 bg-border" />
                  <OrgNode node={child} tpMap={tpMap} onEdit={onEdit} onView={onView} level={level + 1} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function OrgChart({ contacts, touchpoints = [], onEditContact, onViewContact }: OrgChartProps) {
  const tree = useMemo(() => buildOrgTree(contacts), [contacts]);

  const tpMap = useMemo(() => {
    const map = new Map<string, Touchpoint[]>();
    for (const tp of touchpoints) {
      const arr = map.get(tp.contactId) ?? [];
      arr.push(tp);
      map.set(tp.contactId, arr);
    }
    return map;
  }, [touchpoints]);

  if (contacts.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto pb-4">
      <div className="inline-flex flex-col items-center gap-4 min-w-max p-4">
        {tree.map((node) => (
          <OrgNode key={node.contact.id} node={node} tpMap={tpMap} onEdit={onEditContact} onView={onViewContact} level={0} />
        ))}
      </div>
    </div>
  );
}
