import { useEffect, useState } from "react";
import { AlertCircle, PhoneCall } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CallActivityTrendline } from "@/components/call-activity-trendline";
import { CallPaceCard } from "@/components/call-pace-card";
import { CallQualityPanel } from "@/components/call-quality-scorecard";
import { IntegrationDegradedPill } from "@/components/integration-degraded-pill";

// Mirrors the sidebar visibility for "Call Performance" and the server-side
// allowlist on `/api/calls/trendline/org`. Non-managers who arrive via direct
// URL get the same access-restricted screen as `/phone-usage`.
const ALLOWED_ROLES = ["admin", "director", "national_account_manager", "sales_director"];

/**
 * Call Performance Hub (Task #691) — single org-wide view that consolidates
 * the three Webex telephony surfaces (per-shipper pace, weekly trendline,
 * per-rep quality scorecard) under one shared days picker. Each section
 * still owns its own filters (sort key, direction, rep) but reads the
 * window from this page so the picker drives all three in lockstep.
 */
export default function CallsPage() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);

  useEffect(() => {
    const prev = document.title;
    document.title = "Call Performance — FreightDNA";
    return () => { document.title = prev; };
  }, []);

  if (!user || !ALLOWED_ROLES.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center" data-testid="page-calls-restricted">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="text-muted-foreground">Access restricted to leadership roles.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-calls">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <PhoneCall className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <div>
                <CardTitle data-testid="text-calls-title" className="flex items-center gap-2">
                  Call Performance
                  <IntegrationDegradedPill source="webex" label="Webex" />
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Webex telephony rollup across the entire org — pace, weekly trendline, and quality.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Window</span>
              <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v, 10))}>
                <SelectTrigger className="h-8 text-xs w-[110px]" data-testid="select-calls-days">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground pt-0">
          The window picker above drives every section on this page. Each section
          keeps its own per-section filters (sort, direction, rep) so you can
          slice the same window three different ways.
        </CardContent>
      </Card>

      <section data-testid="section-call-pace">
        <CallPaceCard days={days} onDaysChange={setDays} />
      </section>

      <section data-testid="section-call-trendline">
        <CallActivityTrendline scope="org" days={days} onDaysChange={setDays} />
      </section>

      <section data-testid="section-call-quality">
        {/* CallQualityPanel only supports up to 90d so the picker stops at 90. */}
        <CallQualityPanel days={days} onDaysChange={setDays} />
      </section>
    </div>
  );
}
