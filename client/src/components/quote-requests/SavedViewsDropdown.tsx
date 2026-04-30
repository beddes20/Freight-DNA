/**
 * Task #863 — Saved Views dropdown.
 *
 * Built-in views (Today / Mine, New, Past SLA, Closed today) sit at
 * the top, followed by user-created saved views from the API. A
 * trailing "Save current view…" prompts for a name and POSTs to
 * /api/customer-quotes/saved-views; the trash button on each user
 * view DELETEs it. Apply just calls back to the parent with the
 * stored filter shape — the parent owns the actual filter state.
 *
 * The "Manage views…" dialog lets reps rename their own views, mark
 * one view (built-in or user) as their default, and delete views.
 * The default key is persisted in localStorage and re-applied once on
 * mount so reps land on the same workspace they left.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bookmark, BookmarkPlus, Check, ChevronDown, Loader2, Pencil, Settings, Star, Trash2, X,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface QuoteViewFilters {
  status?: string;
  age?: string;
  mineOnly?: boolean;
  freeEmailOnly?: boolean;
  includeSnoozed?: boolean;
  search?: string;
  domainFilter?: string | null;
  pastSlaOnly?: boolean;
}

interface SavedView {
  id: string;
  name: string;
  filters: QuoteViewFilters;
}

interface BuiltIn {
  key: string;
  name: string;
  filters: QuoteViewFilters;
}

const BUILT_INS: BuiltIn[] = [
  { key: "all_open", name: "All open", filters: { status: "new", age: "30d", mineOnly: false } },
  { key: "today_mine", name: "Today · Mine", filters: { status: "all", age: "today", mineOnly: true } },
  { key: "new_today", name: "New today", filters: { status: "new", age: "today" } },
  { key: "past_sla", name: "Past SLA", filters: { status: "new", age: "7d", pastSlaOnly: true } },
  { key: "won_today", name: "Won today", filters: { status: "won", age: "today" } },
];

const DEFAULT_VIEW_LS_KEY = "quote-requests:default-view";

function readDefaultKey(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(DEFAULT_VIEW_LS_KEY); } catch { return null; }
}
function writeDefaultKey(key: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (key) window.localStorage.setItem(DEFAULT_VIEW_LS_KEY, key);
    else window.localStorage.removeItem(DEFAULT_VIEW_LS_KEY);
  } catch { /* ignore quota / private mode */ }
}

export function SavedViewsDropdown({
  currentFilters, activeKey, onApply,
}: {
  currentFilters: QuoteViewFilters;
  /** Optional active marker. May be a built-in key or a saved-view id. */
  activeKey?: string | null;
  onApply: (filters: QuoteViewFilters, key: string) => void;
}): JSX.Element {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [defaultKey, setDefaultKey] = useState<string | null>(() => readDefaultKey());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const viewsQuery = useQuery<SavedView[]>({
    queryKey: ["/api/customer-quotes/saved-views"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/saved-views", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load saved views");
      return res.json();
    },
    staleTime: 60_000,
  });

  // ─── Apply the user's default view exactly once on first load ────────
  // Built-in defaults can fire as soon as we mount; user-saved defaults
  // wait for the saved-views query to resolve so we can hand the right
  // filter shape to the parent.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    if (!defaultKey) { appliedDefaultRef.current = true; return; }
    const builtin = BUILT_INS.find(b => b.key === defaultKey);
    if (builtin) {
      onApply(builtin.filters, builtin.key);
      appliedDefaultRef.current = true;
      return;
    }
    if (!viewsQuery.data) return; // wait for fetch
    const sv = viewsQuery.data.find(v => v.id === defaultKey);
    if (sv) {
      onApply(sv.filters ?? {}, sv.id);
    } else {
      // Stored default no longer exists — clear it so we don't keep
      // checking on every page load.
      writeDefaultKey(null);
      setDefaultKey(null);
    }
    appliedDefaultRef.current = true;
  }, [defaultKey, viewsQuery.data, onApply]);

  const saveMut = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/customer-quotes/saved-views", {
        name,
        filters: currentFilters,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Could not save view");
      return json;
    },
    onSuccess: () => {
      toast({ title: "View saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] });
      setSavePromptOpen(false);
      setDraftName("");
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not save view",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/customer-quotes/saved-views/${id}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error ?? "Could not delete view");
      }
      return id;
    },
    onSuccess: (id) => {
      toast({ title: "View deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] });
      // If the deleted view was set as default, clear the default too.
      if (defaultKey === id) {
        writeDefaultKey(null);
        setDefaultKey(null);
      }
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not delete view",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const renameMut = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/saved-views/${id}`, { name });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Could not rename view");
      return json;
    },
    onSuccess: () => {
      toast({ title: "View renamed" });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] });
      setRenamingId(null);
      setRenameDraft("");
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not rename view",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const userViews = viewsQuery.data ?? [];
  const activeLabel = useMemo(() => {
    if (!activeKey) return "Saved views";
    const bi = BUILT_INS.find(b => b.key === activeKey);
    if (bi) return bi.name;
    const sv = userViews.find(v => v.id === activeKey);
    return sv?.name ?? "Saved views";
  }, [activeKey, userViews]);

  function setAsDefault(key: string | null) {
    writeDefaultKey(key);
    setDefaultKey(key);
    if (key) toast({ title: "Default view set" });
    else toast({ title: "Default view cleared" });
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" data-testid="button-saved-views">
            <Bookmark className="h-3 w-3" />
            {activeLabel}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Built-in views
          </DropdownMenuLabel>
          {BUILT_INS.map(b => (
            <DropdownMenuItem
              key={b.key}
              onClick={() => { onApply(b.filters, b.key); setOpen(false); }}
              data-testid={`saved-view-builtin-${b.key}`}
            >
              {activeKey === b.key && <Check className="h-3.5 w-3.5 mr-2" />}
              <span className={`flex-1 ${activeKey === b.key ? "font-medium" : ""}`}>{b.name}</span>
              {defaultKey === b.key && (
                <Star className="h-3 w-3 text-amber-500 fill-amber-500 ml-1" data-testid={`badge-default-${b.key}`} />
              )}
            </DropdownMenuItem>
          ))}
          {userViews.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Your views
              </DropdownMenuLabel>
              {userViews.map(v => (
                <DropdownMenuItem
                  key={v.id}
                  className="flex items-center"
                  onSelect={(e) => { e.preventDefault(); }}
                  data-testid={`saved-view-user-${v.id}`}
                >
                  <button
                    type="button"
                    className="flex-1 flex items-center text-left"
                    onClick={() => { onApply(v.filters ?? {}, v.id); setOpen(false); }}
                  >
                    {activeKey === v.id && <Check className="h-3.5 w-3.5 mr-2" />}
                    <span className={`truncate flex-1 ${activeKey === v.id ? "font-medium" : ""}`}>{v.name}</span>
                    {defaultKey === v.id && (
                      <Star className="h-3 w-3 text-amber-500 fill-amber-500 ml-1" data-testid={`badge-default-${v.id}`} />
                    )}
                  </button>
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => { setSavePromptOpen(true); setOpen(false); }}
            data-testid="button-save-current-view"
          >
            <BookmarkPlus className="h-3.5 w-3.5 mr-2" /> Save current view…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => { setManageOpen(true); setOpen(false); }}
            data-testid="button-manage-views"
          >
            <Settings className="h-3.5 w-3.5 mr-2" /> Manage views…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save current view dialog */}
      <Dialog open={savePromptOpen} onOpenChange={setSavePromptOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-save-view">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
          </DialogHeader>
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="View name (e.g. Past SLA · Reefer)"
            autoFocus
            data-testid="input-saved-view-name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSavePromptOpen(false)} data-testid="button-cancel-save-view">
              Cancel
            </Button>
            <Button
              disabled={!draftName.trim() || saveMut.isPending}
              onClick={() => saveMut.mutate(draftName.trim())}
              data-testid="button-confirm-save-view"
            >
              {saveMut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage views dialog */}
      <Dialog open={manageOpen} onOpenChange={(o) => { setManageOpen(o); if (!o) { setRenamingId(null); setRenameDraft(""); } }}>
        <DialogContent className="max-w-md" data-testid="dialog-manage-views">
          <DialogHeader>
            <DialogTitle>Manage saved views</DialogTitle>
            <DialogDescription>
              Star a view to set it as your default landing view. Rename or delete the views you've saved.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1 pt-1">
              Built-in
            </div>
            {BUILT_INS.map(b => (
              <ManageRow
                key={b.key}
                name={b.name}
                isDefault={defaultKey === b.key}
                onSetDefault={() => setAsDefault(defaultKey === b.key ? null : b.key)}
                testId={`manage-row-${b.key}`}
              />
            ))}
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1 pt-3">
              Your views
            </div>
            {userViews.length === 0 && (
              <div className="text-xs text-muted-foreground italic px-1 py-2" data-testid="text-no-user-views">
                You haven't saved any views yet. Use "Save current view…" from the dropdown.
              </div>
            )}
            {userViews.map(v => (
              <div
                key={v.id}
                className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-muted/40"
                data-testid={`manage-row-${v.id}`}
              >
                <button
                  type="button"
                  className="shrink-0"
                  title={defaultKey === v.id ? "Clear as default" : "Set as default"}
                  onClick={() => setAsDefault(defaultKey === v.id ? null : v.id)}
                  data-testid={`button-set-default-${v.id}`}
                >
                  <Star className={`h-4 w-4 ${defaultKey === v.id ? "text-amber-500 fill-amber-500" : "text-muted-foreground"}`} />
                </button>

                {renamingId === v.id ? (
                  <>
                    <Input
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      className="h-7 text-sm flex-1"
                      autoFocus
                      data-testid={`input-rename-${v.id}`}
                    />
                    <Button
                      size="sm"
                      className="h-7 px-2"
                      disabled={!renameDraft.trim() || renameMut.isPending}
                      onClick={() => renameMut.mutate({ id: v.id, name: renameDraft.trim() })}
                      data-testid={`button-confirm-rename-${v.id}`}
                    >
                      {renameMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => { setRenamingId(null); setRenameDraft(""); }}
                      title="Cancel"
                      data-testid={`button-cancel-rename-${v.id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm truncate" data-testid={`text-view-name-${v.id}`}>{v.name}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      title="Rename"
                      onClick={() => { setRenamingId(v.id); setRenameDraft(v.name); }}
                      data-testid={`button-rename-${v.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      title="Delete"
                      onClick={() => deleteMut.mutate(v.id)}
                      data-testid={`button-delete-saved-view-${v.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setManageOpen(false)} data-testid="button-close-manage-views">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ManageRow({
  name, isDefault, onSetDefault, testId,
}: {
  name: string;
  isDefault: boolean;
  onSetDefault: () => void;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-muted/40" data-testid={testId}>
      <button
        type="button"
        className="shrink-0"
        title={isDefault ? "Clear as default" : "Set as default"}
        onClick={onSetDefault}
        data-testid={`button-set-default-${testId}`}
      >
        <Star className={`h-4 w-4 ${isDefault ? "text-amber-500 fill-amber-500" : "text-muted-foreground"}`} />
      </button>
      <span className="flex-1 text-sm">{name}</span>
    </div>
  );
}
