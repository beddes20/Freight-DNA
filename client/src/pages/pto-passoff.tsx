import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plane, Plus, Trash2, ChevronDown, ChevronRight, Shield, Pencil,
  AlertTriangle, Phone, Users, ClipboardList, Briefcase, CheckCircle2,
  FileText, Package, Clock, UserCheck, Mail, Database, TrendingUp
} from "lucide-react";
import type { Company } from "@shared/schema";

type PtoPassoffItem = {
  companyName?: string | null;
  id: string;
  passoffId: string;
  companyId: string | null;
  priority: string;
  spotFreightHandler: string | null;
  keyCustomerContact: string | null;
  openItems: string | null;
  processNotes: string | null;
  activeDeals: string | null;
  acknowledged: boolean;
  emailForwardingSet: boolean;
  spotBoardUpdated: boolean;
  avgWeeklySpotLoads: string | null;
  avgWeeklyTotalLoads: string | null;
};

type PassoffWithItems = {
  id: string;
  createdById: string;
  coveringUserId: string | null;
  startDate: string;
  endDate: string;
  emergencyContact: string | null;
  generalNotes: string | null;
  status: string;
  createdAt: string;
  items: PtoPassoffItem[];
};

type SafeUser = { id: string; name: string; role: string };

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  active: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  completed: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300",
  medium: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function PassoffDialog({
  passoff,
  users,
  companies,
  onClose,
}: {
  passoff?: PassoffWithItems;
  users: SafeUser[];
  companies: Company[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [startDate, setStartDate] = useState(passoff?.startDate ?? "");
  const [endDate, setEndDate] = useState(passoff?.endDate ?? "");
  const [coveringUserId, setCoveringUserId] = useState(passoff?.coveringUserId ?? "none");
  const [emergencyContact, setEmergencyContact] = useState(passoff?.emergencyContact ?? "");
  const [generalNotes, setGeneralNotes] = useState(passoff?.generalNotes ?? "");
  const [status, setStatus] = useState(passoff?.status ?? "draft");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [accountSearch, setAccountSearch] = useState("");
  const [showAccountList, setShowAccountList] = useState(false);

  const sortedCompanies = [...companies].sort((a, b) => a.name.localeCompare(b.name));
  const filteredCompanies = sortedCompanies.filter(c =>
    c.name.toLowerCase().includes(accountSearch.toLowerCase())
  );
  const allSelected = sortedCompanies.length > 0 && sortedCompanies.every(c => selectedCompanyIds.has(c.id));

  const toggleCompany = (id: string) => {
    setSelectedCompanyIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedCompanyIds(new Set());
    } else {
      setSelectedCompanyIds(new Set(sortedCompanies.map(c => c.id)));
    }
  };

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/pto-passoffs", data);
      const created = await res.json();
      if (selectedCompanyIds.size > 0) {
        for (const companyId of selectedCompanyIds) {
          await apiRequest("POST", `/api/pto-passoffs/${created.id}/items`, { companyId, priority: "medium" });
        }
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] });
      toast({ title: "PTO passoff created" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to create passoff", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/pto-passoffs/${passoff!.id}`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] });
      toast({ title: "Passoff updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update passoff", variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!startDate || !endDate) {
      toast({ title: "Please enter start and end dates", variant: "destructive" });
      return;
    }
    const data = {
      startDate,
      endDate,
      coveringUserId: coveringUserId === "none" ? null : coveringUserId,
      emergencyContact: emergencyContact || null,
      generalNotes: generalNotes || null,
      status,
    };
    passoff ? updateMutation.mutate(data) : createMutation.mutate(data);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Start Date (Out)</Label>
          <Input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            required
            data-testid="input-pto-start"
          />
        </div>
        <div className="space-y-1.5">
          <Label>End Date (Return)</Label>
          <Input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            required
            data-testid="input-pto-end"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Who Is Covering?</Label>
        <Select value={coveringUserId} onValueChange={setCoveringUserId}>
          <SelectTrigger data-testid="select-pto-covering">
            <SelectValue placeholder="Select a teammate" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not assigned yet</SelectItem>
            {[...users].sort((a, b) => a.name.localeCompare(b.name)).map(u => (
              <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          <Phone className="w-3.5 h-3.5 text-muted-foreground" />
          Emergency Contact (for urgent issues)
        </Label>
        <Input
          placeholder="e.g. 480-555-1234 or email"
          value={emergencyContact}
          onChange={e => setEmergencyContact(e.target.value)}
          data-testid="input-pto-emergency"
        />
      </div>
      <div className="space-y-1.5">
        <Label>General Notes</Label>
        <Textarea
          placeholder="Anything the covering person should know in general..."
          value={generalNotes}
          onChange={e => setGeneralNotes(e.target.value)}
          rows={2}
          data-testid="textarea-pto-notes"
        />
      </div>

      {!passoff && companies.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <Briefcase className="w-3.5 h-3.5 text-muted-foreground" />
              Accounts to Include
              {selectedCompanyIds.size > 0 && (
                <Badge variant="secondary" className="ml-1 text-xs">{selectedCompanyIds.size} selected</Badge>
              )}
            </Label>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              data-testid="button-select-all-accounts"
            >
              {allSelected ? "Clear all" : "Select all"}
            </button>
          </div>
          <Input
            placeholder="Click to search accounts…"
            value={accountSearch}
            onChange={e => setAccountSearch(e.target.value)}
            onFocus={() => setShowAccountList(true)}
            className="h-8 text-sm"
            data-testid="input-search-accounts"
          />
          {showAccountList && (
            <div className="border rounded-md max-h-44 overflow-y-auto divide-y">
              {filteredCompanies.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-3 italic">No accounts match</p>
              ) : (
                filteredCompanies.map(c => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2.5 px-3 py-2 hover:bg-muted/40 cursor-pointer text-sm"
                    data-testid={`label-account-${c.id}`}
                  >
                    <Checkbox
                      checked={selectedCompanyIds.has(c.id)}
                      onCheckedChange={() => toggleCompany(c.id)}
                      data-testid={`checkbox-account-${c.id}`}
                    />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label>Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger data-testid="select-pto-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft – Still preparing</SelectItem>
            <SelectItem value="active">Active – I am out</SelectItem>
            <SelectItem value="completed">Completed – Back from PTO</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" className="w-full bg-gradient-to-r from-blue-600 to-green-600" disabled={isPending} data-testid="button-save-passoff">
        {isPending ? "Saving..." : passoff ? "Update Passoff" : `Create Passoff${selectedCompanyIds.size > 0 ? ` with ${selectedCompanyIds.size} account${selectedCompanyIds.size !== 1 ? "s" : ""}` : ""}`}
      </Button>
    </form>
  );
}

function AccountItemEditor({
  item,
  companyName,
  passoffId,
  isOwner,
  isCovering,
}: {
  item: PtoPassoffItem;
  companyName: string;
  passoffId: string;
  isOwner: boolean;
  isCovering: boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [priority, setPriority] = useState(item.priority);
  const [spotFreightHandler, setSpotFreightHandler] = useState(item.spotFreightHandler ?? "");
  const [keyCustomerContact, setKeyCustomerContact] = useState(item.keyCustomerContact ?? "");
  const [openItems, setOpenItems] = useState(item.openItems ?? "");
  const [processNotes, setProcessNotes] = useState(item.processNotes ?? "");
  const [activeDeals, setActiveDeals] = useState(item.activeDeals ?? "");
  const [emailForwardingSet, setEmailForwardingSet] = useState(item.emailForwardingSet);
  const [spotBoardUpdated, setSpotBoardUpdated] = useState(item.spotBoardUpdated);
  const [avgWeeklySpotLoads, setAvgWeeklySpotLoads] = useState(item.avgWeeklySpotLoads ?? "");
  const [avgWeeklyTotalLoads, setAvgWeeklyTotalLoads] = useState(item.avgWeeklyTotalLoads ?? "");

  const updateMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("PATCH", `/api/pto-passoffs/${passoffId}/items/${item.id}`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] });
      setEditing(false);
    },
    onError: () => toast({ title: "Error saving", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiRequest("DELETE", `/api/pto-passoffs/${passoffId}/items/${item.id}`).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] }),
    onError: () => toast({ title: "Error removing account", variant: "destructive" }),
  });

  const handleSave = () => {
    updateMutation.mutate({
      priority, spotFreightHandler, keyCustomerContact, openItems, processNotes, activeDeals,
      emailForwardingSet, spotBoardUpdated,
      avgWeeklySpotLoads: avgWeeklySpotLoads !== "" ? avgWeeklySpotLoads : null,
      avgWeeklyTotalLoads: avgWeeklyTotalLoads !== "" ? avgWeeklyTotalLoads : null,
    });
  };

  const handleAck = (checked: boolean) => {
    updateMutation.mutate({ acknowledged: checked });
  };

  const handleToggle = (field: "emailForwardingSet" | "spotBoardUpdated", checked: boolean) => {
    updateMutation.mutate({ [field]: checked });
    if (field === "emailForwardingSet") setEmailForwardingSet(checked);
    else setSpotBoardUpdated(checked);
  };

  const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);

  return (
    <div className={`border rounded-lg p-4 space-y-3 ${item.acknowledged ? "opacity-70" : ""} ${PRIORITY_COLORS[priority] || ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Briefcase className="w-4 h-4 shrink-0" />
          <span className="font-semibold truncate">{companyName}</span>
          <Badge variant="outline" className="text-xs shrink-0">{priorityLabel} Priority</Badge>
          {item.acknowledged && (
            <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 text-xs shrink-0">
              <CheckCircle2 className="w-3 h-3 mr-1" />Acknowledged
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isCovering && (
            <div className="flex items-center gap-1.5 mr-2">
              <Checkbox
                id={`ack-${item.id}`}
                checked={item.acknowledged}
                onCheckedChange={handleAck}
                data-testid={`checkbox-ack-${item.id}`}
              />
              <label htmlFor={`ack-${item.id}`} className="text-xs font-medium cursor-pointer">I've reviewed</label>
            </div>
          )}
          {isOwner && (
            <>
              <Button variant="ghost" size="icon" onClick={() => setEditing(!editing)} data-testid={`button-edit-item-${item.id}`}>
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-red-500 hover:text-red-700"
                onClick={() => deleteMutation.mutate()}
                data-testid={`button-delete-item-${item.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {isOwner && (
        <div className="flex flex-col sm:flex-row gap-2 pt-1 border-t border-black/10 dark:border-white/10">
          <div className="flex items-center gap-2 text-xs flex-1" data-testid={`label-email-fwd-${item.id}`}>
            <Checkbox
              checked={item.emailForwardingSet}
              onCheckedChange={(v) => handleToggle("emailForwardingSet", !!v)}
              data-testid={`checkbox-email-fwd-${item.id}`}
            />
            <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span
              className={`cursor-pointer select-none ${item.emailForwardingSet ? "line-through text-muted-foreground" : ""}`}
              onClick={() => handleToggle("emailForwardingSet", !item.emailForwardingSet)}
            >
              Autoforwarding emails to rep covering?
            </span>
            {item.emailForwardingSet && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
          </div>
          <div className="flex items-center gap-2 text-xs flex-1" data-testid={`label-spot-board-${item.id}`}>
            <Checkbox
              checked={item.spotBoardUpdated}
              onCheckedChange={(v) => handleToggle("spotBoardUpdated", !!v)}
              data-testid={`checkbox-spot-board-${item.id}`}
            />
            <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span
              className={`cursor-pointer select-none ${item.spotBoardUpdated ? "line-through text-muted-foreground" : ""}`}
              onClick={() => handleToggle("spotBoardUpdated", !item.spotBoardUpdated)}
            >
              Spot board/portal info up to date?
            </span>
            {item.spotBoardUpdated && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
          </div>
        </div>
      )}

      {!isOwner && (
        <div className="flex flex-col sm:flex-row gap-3 pt-1 border-t border-black/10 dark:border-white/10 text-xs">
          <span className={`flex items-center gap-1.5 ${item.emailForwardingSet ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
            <Mail className="w-3.5 h-3.5" />
            Autoforward: {item.emailForwardingSet ? "✓ Set" : "Not set"}
          </span>
          <span className={`flex items-center gap-1.5 ${item.spotBoardUpdated ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
            <Database className="w-3.5 h-3.5" />
            Spot board: {item.spotBoardUpdated ? "✓ Updated" : "Not updated"}
          </span>
        </div>
      )}

      {editing && isOwner ? (
        <div className="space-y-3 bg-background/70 rounded p-3 border">
          <div className="space-y-1">
            <Label className="text-xs">Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">🔴 High – Can't miss this one</SelectItem>
                <SelectItem value="medium">🟡 Medium – Keep an eye on</SelectItem>
                <SelectItem value="low">🟢 Low – Low touch needed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><Package className="w-3 h-3" />Who Handles Spot Freight</Label>
            <Input
              className="h-8 text-sm"
              placeholder="e.g. Jason Allen or call dispatch"
              value={spotFreightHandler}
              onChange={e => setSpotFreightHandler(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><UserCheck className="w-3 h-3" />Key Customer Contact</Label>
            <Input
              className="h-8 text-sm"
              placeholder="e.g. Karen Mitchell – VP of Logistics – 602-555-0198"
              value={keyCustomerContact}
              onChange={e => setKeyCustomerContact(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><ClipboardList className="w-3 h-3" />Open Items / Follow-Ups</Label>
            <Textarea
              className="text-sm"
              placeholder="List any open items, pending callbacks, or things to follow up on..."
              value={openItems}
              onChange={e => setOpenItems(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><FileText className="w-3 h-3" />Process Notes / Account Quirks</Label>
            <Textarea
              className="text-sm"
              placeholder="How does this customer like to operate? Anything special to know?"
              value={processNotes}
              onChange={e => setProcessNotes(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><Briefcase className="w-3 h-3" />Active RFPs / Bids / Hot Deals</Label>
            <Textarea
              className="text-sm"
              placeholder="Any open RFPs, bids in flight, or time-sensitive opportunities?"
              value={activeDeals}
              onChange={e => setActiveDeals(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><TrendingUp className="w-3 h-3" />4-Week Avg Load Acquisition</Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Spot Loads / week</Label>
                <Input
                  className="h-8 text-sm"
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="e.g. 4.5"
                  value={avgWeeklySpotLoads}
                  onChange={e => setAvgWeeklySpotLoads(e.target.value)}
                  data-testid="input-avg-spot-loads"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Total Loads / week</Label>
                <Input
                  className="h-8 text-sm"
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="e.g. 12"
                  value={avgWeeklyTotalLoads}
                  onChange={e => setAvgWeeklyTotalLoads(e.target.value)}
                  data-testid="input-avg-total-loads"
                />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {item.spotFreightHandler && (
            <div>
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-0.5"><Package className="w-3 h-3" />Spot Freight</p>
              <p>{item.spotFreightHandler}</p>
            </div>
          )}
          {item.keyCustomerContact && (
            <div>
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-0.5"><UserCheck className="w-3 h-3" />Key Customer Contact</p>
              <p>{item.keyCustomerContact}</p>
            </div>
          )}
          {item.openItems && (
            <div className="col-span-full">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-0.5"><ClipboardList className="w-3 h-3" />Open Items</p>
              <p className="whitespace-pre-wrap">{item.openItems}</p>
            </div>
          )}
          {item.processNotes && (
            <div className="col-span-full">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-0.5"><FileText className="w-3 h-3" />Process Notes</p>
              <p className="whitespace-pre-wrap">{item.processNotes}</p>
            </div>
          )}
          {item.activeDeals && (
            <div className="col-span-full">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-0.5"><Briefcase className="w-3 h-3" />Active Deals / RFPs</p>
              <p className="whitespace-pre-wrap">{item.activeDeals}</p>
            </div>
          )}
          {(item.avgWeeklySpotLoads || item.avgWeeklyTotalLoads) && (
            <div className="col-span-full border-t pt-2 mt-1">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-2">
                <TrendingUp className="w-3 h-3" />4-Week Avg Load Acquisition
              </p>
              <div className="flex gap-4">
                {item.avgWeeklySpotLoads && (
                  <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg px-3 py-2 text-center min-w-[80px]">
                    <p className="text-lg font-bold text-orange-700 dark:text-orange-300">{Number(item.avgWeeklySpotLoads).toFixed(1)}</p>
                    <p className="text-xs text-orange-600 dark:text-orange-400">Spot / wk</p>
                  </div>
                )}
                {item.avgWeeklyTotalLoads && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 text-center min-w-[80px]">
                    <p className="text-lg font-bold text-blue-700 dark:text-blue-300">{Number(item.avgWeeklyTotalLoads).toFixed(1)}</p>
                    <p className="text-xs text-blue-600 dark:text-blue-400">Total / wk</p>
                  </div>
                )}
              </div>
            </div>
          )}
          {!item.spotFreightHandler && !item.keyCustomerContact && !item.openItems && !item.processNotes && !item.activeDeals && !item.avgWeeklySpotLoads && !item.avgWeeklyTotalLoads && (
            <p className="col-span-full text-muted-foreground text-xs italic">No details filled in yet. {isOwner ? "Click edit to add coverage info." : ""}</p>
          )}
        </div>
      )}
    </div>
  );
}

function PassoffCard({
  passoff,
  users,
  companies,
  currentUserId,
  isAdmin,
}: {
  passoff: PassoffWithItems;
  users: SafeUser[];
  companies: Company[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [addAccountId, setAddAccountId] = useState("none");

  const isOwner = passoff.createdById === currentUserId;
  const isCovering = passoff.coveringUserId === currentUserId;
  const coveringUser = users.find(u => u.id === passoff.coveringUserId);
  const creator = users.find(u => u.id === passoff.createdById);

  const addedCompanyIds = new Set(passoff.items.map(i => i.companyId).filter(Boolean));
  const availableCompanies = companies.filter(c => !addedCompanyIds.has(c.id));

  const acknowledged = passoff.items.filter(i => i.acknowledged).length;
  const total = passoff.items.length;

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/pto-passoffs/${passoff.id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] });
      toast({ title: "Passoff deleted" });
    },
  });

  const addItemMutation = useMutation({
    mutationFn: (companyId: string) =>
      apiRequest("POST", `/api/pto-passoffs/${passoff.id}/items`, { companyId, priority: "medium" }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] });
      setAddAccountId("none");
    },
    onError: () => toast({ title: "Error adding account", variant: "destructive" }),
  });

  const addAllMutation = useMutation({
    mutationFn: async () => {
      for (const c of availableCompanies) {
        await apiRequest("POST", `/api/pto-passoffs/${passoff.id}/items`, { companyId: c.id, priority: "medium" });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pto-passoffs"] });
      toast({ title: `Added ${availableCompanies.length} accounts` });
    },
  });

  const handleAddAccount = (cid: string) => {
    if (cid && cid !== "none") addItemMutation.mutate(cid);
  };

  return (
    <Card data-testid={`card-passoff-${passoff.id}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                  <Plane className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-base">
                      {formatDate(passoff.startDate)} – {formatDate(passoff.endDate)}
                    </CardTitle>
                    <Badge className={`text-xs ${STATUS_COLORS[passoff.status]}`}>
                      {passoff.status.charAt(0).toUpperCase() + passoff.status.slice(1)}
                    </Badge>
                    {total > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {acknowledged}/{total} accounts reviewed
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                    {!isOwner && creator && (
                      <span className="flex items-center gap-1"><Users className="w-3 h-3" />Created by {creator.name}</span>
                    )}
                    {coveringUser ? (
                      <span className="flex items-center gap-1"><UserCheck className="w-3 h-3" />Covered by {coveringUser.name}</span>
                    ) : (
                      <span className="text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />No cover assigned</span>
                    )}
                    {passoff.emergencyContact && (
                      <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{passoff.emergencyContact}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(isOwner || isAdmin) && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={e => { e.stopPropagation(); setEditOpen(true); }}
                      data-testid={`button-edit-passoff-${passoff.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-500 hover:text-red-700"
                      onClick={e => { e.stopPropagation(); deleteMutation.mutate(); }}
                      data-testid={`button-delete-passoff-${passoff.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </>
                )}
                {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-4 px-4 space-y-4">
            {passoff.generalNotes && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-3 text-sm">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />General Notes
                </p>
                <p className="whitespace-pre-wrap text-amber-900 dark:text-amber-200">{passoff.generalNotes}</p>
              </div>
            )}

            {total > 0 && (
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-muted rounded-full h-1.5">
                  <div
                    className="bg-green-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${total > 0 ? (acknowledged / total) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">{acknowledged}/{total} reviewed</span>
              </div>
            )}

            <div className="space-y-3">
              {passoff.items.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4 italic">
                  No accounts added yet. {isOwner ? "Add accounts below to build the checklist." : ""}
                </p>
              )}
              {passoff.items.map(item => (
                <AccountItemEditor
                  key={item.id}
                  item={item}
                  companyName={item.companyName ?? companies.find(c => c.id === item.companyId)?.name ?? "Unknown Account"}
                  passoffId={passoff.id}
                  isOwner={isOwner || isAdmin}
                  isCovering={isCovering}
                />
              ))}
            </div>

            {(isOwner || isAdmin) && availableCompanies.length > 0 && (
              <div className="flex gap-2 items-center pt-2 border-t">
                <Select value={addAccountId} onValueChange={v => { setAddAccountId(v); handleAddAccount(v); }}>
                  <SelectTrigger className="flex-1 h-8 text-sm" data-testid="select-add-account">
                    <SelectValue placeholder="+ Add an account…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select an account…</SelectItem>
                    {availableCompanies
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {availableCompanies.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => addAllMutation.mutate()}
                    disabled={addAllMutation.isPending}
                    data-testid="button-add-all-accounts"
                  >
                    Add All ({availableCompanies.length})
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit PTO Passoff</DialogTitle>
          </DialogHeader>
          <PassoffDialog passoff={passoff} users={users} companies={[]} onClose={() => setEditOpen(false)} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function PtoPassoffPage() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: passoffs = [], isLoading } = useQuery<PassoffWithItems[]>({
    queryKey: ["/api/pto-passoffs"],
  });

  const { data: users = [] } = useQuery<SafeUser[]>({ queryKey: ["/api/users"] });
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["/api/companies"] });

  if (!currentUser) return null;

  const isAdmin = currentUser.role === "admin" || currentUser.role === "director";

  const myPassoffs = passoffs.filter(p => p.createdById === currentUser.id);
  const coveringPassoffs = passoffs.filter(p => p.coveringUserId === currentUser.id && p.createdById !== currentUser.id);

  const activeCount = passoffs.filter(p => p.status === "active").length;
  const myPendingAcks = coveringPassoffs.reduce((sum, p) =>
    sum + p.items.filter(i => !i.acknowledged).length, 0);

  const otherUsers = users.filter(u => u.id !== currentUser.id);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-pto-title">
            <Plane className="w-6 h-6 text-blue-600" />
            PTO Passoff
          </h1>
          <p className="text-muted-foreground mt-1">
            Ensure seamless account coverage when you're out
          </p>
        </div>
        <Button
          className="bg-gradient-to-r from-blue-600 to-green-600 hover:from-blue-700 hover:to-green-700"
          onClick={() => setCreateOpen(true)}
          data-testid="button-create-passoff"
        >
          <Plus className="w-4 h-4 mr-2" />New Passoff
        </Button>
      </div>

      {(activeCount > 0 || myPendingAcks > 0) && (
        <div className="flex gap-3 flex-wrap">
          {activeCount > 0 && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-green-700 dark:text-green-300">
              <Clock className="w-4 h-4" />
              {activeCount} active passoff{activeCount !== 1 ? "s" : ""} in progress
            </div>
          )}
          {myPendingAcks > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4" />
              You have {myPendingAcks} account{myPendingAcks !== 1 ? "s" : ""} to review
            </div>
          )}
        </div>
      )}

      <Tabs defaultValue={coveringPassoffs.length > 0 ? "covering" : "mine"}>
        <TabsList>
          <TabsTrigger value="mine" data-testid="tab-my-passoffs">
            My Passoffs {myPassoffs.length > 0 && `(${myPassoffs.length})`}
          </TabsTrigger>
          <TabsTrigger value="covering" data-testid="tab-covering">
            I'm Covering {coveringPassoffs.length > 0 && `(${coveringPassoffs.length})`}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="all" data-testid="tab-all-passoffs">
              All Active
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="mine" className="mt-4 space-y-4">
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading…</div>
          ) : myPassoffs.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <Plane className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="font-medium text-muted-foreground">No passoffs yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Create one before your next PTO to keep your accounts covered.
                </p>
                <Button className="mt-4" onClick={() => setCreateOpen(true)} data-testid="button-create-first-passoff">
                  <Plus className="w-4 h-4 mr-2" />Create Your First Passoff
                </Button>
              </CardContent>
            </Card>
          ) : (
            myPassoffs.map(p => (
              <PassoffCard
                key={p.id}
                passoff={p}
                users={users}
                companies={companies.filter(c => c.assignedTo === currentUser.id)}
                currentUserId={currentUser.id}
                isAdmin={isAdmin}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="covering" className="mt-4 space-y-4">
          {coveringPassoffs.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <Shield className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="font-medium text-muted-foreground">Not covering anyone right now</p>
                <p className="text-sm text-muted-foreground mt-1">
                  When a teammate sets you as their cover, their passoff will appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            coveringPassoffs.map(p => {
              const creator = users.find(u => u.id === p.createdById);
              const creatorCompanies = companies.filter(c => c.assignedTo === p.createdById);
              return (
                <div key={p.id} className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                    <Users className="w-3.5 h-3.5" />
                    Passoff from <span className="font-semibold text-foreground">{creator?.name ?? "Unknown"}</span>
                  </div>
                  <PassoffCard
                    passoff={p}
                    users={users}
                    companies={creatorCompanies}
                    currentUserId={currentUser.id}
                    isAdmin={isAdmin}
                  />
                </div>
              );
            })
          )}
        </TabsContent>

        {isAdmin && (
          <TabsContent value="all" className="mt-4 space-y-4">
            {passoffs.length === 0 ? (
              <Card>
                <CardContent className="text-center py-12">
                  <p className="text-muted-foreground">No passoffs in the system yet.</p>
                </CardContent>
              </Card>
            ) : (
              passoffs.map(p => {
                const creator = users.find(u => u.id === p.createdById);
                const creatorCompanies = companies.filter(c => c.assignedTo === p.createdById);
                return (
                  <div key={p.id} className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                      <Users className="w-3.5 h-3.5" />
                      <span className="font-semibold text-foreground">{creator?.name ?? "Unknown"}'s</span> passoff
                    </div>
                    <PassoffCard
                      passoff={p}
                      users={users}
                      companies={creatorCompanies}
                      currentUserId={currentUser.id}
                      isAdmin={isAdmin}
                    />
                  </div>
                );
              })
            )}
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create PTO Passoff</DialogTitle>
          </DialogHeader>
          <PassoffDialog
            users={users}
            companies={(() => {
              const mine = companies.filter(c => c.assignedTo === currentUser.id);
              return mine.length > 0 ? mine : companies;
            })()}
            onClose={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
