import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  UserPlus,
  Loader2,
  AlertCircle,
  Building2,
  Briefcase,
  Phone,
  Mail,
  ExternalLink,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface ZoomInfoContact {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  department: string | null;
  managementLevel: string | null;
  companyName: string | null;
  linkedInUrl: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companyName: string;
}

const MANAGEMENT_LEVEL_ORDER: Record<string, number> = {
  "C-Level": 1,
  "VP": 2,
  "Director": 3,
  "Manager": 4,
  "Individual Contributor": 5,
  "Non-Manager": 6,
};

function managementBadgeColor(level: string | null) {
  if (!level) return "secondary";
  if (level.includes("C-Level") || level.includes("Owner")) return "default";
  if (level.includes("VP") || level.includes("Vice President")) return "default";
  if (level.includes("Director")) return "secondary";
  return "outline";
}

export function ZoomInfoSuggestionsDialog({ open, onClose, companyId, companyName }: Props) {
  const { toast } = useToast();
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery<{ contacts: ZoomInfoContact[] }>({
    queryKey: ["/api/zoominfo/search-contacts", companyName],
    queryFn: () =>
      fetch(`/api/zoominfo/search-contacts?companyName=${encodeURIComponent(companyName)}`)
        .then((r) => {
          if (!r.ok) return r.json().then((e) => Promise.reject(e));
          return r.json();
        }),
    enabled: open && !!companyName,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const addContact = useMutation({
    mutationFn: (contact: ZoomInfoContact) =>
      apiRequest("POST", "/api/contacts", {
        companyId,
        name: `${contact.firstName} ${contact.lastName}`.trim(),
        title: contact.jobTitle || null,
        email: contact.email || null,
        phone: contact.phone || contact.mobilePhone || null,
        notes: contact.linkedInUrl ? `LinkedIn: ${contact.linkedInUrl}` : null,
      }),
    onSuccess: (_data, contact) => {
      setAddedIds((prev) => new Set(prev).add(contact.id));
      queryClient.invalidateQueries({ queryKey: [`/api/companies/${companyId}/contacts`] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact added", description: `${contact.firstName} ${contact.lastName} added to org chart` });
    },
    onError: () => {
      toast({ title: "Failed to add contact", variant: "destructive" });
    },
  });

  const contacts = (data?.contacts || []).sort((a, b) => {
    const aOrder = MANAGEMENT_LEVEL_ORDER[a.managementLevel || ""] ?? 99;
    const bOrder = MANAGEMENT_LEVEL_ORDER[b.managementLevel || ""] ?? 99;
    return aOrder - bOrder;
  });

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-amber-500" />
            <DialogTitle className="text-base">ZoomInfo Contact Suggestions</DialogTitle>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Freight buyer contacts found at <span className="font-medium text-foreground">{companyName}</span> — load planners, logistics &amp; transportation coordinators, shipping supervisors, and distribution managers
          </p>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-5 py-3">
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="h-7 w-7 animate-spin text-amber-500" />
              <p className="text-sm text-muted-foreground">Searching ZoomInfo database…</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <AlertCircle className="h-7 w-7 text-red-500" />
              <div>
                <p className="text-sm font-medium text-foreground">Search unavailable</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {(error as any)?.error || "ZoomInfo API returned an error. Your app may still be pending approval from ZoomInfo."}
                </p>
              </div>
            </div>
          )}

          {!isLoading && !error && contacts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <Building2 className="h-7 w-7 text-muted-foreground/50" />
              <div>
                <p className="text-sm font-medium">No contacts found</p>
                <p className="text-xs text-muted-foreground mt-1">
                  ZoomInfo returned no transportation contacts for this company name. Try checking the company name matches exactly.
                </p>
              </div>
            </div>
          )}

          {!isLoading && !error && contacts.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground mb-3">
                {contacts.length} contact{contacts.length !== 1 ? "s" : ""} found — sorted by seniority
              </p>
              {contacts.map((c) => {
                const isAdded = addedIds.has(c.id);
                const isExpanded = expandedId === c.id;
                const fullName = `${c.firstName} ${c.lastName}`.trim();
                return (
                  <div
                    key={c.id}
                    className={`border rounded-lg transition-colors ${isAdded ? "border-green-500/40 bg-green-50/40 dark:bg-green-950/20" : "border-border hover:border-amber-300/60"}`}
                    data-testid={`zoominfo-contact-${c.id}`}
                  >
                    <div className="flex items-start gap-3 p-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{fullName}</span>
                          {c.managementLevel && (
                            <Badge variant={managementBadgeColor(c.managementLevel)} className="text-[10px] px-1.5 py-0">
                              {c.managementLevel}
                            </Badge>
                          )}
                          {isAdded && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500 text-green-600">
                              <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> Added
                            </Badge>
                          )}
                        </div>
                        {c.jobTitle && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Briefcase className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="text-xs text-muted-foreground">{c.jobTitle}</span>
                          </div>
                        )}
                        {c.department && (
                          <span className="text-xs text-muted-foreground/70 mt-0.5 block">{c.department}</span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => setExpandedId(isExpanded ? null : c.id)}
                          data-testid={`button-expand-${c.id}`}
                          title="Show contact details"
                        >
                          {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          size="sm"
                          variant={isAdded ? "outline" : "default"}
                          className={`h-7 text-xs gap-1 ${isAdded ? "text-green-600 border-green-500" : "bg-amber-500 hover:bg-amber-600 text-black"}`}
                          onClick={() => !isAdded && addContact.mutate(c)}
                          disabled={isAdded || addContact.isPending}
                          data-testid={`button-add-zoominfo-${c.id}`}
                        >
                          {isAdded ? (
                            <><CheckCircle2 className="h-3 w-3" /> Added</>
                          ) : addContact.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <><UserPlus className="h-3 w-3" /> Add</>
                          )}
                        </Button>
                      </div>
                    </div>

                    {isExpanded && (
                      <>
                        <Separator />
                        <div className="px-3 py-2.5 grid grid-cols-1 gap-1.5">
                          {(c.email) && (
                            <div className="flex items-center gap-2 text-xs">
                              <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                              <a href={`mailto:${c.email}`} className="text-blue-600 hover:underline">{c.email}</a>
                            </div>
                          )}
                          {(c.phone || c.mobilePhone) && (
                            <div className="flex items-center gap-2 text-xs">
                              <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                              <span className="text-muted-foreground">{c.phone || c.mobilePhone}</span>
                            </div>
                          )}
                          {c.linkedInUrl && (
                            <div className="flex items-center gap-2 text-xs">
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                              <a
                                href={c.linkedInUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline truncate"
                              >
                                LinkedIn Profile
                              </a>
                            </div>
                          )}
                          {!c.email && !c.phone && !c.mobilePhone && !c.linkedInUrl && (
                            <p className="text-xs text-muted-foreground italic">No contact details available</p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-muted/30 shrink-0 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Data provided by <span className="font-medium">ZoomInfo</span> · Filtered to freight buyer roles only
          </p>
          <Button variant="outline" size="sm" onClick={onClose} data-testid="button-close-zoominfo-dialog">
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    {taskContact && (
      <TaskDialog
        open={!!taskContact}
        onOpenChange={(v) => { if (!v) setTaskContact(null); }}
        companyId={companyId}
        prefillData={{
          title: `Call and introduce yourself — ${taskContact.firstName} ${taskContact.lastName}`,
          notes: `New contact added via ZoomInfo.\n\n${taskContact.firstName} ${taskContact.lastName} is ${taskContact.jobTitle || "a new contact"} at ${companyName}. Reach out to introduce yourself and learn about their freight needs.${taskContact.email ? `\n\nEmail: ${taskContact.email}` : ""}${taskContact.phone || taskContact.mobilePhone ? `\nPhone: ${taskContact.phone || taskContact.mobilePhone}` : ""}`,
        }}
      />
    )}
    </>
  );
}
