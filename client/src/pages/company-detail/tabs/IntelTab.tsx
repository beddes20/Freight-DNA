import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Globe, KeyRound, Eye, EyeOff, DollarSign, UserCheck, Pencil, Users,
  AlertCircle, FileText, Clock, Zap, Mail, ExternalLink, Trash2, Plus,
  ClipboardList, Copy, PhoneCall, MessageSquare, Building2,
  TruckIcon, CheckSquare, Square, CheckCircle2,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { FileAttachmentList, FileAttachmentUpload, uploadPendingFiles } from "@/components/file-attachment";
import type { PendingFile } from "@/components/file-attachment";
import { InfoTooltip } from "@/components/info-tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Company, Touchpoint, User, Rfp } from "@shared/schema";
import type { AccountPerf, SharedRepEntry, TouchLogEntry } from "../types";
import { CustomerEmailSignalsSection } from "./CustomerEmailSignalsSection";
import { IntelligenceCardsList } from "@/components/dna-copilot/intelligence-cards-list";

const ONBOARDING_MILESTONES = [
  { id: "kickoff_call", label: "Kickoff call completed" },
  { id: "system_access", label: "System access granted" },
  { id: "first_load", label: "First load covered" },
  { id: "rate_process_review", label: "Rate confirmation process reviewed" },
  { id: "primary_contact", label: "Primary contact confirmed" },
  { id: "routing_guide", label: "Routing guide / tender preferences documented" },
  { id: "thirty_day_checkin", label: "30-day check-in completed" },
];

function OnboardingMilestoneCard({ companyId, company }: { companyId: string; company: Company }) {
  const { toast } = useToast();
  const milestones: Record<string, boolean> = (company as any).onboardingMilestones ?? {};
  const completedCount = ONBOARDING_MILESTONES.filter(m => milestones[m.id]).length;
  const total = ONBOARDING_MILESTONES.length;
  const pct = Math.round((completedCount / total) * 100);

  const toggleMutation = useMutation({
    mutationFn: async ({ id, checked }: { id: string; checked: boolean }) => {
      return apiRequest("PATCH", `/api/companies/${companyId}/onboarding-milestones`, { milestoneId: id, completed: checked });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
    },
    onError: () => {
      toast({ title: "Failed to update milestone", variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-onboarding-milestones">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-green-600 dark:text-green-400" />
          Onboarding Milestones
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {completedCount}/{total} complete
          </span>
        </CardTitle>
        <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${pct === 100 ? "bg-green-500" : "bg-blue-500"}`}
            style={{ width: `${pct}%` }}
            data-testid="bar-onboarding-progress"
          />
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-1.5">
        {pct === 100 && (
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 font-medium mb-2">
            <CheckCircle2 className="h-3.5 w-3.5" /> Onboarding complete!
          </div>
        )}
        {ONBOARDING_MILESTONES.map(m => {
          const done = !!milestones[m.id];
          return (
            <button
              key={m.id}
              onClick={() => toggleMutation.mutate({ id: m.id, checked: !done })}
              disabled={toggleMutation.isPending}
              className="flex items-center gap-2.5 w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors disabled:opacity-60"
              data-testid={`button-milestone-${m.id}`}
            >
              {done
                ? <CheckSquare className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                : <Square className="h-4 w-4 text-muted-foreground shrink-0" />}
              <span className={`text-sm ${done ? "line-through text-muted-foreground" : ""}`}>{m.label}</span>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface IntelTabProps {
  company: Company;
  companyId: string;
  currentUser: Omit<User, "password"> | null | undefined;
  teamMembers: Omit<User, "password">[];
  companyRfps: Rfp[];
  accountPerf: AccountPerf;
  selectedTouchpoint: TouchLogEntry | null;
  setSelectedTouchpoint: (v: TouchLogEntry | null) => void;
}

export function IntelTab({
  company,
  companyId,
  currentUser,
  teamMembers,
  companyRfps,
  accountPerf,
  selectedTouchpoint,
  setSelectedTouchpoint,
}: IntelTabProps) {
  const { toast } = useToast();

  // ── Role checks ────────────────────────────────────────────────────────────
  const canEditSalesPerson = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales_director";
  // Mirrors the server-side guard on PATCH /api/companies/:id/owner.
  const canEditAccountOwner = canEditSalesPerson;
  const canManageSharedReps = currentUser?.role === "admin" || currentUser?.role === "national_account_manager";
  const canReassign = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales" || currentUser?.role === "sales_director";

  // ── Account Info form state ────────────────────────────────────────────────
  const [portalEdit, setPortalEdit] = useState(false);
  const [portalUrl, setPortalUrl] = useState("");
  const [portalUsername, setPortalUsername] = useState("");
  const [portalPassword, setPortalPassword] = useState("");
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [financialAliasEdit, setFinancialAliasEdit] = useState("");
  const [tenderStyle, setTenderStyle] = useState("");
  const [accountQuirks, setAccountQuirks] = useState("");
  const [processNotes, setProcessNotes] = useState("");
  const [handoffNotes, setHandoffNotes] = useState("");
  const [spotProcess, setSpotProcess] = useState("");
  const [dlEmail, setDlEmail] = useState("");
  const [operatingHours, setOperatingHours] = useState("");
  const [accountSummary, setAccountSummary] = useState("");
  const [salesPersonIdEdit, setSalesPersonIdEdit] = useState("");
  // Account Owner (canonical owner_rep_id on companies — drives email
  // ingestion fallback + Quote Requests Rep fallback). Edited via the
  // dedicated PATCH /api/companies/:id/owner endpoint (same RBAC).
  const [accountOwnerIdEdit, setAccountOwnerIdEdit] = useState("");

  // ── Shared Reps state ──────────────────────────────────────────────────────
  const [addSharedRepOpen, setAddSharedRepOpen] = useState(false);
  const [newSharedRepUserId, setNewSharedRepUserId] = useState("");
  const [newSharedRepNote, setNewSharedRepNote] = useState("");

  // ── Transfer state ─────────────────────────────────────────────────────────
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState("");

  // ── Wallet share / margin override ────────────────────────────────────────
  const [walletSharePct, setWalletSharePct] = useState(5);
  const [avgMarginOverride, setAvgMarginOverride] = useState("");

  // ── Scorecard upload state ────────────────────────────────────────────────
  const [scorecardPending, setScorecardPending] = useState<PendingFile[]>([]);
  const [scorecardUploading, setScorecardUploading] = useState(false);

  // Reset margin override when switching companies
  useEffect(() => { setAvgMarginOverride(""); }, [companyId]);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: sharedReps = [] } = useQuery<SharedRepEntry[]>({
    queryKey: ["/api/companies", companyId, "shared-reps"],
  });
  const { data: allSalesUsers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users/sales"],
  });
  const { data: allUsersForSales = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users"],
    enabled: canEditSalesPerson,
  });
  const { data: assignableUsers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users"],
    enabled: canReassign,
  });
  const salesUsers = allUsersForSales
    .filter(u => u.role === "sales" || u.role === "sales_director")
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Mutations ─────────────────────────────────────────────────────────────
  const savePortalMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/companies/${companyId}`, {
        name: company.name,
        portalUrl: portalUrl || null,
        portalUsername: portalUsername || null,
        portalPassword: portalPassword || null,
        financialAlias: financialAliasEdit.trim() || null,
        tenderStyle: tenderStyle || null,
        accountQuirks: accountQuirks || null,
        processNotes: processNotes || null,
        spotProcess: spotProcess || null,
        dlEmail: dlEmail || null,
        operatingHours: operatingHours || null,
        accountSummary: accountSummary.trim() || null,
        salesPersonId: salesPersonIdEdit || null,
        handoffNotes: handoffNotes.trim() || null,
      });
      // Account Owner is persisted via the dedicated /owner endpoint
      // (RBAC-gated server-side). Only fire when the value actually
      // changed to avoid noisy 403s for users without owner-edit perms.
      const currentOwner = (company as { ownerRepId?: string | null })?.ownerRepId ?? null;
      const nextOwner = accountOwnerIdEdit || null;
      if (canEditAccountOwner && currentOwner !== nextOwner) {
        await apiRequest("PATCH", `/api/companies/${companyId}/owner`, {
          ownerRepId: nextOwner,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      setPortalEdit(false);
      toast({ title: "Account info saved", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: () => toast({ title: "Failed to save account info", variant: "destructive" }),
  });

  const addSharedRepMutation = useMutation({
    mutationFn: async ({ userId, territoryNote }: { userId: string; territoryNote: string }) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/shared-reps`, { userId, territoryNote });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "shared-reps"] });
      setAddSharedRepOpen(false);
      setNewSharedRepUserId("");
      setNewSharedRepNote("");
      toast({ title: "Shared rep added" });
    },
    onError: () => toast({ title: "Failed to add shared rep", variant: "destructive" }),
  });

  const removeSharedRepMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("DELETE", `/api/companies/${companyId}/shared-reps/${userId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "shared-reps"] });
      toast({ title: "Shared rep removed" });
    },
    onError: () => toast({ title: "Failed to remove shared rep", variant: "destructive" }),
  });

  const reassignMutation = useMutation({
    mutationFn: async (assignedTo: string) => {
      await apiRequest("PATCH", `/api/companies/${companyId}/reassign`, { assignedTo });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      setTransferOpen(false);
      setTransferTo("");
      toast({ title: "Account transferred successfully", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: (e: any) => toast({ title: "Failed to transfer account", description: e.message, variant: "destructive" }),
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const openPortalEdit = () => {
    setPortalUrl(company?.portalUrl || "");
    setPortalUsername(company?.portalUsername || "");
    setPortalPassword(company?.portalPassword || "");
    setFinancialAliasEdit(company?.financialAlias || "");
    setTenderStyle(company?.tenderStyle || "");
    setAccountQuirks(company?.accountQuirks || "");
    setProcessNotes(company?.processNotes || "");
    setHandoffNotes(company?.handoffNotes || "");
    setSpotProcess(company?.spotProcess || "");
    setDlEmail(company?.dlEmail || "");
    setOperatingHours(company?.operatingHours || "");
    setAccountSummary(company?.accountSummary || "");
    setSalesPersonIdEdit(company?.salesPersonId || "");
    setAccountOwnerIdEdit((company as { ownerRepId?: string | null })?.ownerRepId || "");
    setPortalEdit(true);
  };

  return (
    <>
      {/* Task #912 — Copilot Fit & Intelligence Cards (most-recent few). */}
      <IntelligenceCardsList anchor={{ kind: "customer", companyId }} />

      {/* Account Information */}
      <Card data-testid="card-portal-info">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Account Information
            </CardTitle>
            {!portalEdit && (
              <Button variant="ghost" size="sm" onClick={openPortalEdit} data-testid="button-edit-portal">
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {portalEdit ? (
            <div className="space-y-4">
              {/* Portal Credentials Section */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portal Credentials</p>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Globe className="h-3 w-3" /> Portal URL</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="https://portal.example.com"
                      value={portalUrl}
                      onChange={e => setPortalUrl(e.target.value)}
                      data-testid="input-portal-url"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" /> Username</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="username"
                      value={portalUsername}
                      onChange={e => setPortalUsername(e.target.value)}
                      data-testid="input-portal-username"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><KeyRound className="h-3 w-3" /> Password</label>
                    <div className="relative">
                      <input
                        className="w-full border rounded-md px-3 py-1.5 pr-9 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        type={showPortalPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={portalPassword}
                        onChange={e => setPortalPassword(e.target.value)}
                        data-testid="input-portal-password"
                      />
                      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowPortalPassword(v => !v)} data-testid="button-toggle-password">
                        {showPortalPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><DollarSign className="h-3 w-3" /> Financial Name</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder={`Default: ${company!.name}`}
                      value={financialAliasEdit}
                      onChange={e => setFinancialAliasEdit(e.target.value)}
                      data-testid="input-financial-alias"
                    />
                    <p className="text-[11px] text-muted-foreground">Alternate name(s) used to match this account in financial data. Use commas to add multiple, e.g. <span className="font-mono">BROOGLA1, BROOGLAZ</span>. Leave blank to use the account name.</p>
                  </div>
                  {canEditSalesPerson && (
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <UserCheck className="h-3 w-3" /> Salesperson
                      </label>
                      <select
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        value={salesPersonIdEdit}
                        onChange={e => setSalesPersonIdEdit(e.target.value)}
                        data-testid="select-salesperson"
                      >
                        <option value="">— None —</option>
                        {salesUsers.map(u => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">Auto-populated from the Salesperson column in uploaded financial data. Override manually if needed.</p>
                    </div>
                  )}
                  {canEditAccountOwner && (
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <UserCheck className="h-3 w-3" /> Account Owner
                      </label>
                      <select
                        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        value={accountOwnerIdEdit}
                        onChange={e => setAccountOwnerIdEdit(e.target.value)}
                        data-testid="select-account-owner"
                      >
                        <option value="">— None —</option>
                        {assignableUsers
                          .slice()
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map(u => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                          ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">Default fallback owner for inbound emails and quote requests when no specific rep is matched. Used as the Rep on Quote Requests rows that aren't explicitly assigned.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Account Summary Section */}
              <div className="border-t pt-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Summary</p>
                <p className="text-xs text-muted-foreground mb-2">A brief snapshot of this account's current status, relationship, and strategic context.</p>
                <textarea
                  className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                  placeholder="e.g. Key account, good relationship with VP. Currently trialing us on Midwest lanes. RFP renewal in Q3 — position to expand."
                  value={accountSummary}
                  onChange={e => setAccountSummary(e.target.value)}
                  rows={3}
                  data-testid="input-account-summary"
                />
              </div>

              {/* Account Intelligence Section */}
              <div className="border-t pt-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Intelligence</p>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><TruckIcon className="h-3 w-3" /> Tendering Process</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="e.g. TMS portal, email, phone, EDI…"
                      value={tenderStyle}
                      onChange={e => setTenderStyle(e.target.value)}
                      data-testid="input-tender-style"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Zap className="h-3 w-3" /> Spot Process</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="e.g. Portal, Email…"
                      value={spotProcess}
                      onChange={e => setSpotProcess(e.target.value)}
                      data-testid="input-spot-process"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" /> D/L Email</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      type="email"
                      placeholder="dispatch@customer.com"
                      value={dlEmail}
                      onChange={e => setDlEmail(e.target.value)}
                      data-testid="input-dl-email"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Operating Hours / Scheduling Windows</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="e.g. Mon–Fri 6am–4pm, no weekend pickups…"
                      value={operatingHours}
                      onChange={e => setOperatingHours(e.target.value)}
                      data-testid="input-operating-hours"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Account Quirks</label>
                    <textarea
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      rows={3}
                      placeholder="Special requirements, sensitivities, things to know…"
                      value={accountQuirks}
                      onChange={e => setAccountQuirks(e.target.value)}
                      data-testid="input-account-quirks"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><FileText className="h-3 w-3" /> Process Notes</label>
                    <textarea
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      rows={3}
                      placeholder="Standard operating procedures, workflows, key steps…"
                      value={processNotes}
                      onChange={e => setProcessNotes(e.target.value)}
                      data-testid="input-process-notes"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" /> Rep Handoff Notes</label>
                    <textarea
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      rows={3}
                      placeholder="Notes for incoming reps: key relationships, history, landmines to avoid, key context…"
                      value={handoffNotes}
                      onChange={e => setHandoffNotes(e.target.value)}
                      data-testid="input-handoff-notes"
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={() => savePortalMutation.mutate()} disabled={savePortalMutation.isPending} data-testid="button-save-portal">
                  {savePortalMutation.isPending && <span className="mr-1 h-3 w-3 animate-spin rounded-full border-2 border-background border-t-transparent inline-block" />}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPortalEdit(false)} data-testid="button-cancel-portal">Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Portal Credentials */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portal Credentials</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Globe className="h-3 w-3" /> Portal URL</p>
                    {company.portalUrl ? (
                      <a href={company.portalUrl.startsWith("http") ? company.portalUrl : `https://${company.portalUrl}`} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1" data-testid="link-portal-url">
                        {company.portalUrl} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">Not set</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Users className="h-3 w-3" /> Username</p>
                    {company.portalUsername ? (
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-mono" data-testid="text-portal-username">{company.portalUsername}</p>
                        <CopyButton value={company.portalUsername} label="Username" data-testid="button-copy-portal-username" />
                      </div>
                    ) : (
                      <p className="text-sm font-mono" data-testid="text-portal-username"><span className="text-muted-foreground italic font-sans">Not set</span></p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><KeyRound className="h-3 w-3" /> Password</p>
                    {company.portalPassword ? (
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono" data-testid="text-portal-password">{showPortalPassword ? company.portalPassword : "••••••••"}</p>
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setShowPortalPassword(v => !v)} data-testid="button-reveal-password">
                          {showPortalPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                        <CopyButton value={company.portalPassword} label="Password" data-testid="button-copy-portal-password" />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">Not set</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><DollarSign className="h-3 w-3" /> Financial Name</p>
                    <p className="text-sm" data-testid="text-financial-alias">
                      {company.financialAlias ?? <span className="text-muted-foreground italic">{company.name} (default)</span>}
                    </p>
                  </div>
                  {(() => {
                    const spId = company.salesPersonId as string | null;
                    const spUser = allSalesUsers.find(u => u.id === spId) || [...assignableUsers, ...allUsersForSales].find(u => u.id === spId);
                    if (!spId && !canEditSalesPerson) return null;
                    return (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><UserCheck className="h-3 w-3" /> Salesperson</p>
                        <p className="text-sm" data-testid="text-salesperson">
                          {spUser ? spUser.name : <span className="text-muted-foreground italic">Not assigned</span>}
                        </p>
                      </div>
                    );
                  })()}
                  {(() => {
                    const ownerId = (company as { ownerRepId?: string | null }).ownerRepId ?? null;
                    const ownerUser = ownerId
                      ? (assignableUsers.find(u => u.id === ownerId)
                          || allUsersForSales.find(u => u.id === ownerId)
                          || allSalesUsers.find(u => u.id === ownerId))
                      : null;
                    if (!ownerId && !canEditAccountOwner) return null;
                    return (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><UserCheck className="h-3 w-3" /> Account Owner</p>
                        <p className="text-sm" data-testid="text-account-owner">
                          {ownerUser
                            ? ownerUser.name
                            : ownerId
                              ? <span className="text-muted-foreground italic">Assigned (user not in your view)</span>
                              : <span className="text-muted-foreground italic">Not assigned</span>}
                        </p>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Account Summary View */}
              {company.accountSummary && (
                <div className="border-t pt-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Summary</p>
                  <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap" data-testid="text-account-summary">{company.accountSummary}</p>
                </div>
              )}

              {/* Account Intelligence */}
              {(company.tenderStyle || company.spotProcess || company.dlEmail || company.operatingHours || company.accountQuirks || company.processNotes || company.handoffNotes) && (
                <div className="border-t pt-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Account Intelligence</p>
                  <div className="space-y-3">
                    {company.tenderStyle && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><TruckIcon className="h-3 w-3" /> Tendering Process</p>
                        <p className="text-sm" data-testid="text-tender-style">{company.tenderStyle}</p>
                      </div>
                    )}
                    {company.spotProcess && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Zap className="h-3 w-3" /> Spot Process</p>
                        <p className="text-sm" data-testid="text-spot-process">{company.spotProcess}</p>
                      </div>
                    )}
                    {company.dlEmail && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Mail className="h-3 w-3" /> D/L Email</p>
                        <div className="flex items-center gap-1.5">
                          <a href={`mailto:${company.dlEmail}`} className="text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="text-dl-email">{company.dlEmail}</a>
                          <CopyButton value={company.dlEmail} label="Email" data-testid="button-copy-dl-email" />
                        </div>
                      </div>
                    )}
                    {company.operatingHours && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Clock className="h-3 w-3" /> Operating Hours / Scheduling Windows</p>
                        <p className="text-sm" data-testid="text-operating-hours">{company.operatingHours}</p>
                      </div>
                    )}
                    {company.accountQuirks && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><AlertCircle className="h-3 w-3" /> Account Quirks</p>
                        <p className="text-sm whitespace-pre-wrap" data-testid="text-account-quirks">{company.accountQuirks}</p>
                      </div>
                    )}
                    {company.processNotes && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><FileText className="h-3 w-3" /> Process Notes</p>
                        <p className="text-sm whitespace-pre-wrap" data-testid="text-process-notes">{company.processNotes}</p>
                      </div>
                    )}
                    {company.handoffNotes && (
                      <div className="border border-amber-700/40 bg-amber-950/10 rounded-md px-3 py-2">
                        <p className="text-xs text-amber-500 flex items-center gap-1 mb-1 font-medium"><Users className="h-3 w-3" /> Rep Handoff Notes</p>
                        <p className="text-sm whitespace-pre-wrap text-amber-200/80" data-testid="text-handoff-notes">{company.handoffNotes}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Empty state nudge for intelligence section */}
              {!company.tenderStyle && !company.spotProcess && !company.dlEmail && !company.accountQuirks && !company.processNotes && !company.handoffNotes && (
                <div className="border-t pt-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Intelligence</p>
                  <p className="text-xs text-muted-foreground italic">No account intelligence captured yet. Click Edit to add tendering process, spot process, D/L email, quirks, and process notes.</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Onboarding Milestone Tracker */}
      <OnboardingMilestoneCard companyId={companyId} company={company} />

      {/* Shared Reps */}
      <Card data-testid="card-shared-reps">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              Shared Reps
            </CardTitle>
            {canManageSharedReps && (
              <Button variant="ghost" size="sm" onClick={() => setAddSharedRepOpen(true)} data-testid="button-add-shared-rep">
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Rep
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {sharedReps.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No shared reps on this account.{canManageSharedReps ? " Click \"Add Rep\" to grant another rep co-ownership." : ""}
            </p>
          ) : (
            <div className="space-y-2">
              {sharedReps.map(rep => (
                <div key={rep.userId} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2" data-testid={`row-shared-rep-${rep.userId}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <UserCheck className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
                    <span className="text-sm font-medium truncate" data-testid={`text-shared-rep-name-${rep.userId}`}>{rep.name}</span>
                    {rep.territoryNote && (
                      <span className="text-xs text-muted-foreground truncate">— {rep.territoryNote}</span>
                    )}
                  </div>
                  {canManageSharedReps && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => removeSharedRepMutation.mutate(rep.userId)}
                      disabled={removeSharedRepMutation.isPending}
                      data-testid={`button-remove-shared-rep-${rep.userId}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Customer Email Intelligence */}
      <CustomerEmailSignalsSection companyId={companyId} />

      {/* Add Shared Rep Dialog */}
      <Dialog open={addSharedRepOpen} onOpenChange={setAddSharedRepOpen}>
        <DialogContent data-testid="dialog-add-shared-rep">
          <DialogHeader>
            <DialogTitle>Add Shared Rep</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Rep</label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                value={newSharedRepUserId}
                onChange={e => setNewSharedRepUserId(e.target.value)}
                data-testid="select-shared-rep-user"
              >
                <option value="">— Select a rep —</option>
                {teamMembers.filter(u => !sharedReps.some(r => r.userId === u.id) && u.id !== company?.assignedTo).sort((a, b) => a.name.localeCompare(b.name)).map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role.replace(/_/g, " ")})</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Territory Note <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input
                className="w-full border rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="e.g. Laredo, All other, Southeast region"
                value={newSharedRepNote}
                onChange={e => setNewSharedRepNote(e.target.value)}
                data-testid="input-shared-rep-territory-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddSharedRepOpen(false)} data-testid="button-cancel-add-shared-rep">
              Cancel
            </Button>
            <Button
              onClick={() => addSharedRepMutation.mutate({ userId: newSharedRepUserId, territoryNote: newSharedRepNote })}
              disabled={!newSharedRepUserId || addSharedRepMutation.isPending}
              data-testid="button-confirm-add-shared-rep"
            >
              {addSharedRepMutation.isPending ? "Adding..." : "Add Rep"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Customer Scorecard */}
      <Card data-testid="card-customer-scorecard">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              Customer Scorecard
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <p className="text-xs text-muted-foreground">
            Upload scorecards, performance reviews, or any account-related documents.
          </p>
          <FileAttachmentList
            entityType="scorecard"
            entityIds={companyId ? [companyId] : []}
            showForEntityId={companyId}
          />
          <div className="space-y-2">
            <FileAttachmentUpload
              pendingFiles={scorecardPending}
              onAdd={(files) => setScorecardPending(prev => [...prev, ...files])}
              onRemove={(i) => setScorecardPending(prev => prev.filter((_, idx) => idx !== i))}
            />
            {scorecardPending.length > 0 && (
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={scorecardUploading}
                data-testid="button-upload-scorecard"
                onClick={async () => {
                  if (!companyId) return;
                  setScorecardUploading(true);
                  try {
                    await uploadPendingFiles(scorecardPending, "scorecard", companyId);
                    setScorecardPending([]);
                    queryClient.invalidateQueries({ queryKey: ["/api/attachments", "scorecard", companyId] });
                    toast({ title: "Scorecard uploaded" });
                  } catch {
                    toast({ title: "Upload failed", variant: "destructive" });
                  } finally {
                    setScorecardUploading(false);
                  }
                }}
              >
                {scorecardUploading ? "Uploading…" : `Save ${scorecardPending.length} file${scorecardPending.length !== 1 ? "s" : ""}`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Wallet Share Calculator */}
      {(() => {
        const ytd = accountPerf?.ytd;
        const hasFinancial = ytd && ytd.totalLoads > 0;
        const thisMonthBucket = accountPerf?.thisMonth;
        const lastMonthBucket = accountPerf?.lastMonth;
        const avgMarginPerLoad = hasFinancial
          ? (thisMonthBucket && thisMonthBucket.totalLoads > 0
              ? thisMonthBucket.totalMargin / thisMonthBucket.totalLoads
              : lastMonthBucket && lastMonthBucket.totalLoads > 0
                ? lastMonthBucket.totalMargin / lastMonthBucket.totalLoads
                : ytd.totalMargin / ytd.totalLoads)
          : null;
        const avgRevenuePerLoad = hasFinancial && (ytd.totalRevenue ?? 0) > 0 ? (ytd.totalRevenue ?? 0) / ytd.totalLoads : null;
        const rfpTotalVolume = companyRfps.reduce((sum, r) => {
          const vol = parseInt(String(r.totalVolume || "0"), 10);
          return sum + (isNaN(vol) ? 0 : vol);
        }, 0);
        const hasRfp = companyRfps.length > 0 && rfpTotalVolume > 0;
        const estimatedSpend = company.estimatedFreightSpend ? parseFloat(String(company.estimatedFreightSpend)) : null;
        const hasEstimate = !hasRfp && estimatedSpend && estimatedSpend > 0;
        const sliderPct = walletSharePct;
        const overrideVal = avgMarginOverride !== "" ? parseFloat(avgMarginOverride) : null;
        const effectiveAvgMargin = (overrideVal !== null && !isNaN(overrideVal)) ? overrideVal : (avgMarginPerLoad ?? 0);
        let additionalLoads = 0;
        let extraMarginDollars = 0;
        let currentSharePct: number | null = null;
        if (hasRfp && hasFinancial) {
          additionalLoads = Math.round(rfpTotalVolume * sliderPct / 100);
          extraMarginDollars = additionalLoads * effectiveAvgMargin;
          currentSharePct = ytd.totalLoads / rfpTotalVolume * 100;
        } else if (hasEstimate && hasFinancial && avgRevenuePerLoad) {
          additionalLoads = Math.round((estimatedSpend! * sliderPct / 100) / avgRevenuePerLoad);
          extraMarginDollars = additionalLoads * effectiveAvgMargin;
        }
        const showCalculator = (hasRfp || hasEstimate) && hasFinancial;
        return showCalculator ? (
          <Card data-testid="card-wallet-share-calculator">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-green-100 dark:bg-green-900/40">
                  <DollarSign className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-1">
                    <p className="text-sm font-semibold">Wallet Share Calculator</p>
                    <InfoTooltip
                      text={hasRfp
                        ? "Uses the total load volume from their RFPs and your current financial data to estimate how much more margin you'd earn by capturing additional percentage points of their freight."
                        : "Uses the estimated freight spend entered on this account to project how much more margin you could earn by winning a larger share of their business. Slide to see different scenarios."}
                      side="top"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {hasRfp ? `Based on ${rfpTotalVolume.toLocaleString()} loads across ${companyRfps.length} RFP${companyRfps.length !== 1 ? "s" : ""}` : `Based on $${estimatedSpend!.toLocaleString()} estimated freight spend`}
                  </p>
                </div>
              </div>
              {currentSharePct !== null && (
                <div className="mb-3 flex items-center gap-3">
                  <div className="text-xs text-muted-foreground shrink-0">Our current share:</div>
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${Math.min(currentSharePct, 100).toFixed(1)}%` }} />
                  </div>
                  <div className="text-xs font-medium shrink-0 w-14 text-right">{currentSharePct.toFixed(1)}%</div>
                </div>
              )}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">If we capture <span className="text-green-600 dark:text-green-400 font-bold">{sliderPct}%</span> more of their freight:</label>
                  <span className="text-xs text-muted-foreground">~{additionalLoads.toLocaleString()} loads</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={25}
                  value={sliderPct}
                  onChange={e => setWalletSharePct(parseInt(e.target.value))}
                  className="w-full accent-green-500"
                  data-testid="slider-wallet-share"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1%</span><span>5%</span><span>10%</span><span>15%</span><span>20%</span><span>25%</span>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200/60 dark:border-green-800/40 px-3 py-2">
                <div>
                  <p className="text-xs text-muted-foreground">Margin opportunity</p>
                  <p className="text-lg font-bold text-green-700 dark:text-green-400" data-testid="text-wallet-margin-opportunity">
                    ${extraMarginDollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">
                    Avg margin/load
                    {avgMarginOverride === "" && (
                      <span className="text-muted-foreground/60 ml-1">
                        ({thisMonthBucket && thisMonthBucket.totalLoads > 0
                          ? accountPerf?.thisMonthKey
                          : lastMonthBucket && lastMonthBucket.totalLoads > 0
                            ? accountPerf?.lastMonthKey
                            : "YTD"})
                      </span>
                    )}
                  </p>
                  <div className="flex items-center justify-end gap-0.5">
                    <span className="text-sm font-semibold">$</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={avgMarginOverride !== "" ? avgMarginOverride : (avgMarginPerLoad ?? 0).toFixed(0)}
                      onChange={e => setAvgMarginOverride(e.target.value)}
                      onBlur={e => { if (e.target.value === "" || isNaN(parseFloat(e.target.value))) setAvgMarginOverride(""); }}
                      className="w-16 text-sm font-semibold text-right bg-transparent border-b border-dashed border-muted-foreground/40 focus:outline-none focus:border-green-500 focus:border-solid"
                      data-testid="input-avg-margin-per-load"
                    />
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-3 text-xs gap-1.5"
                data-testid="button-wallet-copy-talking-point"
                onClick={() => {
                  const talkingPoint = hasRfp
                    ? `If ${company.name} gives us just ${sliderPct}% more of their freight, that's ~${additionalLoads.toLocaleString()} more loads and roughly $${extraMarginDollars.toLocaleString(undefined, { maximumFractionDigits: 0 })} in additional margin. Their RFP shows ${rfpTotalVolume.toLocaleString()} loads/yr total and we're currently at ${currentSharePct?.toFixed(1) ?? "0"}% share.`
                    : `If ${company.name} gives us just ${sliderPct}% more of their estimated $${estimatedSpend!.toLocaleString()} in freight spend, that's ~${additionalLoads.toLocaleString()} more loads and roughly $${extraMarginDollars.toLocaleString(undefined, { maximumFractionDigits: 0 })} in additional margin.`;
                  navigator.clipboard.writeText(talkingPoint);
                  toast({ title: "Talking point copied!", description: "Paste it into your next call prep or email." });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy as Talking Point
              </Button>
            </CardContent>
          </Card>
        ) : null;
      })()}

      {/* Touchpoint Detail Dialog */}
      {selectedTouchpoint && (() => {
        const tp = selectedTouchpoint;
        const VIBE_COLORS: Record<string, string> = {
          great:   "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
          neutral: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
          cold:    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
        };
        const TP_TYPE_ICONS: Record<string, typeof PhoneCall> = { call: PhoneCall, email: Mail, text: MessageSquare, site_visit: Building2 };
        const TP_TYPE_LABELS: Record<string, string> = { call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" };
        const TP_TYPE_COLORS: Record<string, string> = {
          call:       "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
          email:      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
          text:       "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
          site_visit: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        };
        const TypeIcon = TP_TYPE_ICONS[tp.type] ?? PhoneCall;
        const dateStr = (() => {
          try { return new Date(tp.createdAt || tp.date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
          catch { return tp.date; }
        })();
        const timeStr = (() => {
          try { const d = new Date(tp.createdAt); return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
          catch { return ""; }
        })();
        return (
          <Dialog open onOpenChange={() => setSelectedTouchpoint(null)}>
            <DialogContent className="max-w-md" data-testid="dialog-touchpoint-detail">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded font-medium ${TP_TYPE_COLORS[tp.type] ?? "bg-muted text-muted-foreground"}`}>
                    <TypeIcon className="h-4 w-4" />
                    {TP_TYPE_LABELS[tp.type] ?? tp.type}
                  </span>
                  Touchpoint Detail
                </DialogTitle>
              </DialogHeader>
              {(() => {
                const isEmail = tp.type === "email";
                let emailSubject = "";
                let emailTo = "";
                let emailBody = "";
                if (isEmail && tp.notes) {
                  const lines = tp.notes.split("\n");
                  const sl = lines.find(l => l.startsWith("Subject: "));
                  const tl = lines.find(l => l.startsWith("To: "));
                  if (sl) emailSubject = sl.replace("Subject: ", "");
                  if (tl) emailTo = tl.replace("To: ", "");
                  const bodyStart = lines.findIndex((l, i) => i > 0 && !l.startsWith("Subject: ") && !l.startsWith("To: ") && l.trim() !== "");
                  emailBody = bodyStart !== -1 ? lines.slice(bodyStart).join("\n").trim() : "";
                }
                return (
                  <div className="space-y-4 py-1">
                    {tp.contactName && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Contact</p>
                        <p className="text-sm font-medium" data-testid="tp-detail-contact">{tp.contactName}</p>
                      </div>
                    )}
                    {isEmail && emailSubject && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Subject</p>
                        <p className="text-sm font-semibold text-blue-700 dark:text-blue-300" data-testid="tp-detail-email-subject">{emailSubject}</p>
                      </div>
                    )}
                    {isEmail && emailTo && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">To</p>
                        <p className="text-sm text-blue-600 dark:text-blue-400" data-testid="tp-detail-email-to">{emailTo}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {tp.sentiment && (
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${VIBE_COLORS[tp.sentiment] ?? "bg-muted text-muted-foreground"}`} data-testid="tp-detail-vibe">
                          {tp.sentiment.charAt(0).toUpperCase() + tp.sentiment.slice(1)}
                        </span>
                      )}
                      {tp.isMeaningful && (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" data-testid="tp-detail-meaningful">
                          Meaningful
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Logged by</p>
                      <p className="text-sm" data-testid="tp-detail-logged-by">{tp.loggedByName}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Date &amp; Time</p>
                      <p className="text-sm" data-testid="tp-detail-date">{dateStr}{timeStr ? ` · ${timeStr}` : ""}</p>
                    </div>
                    {isEmail ? (
                      emailBody ? (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Email Body</p>
                          <p className="text-sm whitespace-pre-wrap leading-relaxed" data-testid="tp-detail-notes">{emailBody}</p>
                        </div>
                      ) : null
                    ) : tp.notes ? (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Notes</p>
                        <p className="text-sm whitespace-pre-wrap leading-relaxed" data-testid="tp-detail-notes">{tp.notes}</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Notes</p>
                        <p className="text-sm text-muted-foreground italic" data-testid="tp-detail-notes-empty">No notes recorded</p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* Transfer Account Dialog */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCheck className="h-5 w-5 text-blue-600" />
              Transfer Account
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">Select who should own <span className="font-medium text-foreground">{company.name}</span>:</p>
            <Select value={transferTo} onValueChange={setTransferTo}>
              <SelectTrigger data-testid="select-transfer-to">
                <SelectValue placeholder="Select a user..." />
              </SelectTrigger>
              <SelectContent>
                {[...assignableUsers].sort((a, b) => a.name.localeCompare(b.name)).map(u => (
                  <SelectItem key={u.id} value={u.id} data-testid={`option-transfer-${u.id}`}>
                    {u.name} ({u.role === "admin" ? "Admin" : u.role === "director" ? "Director" : u.role === "national_account_manager" ? "NAM" : u.role === "sales" ? "Sales" : "AM"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferOpen(false)}>Cancel</Button>
            <Button
              onClick={() => transferTo && reassignMutation.mutate(transferTo)}
              disabled={!transferTo || reassignMutation.isPending}
              data-testid="button-confirm-transfer"
            >
              {reassignMutation.isPending && <span className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-background border-t-transparent inline-block" />}
              Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
