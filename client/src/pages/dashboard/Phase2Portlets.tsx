/**
 * Phase 2 Dashboard Portlets — action-oriented weekly workflows for AMs.
 *
 * AccountsDriftingPortlet   — Unified attention list (stale + cold contacts + meaningful overdue)
 * RelationshipAdvancementPortlet — Contacts likely ready to move up a relationship base
 * GrowthCallsPortlet        — Top 3 growth calls worth making this week
 */

import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown, ChevronUp, ChevronRight,
  AlertCircle, TrendingUp, PhoneCall, ArrowRight,
  Handshake, Star,
} from "lucide-react";
import type { Contact, Company } from "@shared/schema";
import type { StaleAccount } from "./types";

// ─── Shared helpers ────────────────────────────────────────────────────────────

type ColdContactRow  = { contact: Contact; company: { id: string; name: string }; daysSince: number; lastType: string | null };
type MeaningfulRow   = { contact: Contact; company: { id: string; name: string }; daysSinceLastMeaningful: number };
type OppRow          = { companyId: string; companyName: string; potentialMargin: number; currentLoads: number; rfpVolume: number | null; hasRfp: boolean };

const BASE_LABEL: Record<string, string> = {
  "1st": "1st Base",
  "2nd": "2nd Base",
  "3rd": "3rd Base",
  "home_run": "Home Run",
};

const BASE_COLOR: Record<string, string> = {
  "1st": "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "2nd": "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "3rd": "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "home_run": "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

function fmtK(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

// ─── 1. Accounts Drifting ─────────────────────────────────────────────────────

interface DriftingSignal {
  label: string;
  urgencyScore: number;
  type: "stale" | "cold" | "meaningful";
}

interface DriftingRow {
  companyId: string;
  companyName: string;
  signals: DriftingSignal[];
  topScore: number;
}

interface AccountsDriftingProps {
  staleAccounts: StaleAccount[];
  coldContacts: ColdContactRow[];
  meaningfulOverdue: MeaningfulRow[];
  collapsed: boolean;
  onToggle: () => void;
}

export function AccountsDriftingPortlet({
  staleAccounts, coldContacts, meaningfulOverdue, collapsed, onToggle,
}: AccountsDriftingProps) {
  const [showAll, setShowAll] = useState(false);

  // ── Merge signals keyed by companyId ──
  const map = new Map<string, DriftingRow>();

  const ensure = (id: string, name: string) => {
    if (!map.has(id)) map.set(id, { companyId: id, companyName: name, signals: [], topScore: 0 });
    return map.get(id)!;
  };

  staleAccounts.forEach(a => {
    const row = ensure(a.id, a.name);
    const sig: DriftingSignal = { type: "stale", label: `No team touch in ${a.daysSince}d`, urgencyScore: a.daysSince };
    row.signals.push(sig);
    if (sig.urgencyScore > row.topScore) row.topScore = sig.urgencyScore;
  });

  coldContacts.forEach(({ contact, company, daysSince, lastType }) => {
    const row = ensure(company.id, company.name);
    const last = lastType ? `, last ${lastType}` : "";
    const sig: DriftingSignal = {
      type: "cold",
      label: `${contact.name} cold (${daysSince}d${last})`,
      urgencyScore: daysSince,
    };
    row.signals.push(sig);
    if (sig.urgencyScore > row.topScore) row.topScore = sig.urgencyScore;
  });

  meaningfulOverdue.forEach(({ contact, company, daysSinceLastMeaningful }) => {
    const row = ensure(company.id, company.name);
    // meaningful overdue is weighted slightly less than full cold
    const score = Math.round(daysSinceLastMeaningful * 0.85);
    const sig: DriftingSignal = {
      type: "meaningful",
      label: `${contact.name} — no meaningful touch in ${daysSinceLastMeaningful}d`,
      urgencyScore: score,
    };
    row.signals.push(sig);
    if (score > row.topScore) row.topScore = score;
  });

  const sorted = Array.from(map.values()).sort((a, b) => b.topScore - a.topScore);
  const preview = sorted.slice(0, 5);
  const visible = showAll ? sorted : preview;
  const hiddenCount = sorted.length - preview.length;

  const total = sorted.length;

  return (
    <Card data-testid="portlet-accounts-drifting">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-accounts-drifting"
      >
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-semibold">Accounts Drifting</span>
          {total > 0 && (
            <Badge className="text-xs px-1.5 bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 border-0">
              {total}
            </Badge>
          )}
        </div>
        {collapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {total === 0 ? (
            <p className="text-sm text-muted-foreground py-3">
              No drifting accounts — all contacts and accounts have recent touch activity.
            </p>
          ) : (
            <div className="flex flex-col divide-y" data-testid="accounts-drifting-list">
              {visible.map(row => (
                <div key={row.companyId} className="py-2.5">
                  <Link href={`/companies/${row.companyId}`} data-testid={`drifting-row-${row.companyId}`}>
                    <div className="flex items-center gap-2 group">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{row.companyName}</p>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                          {row.signals.slice(0, 3).map((sig, i) => (
                            <span key={i} className={`text-[10px] ${sig.type === "stale" ? "text-orange-600 dark:text-orange-400" : sig.type === "cold" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
                              {sig.label}
                            </span>
                          ))}
                          {row.signals.length > 3 && (
                            <span className="text-[10px] text-muted-foreground">+{row.signals.length - 3} more</span>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </Link>
                </div>
              ))}

              {(hiddenCount > 0 || showAll) && (
                <div className="pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs w-full"
                    onClick={(e) => { e.stopPropagation(); setShowAll(v => !v); }}
                    data-testid="button-drifting-show-all"
                  >
                    {showAll ? "Show fewer" : `Show ${hiddenCount} more account${hiddenCount !== 1 ? "s" : ""}`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ─── 2. Relationship Advancement Candidates ────────────────────────────────────

const BASE_ORDER: Record<string, number> = { "1st": 1, "2nd": 2, "3rd": 3 };

const NEXT_MOVE: Record<string, string> = {
  "1st": "Invite to a meaningful discovery or strategy conversation",
  "2nd": "Schedule a QBR or executive relationship call",
  "3rd": "Propose preferred carrier arrangement or exclusive lane partnership",
};

const NEXT_BASE_LABEL: Record<string, string> = {
  "1st": "2nd Base",
  "2nd": "3rd Base",
  "3rd": "Home Run",
};

interface RelationshipAdvancementProps {
  contacts: Contact[];
  companies: Company[];
  coldContacts: ColdContactRow[];
  meaningfulOverdue: MeaningfulRow[];
  collapsed: boolean;
  onToggle: () => void;
}

export function RelationshipAdvancementPortlet({
  contacts, companies, coldContacts, meaningfulOverdue, collapsed, onToggle,
}: RelationshipAdvancementProps) {
  const coldIds = new Set(coldContacts.map(c => c.contact.id));
  const meaningfulOverdueIds = new Set(meaningfulOverdue.map(m => m.contact.id));

  const companyMap = new Map(companies.map(c => [c.id, c.name]));

  const candidates = contacts
    .filter(c => {
      const base = c.relationshipBase;
      if (!base || base === "home_run") return false;
      // Must be warm — touched in last 30 days
      return !coldIds.has(c.id);
    })
    .map(c => {
      const base = c.relationshipBase!;
      const isEngaged = !meaningfulOverdueIds.has(c.id); // has recent meaningful touch
      const noNextStep = !c.nextSteps?.trim();
      const baseScore = BASE_ORDER[base] ?? 0;
      // Higher base = closer to home run = higher priority
      // Engaged contacts (with meaningful touch) score higher
      const score = baseScore * 10 + (isEngaged ? 5 : 0) + (noNextStep ? 2 : 0);

      const whyReady: string[] = [];
      if (isEngaged) whyReady.push("Recent meaningful conversation");
      else           whyReady.push("Warm — touched recently");
      if (noNextStep) whyReady.push("No next step logged — good time to define one");
      if (c.freightSpend && parseFloat(c.freightSpend) > 0) whyReady.push("Active freight spender");

      return {
        contactId: c.id,
        contactName: c.name,
        contactTitle: c.title ?? null,
        companyId: c.companyId,
        companyName: companyMap.get(c.companyId) ?? "",
        base,
        score,
        whyReady,
        nextMove: NEXT_MOVE[base] ?? "",
        nextBaseLabel: NEXT_BASE_LABEL[base] ?? "",
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <Card data-testid="portlet-relationship-advancement">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-relationship-advancement"
      >
        <div className="flex items-center gap-2">
          <Handshake className="h-4 w-4 text-purple-500" />
          <span className="text-sm font-semibold">Relationship Advancement</span>
          {candidates.length > 0 && (
            <Badge className="text-xs px-1.5 bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border-0">
              {candidates.length} ready to advance
            </Badge>
          )}
        </div>
        {collapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3">
              No warm contacts with a relationship base assigned. Start logging touches and assigning base levels to surface advancement candidates.
            </p>
          ) : (
            <div className="flex flex-col divide-y" data-testid="relationship-advancement-list">
              {candidates.map(c => (
                <div key={c.contactId} className="py-2.5" data-testid={`advancement-row-${c.contactId}`}>
                  <Link href={`/companies/${c.companyId}`}>
                    <div className="flex items-start gap-3 group">
                      <div className="flex-1 min-w-0">
                        {/* Contact + company */}
                        <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                          <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{c.contactName}</p>
                          {c.contactTitle && (
                            <span className="text-[10px] text-muted-foreground">· {c.contactTitle}</span>
                          )}
                          <span className="text-[10px] text-muted-foreground">@ {c.companyName}</span>
                        </div>

                        {/* Base + target */}
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${BASE_COLOR[c.base] ?? ""}`}>
                            {BASE_LABEL[c.base] ?? c.base}
                          </span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-[10px] font-semibold text-muted-foreground">{c.nextBaseLabel}</span>
                        </div>

                        {/* Why ready */}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          {c.whyReady.map((w, i) => (
                            <span key={i} className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                              <Star className="h-2.5 w-2.5" />{w}
                            </span>
                          ))}
                        </div>

                        {/* Next move */}
                        <p className="text-[10px] text-muted-foreground mt-0.5 italic">{c.nextMove}</p>
                      </div>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ─── 3. Growth Calls This Week ────────────────────────────────────────────────

interface GrowthCallsProps {
  opportunityLeaderboard: OppRow[];
  collapsed: boolean;
  onToggle: () => void;
}

function buildCta(opp: OppRow): string {
  if (opp.hasRfp && opp.rfpVolume && opp.rfpVolume > 0) {
    return `Active RFP (${fmtK(opp.rfpVolume)} volume) — follow up on pricing and lane positioning`;
  }
  if (opp.potentialMargin >= 50_000) {
    return `${fmtK(opp.potentialMargin)} margin opportunity — schedule a dedicated freight growth conversation`;
  }
  if (opp.potentialMargin >= 10_000) {
    return `${fmtK(opp.potentialMargin)} wallet share gap — ask about new lanes and shipment volume`;
  }
  return "Underpenetrated account — check in on shipping needs and open lanes";
}

export function GrowthCallsPortlet({ opportunityLeaderboard, collapsed, onToggle }: GrowthCallsProps) {
  const top3 = opportunityLeaderboard.slice(0, 3);

  return (
    <Card data-testid="portlet-growth-calls">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-growth-calls"
      >
        <div className="flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-green-500" />
          <span className="text-sm font-semibold">Top Growth Calls This Week</span>
          {top3.length > 0 && (
            <Badge className="text-xs px-1.5 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-0">
              {top3.length} accounts
            </Badge>
          )}
        </div>
        {collapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {top3.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3">
              No growth opportunities identified yet. Upload financial data or add RFP records to surface accounts worth calling this week.
            </p>
          ) : (
            <div className="flex flex-col gap-3" data-testid="growth-calls-list">
              {top3.map((opp, idx) => (
                <Link key={opp.companyId} href={`/companies/${opp.companyId}`} data-testid={`growth-call-${opp.companyId}`}>
                  <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 transition-colors px-3 py-2.5 group cursor-pointer">
                    {/* Rank */}
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-bold mt-0.5">
                      {idx + 1}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Company + potential */}
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">{opp.companyName}</p>
                        <div className="flex items-center gap-1 shrink-0">
                          {opp.hasRfp && (
                            <Badge className="text-[10px] px-1.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-0">
                              RFP
                            </Badge>
                          )}
                          <span className="text-xs font-semibold text-green-600 dark:text-green-400">
                            {fmtK(opp.potentialMargin)} potential
                          </span>
                        </div>
                      </div>

                      {/* CTA */}
                      <p className="text-xs text-muted-foreground leading-snug">{buildCta(opp)}</p>

                      {/* Supporting detail */}
                      {opp.currentLoads > 0 && (
                        <div className="flex items-center gap-1 mt-1">
                          <TrendingUp className="h-3 w-3 text-muted-foreground" />
                          <span className="text-[10px] text-muted-foreground">{opp.currentLoads} loads YTD</span>
                        </div>
                      )}
                    </div>

                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
