import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Kanban, Building2, BarChart2, Settings, AlertCircle, Inbox } from "lucide-react";
import type { ProspectStage } from "@shared/schema";
import {
  PROSPECT_STAGE_LABELS, PROSPECT_LEAD_SOURCES, PROSPECT_LEAD_SOURCE_LABELS,
} from "@shared/schema";
import { useLocation, useSearch } from "wouter";
import { ExecAnalyticsDashboard, RepPersonalAnalytics } from "@/components/exec-analytics";

import { ACTIVE_STAGES, type EnrichedProspect, type LaunchpadTab } from "./prospects/types";
import { PipelineSection } from "./prospects/components/PipelineSection";
import { AccountsSection } from "./prospects/components/AccountsSection";
import { RoutingSection } from "./prospects/components/RoutingSection";
import { ProspectFormDialog } from "./prospects/components/ProspectFormDialog";
import { ImportDialog } from "./prospects/components/ImportDialog";
import { OwnershipRequestsAdminPanel } from "./prospects/components/OwnershipRequestsAdminPanel";
import { CrmSettingsDialog } from "./prospects/components/CrmSettingsDialog";
import { ProspectDetailSheet } from "./prospects/components/ProspectDetailSheet";

const PROSPECTS_ALLOWED_ROLES = ["admin", "sales", "sales_director"];

export default function ProspectsPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const params = new URLSearchParams(searchStr);

  const isSalesDirectorOrAdmin = user?.role === "admin" || user?.role === "sales_director";
  const defaultTab: LaunchpadTab = isSalesDirectorOrAdmin ? "analytics" : "pipeline";
  const rawTab = params.get("tab") as LaunchpadTab | null;
  const isAdmin = user?.role === "admin";
  const activeTab: LaunchpadTab =
    rawTab === "pipeline" || rawTab === "accounts" || rawTab === "analytics"
      ? rawTab
      : rawTab === "routing" && isAdmin
        ? rawTab
        : defaultTab;

  const setTab = (tab: LaunchpadTab) => navigate(`/prospects?tab=${tab}`);

  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<EnrichedProspect | null>(null);
  const [adminOwnershipOpen, setAdminOwnershipOpen] = useState(false);
  const [crmSettingsOpen, setCrmSettingsOpen] = useState(false);

  const { data: prospects = [], isLoading } = useQuery<EnrichedProspect[]>({ queryKey: ["/api/prospects"] });
  const { data: allUsers = [] } = useQuery<any[]>({ queryKey: ["/api/users"] });
  const { data: oppsSummary = {} } = useQuery<Record<number, { openCount: number; closedWonCount: number; pipelineValue: number }>>({
    queryKey: ["/api/prospects/opportunities-summary"],
    queryFn: async () => {
      const res = await fetch("/api/prospects/opportunities-summary", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
  });
  const { data: crmSettings } = useQuery<any>({
    queryKey: ["/api/launchpad/crm-settings"],
    queryFn: async () => {
      const res = await fetch("/api/launchpad/crm-settings", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const activeStages: ProspectStage[] = useMemo(() => {
    if (crmSettings?.pipelineStages) {
      return crmSettings.pipelineStages
        .filter((s: any) => s.active !== false && s.key !== "lost" && s.key !== "disqualified")
        .map((s: any) => s.key as ProspectStage);
    }
    return ACTIVE_STAGES;
  }, [crmSettings]);

  const stageLabels: Record<string, string> = useMemo(() => {
    if (crmSettings?.pipelineStages) {
      const overrides: Record<string, string> = {};
      crmSettings.pipelineStages.forEach((s: any) => { overrides[s.key] = s.label; });
      return { ...PROSPECT_STAGE_LABELS, ...overrides };
    }
    return PROSPECT_STAGE_LABELS as Record<string, string>;
  }, [crmSettings]);

  const settingsLeadSources: Array<{ key: string; label: string }> = useMemo(() => {
    if (crmSettings?.leadSources) return crmSettings.leadSources.filter((s: any) => s.active !== false);
    return PROSPECT_LEAD_SOURCES.map(k => ({ key: k, label: PROSPECT_LEAD_SOURCE_LABELS[k] ?? k }));
  }, [crmSettings]);

  const staleThreshold: number = crmSettings?.staleThresholdDays ?? 14;
  const settingsRequiredFields: Record<string, boolean> = crmSettings?.requiredFields ?? {};

  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    prospects.forEach(p => { if (p.ownerId && p.ownerName) seen.set(p.ownerId, p.ownerName); });
    return Array.from(seen.entries());
  }, [prospects]);

  if (!user || !PROSPECTS_ALLOWED_ROLES.includes(user.role ?? "")) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="font-semibold">Access Restricted</p>
        <p className="text-sm text-muted-foreground">The sales pipeline is only accessible to sales team members.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Top tab bar ── */}
      <div className="flex items-center gap-0 border-b px-4 pt-3 bg-background" data-testid="launchpad-tab-bar">
        <div className="flex items-center gap-1 flex-1">
          <h1 className="text-base font-bold mr-4 text-foreground">Launchpad</h1>
          {((user?.role === "admin"
            ? ["pipeline", "accounts", "routing", "analytics"]
            : ["pipeline", "accounts", "analytics"]) as LaunchpadTab[]).map(tab => {
            const icons = { pipeline: Kanban, accounts: Building2, routing: Inbox, analytics: BarChart2 };
            const labels = { pipeline: "Pipeline", accounts: "Accounts", routing: "Needs Routing", analytics: "Analytics" };
            const Icon = icons[tab];
            return (
              <button
                key={tab}
                onClick={() => setTab(tab)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  activeTab === tab
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                }`}
                data-testid={`tab-${tab}`}
              >
                <Icon className="h-3.5 w-3.5" />{labels[tab]}
              </button>
            );
          })}
        </div>
        {user.role === "admin" && (
          <button
            onClick={() => setAdminOwnershipOpen(true)}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors mb-1"
            data-testid="button-launchpad-settings"
            title="Account transfer requests"
          >
            <Settings className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ── Analytics Tab ── */}
      {activeTab === "analytics" && (
        <div className="flex-1 overflow-auto">
          {isSalesDirectorOrAdmin ? <ExecAnalyticsDashboard /> : <RepPersonalAnalytics />}
        </div>
      )}

      {/* ── Accounts Tab ── */}
      {activeTab === "accounts" && (
        <AccountsSection prospects={prospects} isLoading={isLoading} onSelectProspect={setSelected} />
      )}

      {/* ── Needs Routing Tab (Launchpad L1) ── */}
      {activeTab === "routing" && <RoutingSection />}

      {/* ── Pipeline Tab ── */}
      {activeTab === "pipeline" && (
        <PipelineSection
          prospects={prospects}
          isLoading={isLoading}
          oppsSummary={oppsSummary}
          activeStages={activeStages}
          stageLabels={stageLabels}
          staleThreshold={staleThreshold}
          settingsLeadSources={settingsLeadSources}
          ownerOptions={ownerOptions}
          isSalesDirectorOrAdmin={!!isSalesDirectorOrAdmin}
          userRole={user.role ?? ""}
          onAddAccount={() => setAddOpen(true)}
          onImport={() => setImportOpen(true)}
          onAdminOwnership={() => setAdminOwnershipOpen(true)}
          onCrmSettings={() => setCrmSettingsOpen(true)}
          onSelectProspect={setSelected}
        />
      )}

      {/* ── Top-level dialogs ── */}
      {addOpen && (
        <ProspectFormDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          currentUserId={user.id}
          users={allUsers}
          activeStages={activeStages}
          stageLabels={stageLabels}
          leadSources={settingsLeadSources}
          requiredFields={settingsRequiredFields}
        />
      )}
      {importOpen && <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />}
      {adminOwnershipOpen && (
        <OwnershipRequestsAdminPanel
          onClose={() => setAdminOwnershipOpen(false)}
          users={allUsers}
          prospects={prospects}
        />
      )}
      {crmSettingsOpen && (
        <CrmSettingsDialog
          onClose={() => setCrmSettingsOpen(false)}
          openOwnershipQueue={() => { setCrmSettingsOpen(false); setAdminOwnershipOpen(true); }}
        />
      )}
      {selected && (
        <ProspectDetailSheet
          prospect={selected}
          onClose={() => setSelected(null)}
          users={allUsers}
          currentUser={user}
          activeStages={activeStages}
          stageLabels={stageLabels}
          leadSources={settingsLeadSources}
          staleThreshold={staleThreshold}
          requiredFields={settingsRequiredFields}
        />
      )}
    </div>
  );
}
