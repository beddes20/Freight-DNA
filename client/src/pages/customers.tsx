import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building2,
  Plus,
  Search,
  Users,
  Network,
  ChevronRight,
  AlertTriangle,
  Archive,
  ArchiveX,
  DollarSign,
  Truck,
  Phone,
  PhoneCall,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CompanyDialog } from "@/components/company-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Company, Contact } from "@shared/schema";

type AccountSummaryRow = {
  customerName: string;
  totalLoads: number;
  spotLoads: number;
  totalMargin: number;
  repName: string;
};

type TouchpointSummary = Record<string, { week: number; month: number }>;

function matchFinancials(name: string, rows: AccountSummaryRow[]): AccountSummaryRow | null {
  if (!rows.length) return null;
  const lower = name.toLowerCase();
  const exact = rows.find(r => r.customerName.toLowerCase() === lower);
  if (exact) return exact;
  const sub = name.length >= 5 ? rows.find(r =>
    r.customerName.toLowerCase().includes(lower) ||
    lower.includes(r.customerName.toLowerCase())
  ) : null;
  return sub || null;
}

export default function Customers() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [quickTouch, setQuickTouch] = useState<{ company: Company; contacts: Contact[] } | null>(null);
  const [quickTouchContactId, setQuickTouchContactId] = useState("");
  const [quickTouchType, setQuickTouchType] = useState("call");

  const logTouchMutation = useMutation({
    mutationFn: ({ contactId, type }: { contactId: string; type: string }) =>
      apiRequest("POST", `/api/contacts/${contactId}/touchpoints`, { type, date: new Date().toISOString().slice(0, 10), notes: "" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });
      toast({ title: "Touch logged!" });
      setQuickTouch(null);
      setQuickTouchContactId("");
      setQuickTouchType("call");
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: archivedCompanies, isLoading: archivedLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies", { includeArchived: true }],
    queryFn: async () => {
      const res = await fetch("/api/companies?includeArchived=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      const all: Company[] = await res.json();
      return all.filter(c => c.archivedAt);
    },
    enabled: showArchived,
  });

  const { data: allContacts } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: researchTasks } = useQuery<any[]>({
    queryKey: ["/api/research-tasks"],
  });

  const { data: accountSummary = [] } = useQuery<AccountSummaryRow[]>({
    queryKey: ["/api/financials/account-summary"],
  });

  const { data: tpSummary = {} } = useQuery<TouchpointSummary>({
    queryKey: ["/api/touchpoints/company-summary"],
  });

  const contactsByCompany = new Map<string, Contact[]>();
  allContacts?.forEach((c) => {
    const list = contactsByCompany.get(c.companyId) || [];
    list.push(c);
    contactsByCompany.set(c.companyId, list);
  });

  const openTasksByCompany = new Map<string, number>();
  researchTasks?.forEach((t) => {
    if (t.status === "open") {
      openTasksByCompany.set(t.companyId, (openTasksByCompany.get(t.companyId) || 0) + 1);
    }
  });

  const activeList = companies
    ?.filter((company) =>
      company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      company.industry?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const archivedList = archivedCompanies
    ?.filter((company) =>
      company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      company.industry?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const displayList = showArchived ? archivedList : activeList;
  const isLoading = showArchived ? archivedLoading : companiesLoading;

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-customers-title">
            {showArchived ? "Archived Accounts" : "Customers"}
          </h1>
          <p className="text-muted-foreground">
            {showArchived ? "Accounts that have been parked — click to view or restore" : "View customer org charts and manage contacts"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showArchived ? "default" : "outline"}
            onClick={() => setShowArchived(v => !v)}
            data-testid="button-toggle-archived"
          >
            {showArchived ? (
              <><ArchiveX className="h-4 w-4 mr-2" />Show Active</>
            ) : (
              <><Archive className="h-4 w-4 mr-2" />Archived</>
            )}
          </Button>
          {!showArchived && (
            <Button onClick={() => setDialogOpen(true)} data-testid="button-add-customer">
              <Plus className="h-4 w-4 mr-2" />
              Add Customer
            </Button>
          )}
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={showArchived ? "Search archived..." : "Search customers..."}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-customers"
        />
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-12 w-full mb-3" />
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : displayList && displayList.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {displayList.map((company) => {
            const contacts = contactsByCompany.get(company.id) || [];
            const openTasks = openTasksByCompany.get(company.id) || 0;
            const fin = (company.financialAlias ? matchFinancials(company.financialAlias, accountSummary) : null) || matchFinancials(company.name, accountSummary);
            const tps = tpSummary[company.id] || { week: 0, month: 0 };
            return (
              <Link key={company.id} href={`/companies/${company.id}`}>
                <Card className="hover-elevate cursor-pointer h-full" data-testid={`card-customer-${company.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${company.archivedAt ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                          {company.archivedAt ? <Archive className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium truncate" data-testid={`text-customer-name-${company.id}`}>
                              {company.name}
                            </h3>
                            {company.archivedAt && (
                              <Badge variant="secondary" className="text-xs shrink-0">Archived</Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground truncate">
                            {company.industry || "No industry specified"}
                          </p>
                        </div>
                      </div>
                      {contacts.length > 0 && !company.archivedAt && (
                        <button
                          className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                          title="Quick log touch"
                          data-testid={`button-quick-touch-${company.id}`}
                          onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setQuickTouch({ company, contacts });
                            setQuickTouchContactId(contacts[0]?.id ?? "");
                          }}
                        >
                          <PhoneCall className="h-4 w-4" />
                        </button>
                      )}
                      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                    </div>

                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Users className="h-3.5 w-3.5" />
                        <span>{contacts.length} contact{contacts.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Network className="h-3.5 w-3.5" />
                        <span>Org Chart</span>
                      </div>
                      {openTasks > 0 && !company.archivedAt && (
                        <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          {openTasks} lane{openTasks !== 1 ? "s" : ""} need research
                        </Badge>
                      )}
                      {company.archivedAt && (
                        <span className="text-xs text-muted-foreground">
                          Archived {new Date(company.archivedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    {!company.archivedAt && (
                      <div className="mt-3 pt-3 border-t flex items-center gap-4 flex-wrap">
                        {fin ? (
                          <>
                            <div className="flex items-center gap-1.5 text-xs" title="Total loads (financial data)">
                              <Truck className="h-3.5 w-3.5 text-blue-500" />
                              <span className="font-medium text-foreground">{fin.totalLoads.toLocaleString()}</span>
                              <span className="text-muted-foreground">loads</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-xs" title="Total margin (financial data)">
                              <DollarSign className="h-3.5 w-3.5 text-green-500" />
                              <span className="font-medium text-foreground">
                                {fin.totalMargin >= 1000
                                  ? `$${(fin.totalMargin / 1000).toFixed(1)}k`
                                  : `$${fin.totalMargin.toFixed(0)}`}
                              </span>
                              <span className="text-muted-foreground">margin</span>
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">No financial data</span>
                        )}
                        <div className="flex items-center gap-1.5 text-xs ml-auto" title="Touchpoints this week / this month">
                          <Phone className="h-3.5 w-3.5 text-violet-500" />
                          <span className="font-medium text-foreground">{tps.week}</span>
                          <span className="text-muted-foreground">/ {tps.month}</span>
                          <span className="text-muted-foreground">touches</span>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16">
          {showArchived ? (
            <>
              <Archive className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground text-center">No archived accounts</p>
              <p className="text-sm text-muted-foreground/70 text-center mt-1">
                Accounts you archive will appear here
              </p>
            </>
          ) : (
            <>
              <Building2 className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground text-center">
                {searchQuery ? "No customers match your search" : "No customers yet"}
              </p>
              {!searchQuery && (
                <Button className="mt-4" onClick={() => setDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add First Customer
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <CompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      <Dialog open={!!quickTouch} onOpenChange={open => { if (!open) setQuickTouch(null); }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-quick-touch">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-primary" />
              Log Touch — {quickTouch?.company.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Contact</label>
              <Select value={quickTouchContactId} onValueChange={setQuickTouchContactId}>
                <SelectTrigger data-testid="select-quick-touch-contact">
                  <SelectValue placeholder="Pick a contact" />
                </SelectTrigger>
                <SelectContent>
                  {(quickTouch?.contacts ?? []).map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.title ? ` · ${c.title}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Touch Type</label>
              <div className="flex gap-2">
                {[{ value: "call", label: "Call" }, { value: "email", label: "Email" }, { value: "text", label: "Text" }, { value: "site_visit", label: "Site Visit" }].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setQuickTouchType(opt.value)}
                    data-testid={`button-touch-type-${opt.value}`}
                    className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                      quickTouchType === opt.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setQuickTouch(null)} data-testid="button-cancel-quick-touch">Cancel</Button>
              <Button
                className="flex-1"
                disabled={!quickTouchContactId || logTouchMutation.isPending}
                onClick={() => logTouchMutation.mutate({ contactId: quickTouchContactId, type: quickTouchType })}
                data-testid="button-submit-quick-touch"
              >
                Log Touch
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
