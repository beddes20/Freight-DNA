import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Brain, TrendingUp, TrendingDown, Users, Target, Shield, Handshake,
  ArrowRight, AlertTriangle, CheckCircle, Clock, Sparkles, BarChart3,
  Loader2, RefreshCw, Eye, ChevronDown, ChevronUp, UserPlus, Route,
  DollarSign, Crosshair, Swords, FileText, Lightbulb, X
} from "lucide-react";

export default function AIIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  const { data: dashboard, isLoading: dashLoading } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/dashboard"],
  });

  const { data: companiesData } = useQuery<any[]>({
    queryKey: ["/api/companies"],
  });
  const companies = companiesData || [];

  const { data: sentimentData, isLoading: sentimentLoading } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/sentiment", selectedCompany],
    enabled: !!selectedCompany,
  });

  const { data: coachingData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/coaching", selectedCompany],
    enabled: !!selectedCompany,
  });

  const { data: orgGapsData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/org-gaps", selectedCompany],
    enabled: !!selectedCompany,
  });

  const { data: crossSellData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/cross-sell", selectedCompany],
    enabled: !!selectedCompany,
  });

  const { data: competitiveData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/competitive", selectedCompany],
    queryFn: async () => {
      const url = selectedCompany ? `/api/ai-intelligence/competitive?companyId=${selectedCompany}` : "/api/ai-intelligence/competitive";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const { data: winLossData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/win-loss"],
  });

  const { data: followUpsData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/follow-ups", selectedCompany],
    queryFn: async () => {
      const url = selectedCompany ? `/api/ai-intelligence/follow-ups?companyId=${selectedCompany}` : "/api/ai-intelligence/follow-ups";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const { data: walletShareData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/wallet-share", selectedCompany],
    enabled: !!selectedCompany,
  });

  const { data: briefsData } = useQuery<any>({
    queryKey: ["/api/ai-intelligence/meeting-prep", selectedCompany],
    enabled: !!selectedCompany,
  });

  const genBriefMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/meeting-prep/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/meeting-prep", selectedCompany] });
      toast({ title: "Meeting brief generated" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genCoachingMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/coaching/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/coaching", selectedCompany] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/dashboard"] });
      toast({ title: "Coaching insights generated" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genOrgGapsMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/org-gaps/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/org-gaps", selectedCompany] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/dashboard"] });
      toast({ title: "Org chart analysis complete" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genCrossSellMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/cross-sell/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/cross-sell", selectedCompany] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/dashboard"] });
      toast({ title: "Cross-sell opportunities identified" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genCompetitiveMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/competitive/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/competitive"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/dashboard"] });
      toast({ title: "Competitive analysis complete" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genWinLossMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/win-loss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/win-loss"] });
      toast({ title: "Win/loss patterns analyzed" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genWalletShareMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/wallet-share/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/wallet-share", selectedCompany] });
      toast({ title: "Growth playbook generated" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genWarmIntrosMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/warm-intros/${selectedCompany}`),
    onSuccess: () => {
      toast({ title: "Warm intro paths identified" });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/org-gaps", selectedCompany] });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genLookAlikesMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/look-alikes/${selectedCompany}`),
    onSuccess: () => {
      toast({ title: "Look-alike accounts identified" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genBulkSentimentMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/sentiment-bulk/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/sentiment", selectedCompany] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/dashboard"] });
      toast({ title: "Sentiment analysis complete for all contacts" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const genBulkFollowUpsMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/ai-intelligence/follow-up-bulk/${selectedCompany}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/follow-ups", selectedCompany] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/dashboard"] });
      toast({ title: "Follow-up timing analysis complete" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const dismissGapMutation = useMutation({
    mutationFn: (gapId: string) => apiRequest("PATCH", `/api/ai-intelligence/org-gaps/${gapId}/dismiss`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/org-gaps", selectedCompany] }),
  });

  const dismissCompetitiveMutation = useMutation({
    mutationFn: (signalId: string) => apiRequest("PATCH", `/api/ai-intelligence/competitive/${signalId}/dismiss`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/competitive"] }),
  });

  const dismissCoachingMutation = useMutation({
    mutationFn: (insightId: string) => apiRequest("PATCH", `/api/ai-intelligence/coaching/${insightId}/dismiss`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/ai-intelligence/coaching", selectedCompany] }),
  });

  const toggleExpand = (id: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const priorityColor = (p: string) => {
    switch (p) {
      case "critical": return "destructive";
      case "high": return "default";
      case "moderate": return "secondary";
      default: return "outline";
    }
  };

  const severityColor = (s: string) => {
    switch (s) {
      case "critical": return "text-red-500";
      case "high": return "text-orange-500";
      case "moderate": return "text-yellow-500";
      default: return "text-gray-400";
    }
  };

  const isLeadership = user && ["admin", "sales_director", "director"].includes(user.role);

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4 md:space-y-6" data-testid="ai-intelligence-page">
      <div className="relative overflow-hidden rounded-xl px-6 py-5 text-white" style={{ background: "#0d0d0d", border: "1px solid #1f1f1f" }}>
        <div className="pointer-events-none absolute -top-10 -right-10 h-48 w-48 rounded-full" style={{ background: "rgba(255,180,0,0.04)" }} />
        <div className="pointer-events-none absolute -bottom-8 -right-4 h-32 w-32 rounded-full" style={{ background: "rgba(255,180,0,0.03)" }} />
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg md:text-xl font-bold flex items-center gap-2" data-testid="text-page-title">
              <Brain className="h-5 w-5 md:h-6 md:w-6" style={{ color: "#ffb400" }} />
              AI Intelligence Hub
            </h1>
            <p className="text-white/60 mt-1 text-xs md:text-sm">AI-powered insights to build better relationships and grow accounts</p>
          </div>
          <Select value={selectedCompany} onValueChange={setSelectedCompany}>
            <SelectTrigger className="w-full md:w-[280px] bg-white/10 border-white/20 text-white" data-testid="select-company">
              <SelectValue placeholder="Select an account..." />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c: any) => (
                <SelectItem key={c.id} value={c.id} data-testid={`select-company-${c.id}`}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {dashLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {(() => {
            const totalKPIs = (dashboard?.sentimentAlerts || 0) + (dashboard?.openOrgChartGaps || 0) + (dashboard?.crossSellOpportunities || 0) + (dashboard?.competitiveAlerts || 0) + (dashboard?.upcomingFollowUps || 0);
            if (totalKPIs === 0) {
              return (
                <div className="rounded-xl border border-dashed border-border p-6 text-center" data-testid="kpi-empty-state">
                  <Sparkles className="h-8 w-8 text-amber-400 mx-auto mb-3" />
                  <p className="text-sm font-medium">No insights generated yet</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">Select an account above and run any analysis to start generating AI-powered intelligence. Insights will appear here as alerts accumulate.</p>
                </div>
              );
            }
            return (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <KPICard icon={<TrendingDown className="h-5 w-5 text-red-500" />} label="Cooling Contacts" value={dashboard?.sentimentAlerts || 0} color="red" testId="kpi-cooling" />
                <KPICard icon={<Users className="h-5 w-5 text-orange-500" />} label="Org Chart Gaps" value={dashboard?.openOrgChartGaps || 0} color="orange" testId="kpi-org-gaps" />
                <KPICard icon={<Target className="h-5 w-5 text-green-500" />} label="Cross-Sell Opps" value={dashboard?.crossSellOpportunities || 0} color="green" testId="kpi-cross-sell" />
                <KPICard icon={<Shield className="h-5 w-5 text-purple-500" />} label="Competitive Alerts" value={dashboard?.competitiveAlerts || 0} color="purple" testId="kpi-competitive" />
                <KPICard icon={<Clock className="h-5 w-5 text-blue-500" />} label="Follow-Ups Due" value={dashboard?.upcomingFollowUps || 0} color="blue" testId="kpi-followups" />
              </div>
            );
          })()}

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="flex md:grid md:grid-cols-5 lg:grid-cols-10 w-full overflow-x-auto no-scrollbar" data-testid="tabs-intelligence">
              <TabsTrigger value="overview" className="flex-shrink-0" data-testid="tab-overview">Overview</TabsTrigger>
              <TabsTrigger value="meeting-prep" className="flex-shrink-0" data-testid="tab-meeting-prep">Meeting Prep</TabsTrigger>
              <TabsTrigger value="sentiment" className="flex-shrink-0" data-testid="tab-sentiment">Sentiment</TabsTrigger>
              <TabsTrigger value="follow-ups" className="flex-shrink-0" data-testid="tab-follow-ups">Follow-Ups</TabsTrigger>
              <TabsTrigger value="coaching" className="flex-shrink-0" data-testid="tab-coaching">Coaching</TabsTrigger>
              <TabsTrigger value="org-gaps" className="flex-shrink-0" data-testid="tab-org-gaps">Org Gaps</TabsTrigger>
              <TabsTrigger value="cross-sell" className="flex-shrink-0" data-testid="tab-cross-sell">Cross-Sell</TabsTrigger>
              <TabsTrigger value="growth" className="flex-shrink-0" data-testid="tab-growth"><span className="md:hidden">Growth</span><span className="hidden md:inline">Growth Plays</span></TabsTrigger>
              <TabsTrigger value="competitive" className="flex-shrink-0" data-testid="tab-competitive">Competitive</TabsTrigger>
              <TabsTrigger value="win-loss" className="flex-shrink-0" data-testid="tab-win-loss">Win/Loss</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <OverviewCard
                  icon={<FileText className="h-5 w-5 text-blue-500" />}
                  title="Meeting Prep Briefs"
                  description="Generate AI-powered pre-meeting briefs with talking points, risk alerts, and opportunity highlights."
                  action={() => setActiveTab("meeting-prep")}
                  testId="overview-meeting-prep"
                />
                <OverviewCard
                  icon={<TrendingDown className="h-5 w-5 text-red-500" />}
                  title="Sentiment Tracking"
                  description="Monitor contact engagement patterns and detect cooling relationships before they become problems."
                  action={() => setActiveTab("sentiment")}
                  testId="overview-sentiment"
                />
                <OverviewCard
                  icon={<Clock className="h-5 w-5 text-blue-500" />}
                  title="Smart Follow-Up Timing"
                  description="AI learns optimal follow-up cadence per contact based on response patterns."
                  action={() => setActiveTab("follow-ups")}
                  testId="overview-follow-ups"
                />
                <OverviewCard
                  icon={<Lightbulb className="h-5 w-5 text-amber-500" />}
                  title="Relationship Coaching"
                  description="Per-account coaching insights combining sentiment, touchpoints, and org coverage."
                  action={() => setActiveTab("coaching")}
                  testId="overview-coaching"
                />
                <OverviewCard
                  icon={<Users className="h-5 w-5 text-orange-500" />}
                  title="Org Chart Gaps"
                  description="Find missing roles and untouched contacts in customer organizations."
                  action={() => setActiveTab("org-gaps")}
                  testId="overview-org-gaps"
                />
                <OverviewCard
                  icon={<Route className="h-5 w-5 text-green-500" />}
                  title="Cross-Sell Intelligence"
                  description="Discover lanes and services customers should be shipping but aren't."
                  action={() => setActiveTab("cross-sell")}
                  testId="overview-cross-sell"
                />
                <OverviewCard
                  icon={<DollarSign className="h-5 w-5 text-emerald-500" />}
                  title="Growth Playbooks"
                  description="AI-generated per-account growth plans with steps, contacts, and pricing."
                  action={() => setActiveTab("growth")}
                  testId="overview-growth"
                />
                <OverviewCard
                  icon={<Swords className="h-5 w-5 text-purple-500" />}
                  title="Competitive Intel"
                  description="Detect competitor mentions and switching risk from email analysis."
                  action={() => setActiveTab("competitive")}
                  testId="overview-competitive"
                />
                <OverviewCard
                  icon={<BarChart3 className="h-5 w-5 text-indigo-500" />}
                  title="Win/Loss Patterns"
                  description="Analyze RFP outcomes to find what predicts success."
                  action={() => setActiveTab("win-loss")}
                  testId="overview-win-loss"
                />
              </div>
            </TabsContent>

            <TabsContent value="meeting-prep" className="space-y-4 mt-4">
              {!selectedCompany ? <SelectAccountPrompt /> : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Meeting Prep Briefs</h2>
                    <Button onClick={() => genBriefMutation.mutate()} disabled={genBriefMutation.isPending} data-testid="btn-gen-brief">
                      {genBriefMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                      Generate Brief
                    </Button>
                  </div>
                  {briefsData?.briefs?.map((brief: any) => (
                    <Card key={brief.id} data-testid={`brief-card-${brief.id}`}>
                      <CardHeader className="pb-2 cursor-pointer" onClick={() => toggleExpand(brief.id)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base flex items-center gap-2">
                            <FileText className="h-4 w-4 text-blue-500" />
                            Meeting Brief — {new Date(brief.createdAt).toLocaleDateString()}
                          </CardTitle>
                          {expandedCards.has(brief.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </CardHeader>
                      {expandedCards.has(brief.id) && (
                        <CardContent className="space-y-4">
                          <div>
                            <h4 className="font-medium text-sm text-muted-foreground mb-1">Executive Summary</h4>
                            <p className="text-sm">{brief.briefContent?.executiveSummary}</p>
                          </div>
                          <div>
                            <h4 className="font-medium text-sm text-muted-foreground mb-1">Talking Points</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              {brief.briefContent?.keyTalkingPoints?.map((pt: string, i: number) => (
                                <li key={i} className="text-sm">{pt}</li>
                              ))}
                            </ul>
                          </div>
                          {brief.briefContent?.riskAlerts?.length > 0 && (
                            <div>
                              <h4 className="font-medium text-sm text-red-500 mb-1">Risk Alerts</h4>
                              <ul className="list-disc pl-5 space-y-1">
                                {brief.briefContent.riskAlerts.map((r: string, i: number) => (
                                  <li key={i} className="text-sm text-red-600 dark:text-red-400">{r}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {brief.briefContent?.opportunities?.length > 0 && (
                            <div>
                              <h4 className="font-medium text-sm text-green-500 mb-1">Opportunities</h4>
                              <ul className="list-disc pl-5 space-y-1">
                                {brief.briefContent.opportunities.map((o: string, i: number) => (
                                  <li key={i} className="text-sm text-green-600 dark:text-green-400">{o}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {brief.briefContent?.suggestedAgenda?.length > 0 && (
                            <div>
                              <h4 className="font-medium text-sm text-muted-foreground mb-1">Suggested Agenda</h4>
                              <ol className="list-decimal pl-5 space-y-1">
                                {brief.briefContent.suggestedAgenda.map((a: string, i: number) => (
                                  <li key={i} className="text-sm">{a}</li>
                                ))}
                              </ol>
                            </div>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  ))}
                  {!briefsData?.briefs?.length && <EmptyState message="No briefs yet. Select an account above and click 'Generate Brief' to create a pre-meeting one-pager with talking points, risk alerts, and opportunities." />}
                </div>
              )}
            </TabsContent>

            <TabsContent value="sentiment" className="space-y-4 mt-4">
              {!selectedCompany ? <SelectAccountPrompt /> : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Contact Sentiment</h2>
                    <Button onClick={() => genBulkSentimentMutation.mutate()} disabled={genBulkSentimentMutation.isPending} data-testid="btn-gen-sentiment">
                      {genBulkSentimentMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                      Analyze All Contacts
                    </Button>
                  </div>
                  {sentimentData?.sentiment?.length ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {sentimentData.sentiment.map((s: any) => (
                        <Card key={s.id} data-testid={`sentiment-card-${s.id}`}>
                          <CardContent className="pt-4">
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium text-sm" data-testid={`text-contact-name-${s.id}`}>{s.contactName || `Contact ${s.contactId?.substring(0, 8)}...`}</span>
                              <Badge variant={s.sentimentTrend === "cooling" ? "destructive" : s.sentimentTrend === "warming" ? "default" : "secondary"}>
                                {s.sentimentTrend === "warming" && <TrendingUp className="h-3 w-3 mr-1" />}
                                {s.sentimentTrend === "cooling" && <TrendingDown className="h-3 w-3 mr-1" />}
                                {s.sentimentTrend}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 mb-2">
                              <div className="flex-1 bg-muted rounded-full h-2">
                                <div className="h-2 rounded-full bg-blue-500" style={{ width: `${s.sentimentScore}%` }} />
                              </div>
                              <span className="text-sm font-mono">{s.sentimentScore}</span>
                            </div>
                            {Array.isArray(s.signals) && s.signals.map((sig: any, i: number) => (
                              <p key={i} className="text-xs text-muted-foreground">
                                {sig.type === "positive" ? "+" : sig.type === "negative" ? "-" : "~"} {sig.detail}
                              </p>
                            ))}
                            {s.createdAt && (
                              <p className="text-[10px] text-muted-foreground/50 mt-2" data-testid="text-sentiment-timestamp">
                                Analyzed {new Date(s.createdAt).toLocaleDateString()} at {new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </p>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <EmptyState message="No sentiment data yet. Click 'Analyze All Contacts' above to scan engagement patterns and detect cooling relationships before they become problems." />
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="follow-ups" className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Smart Follow-Up Recommendations</h2>
                {selectedCompany && (
                  <Button onClick={() => genBulkFollowUpsMutation.mutate()} disabled={genBulkFollowUpsMutation.isPending} data-testid="btn-gen-followups">
                    {genBulkFollowUpsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                    Analyze Timing
                  </Button>
                )}
              </div>
              {followUpsData?.recommendations?.length ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {followUpsData.recommendations.map((rec: any) => (
                    <Card key={rec.id} data-testid={`followup-card-${rec.id}`}>
                      <CardContent className="pt-4 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium" data-testid={`text-contact-name-${rec.id}`}>{rec.contactName || `Contact ${rec.contactId?.substring(0, 8)}...`}</span>
                          {rec.confidenceScore && <Badge variant="outline">{rec.confidenceScore}% conf</Badge>}
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div><span className="text-muted-foreground">Best Day:</span> <span className="font-medium">{rec.recommendedDay || "—"}</span></div>
                          <div><span className="text-muted-foreground">Time:</span> <span className="font-medium">{rec.recommendedTimeOfDay || "—"}</span></div>
                          <div><span className="text-muted-foreground">Cadence:</span> <span className="font-medium">{rec.optimalCadenceDays ? `${rec.optimalCadenceDays}d` : "—"}</span></div>
                          <div><span className="text-muted-foreground">Max Gap:</span> <span className="font-medium">{rec.maxSilenceDays ? `${rec.maxSilenceDays}d` : "—"}</span></div>
                        </div>
                        {rec.nextFollowUpDate && (
                          <div className="flex items-center gap-1 text-sm">
                            <Clock className="h-3 w-3 text-blue-500" />
                            <span>Next: <strong>{rec.nextFollowUpDate}</strong></span>
                          </div>
                        )}
                        {rec.reasoning && <p className="text-xs text-muted-foreground">{rec.reasoning}</p>}
                        {rec.createdAt && (
                          <p className="text-[10px] text-muted-foreground/50 mt-1" data-testid="text-followup-timestamp">
                            Analyzed {new Date(rec.createdAt).toLocaleDateString()} at {new Date(rec.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <EmptyState message="No follow-up timing data yet. Select an account above and click 'Analyze Timing' to learn the best day, time, and cadence for each contact." />
              )}
            </TabsContent>

            <TabsContent value="coaching" className="space-y-4 mt-4">
              {!selectedCompany ? <SelectAccountPrompt /> : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Relationship Coaching</h2>
                    <Button onClick={() => genCoachingMutation.mutate()} disabled={genCoachingMutation.isPending} data-testid="btn-gen-coaching">
                      {genCoachingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                      Generate Insights
                    </Button>
                  </div>
                  {coachingData?.insights?.map((insight: any) => (
                    <Card key={insight.id} data-testid={`coaching-card-${insight.id}`}>
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant={priorityColor(insight.priority)}>{insight.priority}</Badge>
                            <Badge variant="outline">{insight.insightType}</Badge>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => dismissCoachingMutation.mutate(insight.id)} data-testid={`btn-dismiss-coaching-${insight.id}`}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                        <h3 className="font-medium mb-1">{insight.title}</h3>
                        <p className="text-sm text-muted-foreground mb-2">{insight.description}</p>
                        {insight.suggestedAction && (
                          <div className="flex items-start gap-2 bg-blue-50 dark:bg-blue-950/30 p-3 rounded-lg">
                            <ArrowRight className="h-4 w-4 text-blue-500 mt-0.5" />
                            <p className="text-sm text-blue-700 dark:text-blue-300">{insight.suggestedAction}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                  {!coachingData?.insights?.length && <EmptyState message="No coaching insights yet. Click Generate Insights to analyze this account." />}
                </div>
              )}
            </TabsContent>

            <TabsContent value="org-gaps" className="space-y-4 mt-4">
              {!selectedCompany ? <SelectAccountPrompt /> : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Org Chart Gap Analysis</h2>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => genWarmIntrosMutation.mutate()} disabled={genWarmIntrosMutation.isPending} data-testid="btn-warm-intros">
                        {genWarmIntrosMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Handshake className="h-4 w-4 mr-2" />}
                        Find Warm Intros
                      </Button>
                      <Button onClick={() => genOrgGapsMutation.mutate()} disabled={genOrgGapsMutation.isPending} data-testid="btn-gen-org-gaps">
                        {genOrgGapsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                        Analyze Gaps
                      </Button>
                    </div>
                  </div>
                  {orgGapsData?.gaps?.map((gap: any) => (
                    <Card key={gap.id} data-testid={`gap-card-${gap.id}`}>
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant={priorityColor(gap.priority)}>{gap.priority}</Badge>
                            <Badge variant="outline">{gap.gapType?.replace(/_/g, " ")}</Badge>
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => dismissGapMutation.mutate(gap.id)} data-testid={`btn-dismiss-gap-${gap.id}`}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                        <h3 className="font-medium mb-1">{gap.title}</h3>
                        <p className="text-sm text-muted-foreground mb-2">{gap.description}</p>
                        {(gap.suggestedContactName || gap.suggestedContactTitle) && (
                          <div className="flex items-center gap-2 bg-green-50 dark:bg-green-950/30 p-3 rounded-lg">
                            <UserPlus className="h-4 w-4 text-green-500" />
                            <div className="text-sm">
                              <span className="font-medium text-green-700 dark:text-green-300">{gap.suggestedContactName || "Unknown"}</span>
                              {gap.suggestedContactTitle && <span className="text-green-600 dark:text-green-400"> — {gap.suggestedContactTitle}</span>}
                              {gap.suggestedContactEmail && <span className="text-green-500 dark:text-green-500 ml-2">({gap.suggestedContactEmail})</span>}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                  {!orgGapsData?.gaps?.length && <EmptyState message="No gaps identified. Click Analyze Gaps to scan for coverage gaps." />}
                </div>
              )}
            </TabsContent>

            <TabsContent value="cross-sell" className="space-y-4 mt-4">
              {!selectedCompany ? <SelectAccountPrompt /> : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Cross-Sell Opportunities</h2>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => genLookAlikesMutation.mutate()} disabled={genLookAlikesMutation.isPending} data-testid="btn-look-alikes">
                        {genLookAlikesMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Crosshair className="h-4 w-4 mr-2" />}
                        Find Look-Alikes
                      </Button>
                      <Button onClick={() => genCrossSellMutation.mutate()} disabled={genCrossSellMutation.isPending} data-testid="btn-gen-cross-sell">
                        {genCrossSellMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                        Find Opportunities
                      </Button>
                    </div>
                  </div>
                  {crossSellData?.opportunities?.map((opp: any) => (
                    <Card key={opp.id} data-testid={`cross-sell-card-${opp.id}`}>
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{opp.opportunityType?.replace(/_/g, " ")}</Badge>
                            {opp.confidenceScore && <Badge variant="secondary">{opp.confidenceScore}%</Badge>}
                          </div>
                          {opp.estimatedValue && <span className="text-sm font-mono text-green-500">${Number(opp.estimatedValue).toLocaleString()}</span>}
                        </div>
                        <h3 className="font-medium mb-1">{opp.title}</h3>
                        <p className="text-sm text-muted-foreground mb-2">{opp.description}</p>
                        {opp.lane && (
                          <div className="flex items-center gap-2 text-sm">
                            <Route className="h-3 w-3 text-blue-500" />
                            <span className="font-medium">{opp.lane}</span>
                          </div>
                        )}
                        {opp.suggestedApproach && (
                          <div className="mt-2 flex items-start gap-2 bg-blue-50 dark:bg-blue-950/30 p-3 rounded-lg">
                            <ArrowRight className="h-4 w-4 text-blue-500 mt-0.5" />
                            <p className="text-sm text-blue-700 dark:text-blue-300">{opp.suggestedApproach}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                  {!crossSellData?.opportunities?.length && <EmptyState message="No cross-sell opportunities found. Click Find Opportunities to analyze." />}
                </div>
              )}
            </TabsContent>

            <TabsContent value="growth" className="space-y-4 mt-4">
              {!selectedCompany ? <SelectAccountPrompt /> : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Wallet Share Growth Playbooks</h2>
                    <Button onClick={() => genWalletShareMutation.mutate()} disabled={genWalletShareMutation.isPending} data-testid="btn-gen-wallet-share">
                      {genWalletShareMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                      Generate Playbook
                    </Button>
                  </div>
                  {walletShareData?.plays?.map((play: any) => (
                    <Card key={play.id} data-testid={`play-card-${play.id}`}>
                      <CardHeader className="pb-2 cursor-pointer" onClick={() => toggleExpand(play.id)}>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base flex items-center gap-2">
                            <DollarSign className="h-4 w-4 text-green-500" />
                            {play.playTitle}
                          </CardTitle>
                          <div className="flex items-center gap-2">
                            {play.estimatedRevenue && <span className="text-sm font-mono text-green-500">${Number(play.estimatedRevenue).toLocaleString()}</span>}
                            {play.timelineWeeks && <Badge variant="outline">{play.timelineWeeks} weeks</Badge>}
                            {expandedCards.has(play.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </div>
                        </div>
                      </CardHeader>
                      {expandedCards.has(play.id) && (
                        <CardContent className="space-y-4">
                          <p className="text-sm text-muted-foreground">{play.playDescription}</p>
                          {play.pricingStrategy && (
                            <div>
                              <h4 className="font-medium text-sm text-muted-foreground mb-1">Pricing Strategy</h4>
                              <p className="text-sm">{play.pricingStrategy}</p>
                            </div>
                          )}
                          {Array.isArray(play.targetLanes) && play.targetLanes.length > 0 && (
                            <div>
                              <h4 className="font-medium text-sm text-muted-foreground mb-1">Target Lanes</h4>
                              {play.targetLanes.map((l: any, i: number) => (
                                <div key={i} className="text-sm flex items-center gap-2 mb-1">
                                  <Route className="h-3 w-3 text-blue-500" />
                                  <span className="font-medium">{l.lane}</span>
                                  <span className="text-muted-foreground">— {l.reason}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {Array.isArray(play.steps) && play.steps.length > 0 && (
                            <div>
                              <h4 className="font-medium text-sm text-muted-foreground mb-1">Execution Steps</h4>
                              <div className="space-y-2">
                                {play.steps.map((step: any, i: number) => (
                                  <div key={i} className="flex items-start gap-3 bg-muted/50 p-3 rounded-lg">
                                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900 text-xs font-bold text-blue-600 dark:text-blue-300">
                                      {step.week || i + 1}
                                    </div>
                                    <div className="flex-1">
                                      <p className="text-sm font-medium">{step.action}</p>
                                      <p className="text-xs text-muted-foreground">{step.outcome}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  ))}
                  {!walletShareData?.plays?.length && <EmptyState message="No growth playbooks yet. Click Generate Playbook to create one." />}
                </div>
              )}
            </TabsContent>

            <TabsContent value="competitive" className="space-y-4 mt-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Competitive Intelligence</h2>
                  {selectedCompany && (
                    <Button onClick={() => genCompetitiveMutation.mutate()} disabled={genCompetitiveMutation.isPending} data-testid="btn-gen-competitive">
                      {genCompetitiveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                      Scan for Threats
                    </Button>
                  )}
                </div>
                {competitiveData?.signals?.map((sig: any) => (
                  <Card key={sig.id} data-testid={`competitive-card-${sig.id}`}>
                    <CardContent className="pt-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className={`h-4 w-4 ${severityColor(sig.severity)}`} />
                          <Badge variant={sig.severity === "critical" ? "destructive" : "outline"}>{sig.severity}</Badge>
                          <Badge variant="secondary">{sig.signalType?.replace(/_/g, " ")}</Badge>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => dismissCompetitiveMutation.mutate(sig.id)} data-testid={`btn-dismiss-comp-${sig.id}`}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      {sig.competitorName && <p className="text-sm font-medium mb-1">Competitor: {sig.competitorName}</p>}
                      <p className="text-sm text-muted-foreground mb-2">{sig.description}</p>
                      {sig.suggestedResponse && (
                        <div className="flex items-start gap-2 bg-purple-50 dark:bg-purple-950/30 p-3 rounded-lg">
                          <Shield className="h-4 w-4 text-purple-500 mt-0.5" />
                          <p className="text-sm text-purple-700 dark:text-purple-300">{sig.suggestedResponse}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
                {!competitiveData?.signals?.length && <EmptyState message="No competitive signals detected. Select an account and scan for threats." />}
              </div>
            </TabsContent>

            <TabsContent value="win-loss" className="space-y-4 mt-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Win/Loss Patterns</h2>
                  {isLeadership && (
                    <Button onClick={() => genWinLossMutation.mutate()} disabled={genWinLossMutation.isPending} data-testid="btn-gen-win-loss">
                      {genWinLossMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                      Analyze Patterns
                    </Button>
                  )}
                </div>
                {winLossData?.patterns?.map((pattern: any) => (
                  <Card key={pattern.id} data-testid={`pattern-card-${pattern.id}`}>
                    <CardHeader className="pb-2 cursor-pointer" onClick={() => toggleExpand(pattern.id)}>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                          {pattern.outcome === "win" ? <CheckCircle className="h-4 w-4 text-green-500" /> : pattern.outcome === "loss" ? <AlertTriangle className="h-4 w-4 text-red-500" /> : <BarChart3 className="h-4 w-4 text-blue-500" />}
                          {pattern.title}
                        </CardTitle>
                        <div className="flex items-center gap-2">
                          <Badge variant={pattern.outcome === "win" ? "default" : pattern.outcome === "loss" ? "destructive" : "secondary"}>
                            {pattern.outcome}
                          </Badge>
                          <Badge variant="outline">{pattern.patternType}</Badge>
                          {expandedCards.has(pattern.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </div>
                    </CardHeader>
                    {expandedCards.has(pattern.id) && (
                      <CardContent className="space-y-3">
                        <p className="text-sm text-muted-foreground">{pattern.description}</p>
                        {Array.isArray(pattern.factors) && pattern.factors.length > 0 && (
                          <div>
                            <h4 className="text-sm font-medium text-muted-foreground mb-1">Contributing Factors</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              {pattern.factors.map((f: string, i: number) => <li key={i} className="text-sm">{f}</li>)}
                            </ul>
                          </div>
                        )}
                        {Array.isArray(pattern.recommendations) && pattern.recommendations.length > 0 && (
                          <div>
                            <h4 className="text-sm font-medium text-green-600 dark:text-green-400 mb-1">Recommendations</h4>
                            <ul className="list-disc pl-5 space-y-1">
                              {pattern.recommendations.map((r: string, i: number) => (
                                <li key={i} className="text-sm text-green-700 dark:text-green-300">{r}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </CardContent>
                    )}
                  </Card>
                ))}
                {!winLossData?.patterns?.length && <EmptyState message={isLeadership ? "No patterns analyzed yet. Click Analyze Patterns to scan RFP data." : "Win/loss pattern data will appear here once leadership runs analysis."} />}
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function KPICard({ icon, label, value, color, testId }: { icon: any; label: string; value: number; color: string; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-4 pb-3 flex items-center gap-3">
        <div className={`p-2 rounded-lg bg-${color}-100 dark:bg-${color}-950/30`}>{icon}</div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewCard({ icon, title, description, action, testId }: { icon: any; title: string; description: string; action: () => void; testId: string }) {
  return (
    <Card className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={action} data-testid={testId}>
      <CardContent className="pt-4 space-y-2">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-medium">{title}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex items-center gap-1 text-xs text-blue-500">
          <span>Explore</span>
          <ArrowRight className="h-3 w-3" />
        </div>
      </CardContent>
    </Card>
  );
}

function SelectAccountPrompt() {
  return (
    <Card>
      <CardContent className="pt-6 text-center py-12">
        <Target className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <h3 className="font-medium mb-1">Select an Account</h3>
        <p className="text-sm text-muted-foreground">Choose a company from the dropdown above to view AI intelligence for that account.</p>
      </CardContent>
    </Card>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="pt-6 text-center py-8">
        <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}