import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BookOpen, FolderOpen, ExternalLink, Wrench, Link, Globe, FileText, Video, Star, Plus, Pencil, Trash2, GraduationCap, BarChart2, Shield, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ToolLink } from "@shared/schema";

const ICON_OPTIONS = [
  { name: "Link", icon: Link },
  { name: "BookOpen", icon: BookOpen },
  { name: "FolderOpen", icon: FolderOpen },
  { name: "Globe", icon: Globe },
  { name: "FileText", icon: FileText },
  { name: "Video", icon: Video },
  { name: "Star", icon: Star },
  { name: "Wrench", icon: Wrench },
  { name: "GraduationCap", icon: GraduationCap },
  { name: "BarChart2", icon: BarChart2 },
  { name: "Shield", icon: Shield },
];

const COLOR_OPTIONS = [
  { label: "Blue", value: "from-blue-500 to-blue-600" },
  { label: "Green", value: "from-green-500 to-green-600" },
  { label: "Purple", value: "from-purple-500 to-purple-600" },
  { label: "Orange", value: "from-orange-500 to-orange-600" },
  { label: "Red", value: "from-red-500 to-red-600" },
  { label: "Teal", value: "from-teal-500 to-teal-600" },
  { label: "Indigo", value: "from-indigo-500 to-indigo-600" },
];

const DEFAULT_LINKS: Omit<ToolLink, "id" | "createdById" | "createdAt"> [] = [
  {
    title: "Playbook",
    url: "https://valuetruck-my.sharepoint.com/:w:/p/ben_beddes/IQAxq4cjYozxTJHB-zYcZtBnAYWpGDvcP6Qj_AW6ULA_Oq8?rtime=s9jxtGeA3kg&ovuser=99d7bd71-9046-4915-be1c-3aae2baf1645%2Cben.beddes%40valuetruck.com&clickparams=eyJBcHBOYW1lIjoiVGVhbXMtRGVza3RvcCIsIkFwcFZlcnNpb24iOiI0OS8yNjAyMDEwMTEyMCIsIkhhc0ZlZGVyYXRlZFVzZXIiOmZhbHNlfQ%3D%3D",
    description: "The Value Truck sales playbook — processes, scripts, objection handling, and account strategies.",
    iconName: "BookOpen",
    color: "from-blue-500 to-blue-600",
    sortOrder: 0,
  },
  {
    title: "Buckets",
    url: "https://valuetruck-my.sharepoint.com/:p:/r/personal/ben_beddes_valuetruck_com/_layouts/15/Doc2.aspx?action=edit&sourcedoc=%7B088c48cc-a345-4d1a-9947-b49d3cd7112c%7D&wdOrigin=TEAMS-MAGLEV.undefined_ns.rwc&wdExp=TEAMS-TREATMENT&wdhostclicktime=1749156731495&web=1",
    description: "Bucket structure and territory breakdown for account planning and market segmentation.",
    iconName: "FolderOpen",
    color: "from-green-500 to-green-600",
    sortOrder: 1,
  },
];

function getIcon(name: string | null | undefined) {
  const found = ICON_OPTIONS.find(o => o.name === name);
  return found ? found.icon : Link;
}

interface LinkFormState {
  title: string;
  url: string;
  description: string;
  iconName: string;
  color: string;
  sortOrder: number;
}

const emptyForm = (): LinkFormState => ({ title: "", url: "", description: "", iconName: "Link", color: "from-blue-500 to-blue-600", sortOrder: 0 });

export default function ToolsPage() {
  const { toast } = useToast();
  const { data: currentUser } = useQuery<any>({ queryKey: ["/api/auth/user"] });
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "director";

  const { data: dbLinks = [], isLoading } = useQuery<ToolLink[]>({ queryKey: ["/api/tool-links"] });

  const links = dbLinks.length > 0 ? dbLinks : DEFAULT_LINKS as any[];
  const usingDefaults = dbLinks.length === 0;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<ToolLink | null>(null);
  const [form, setForm] = useState<LinkFormState>(emptyForm());
  const [showIconPicker, setShowIconPicker] = useState(false);

  const createMutation = useMutation({
    mutationFn: (data: LinkFormState) => apiRequest("POST", "/api/tool-links", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tool-links"] });
      toast({ title: "Link added" });
      setDialogOpen(false);
    },
    onError: () => toast({ title: "Failed to add link", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: LinkFormState }) => apiRequest("PATCH", `/api/tool-links/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tool-links"] });
      toast({ title: "Link updated" });
      setDialogOpen(false);
    },
    onError: () => toast({ title: "Failed to update link", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/tool-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tool-links"] });
      toast({ title: "Link removed" });
    },
    onError: () => toast({ title: "Failed to remove link", variant: "destructive" }),
  });

  function openAdd() {
    setEditingLink(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(link: ToolLink) {
    setEditingLink(link);
    setForm({ title: link.title, url: link.url, description: link.description ?? "", iconName: link.iconName ?? "Link", color: link.color ?? "from-blue-500 to-blue-600", sortOrder: link.sortOrder ?? 0 });
    setDialogOpen(true);
  }

  function handleSubmit() {
    if (!form.title.trim() || !form.url.trim()) return;
    if (editingLink) {
      updateMutation.mutate({ id: editingLink.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 text-white">
            <Wrench className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Tools & Resources</h1>
            <p className="text-sm text-muted-foreground">Quick access to team reference materials and external resources.</p>
          </div>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={openAdd} data-testid="button-add-tool-link">
            <Plus className="h-4 w-4 mr-1" /> Add Link
          </Button>
        )}
      </div>

      {/* Default notice */}
      {usingDefaults && isAdmin && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          Showing default links. Add your own links above — they'll replace these defaults for everyone.
        </div>
      )}

      {/* Resources portlet */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Resources</p>
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[0, 1].map(i => <div key={i} className="h-28 rounded-xl border bg-muted animate-pulse" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {links.map((r: any, idx: number) => {
              const IconComp = getIcon(r.iconName);
              return (
                <div key={r.id ?? idx} className="relative group">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`link-tool-${r.id ?? idx}`}
                    className="flex flex-col gap-3 rounded-xl border bg-background p-5 hover:border-primary/40 hover:shadow-sm transition-all h-full"
                  >
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ${r.color ?? "from-blue-500 to-blue-600"} text-white`}>
                      <IconComp className="h-5 w-5" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm">{r.title}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      {r.description && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{r.description}</p>}
                    </div>
                  </a>
                  {isAdmin && !usingDefaults && (
                    <div className="absolute top-2 right-2 hidden group-hover:flex gap-1">
                      <button
                        onClick={e => { e.preventDefault(); openEdit(r as ToolLink); }}
                        data-testid={`button-edit-tool-link-${r.id}`}
                        className="p-1 rounded bg-background border shadow-sm hover:bg-muted transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      <button
                        onClick={e => { e.preventDefault(); deleteMutation.mutate(r.id); }}
                        data-testid={`button-delete-tool-link-${r.id}`}
                        className="p-1 rounded bg-background border shadow-sm hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingLink ? "Edit Link" : "Add Link"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Title *</label>
              <input
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Sales Playbook"
                data-testid="input-tool-link-title"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">URL *</label>
              <input
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.url}
                onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://..."
                data-testid="input-tool-link-url"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Description <span className="font-normal">(optional)</span></label>
              <input
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Short description for the card"
                data-testid="input-tool-link-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Icon</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowIconPicker(v => !v)}
                    data-testid="button-tool-link-icon-picker"
                    className="w-full flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted transition-colors"
                  >
                    {(() => { const IC = getIcon(form.iconName); return <IC className="h-4 w-4" />; })()}
                    <span>{form.iconName}</span>
                    <ChevronDown className="h-3 w-3 ml-auto text-muted-foreground" />
                  </button>
                  {showIconPicker && (
                    <div className="absolute top-10 left-0 z-50 bg-card border rounded-lg shadow-lg p-2 grid grid-cols-4 gap-1 w-44">
                      {ICON_OPTIONS.map(o => {
                        const IC = o.icon;
                        return (
                          <button
                            key={o.name}
                            title={o.name}
                            onClick={() => { setForm(f => ({ ...f, iconName: o.name })); setShowIconPicker(false); }}
                            className={`p-2 rounded hover:bg-muted transition-colors ${form.iconName === o.name ? "bg-primary/10 text-primary" : ""}`}
                          >
                            <IC className="h-4 w-4" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Color</label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={form.color}
                  onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                  data-testid="select-tool-link-color"
                >
                  {COLOR_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Sort Order</label>
              <input
                type="number"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.sortOrder}
                onChange={e => setForm(f => ({ ...f, sortOrder: parseInt(e.target.value) || 0 }))}
                data-testid="input-tool-link-sort"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button className="flex-1" onClick={handleSubmit} disabled={isPending || !form.title.trim() || !form.url.trim()} data-testid="button-save-tool-link">
                {isPending ? "Saving…" : editingLink ? "Save Changes" : "Add Link"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
