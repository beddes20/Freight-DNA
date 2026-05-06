              <LaneRow
                key={item.lane.id}
                item={item}
                completionThreshold={completionThreshold}
                onOpen={onOpen}
                bucket={bucket}
                teamMembers={teamMembers}
                isManagerRole={isManagerRole}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function LaneWorkQueuePage() {
  const { user } = useAuth();
  const [openLaneId, setOpenLaneId] = useState<string | null>(null);
<<<<<<< HEAD
  const [filterHighFreq, setFilterHighFreq] = useState(false);
=======
  const [highFreqOnly, setHighFreqOnly] = useState(false);
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)

  const managerRoles = ["admin", "director", "national_account_manager", "logistics_manager"];
  const isManager = managerRoles.includes(user?.role ?? "");

  const { data: queue, isLoading, refetch } = useQuery<WorkQueue>({
    queryKey: ["/api/recurring-lanes/work-queue"],
    queryFn: () => fetch("/api/recurring-lanes/work-queue").then(r => r.json()),
    enabled: isManager,
  });

  const { data: outreachConfig } = useQuery<{ completionCarriersContacted: number }>({
    queryKey: ["/api/lane-outreach-config"],
    queryFn: () => fetch("/api/lane-outreach-config").then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const completionThreshold = outreachConfig?.completionCarriersContacted ?? 3;

  const { data: teamMembers = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    queryFn: () => fetch("/api/team-members").then(r => r.json()),
  });

  // Count high-frequency lanes across all buckets for the filter chip label
  const highFreqCount = useMemo(() => {
    if (!queue) return 0;
    return (
      queue.unassigned.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      queue.noContactable.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      queue.assignedUntouched.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      queue.inProgress.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length
    );
  }, [queue]);

  if (!isManager) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-orange-400 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Manager access required to view the Lane Work Queue.</p>
        </div>
      </div>
    );
  }

  const totalLanes = (queue?.unassigned.length ?? 0) +
    (queue?.noContactable.length ?? 0) +
    (queue?.assignedUntouched.length ?? 0) +
    (queue?.inProgress.length ?? 0);

  // Sort unassigned by avgLoadsPerWeek descending so highest-frequency lanes appear first
  const sortedUnassigned = [...(queue?.unassigned ?? [])].sort((a, b) => {
    const aVal = parseLoadsPerWeek(a.lane.avgLoadsPerWeek) ?? 0;
    const bVal = parseLoadsPerWeek(b.lane.avgLoadsPerWeek) ?? 0;
    return bVal - aVal;
  });

  // Count 2+/wk lanes in unassigned bucket for the filter pill label
  const highFreqUnassignedCount = sortedUnassigned.filter(
    item => (parseLoadsPerWeek(item.lane.avgLoadsPerWeek) ?? 0) >= 2
  ).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex items-center justify-between bg-card">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ListFilter className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">Lane Work Queue</h1>
            <p className="text-xs text-muted-foreground">
              {isLoading ? "Loading…" : `${totalLanes} eligible lane${totalLanes !== 1 ? "s" : ""} needing attention`}
            </p>
            {/* Scope indicator — shows hierarchy context */}
            {queue?.scopeLabel && (
              <span
                className="inline-flex items-center gap-1 mt-1 text-[11px] text-muted-foreground border border-border rounded-full px-2 py-0.5 bg-muted/40"
                data-testid="scope-label"
              >
                <Eye className="w-3 h-3" />
                Showing: {queue.scopeLabel}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
<<<<<<< HEAD
          {/* 2+/wk filter pill */}
          {!isLoading && highFreqUnassignedCount > 0 && (
            <Button
              variant={filterHighFreq ? "default" : "outline"}
              size="sm"
              className={`h-8 text-xs gap-1.5 ${filterHighFreq ? "bg-amber-500 hover:bg-amber-600 text-white border-amber-500" : "border-amber-500/40 text-amber-400 hover:bg-amber-500/10"}`}
              onClick={() => setFilterHighFreq(v => !v)}
              data-testid="btn-filter-high-freq"
            >
              <Zap className="w-3.5 h-3.5" />
              2+/wk {filterHighFreq ? "✕" : `(${highFreqUnassignedCount})`}
            </Button>
          )}
=======
          {/* 2+/week filter toggle */}
          <Button
            variant={highFreqOnly ? "default" : "outline"}
            size="sm"
            className={`h-8 text-xs gap-1.5 ${highFreqOnly ? "bg-amber-500 hover:bg-amber-600 text-white border-transparent" : ""}`}
            onClick={() => setHighFreqOnly(v => !v)}
            data-testid="btn-filter-high-freq"
          >
            <Zap className="w-3.5 h-3.5" />
            2+/week{highFreqCount > 0 && ` (${highFreqCount})`}
          </Button>
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => refetch()}
            data-testid="btn-refresh-work-queue"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading work queue…</span>
          </div>
        ) : (
          <>
            {/* Summary stat chips */}
            {queue && (
              <div className="flex gap-3 flex-wrap mb-6">
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-orange-400">{queue.unassigned.length}</p>
                  <p className="text-[10px] text-orange-400/70">Unassigned</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-red-400">{queue.noContactable.length}</p>
                  <p className="text-[10px] text-red-400/70">No Contact Info</p>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-blue-400">{queue.assignedUntouched.length}</p>
                  <p className="text-[10px] text-blue-400/70">Untouched</p>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-amber-400">{queue.inProgress.length}</p>
                  <p className="text-[10px] text-amber-400/70">In Progress</p>
                </div>
<<<<<<< HEAD
                {highFreqUnassignedCount > 0 && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                    <p className="text-lg font-bold text-emerald-400">{highFreqUnassignedCount}</p>
                    <p className="text-[10px] text-emerald-400/70">2+/wk Unassigned</p>
                  </div>
=======
                {/* High-frequency summary chip */}
                {highFreqCount > 0 && (
                  <button
                    className={`flex items-center gap-1.5 border rounded-lg px-3 py-2 text-center min-w-[80px] transition-colors ${
                      highFreqOnly
                        ? "bg-amber-500/20 border-amber-500/40"
                        : "bg-amber-500/10 border-amber-500/20 hover:border-amber-500/40"
                    }`}
                    onClick={() => setHighFreqOnly(v => !v)}
                    data-testid="btn-highfreq-chip"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <div>
                      <p className="text-lg font-bold text-amber-400 leading-none">{highFreqCount}</p>
                      <p className="text-[10px] text-amber-400/70">2+/wk</p>
                    </div>
                  </button>
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
                )}
              </div>
            )}

            {/* Buckets */}
            {queue && (
              <>
                <BucketSection
                  title="Unassigned"
                  description={
                    filterHighFreq
                      ? "Showing 2+/wk lanes only — highest procurement priority."
                      : "These lanes have no owner — assign one to get outreach started. Sorted highest frequency first."
                  }
                  icon={UserX}
                  iconColor="bg-orange-500/10 text-orange-400"
                  items={sortedUnassigned}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="unassigned"
                  teamMembers={teamMembers}
<<<<<<< HEAD
                  isManagerRole={isManager}
                  filterHighFreq={filterHighFreq}
=======
                  highFreqOnly={highFreqOnly}
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
                />
                <BucketSection
                  title="No Contactable Carriers"
                  description="Assigned but carriers have no phone or email — update the carrier catalog."
                  icon={AlertCircle}
                  iconColor="bg-red-500/10 text-red-400"
                  items={queue.noContactable}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="noContactable"
                  teamMembers={teamMembers}
<<<<<<< HEAD
                  isManagerRole={isManager}
=======
                  highFreqOnly={highFreqOnly}
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
                />
                <BucketSection
                  title="Assigned — Untouched"
                  description="Owner assigned and carriers are contactable — no outreach logged yet."
                  icon={Truck}
                  iconColor="bg-blue-500/10 text-blue-400"
                  items={queue.assignedUntouched}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="assignedUntouched"
                  teamMembers={teamMembers}
<<<<<<< HEAD
                  isManagerRole={isManager}
=======
                  highFreqOnly={highFreqOnly}
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
                />
                <BucketSection
                  title="In Progress"
                  description="Outreach started — keep going to hit the target."
                  icon={CheckCircle2}
                  iconColor="bg-amber-500/10 text-amber-400"
                  items={queue.inProgress}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="inProgress"
                  teamMembers={teamMembers}
<<<<<<< HEAD
                  isManagerRole={isManager}
=======
                  highFreqOnly={highFreqOnly}
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
                />
              </>
            )}

            {!isLoading && totalLanes === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mb-3" />
                <p className="text-sm font-semibold text-foreground">All caught up!</p>
                <p className="text-xs text-muted-foreground mt-1">No eligible lanes need attention right now.</p>
              </div>
            )}

            {/* Admin debug panel — queue correctness at a glance */}
            {user?.role === "admin" && queue && !isLoading && (
              <details className="mt-8 border border-border rounded-lg overflow-hidden" data-testid="admin-debug-panel">
                <summary className="px-4 py-2 text-[11px] text-muted-foreground cursor-pointer select-none hover:bg-muted/40 transition-colors">
                  Admin: Queue Debug ({totalLanes} lanes across {Object.values(queue).filter(Array.isArray).filter(a => a.length > 0).length} buckets)
                </summary>
                <div className="px-4 py-3 bg-muted/20 font-mono text-[10px] leading-relaxed space-y-2">
                  {(["unassigned", "noContactable", "assignedUntouched", "inProgress"] as const).map(bucket => (
                    <div key={bucket}>
                      <span className="text-foreground font-semibold">{bucket}</span>
                      <span className="text-muted-foreground"> ({queue[bucket].length})</span>
                      {queue[bucket].length > 0 && (
                        <ul className="pl-3 mt-0.5 space-y-0.5">
                          {queue[bucket].map(item => (
                            <li key={item.lane.id} className="text-muted-foreground">
                              {item.lane.id.slice(0, 8)}… {item.lane.origin}→{item.lane.destination}
<<<<<<< HEAD
                              {" | "}{item.lane.avgLoadsPerWeek ?? "?"}loads/wk
=======
                              {" | "}{item.lane.avgLoadsPerWeek ?? "—"}/wk
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)
                              {" | "}owner={item.lane.ownerName ?? "none"}
                              {" | "}contacted={item.lane.carriersContactedCount ?? 0}
                              {" | "}bench={item.totalBenchCount}
                              {" | "}contactable={item.contactableCount}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>

      {/* Outreach panel */}
      <CarrierOutreachPanel
        laneId={openLaneId}
        open={!!openLaneId}
        onClose={() => setOpenLaneId(null)}
        onCarriersContacted={() => {
          setOpenLaneId(null);
          queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
        }}
      />
    </div>
  );
}
