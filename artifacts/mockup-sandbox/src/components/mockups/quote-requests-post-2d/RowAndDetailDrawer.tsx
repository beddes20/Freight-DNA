import React, { useState } from "react";
import { 
  ChevronDown, Search, Sparkles, Filter, MoreHorizontal, 
  Clock, MapPin, Mail, ChevronLeft, ChevronRight, Share, 
  Copy, FileText, Check, X, Phone, Plus, Map, LineChart, MessageSquare, Briefcase
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

// Simplified list for background
const mockData = [
  { id: "QR-1042", customer: "Lactalis", origin: "BELVIDERE, IL", dest: "STURTEVANT, WI", equipment: "Reefer", status: "new", repInitials: "MS" },
  { id: "QR-1041", customer: "Tyson Foods", origin: "SPRINGDALE, AR", dest: "CHICAGO, IL", equipment: "Reefer", status: "quoted", repInitials: "JD" },
  { id: "QR-1040", customer: "ALDI", origin: "BATAVIA, IL", dest: "OAK CREEK, WI", equipment: "Dry Van", status: "new", repInitials: "SK" },
  { id: "QR-1039", customer: "Dole", origin: "MONTEREY, CA", dest: "SEATTLE, WA", equipment: "Reefer", status: "won", repInitials: "MR" },
  { id: "QR-1038", customer: "Cargill Refrigerated", origin: "WICHITA, KS", dest: "DALLAS, TX", equipment: "Reefer", status: "lost", repInitials: "MS" },
  { id: "QR-1037", customer: "FedEx Supply Chain", origin: "MEMPHIS, TN", dest: "ATLANTA, GA", equipment: "Dry Van", status: "no_response", repInitials: "JD" }
];

export default function RowAndDetailDrawer() {
  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-sans overflow-hidden">
      {/* Top Bar - Simplified */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/50">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Quote Requests</h1>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" className="h-8 bg-amber-500 hover:bg-amber-600 text-black font-medium">
            New quote
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Background Table - Simplified */}
        <div className="flex-1 overflow-auto bg-card pr-[480px]">
          <table className="w-full text-left text-[13px] border-collapse">
            <thead className="bg-card border-b border-border shadow-sm">
              <tr className="text-muted-foreground uppercase tracking-wider text-[10px] font-semibold">
                <th className="w-6 py-2 px-3"></th>
                <th className="py-2 px-3">Customer</th>
                <th className="py-2 px-3">Lane</th>
                <th className="py-2 px-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {mockData.map((row) => (
                <tr 
                  key={row.id} 
                  className={`h-[36px] ${row.id === "QR-1042" ? "bg-amber-500/10" : "opacity-50"}`}
                >
                  <td className="px-3 text-center">
                    <div className={`w-1.5 h-1.5 rounded-full mx-auto ${row.id === 'QR-1042' ? 'bg-amber-500' : 'bg-transparent'}`} />
                  </td>
                  <td className="px-3 font-medium whitespace-nowrap">{row.customer}</td>
                  <td className="px-3 whitespace-nowrap">
                    <span className="font-medium text-foreground">{row.origin}</span>
                    <span className="text-muted-foreground text-[10px] mx-1.5">→</span>
                    <span className="font-medium text-foreground">{row.dest}</span>
                  </td>
                  <td className="px-3 whitespace-nowrap text-muted-foreground">
                    {row.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Drawer Sheet */}
        <div className="absolute top-0 right-0 w-[480px] h-full bg-card border-l border-border shadow-2xl flex flex-col z-20">
          
          {/* Sticky Header */}
          <div className="px-5 py-4 border-b border-border bg-card sticky top-0 z-10">
            <div className="flex justify-between items-start mb-3">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Lactalis</h2>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  <span className="uppercase tracking-wider font-semibold">Quote Request</span>
                  <span>·</span>
                  <span className="font-mono">#QR-1042</span>
                  <span>·</span>
                  <span>12m ago</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-amber-500/15 text-amber-500 border-amber-500/30 uppercase tracking-wider text-[10px]">
                  New
                </Badge>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
                  <X className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between mt-4">
              <div className="flex items-center gap-2 text-sm bg-muted/50 px-2 py-1 rounded border border-border hover:bg-muted cursor-pointer transition-colors">
                <Avatar className="h-6 w-6 border border-border">
                  <AvatarFallback className="text-[10px] bg-card">MS</AvatarFallback>
                </Avatar>
                <span className="font-medium">Maria S.</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8 bg-amber-500 hover:bg-amber-600 text-black font-medium gap-1.5 px-4">
                  <Mail className="h-3.5 w-3.5" /> Send quote
                </Button>
                <div className="flex items-center">
                  <Button variant="outline" size="sm" className="h-8 rounded-r-none border-r-0 px-3 hover:bg-emerald-500/10 hover:text-emerald-500 hover:border-emerald-500/30">
                    <Check className="h-3.5 w-3.5 mr-1.5" /> Won
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 rounded-l-none px-3 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30">
                    <X className="h-3.5 w-3.5 mr-1.5" /> Lost
                  </Button>
                </div>
                <Button variant="outline" size="icon" className="h-8 w-8 ml-1">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4 bg-muted/10">
            
            {/* Lane Card */}
            <Card className="border-border/60 shadow-sm overflow-hidden">
              <div className="p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-bold text-foreground">BELVIDERE, IL</h3>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-lg font-bold text-foreground">STURTEVANT, WI</h3>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> Reefer</span>
                      <span>·</span>
                      <span>38,000 lbs</span>
                      <span>·</span>
                      <span className="flex items-center gap-1.5 text-foreground font-medium"><Clock className="h-3.5 w-3.5 text-muted-foreground" /> Tue Apr 30</span>
                      <span>·</span>
                      <span>2 stops</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="h-24 bg-muted/50 border-t border-border relative overflow-hidden flex items-center justify-center">
                <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: "radial-gradient(circle at 2px 2px, rgba(255,255,255,0.15) 1px, transparent 0)", backgroundSize: "16px 16px" }}></div>
                <div className="w-full max-w-[200px] h-0.5 bg-border relative">
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)] z-10 border border-black" />
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)] z-10 border border-black" />
                  <svg className="absolute inset-0 w-full h-8 -top-4 overflow-visible" preserveAspectRatio="none">
                    <path d="M 0,16 Q 100,-8 200,16" fill="none" stroke="rgba(245,158,11,0.5)" strokeWidth="2" strokeDasharray="4 4" />
                  </svg>
                </div>
              </div>
            </Card>

            {/* Confidence Card */}
            <Card className="border-amber-500/20 bg-amber-500/5 shadow-sm p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  <span className="font-semibold text-amber-500 text-sm">Auto-captured by Phase 2b</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 bg-amber-500/20 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-500 w-[94%]" />
                  </div>
                  <span className="text-[10px] uppercase font-bold text-amber-500 tracking-wider">94 · High</span>
                </div>
              </div>
              <ul className="text-xs text-amber-500/80 space-y-1.5 ml-6 list-disc marker:text-amber-500/40">
                <li>Subject contains 'pricing'</li>
                <li>Body has lane + equipment + pickup date</li>
              </ul>
              <div className="mt-3 text-xs">
                <a href="#" className="text-amber-500 hover:text-amber-400 font-medium hover:underline">View signal trace</a>
              </div>
            </Card>

            {/* Source Thread Embed */}
            <Card className="border-border/60 shadow-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> Source Thread
                </h4>
              </div>
              <div className="space-y-2">
                <div className="p-2.5 rounded bg-muted/30 border border-border/50 text-sm">
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="font-medium text-foreground">Tom Broker &lt;broker.tom@lactalis.com&gt;</span>
                    <span className="text-xs text-muted-foreground">12m ago</span>
                  </div>
                  <div className="font-medium text-xs mb-1">Pricing request: Belvidere to Sturtevant (Reefer)</div>
                  <div className="text-muted-foreground text-xs line-clamp-2">
                    Hi team, looking for a rate on a reefer load picking up Tuesday April 30th from Belvidere IL going to Sturtevant WI. 38k lbs, 2 stops. Let me know what you can do.
                  </div>
                </div>
                <div className="p-2 rounded bg-background border border-border/30 text-xs text-muted-foreground flex items-center gap-2 cursor-pointer hover:bg-muted/30 transition-colors">
                  <ChevronRight className="h-3 w-3" />
                  <span>2 previous messages in thread</span>
                </div>
              </div>
              <div className="mt-3 text-xs text-center border-t border-border/50 pt-3">
                <a href="#" className="text-primary hover:text-primary/80 font-medium flex items-center justify-center gap-1">
                  Open full thread in Conversations <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </Card>

            {/* Pricing Intel Mini-panel */}
            <Card className="border-border/60 shadow-sm p-4 bg-gradient-to-br from-card to-muted/20">
              <div className="flex justify-between items-center mb-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <LineChart className="h-3.5 w-3.5" /> Pricing Intel
                </h4>
                <Badge variant="outline" className="text-[10px] bg-background">Last 30d</Badge>
              </div>
              <div className="flex items-end gap-6">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Recommended Band</div>
                  <div className="text-2xl font-bold text-foreground tracking-tight">$2,250 <span className="text-muted-foreground font-normal mx-1">–</span> $2,480</div>
                </div>
                <div className="flex-1">
                  <div className="text-xs text-muted-foreground mb-1">Last 5 won on this lane</div>
                  <div className="flex items-end h-8 gap-1 pt-1">
                    {[40, 60, 45, 80, 50].map((h, i) => (
                      <div key={i} className="flex-1 bg-emerald-500/20 rounded-t-sm hover:bg-emerald-500/40 transition-colors relative group" style={{ height: `${h}%` }}>
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block text-[10px] bg-popover border border-border px-1.5 py-0.5 rounded shadow-sm z-10">
                          ${2000 + h * 10}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            {/* Activity Timeline */}
            <div className="px-1 mt-2 mb-6">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Activity Timeline</h4>
              <div className="space-y-4 relative before:absolute before:inset-0 before:ml-[5px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-border/50">
                
                <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                  <div className="flex items-center justify-center w-3 h-3 rounded-full bg-amber-500 shadow-[0_0_0_3px_hsl(var(--background))] border border-black shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10 absolute left-0 md:left-1/2"></div>
                  <div className="w-[calc(100%-1.5rem)] md:w-[calc(50%-1.5rem)] pl-4 md:pl-0 text-sm">
                    <div className="font-medium text-foreground text-xs mb-0.5">Auto-captured from email</div>
                    <time className="text-[10px] text-muted-foreground">12m ago</time>
                  </div>
                </div>

                <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                  <div className="flex items-center justify-center w-3 h-3 rounded-full bg-muted shadow-[0_0_0_3px_hsl(var(--background))] border border-border shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10 absolute left-0 md:left-1/2"></div>
                  <div className="w-[calc(100%-1.5rem)] md:w-[calc(50%-1.5rem)] pl-4 md:pl-0 text-sm md:text-right">
                    <div className="font-medium text-foreground text-xs mb-0.5">Rep assigned: Maria S.</div>
                    <time className="text-[10px] text-muted-foreground">11m ago</time>
                  </div>
                </div>

                <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                  <div className="flex items-center justify-center w-3 h-3 rounded-full bg-sky-500 shadow-[0_0_0_3px_hsl(var(--background))] border border-black shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10 absolute left-0 md:left-1/2"></div>
                  <div className="w-[calc(100%-1.5rem)] md:w-[calc(50%-1.5rem)] pl-4 md:pl-0 text-sm">
                    <div className="font-medium text-foreground text-xs mb-0.5">Attached to existing opp #4821</div>
                    <div className="text-[10px] text-muted-foreground mb-0.5">Auto, manual override available</div>
                    <time className="text-[10px] text-muted-foreground">11m ago</time>
                  </div>
                </div>

              </div>
            </div>

          </div>

          {/* Quick Actions Strip */}
          <div className="border-t border-border bg-card p-3 flex items-center justify-center gap-2 text-xs">
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              Send reply
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              Log call
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              Add note
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              Create task
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
