import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Pencil,
  Trash2,
  Search,
  MapPin,
  Route,
  DollarSign,
  FileText,
  Mail,
  Phone,
  PhoneCall,
  ArrowRight,
  Send,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Contact, Touchpoint } from "@shared/schema";
import { OutlookComposeDialog } from "@/components/outlook-compose-dialog";

function countThisWeek(tps: Touchpoint[]) {
  const start = new Date();
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  const startStr = start.toISOString().split("T")[0];
  return tps.filter(t => t.date >= startStr).length;
}

function countThisMonth(tps: Touchpoint[]) {
  const now = new Date();
  const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return tps.filter(t => t.date >= startStr).length;
}

function getLastTouchDays(tps: Touchpoint[]): number | null {
  if (tps.length === 0) return null;
  const latest = tps.reduce((a, b) => a.date > b.date ? a : b);
  const today = new Date();
  const d = new Date(latest.date + "T00:00:00");
  return Math.floor((today.getTime() - d.getTime()) / 86400000);
}

function recencyBadgeClass(days: number | null) {
  if (days === null) return "bg-muted/60 text-muted-foreground";
  if (days <= 7)  return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (days <= 30) return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
}

interface ContactListProps {
  contacts: Contact[];
  companyId: string;
  touchpoints?: Touchpoint[];
  onEditContact: (contact: Contact) => void;
  onViewContact?: (contact: Contact) => void;
}

export function ContactList({ contacts, companyId, touchpoints = [], onEditContact, onViewContact }: ContactListProps) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [composeTarget, setComposeTarget] = useState<Contact | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (contactId: string) => {
      await apiRequest("DELETE", `/api/contacts/${contactId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact deleted successfully" });
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting contact", description: error.message, variant: "destructive" });
    },
  });

  const filteredContacts = contacts.filter((contact) =>
    contact.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.regions?.some((r) => r.toLowerCase().includes(searchQuery.toLowerCase())) ||
    contact.lanes?.some((l) => l.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const contactsMap = new Map(contacts.map((c) => [c.id, c]));
  const tpByContact = new Map<string, Touchpoint[]>();
  for (const tp of touchpoints) {
    if (!tp.contactId) continue;
    const arr = tpByContact.get(tp.contactId) ?? [];
    arr.push(tp);
    tpByContact.set(tp.contactId, arr);
  }

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-contacts"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {filteredContacts.map((contact) => {
          const initials = contact.name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();

          const manager = contact.reportsToId ? contactsMap.get(contact.reportsToId) : null;
          const cTps = tpByContact.get(contact.id) ?? [];
          const weekCount = countThisWeek(cTps);
          const monthCount = countThisMonth(cTps);
          const days = getLastTouchDays(cTps);
          const recClass = recencyBadgeClass(days);
          const dayLabel = days === null ? "No touch" : days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;

          return (
            <Card
              key={contact.id}
              data-testid={`card-contact-list-${contact.id}`}
              className={`group min-h-[140px]${onViewContact ? " cursor-pointer hover-elevate" : ""}`}
              onClick={onViewContact ? () => onViewContact(contact) : undefined}
            >
              <CardContent className="p-3">
                <div className="flex items-start gap-3">
                  <div className="relative shrink-0">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className="bg-primary/10 text-primary font-medium text-sm">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${days === null ? "bg-muted-foreground/30" : days <= 7 ? "bg-green-500" : days <= 30 ? "bg-amber-500" : "bg-red-500"}`}
                      title={dayLabel}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="font-semibold text-sm leading-tight truncate">{contact.name}</h4>
                        {contact.title && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5" title={contact.title}>
                            {contact.title}
                          </p>
                        )}
                        {manager && (
                          <p className="text-xs text-muted-foreground/70 mt-0.5">
                            Reports to: {manager.name}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium ${recClass}`}>
                            <PhoneCall className="h-2.5 w-2.5" />
                            {dayLabel}
                          </span>
                          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                            {weekCount} this week
                          </span>
                          <span className="text-[11px] text-muted-foreground">{monthCount} this month</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                        {contact.email && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={(e) => { e.stopPropagation(); setComposeTarget(contact); }}
                            title="Send email via Outlook"
                            data-testid={`button-email-contact-list-${contact.id}`}
                          >
                            <Send className="h-3.5 w-3.5 text-blue-500" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); onEditContact(contact); }}
                          data-testid={`button-edit-contact-list-${contact.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(contact); }}
                          data-testid={`button-delete-contact-${contact.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    <div className="mt-2 space-y-1.5">
                      {(contact.email || contact.phone) && (
                        <div className="space-y-1.5 min-w-0">
                          <div className="flex flex-wrap gap-3 text-xs min-w-0">
                            {contact.email && (
                              <a
                                href={`mailto:${contact.email}`}
                                onClick={e => e.stopPropagation()}
                                className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                              >
                                <Mail className="h-3 w-3" />
                                <span className="truncate">{contact.email}</span>
                              </a>
                            )}
                            {contact.phone && (
                              <a
                                href={`tel:${contact.phone}`}
                                onClick={e => e.stopPropagation()}
                                className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                              >
                                <Phone className="h-3 w-3" />
                                <span>{contact.phone}</span>
                              </a>
                            )}
                          </div>
                          {contact.email && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full gap-2 h-7 text-xs text-blue-600 border-blue-200 hover:bg-blue-50 hover:border-blue-400 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-950/40"
                              onClick={(e) => { e.stopPropagation(); setComposeTarget(contact); }}
                              data-testid={`button-send-email-card-${contact.id}`}
                            >
                              <Send className="h-3 w-3" />
                              Send Email
                            </Button>
                          )}
                        </div>
                      )}

                      {contact.regions && contact.regions.length > 0 && (
                        <div className="flex items-start gap-1.5 min-w-0">
                          <MapPin className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="flex flex-wrap gap-1 min-w-0 overflow-hidden">
                            {contact.regions.map((region, i) => (
                              <span key={i} className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-normal">
                                {region.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {contact.lanes && contact.lanes.length > 0 && (
                        <div className="flex items-start gap-1.5 min-w-0">
                          <Route className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="flex flex-wrap gap-1 min-w-0 overflow-hidden">
                            {contact.lanes.map((lane, i) => (
                              <span key={i} className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground font-normal border border-border/50">
                                {lane.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {contact.freightSpend && (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <DollarSign className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-xs font-medium">
                            ${Number(contact.freightSpend).toLocaleString()}
                          </span>
                          <span className="text-[11px] text-muted-foreground">annual freight spend</span>
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

                      {contact.nextSteps && (
                        <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-2 py-1.5">
                          <ArrowRight className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-0.5">Next Steps</p>
                            <p className="text-xs text-amber-800 dark:text-amber-300 line-clamp-2">{contact.nextSteps}</p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Completeness nudge */}
                    {(() => {
                      const issues: string[] = [];
                      if (!contact.email) issues.push("Missing email");
                      if (!contact.phone) issues.push("Missing phone");
                      if (days === null) issues.push("Never contacted");
                      if (issues.length === 0) return null;
                      return (
                        <div className="mt-2 flex items-center gap-1.5 flex-wrap pt-2 border-t border-border/60" onClick={e => e.stopPropagation()}>
                          <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                          {issues.map(issue => (
                            <span key={issue} className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                              {issue}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {filteredContacts.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <p className="text-sm">No contacts match your search</p>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteTarget?.name}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-contact">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-contact"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <OutlookComposeDialog
        open={!!composeTarget}
        onClose={() => setComposeTarget(null)}
        toEmail={composeTarget?.email || ""}
        toName={composeTarget?.name || ""}
        companyName=""
        contactId={composeTarget?.id}
        companyId={composeTarget?.companyId ?? undefined}
      />
    </div>
  );
}
