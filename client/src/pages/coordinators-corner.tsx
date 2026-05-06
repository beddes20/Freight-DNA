import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  KeyRound, Search, Copy, Eye, EyeOff, ExternalLink, ShieldCheck,
  Building2, Mail, Phone, Truck, Clock, AlertCircle, ChevronDown, ChevronUp, User
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { Company, Contact } from "@shared/schema";

function useCopy() {
  const { toast } = useToast();
  return (value: string, label: string) => {
    navigator.clipboard.writeText(value).then(() => {
      toast({ description: `${label} copied to clipboard` });
    });
  };
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const copy = useCopy();
  return (
    <button
      onClick={() => copy(value, label)}
      className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
      title={`Copy ${label}`}
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

function PasswordField({ password }: { password: string }) {
  const [revealed, setRevealed] = useState(false);
  const copy = useCopy();
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-sm">{revealed ? password : "••••••••"}</span>
      <button
        onClick={() => setRevealed(v => !v)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title={revealed ? "Hide" : "Reveal"}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        onClick={() => copy(password, "Password")}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title="Copy password"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type CompanyWithOp = Company & { operatingHours?: string | null };

function CompanyCard({ company, contacts }: { company: CompanyWithOp; contacts: Contact[] }) {
  const [expanded, setExpanded] = useState(false);
  const copy = useCopy();

  const dispatchContacts = contacts.filter(c => c.phone || c.email);
  const hasCredentials = company.portalUrl || company.portalUsername || company.portalPassword;
  const hasSchedulingInfo = company.dlEmail || company.tenderStyle || company.operatingHours;
  const hasQuirks = company.accountQuirks;

  const badgeCount = (hasCredentials ? 1 : 0) + (hasSchedulingInfo ? 1 : 0) + dispatchContacts.length + (hasQuirks ? 1 : 0);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-3 px-4 flex flex-row items-center gap-3 cursor-pointer select-none" onClick={() => setExpanded(v => !v)}>
        <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          <Building2 className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <Link
            href={`/companies/${company.id}`}
            onClick={e => e.stopPropagation()}
            className="font-semibold text-sm hover:text-primary transition-colors truncate block"
            data-testid={`link-company-${company.id}`}
          >
            {company.name}
          </Link>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {hasCredentials && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-800">
                <KeyRound className="h-2.5 w-2.5 mr-0.5" /> Portal
              </Badge>
            )}
            {company.dlEmail && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800">
                <Mail className="h-2.5 w-2.5 mr-0.5" /> D/L Email
              </Badge>
            )}
            {company.tenderStyle && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-violet-600 dark:text-violet-400 border-violet-200 dark:border-violet-800">
                <Truck className="h-2.5 w-2.5 mr-0.5" /> {company.tenderStyle.length > 20 ? company.tenderStyle.slice(0, 20) + "…" : company.tenderStyle}
              </Badge>
            )}
            {company.operatingHours && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                <Clock className="h-2.5 w-2.5 mr-0.5" /> Hours on file
              </Badge>
            )}
            {dispatchContacts.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800">
                <User className="h-2.5 w-2.5 mr-0.5" /> {dispatchContacts.length} contact{dispatchContacts.length !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        </div>
        <button className="text-muted-foreground shrink-0" aria-label={expanded ? "Collapse" : "Expand"}>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </CardHeader>

      {expanded && (
        <CardContent className="px-4 pb-4 pt-0 space-y-4 border-t">

          {/* Scheduling Info */}
          {hasSchedulingInfo && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 mt-3">Scheduling Info</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {company.dlEmail && (
                  <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-muted/30">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">D/L Email</p>
                      <div className="flex items-center gap-1.5">
                        <a href={`mailto:${company.dlEmail}`} className="text-sm font-mono text-blue-600 dark:text-blue-400 hover:underline truncate">{company.dlEmail}</a>
                        <CopyButton value={company.dlEmail} label="D/L Email" />
                      </div>
                    </div>
                  </div>
                )}
                {company.tenderStyle && (
                  <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-muted/30">
                    <Truck className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Tendering Process</p>
                      <p className="text-sm">{company.tenderStyle}</p>
                    </div>
                  </div>
                )}
                {company.operatingHours && (
                  <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-muted/30 sm:col-span-2">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Operating Hours / Scheduling Windows</p>
                      <p className="text-sm">{company.operatingHours}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Dispatch Contacts */}
          {dispatchContacts.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Dispatch Contacts</p>
              <div className="space-y-1.5">
                {dispatchContacts.map(contact => (
                  <div key={contact.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 bg-muted/30" data-testid={`row-contact-${contact.id}`}>
                    <div className="flex items-center gap-1.5 min-w-[140px]">
                      <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium">{contact.name}</span>
                      {contact.title && <span className="text-xs text-muted-foreground">· {contact.title}</span>}
                    </div>
                    {contact.phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        <a href={`tel:${contact.phone}`} className="text-sm font-mono hover:text-primary transition-colors">{contact.phone}</a>
                        <CopyButton value={contact.phone} label="Phone" />
                      </div>
                    )}
                    {contact.email && (
                      <div className="flex items-center gap-1.5">
                        <Mail className="h-3 w-3 text-muted-foreground" />
                        <a href={`mailto:${contact.email}`} className="text-sm font-mono text-blue-600 dark:text-blue-400 hover:underline">{contact.email}</a>
                        <CopyButton value={contact.email} label="Email" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Portal Credentials */}
          {hasCredentials && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portal Credentials</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {company.portalUrl && (
                  <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-muted/30">
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Portal URL</p>
                      <a
                        href={company.portalUrl.startsWith("http") ? company.portalUrl : `https://${company.portalUrl}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate block"
                        title={company.portalUrl}
                        data-testid={`link-portal-${company.id}`}
                      >
                        {company.portalUrl.replace(/^https?:\/\//, "")}
                      </a>
                    </div>
                  </div>
                )}
                {company.portalUsername && (
                  <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-muted/30">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Username</p>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-mono">{company.portalUsername}</span>
                        <CopyButton value={company.portalUsername} label="Username" />
                      </div>
                    </div>
                  </div>
                )}
                {company.portalPassword && (
                  <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-muted/30">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Password</p>
                      <PasswordField password={company.portalPassword} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Account Quirks */}
          {hasQuirks && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Quirks</p>
              <div className="flex items-start gap-2 rounded-md border px-3 py-2 bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
                <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <p className="text-sm whitespace-pre-wrap text-amber-900 dark:text-amber-200">{company.accountQuirks}</p>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function CoordinatorsCornerPage() {
  const [search, setSearch] = useState("");

  const { data: allCompanies = [], isLoading: companiesLoading } = useQuery<CompanyWithOp[]>({
    queryKey: ["/api/companies"],
  });

  const { data: allContacts = [], isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const isLoading = companiesLoading || contactsLoading;

  // Build a map of companyId → contacts with phone or email
  const contactsByCompany = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of allContacts) {
      if (!c.phone && !c.email) continue;
      if (!map.has(c.companyId)) map.set(c.companyId, []);
      map.get(c.companyId)!.push(c);
    }
    return map;
  }, [allContacts]);

  // Only show companies that have at least one coordinator-relevant field
  const relevantCompanies = useMemo(() => {
    return allCompanies.filter(c => {
      const hasPortal = c.portalUrl || c.portalUsername || c.portalPassword;
      const hasScheduling = c.dlEmail || c.tenderStyle || (c as any).operatingHours;
      const hasContacts = (contactsByCompany.get(c.id)?.length ?? 0) > 0;
      const hasQuirks = c.accountQuirks;
      return hasPortal || hasScheduling || hasContacts || hasQuirks;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [allCompanies, contactsByCompany]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return relevantCompanies;
    return relevantCompanies.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true;
      if ((c.dlEmail ?? "").toLowerCase().includes(q)) return true;
      if ((c.tenderStyle ?? "").toLowerCase().includes(q)) return true;
      if (((c as any).operatingHours ?? "").toLowerCase().includes(q)) return true;
      if ((c.portalUrl ?? "").toLowerCase().includes(q)) return true;
      if ((c.portalUsername ?? "").toLowerCase().includes(q)) return true;
      const contacts = contactsByCompany.get(c.id) ?? [];
      return contacts.some(ct =>
        ct.name.toLowerCase().includes(q) ||
        (ct.phone ?? "").includes(q) ||
        (ct.email ?? "").toLowerCase().includes(q) ||
        (ct.title ?? "").toLowerCase().includes(q)
      );
    });
  }, [relevantCompanies, search, contactsByCompany]);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center border border-amber-500/20 shrink-0">
          <KeyRound className="h-5 w-5 text-amber-500" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Coordinators Corner</h1>
          <p className="text-sm text-muted-foreground">Scheduling contacts, portal credentials, and account info — all in one place</p>
        </div>
        <Badge variant="secondary" className="ml-auto shrink-0">
          {relevantCompanies.length} accounts
        </Badge>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by customer, contact, phone, email, or portal URL…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-coordinator"
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <ShieldCheck className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium text-muted-foreground">
                {search ? "No accounts match your search" : "No coordinator data on file"}
              </p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                {search
                  ? "Try a different search term."
                  : "Add portal credentials, D/L emails, operating hours, or contacts on each customer's detail page."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="list-coordinator-cards">
          {filtered.map(company => (
            <CompanyCard
              key={company.id}
              company={company}
              contacts={contactsByCompany.get(company.id) ?? []}
            />
          ))}
        </div>
      )}

      {filtered.length > 0 && search && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filtered.length} of {relevantCompanies.length} accounts
        </p>
      )}
    </div>
  );
}
