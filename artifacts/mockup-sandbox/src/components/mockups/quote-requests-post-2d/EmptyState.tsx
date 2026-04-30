import React from "react";
import { 
  ChevronDown, Search, Sparkles, Filter, InboxIcon, ArrowRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export default function EmptyState() {
  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-sans">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/50">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Quote Requests</h1>
          <p className="text-xs text-muted-foreground mt-1">Every inbound request, one row, one source of truth</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" className="h-8 gap-2">
            Saved views <ChevronDown className="h-3 w-3" />
          </Button>
          <Button size="sm" className="h-8 bg-amber-500 hover:bg-amber-600 text-black font-medium">
            New quote
          </Button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="flex items-stretch px-6 py-4 gap-4 border-b border-border bg-muted/20">
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Open requests</div>
          <div className="text-2xl font-bold mt-1 text-muted-foreground/50">0</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Awaiting your reply</div>
          <div className="text-2xl font-bold mt-1 text-muted-foreground/50">0</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Past SLA</div>
          <div className="text-2xl font-bold mt-1 text-muted-foreground/50">0</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Won today</div>
          <div className="text-2xl font-bold mt-1 text-muted-foreground/50">0</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center opacity-50">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            <Sparkles className="h-3 w-3" />
            Auto-captured today
          </div>
          <div className="text-2xl font-bold mt-1 text-muted-foreground/50">0</div>
        </div>
      </div>

      {/* Filter Row */}
      <div className="px-6 py-3 border-b border-border flex items-center justify-between bg-card/30">
        <div className="flex items-center gap-4">
          <div className="relative w-64 opacity-50 pointer-events-none">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Lane, customer, sender, notes" 
              className="pl-8 h-8 text-xs bg-background"
              disabled
            />
          </div>
          <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
            <Badge variant="secondary" className="h-6 rounded-sm bg-muted text-foreground">All</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">New</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">Quoted</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">Won</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">Lost</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">No-response</Badge>
          </div>
          <div className="h-4 w-px bg-border mx-1"></div>
          <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
            <Badge variant="secondary" className="h-6 rounded-sm bg-muted text-foreground">Today</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">24h</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">7d</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground">30d</Badge>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground opacity-50 pointer-events-none">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="rounded bg-background border-border" disabled />
            Mine only
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="rounded bg-background border-border" disabled />
            Free-email senders
          </label>
          <Badge variant="outline" className="h-6 gap-1 border-border text-muted-foreground">
            <Filter className="h-3 w-3" />
            Domain
          </Badge>
        </div>
      </div>

      {/* Empty State Body */}
      <div className="flex-1 bg-card flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
          <InboxIcon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold text-foreground mb-1">No quote requests today</h3>
        <p className="text-sm text-muted-foreground max-w-[400px] mb-6">
          Your inbox is clear. New requests will appear here as they arrive or are auto-captured from customer emails.
        </p>

        <div className="w-full max-w-md bg-muted/30 border border-border rounded-lg p-4 mb-4 text-left flex items-start gap-3 hover:bg-muted/50 transition-colors cursor-pointer group">
          <div className="mt-0.5"><Sparkles className="h-4 w-4 text-amber-500" /></div>
          <div className="flex-1">
            <div className="text-sm font-medium text-foreground mb-1 group-hover:text-amber-500 transition-colors">Capture Leak Queue</div>
            <div className="text-xs text-muted-foreground">
              23 emails were auto-evaluated today and skipped (3 internal forwards, 5 low confidence) — review skipped
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-amber-500 transition-colors mt-2" />
        </div>

        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground h-8">
          Or filter by 'Last 7 days' to see the wider window
        </Button>
      </div>

      {/* Automation Strip (Zero state) */}
      <div className="px-6 py-1.5 bg-muted/30 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="font-semibold text-foreground">Phase 2b Auto-capture:</span>
          <span>Created <strong>0</strong></span>
          <span className="text-border">•</span>
          <span>Attached <strong>0</strong></span>
          <span className="text-border">•</span>
          <span>Skipped (internal) <strong>3</strong></span>
          <span className="text-border">•</span>
          <span>Skipped (low conf) <strong>5</strong></span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">j/k</span> navigate
          <span className="ml-2 bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">enter</span> open
        </div>
      </div>
    </div>
  );
}
