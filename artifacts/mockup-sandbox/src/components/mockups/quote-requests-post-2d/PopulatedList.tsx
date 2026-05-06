import React, { useState } from "react";
import { 
  ChevronDown, Search, Sparkles, Filter, MoreHorizontal, 
  Clock, MapPin, Mail, ChevronLeft, ChevronRight, InboxIcon, ShieldAlert
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type QuoteStatus = "new" | "quoted" | "won" | "lost" | "no_response";

interface QuoteRow {
  id: string;
  customer: string;
  origin: string;
  dest: string;
  equipment: string;
  requestedRel: string;
  requestedAbs: string;
  ageHours: number;
  pastSla: boolean;
  status: QuoteStatus;
  repName: string;
  repInitials: string;
  confidence: number;
  confidenceLabel: string;
  lastActivity: string;
  isFreeEmail?: boolean;
  isAutoAttached?: boolean;
}

const mockData: QuoteRow[] = [
  { id: "QR-1042", customer: "Lactalis", origin: "BELVIDERE, IL", dest: "STURTEVANT, WI", equipment: "Reefer", requestedRel: "12m ago", requestedAbs: "10:42 AM", ageHours: 0.2, pastSla: false, status: "new", repName: "Maria S.", repInitials: "MS", confidence: 94, confidenceLabel: "high", lastActivity: "Customer replied 12m ago" },
  { id: "QR-1041", customer: "Tyson Foods", origin: "SPRINGDALE, AR", dest: "CHICAGO, IL", equipment: "Reefer", requestedRel: "1h ago", requestedAbs: "9:50 AM", ageHours: 1.1, pastSla: false, status: "quoted", repName: "John D.", repInitials: "JD", confidence: 98, confidenceLabel: "high", lastActivity: "You replied 1h ago" },
  { id: "QR-1040", customer: "ALDI", origin: "BATAVIA, IL", dest: "OAK CREEK, WI", equipment: "Dry Van", requestedRel: "2h ago", requestedAbs: "8:30 AM", ageHours: 2.5, pastSla: true, status: "new", repName: "Sarah K.", repInitials: "SK", confidence: 85, confidenceLabel: "med", lastActivity: "Auto-captured from email" },
  { id: "QR-1039", customer: "Dole", origin: "MONTEREY, CA", dest: "SEATTLE, WA", equipment: "Reefer", requestedRel: "3h ago", requestedAbs: "7:45 AM", ageHours: 3.2, pastSla: false, status: "won", repName: "Mike R.", repInitials: "MR", confidence: 99, confidenceLabel: "high", lastActivity: "Rep marked Won" },
  { id: "QR-1038", customer: "Cargill Refrigerated", origin: "WICHITA, KS", dest: "DALLAS, TX", equipment: "Reefer", requestedRel: "4h ago", requestedAbs: "6:20 AM", ageHours: 4.5, pastSla: false, status: "lost", repName: "Maria S.", repInitials: "MS", confidence: 92, confidenceLabel: "high", lastActivity: "Customer declined (price)" },
  { id: "QR-1037", customer: "FedEx Supply Chain", origin: "MEMPHIS, TN", dest: "ATLANTA, GA", equipment: "Dry Van", requestedRel: "5h ago", requestedAbs: "5:15 AM", ageHours: 5.8, pastSla: false, status: "no_response", repName: "John D.", repInitials: "JD", confidence: 88, confidenceLabel: "med", lastActivity: "Quote sent 4h ago" },
  { id: "QR-1036", customer: "Unknown — needs review", origin: "FONTANA, CA", dest: "PHOENIX, AZ", equipment: "Dry Van", requestedRel: "6h ago", requestedAbs: "4:00 AM", ageHours: 6.0, pastSla: false, status: "new", repName: "Unassigned", repInitials: "--", confidence: 45, confidenceLabel: "low", lastActivity: "Low confidence — review", isFreeEmail: true },
  { id: "QR-1035", customer: "Lactalis", origin: "NAMPA, ID", dest: "SALT LAKE CITY, UT", equipment: "Reefer", requestedRel: "7h ago", requestedAbs: "3:30 AM", ageHours: 7.5, pastSla: false, status: "quoted", repName: "Sarah K.", repInitials: "SK", confidence: 95, confidenceLabel: "high", lastActivity: "Sent quote $2,180 (4 min ago)" },
  { id: "QR-1034", customer: "Tyson Foods", origin: "OMAHA, NE", dest: "DENVER, CO", equipment: "Reefer", requestedRel: "8h ago", requestedAbs: "2:10 AM", ageHours: 8.8, pastSla: false, status: "new", repName: "Mike R.", repInitials: "MR", confidence: 91, confidenceLabel: "high", lastActivity: "Auto-captured from email" },
  { id: "QR-1033", customer: "ALDI", origin: "VALPARAISO, IN", dest: "INDIANAPOLIS, IN", equipment: "Dry Van", requestedRel: "9h ago", requestedAbs: "1:45 AM", ageHours: 9.2, pastSla: false, status: "won", repName: "Maria S.", repInitials: "MS", confidence: 97, confidenceLabel: "high", lastActivity: "Rep marked Won" },
  { id: "QR-1032", customer: "Dole", origin: "SALINAS, CA", dest: "PORTLAND, OR", equipment: "Reefer", requestedRel: "10h ago", requestedAbs: "12:30 AM", ageHours: 10.5, pastSla: false, status: "quoted", repName: "John D.", repInitials: "JD", confidence: 93, confidenceLabel: "high", lastActivity: "You replied 9h ago" },
  { id: "QR-1031", customer: "Cargill Refrigerated", origin: "DODGE CITY, KS", dest: "HOUSTON, TX", equipment: "Reefer", requestedRel: "11h ago", requestedAbs: "11:20 PM", ageHours: 11.8, pastSla: false, status: "new", repName: "Sarah K.", repInitials: "SK", confidence: 89, confidenceLabel: "med", lastActivity: "Auto-captured from email" },
  { id: "QR-1030", customer: "FedEx Supply Chain", origin: "INDIANAPOLIS, IN", dest: "COLUMBUS, OH", equipment: "Dry Van", requestedRel: "12h ago", requestedAbs: "10:15 PM", ageHours: 12.2, pastSla: true, status: "new", repName: "Mike R.", repInitials: "MR", confidence: 96, confidenceLabel: "high", lastActivity: "Customer replied 12h ago" },
  { id: "QR-1029", customer: "Lactalis", origin: "BUFFALO, NY", dest: "BOSTON, MA", equipment: "Reefer", requestedRel: "13h ago", requestedAbs: "9:00 PM", ageHours: 13.5, pastSla: false, status: "won", repName: "Maria S.", repInitials: "MS", confidence: 98, confidenceLabel: "high", lastActivity: "Rep marked Won" },
  { id: "QR-1028", customer: "Tyson Foods", origin: "WILKESBORO, KS", dest: "KANSAS CITY, MO", equipment: "Reefer", requestedRel: "14h ago", requestedAbs: "8:10 PM", ageHours: 14.8, pastSla: false, status: "lost", repName: "John D.", repInitials: "JD", confidence: 94, confidenceLabel: "high", lastActivity: "Customer declined (service)" },
  { id: "QR-1027", customer: "ALDI", origin: "WEBSTER GROVES, MO", dest: "ST. LOUIS, MO", equipment: "Dry Van", requestedRel: "15h ago", requestedAbs: "7:00 PM", ageHours: 15.2, pastSla: false, status: "no_response", repName: "Sarah K.", repInitials: "SK", confidence: 87, confidenceLabel: "med", lastActivity: "Quote sent 14h ago" },
  { id: "QR-1026", customer: "Dole", origin: "YUMA, AZ", dest: "LOS ANGELES, CA", equipment: "Reefer", requestedRel: "16h ago", requestedAbs: "6:15 PM", ageHours: 16.5, pastSla: false, status: "new", repName: "Mike R.", repInitials: "MR", confidence: 92, confidenceLabel: "high", lastActivity: "Auto-captured from email" }
];

const statusColors = {
  new: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  quoted: "bg-sky-500/15 text-sky-500 border-sky-500/30",
  won: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  lost: "bg-red-500/15 text-red-500 border-red-500/30",
  no_response: "bg-muted text-muted-foreground border-border"
};

const statusLabels = {
  new: "New",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
  no_response: "No Response"
};

export default function PopulatedList() {
  const [selectedId, setSelectedId] = useState<string>("QR-1042");

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
          <div className="text-2xl font-bold mt-1">42</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Awaiting your reply</div>
          <div className="text-2xl font-bold mt-1">14</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-red-500 uppercase tracking-wider font-semibold">Past SLA</div>
          <div className="text-2xl font-bold mt-1 text-red-500">3</div>
        </div>
        <div className="flex-1 bg-card border border-border rounded-md p-3 flex flex-col justify-center">
          <div className="text-xs text-emerald-500 uppercase tracking-wider font-semibold">Won today</div>
          <div className="text-2xl font-bold mt-1 text-emerald-500">12</div>
        </div>
        <div className="flex-1 bg-amber-500/10 border border-amber-500/20 rounded-md p-3 flex flex-col justify-center cursor-pointer hover:bg-amber-500/15 transition-colors">
          <div className="flex items-center gap-1.5 text-xs text-amber-600 uppercase tracking-wider font-semibold">
            <Sparkles className="h-3 w-3" />
            Auto-captured today
          </div>
          <div className="text-2xl font-bold mt-1 text-amber-500">23</div>
        </div>
      </div>

      {/* Filter Row */}
      <div className="px-6 py-3 border-b border-border flex items-center justify-between bg-card/30">
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Lane, customer, sender, notes" 
              className="pl-8 h-8 text-xs bg-background"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="h-6 rounded-sm bg-muted text-foreground cursor-pointer">All</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-amber-500/30 text-amber-500 cursor-pointer">New</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-sky-500/30 text-sky-500 cursor-pointer">Quoted</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-emerald-500/30 text-emerald-500 cursor-pointer">Won</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-red-500/30 text-red-500 cursor-pointer">Lost</Badge>
            <Badge variant="outline" className="h-6 rounded-sm border-border text-muted-foreground cursor-pointer">No-response</Badge>
          </div>
          <div className="h-4 w-px bg-border mx-1"></div>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="h-6 rounded-sm bg-muted text-foreground cursor-pointer">Today</Badge>
            <Badge variant="outline" className="h-6 rounded-sm cursor-pointer">24h</Badge>
            <Badge variant="outline" className="h-6 rounded-sm cursor-pointer">7d</Badge>
            <Badge variant="outline" className="h-6 rounded-sm cursor-pointer">30d</Badge>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
          <label className="flex items-center gap-2 cursor-pointer hover:text-foreground">
            <input type="checkbox" className="rounded bg-background border-border accent-amber-500" />
            Mine only
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:text-foreground">
            <input type="checkbox" className="rounded bg-background border-border accent-amber-500" />
            Free-email senders
          </label>
          <Badge variant="outline" className="h-6 gap-1 cursor-pointer">
            <Filter className="h-3 w-3" />
            Domain
          </Badge>
        </div>
      </div>

      {/* Automation Strip */}
      <div className="px-6 py-1.5 bg-muted/30 border-b border-border text-[11px] text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="font-semibold text-foreground">Phase 2b Auto-capture:</span>
          <span>Created <strong className="text-foreground">47</strong></span>
          <span className="text-border">•</span>
          <span>Attached <strong className="text-foreground">12</strong></span>
          <span className="text-border">•</span>
          <span>Skipped (internal) <strong className="text-foreground">3</strong></span>
          <span className="text-border">•</span>
          <span>Skipped (low conf) <strong className="text-foreground">5</strong></span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">j/k</span> navigate
          <span className="ml-2 bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">enter</span> open
          <span className="ml-2 bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">e</span> assign
          <span className="ml-2 bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">w</span> won
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto bg-card">
        <table className="w-full text-left text-[13px] border-collapse">
          <thead className="sticky top-0 bg-card z-10 border-b border-border shadow-sm">
            <tr className="text-muted-foreground uppercase tracking-wider text-[10px] font-semibold">
              <th className="w-6 py-2 px-3"></th>
              <th className="py-2 px-3">Customer</th>
              <th className="py-2 px-3">Lane</th>
              <th className="py-2 px-3">Requested</th>
              <th className="py-2 px-3">Age</th>
              <th className="py-2 px-3">Status</th>
              <th className="py-2 px-3">Assigned</th>
              <th className="py-2 px-3">Confidence</th>
              <th className="py-2 px-3">Last Activity</th>
              <th className="w-10 py-2 px-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {mockData.map((row) => (
              <tr 
                key={row.id} 
                onClick={() => setSelectedId(row.id)}
                className={`group h-[36px] cursor-pointer transition-colors ${selectedId === row.id ? "bg-amber-500/10 hover:bg-amber-500/15" : "hover:bg-muted/50"}`}
              >
                <td className="px-3 text-center">
                  <div className={`w-1.5 h-1.5 rounded-full mx-auto ${row.status === 'new' ? 'bg-amber-500' : row.status === 'quoted' ? 'bg-sky-500' : 'bg-transparent'}`} />
                </td>
                <td className="px-3 font-medium whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    {row.customer}
                    {row.isFreeEmail && <Badge variant="outline" className="h-4 px-1 text-[9px] border-amber-500/50 text-amber-500 bg-amber-500/10">gmail.com</Badge>}
                  </div>
                </td>
                <td className="px-3 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{row.origin}</span>
                    <span className="text-muted-foreground text-[10px]">→</span>
                    <span className="font-medium text-foreground">{row.dest}</span>
                    <span className="text-muted-foreground text-[11px] ml-1">· {row.equipment}</span>
                  </div>
                </td>
                <td className="px-3 whitespace-nowrap text-muted-foreground relative group/time">
                  {row.requestedRel}
                  <div className="absolute hidden group-hover/time:block bottom-full left-0 mb-1 bg-popover border border-border text-popover-foreground text-[10px] px-2 py-1 rounded shadow-md whitespace-nowrap z-20">
                    {row.requestedAbs}
                  </div>
                </td>
                <td className="px-3 whitespace-nowrap">
                  <div className={`inline-flex items-center justify-center w-8 h-5 rounded-full text-[11px] font-medium ${row.pastSla ? "border border-red-500 text-red-500 bg-red-500/10" : "text-muted-foreground"}`}>
                    {row.ageHours}h
                  </div>
                </td>
                <td className="px-3 whitespace-nowrap">
                  <Badge variant="outline" className={`h-5 text-[10px] font-medium uppercase tracking-wider ${statusColors[row.status]}`}>
                    {statusLabels[row.status]}
                  </Badge>
                </td>
                <td className="px-3 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-5 w-5 border border-border">
                      <AvatarFallback className="text-[9px] bg-muted">{row.repInitials}</AvatarFallback>
                    </Avatar>
                    <span className={row.repName === "Unassigned" ? "text-muted-foreground italic" : "text-foreground"}>{row.repName}</span>
                  </div>
                </td>
                <td className="px-3 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${row.confidence > 90 ? "bg-emerald-500" : row.confidence > 80 ? "bg-amber-500" : "bg-red-500"}`} 
                        style={{ width: `${row.confidence}%` }}
                      />
                    </div>
                    <span className="text-muted-foreground text-[11px] w-12">{row.confidence} · {row.confidenceLabel}</span>
                  </div>
                </td>
                <td className="px-3 whitespace-nowrap text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    {row.isAutoAttached && <Badge variant="outline" className="h-4 px-1 text-[9px] border-sky-500/30 text-sky-500 bg-sky-500/10 mr-1">auto-attached</Badge>}
                    {row.confidence < 50 && <Badge variant="outline" className="h-4 px-1 text-[9px] border-red-500/30 text-red-500 bg-red-500/10 mr-1">review</Badge>}
                    <span className="truncate max-w-[200px]">{row.lastActivity}</span>
                  </div>
                </td>
                <td className="px-3 text-right">
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="px-6 py-2 border-t border-border flex items-center justify-between bg-card text-xs text-muted-foreground">
        <div>Showing 1–17 of 312</div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 px-2" disabled>
            <ChevronLeft className="h-3 w-3 mr-1" /> Prev
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2">
            Next <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
