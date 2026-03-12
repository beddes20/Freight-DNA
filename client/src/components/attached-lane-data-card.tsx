import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  Paperclip,
  AlertTriangle,
  MapPin,
  Warehouse,
  ArrowRightLeft,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";

interface LaneDataAttachment {
  type: string;
  label: string;
  items: any[];
}

interface AttachedLaneDataCardProps {
  attachedLaneData: LaneDataAttachment[];
  companyId?: string | null;
}

const typeIcons: Record<string, any> = {
  action_required: AlertTriangle,
  facility_coverage: MapPin,
  lane_patterns_shipping_receiving: Warehouse,
  lane_matching: ArrowRightLeft,
};

const typeColors: Record<string, string> = {
  action_required: "text-amber-600 dark:text-amber-400",
  facility_coverage: "text-blue-600 dark:text-blue-400",
  lane_patterns_shipping_receiving: "text-purple-600 dark:text-purple-400",
  lane_matching: "text-green-600 dark:text-green-400",
};

const tabSections: Record<string, string> = {
  action_required: "rfp",
  facility_coverage: "analysis",
  lane_patterns_shipping_receiving: "analysis",
  lane_matching: "analysis",
};

function renderItems(type: string, items: any[]) {
  if (type === "action_required") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-1.5 font-medium">Lane</th>
              <th className="p-1.5 font-medium">Volume</th>
              <th className="p-1.5 font-medium">Rate</th>
              <th className="p-1.5 font-medium">RFP</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 15).map((item: any, i: number) => (
              <tr key={i} className="border-b border-dashed last:border-0">
                <td className="p-1.5 max-w-[200px] truncate" data-testid={`text-attached-lane-${i}`}>{item.lane || `${item.origin || ""} → ${item.destination || ""}`}</td>
                <td className="p-1.5 tabular-nums">{item.volume?.toLocaleString()}</td>
                <td className="p-1.5">{item.rate || "—"}</td>
                <td className="p-1.5 max-w-[120px] truncate text-muted-foreground">{item.rfpTitle}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 15 && <p className="text-xs text-muted-foreground mt-1">+{items.length - 15} more</p>}
      </div>
    );
  }

  if (type === "facility_coverage") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-1.5 font-medium">Facility</th>
              <th className="p-1.5 font-medium">Type</th>
              <th className="p-1.5 font-medium">Volume</th>
              <th className="p-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 15).map((item: any, i: number) => (
              <tr key={i} className="border-b border-dashed last:border-0">
                <td className="p-1.5 max-w-[200px] truncate" data-testid={`text-attached-facility-${i}`}>{item.fullName || item.facility}</td>
                <td className="p-1.5 capitalize">{item.type}</td>
                <td className="p-1.5 tabular-nums">{item.totalVolume?.toLocaleString()}</td>
                <td className="p-1.5">
                  {item.covered ? (
                    <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Covered</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Gap</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 15 && <p className="text-xs text-muted-foreground mt-1">+{items.length - 15} more</p>}
      </div>
    );
  }

  if (type === "lane_patterns_shipping_receiving") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-1.5 font-medium">Hub</th>
              <th className="p-1.5 font-medium">Inbound</th>
              <th className="p-1.5 font-medium">Outbound</th>
              <th className="p-1.5 font-medium">Total Vol</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 15).map((item: any, i: number) => (
              <tr key={i} className="border-b border-dashed last:border-0">
                <td className="p-1.5 max-w-[200px] truncate" data-testid={`text-attached-hub-${i}`}>{item.fullName || item.facility}</td>
                <td className="p-1.5 tabular-nums">{item.inboundVolume?.toLocaleString()}</td>
                <td className="p-1.5 tabular-nums">{item.outboundVolume?.toLocaleString()}</td>
                <td className="p-1.5 tabular-nums">{item.totalVolume?.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 15 && <p className="text-xs text-muted-foreground mt-1">+{items.length - 15} more</p>}
      </div>
    );
  }

  if (type === "lane_matching") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-1.5 font-medium">Customer Lane</th>
              <th className="p-1.5 font-medium">Volume</th>
              <th className="p-1.5 font-medium">Our Location</th>
              <th className="p-1.5 font-medium">Distance</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 15).map((item: any, i: number) => (
              <tr key={i} className="border-b border-dashed last:border-0">
                <td className="p-1.5 max-w-[180px] truncate" data-testid={`text-attached-match-${i}`}>{item.customerLane}</td>
                <td className="p-1.5 tabular-nums">{item.customerVolume?.toLocaleString()}</td>
                <td className="p-1.5">{item.ourCity}{item.ourState ? `, ${item.ourState}` : ""}</td>
                <td className="p-1.5">{item.distance} mi</td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 15 && <p className="text-xs text-muted-foreground mt-1">+{items.length - 15} more</p>}
      </div>
    );
  }

  return null;
}

export function AttachedLaneDataCard({ attachedLaneData, companyId }: AttachedLaneDataCardProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(attachedLaneData.map(a => a.type)));

  if (!attachedLaneData || attachedLaneData.length === 0) return null;

  const toggleSection = (type: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/20" data-testid="card-attached-lane-data">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Attached Lane Data
          <Badge variant="secondary" className="ml-auto text-xs">{attachedLaneData.length} {attachedLaneData.length === 1 ? "type" : "types"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {attachedLaneData.map((attachment) => {
          const Icon = typeIcons[attachment.type] || Paperclip;
          const color = typeColors[attachment.type] || "text-muted-foreground";
          const expanded = expandedSections.has(attachment.type);
          return (
            <div key={attachment.type} className="border rounded-lg bg-background">
              <button
                type="button"
                onClick={() => toggleSection(attachment.type)}
                className="w-full flex items-center justify-between p-2.5 text-sm hover:bg-muted/50 transition-colors"
                data-testid={`button-toggle-attached-${attachment.type}`}
              >
                <span className={`flex items-center gap-2 font-medium ${color}`}>
                  <Icon className="h-3.5 w-3.5" />
                  {attachment.label}
                  <span className="text-xs text-muted-foreground font-normal">({attachment.items.length} items)</span>
                </span>
                {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
              {expanded && (
                <div className="px-2.5 pb-2.5">
                  {renderItems(attachment.type, attachment.items)}
                  {companyId && (
                    <Link
                      href={`/companies/${companyId}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
                      data-testid={`link-view-company-${attachment.type}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                      View in Company Page
                    </Link>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
