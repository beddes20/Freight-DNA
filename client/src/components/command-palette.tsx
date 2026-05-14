import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import {
  Building2, UserCircle, Crown, Contact, FileText, ListTodo, Truck,
  Plus, Phone, Moon, Sun, LogOut, Clock, ArrowRight,
} from "lucide-react";
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator,
} from "@/components/ui/command";
import { allVisibleDestinations, type NavItem } from "@/lib/nav-items";
import { useAuth, useIsAuthBypassed } from "@/hooks/use-auth";
import { useLogTouch } from "@/context/log-touch-context";

const RECENTS_KEY = "cmdk_recents_v1";
const RECENTS_MAX = 5;

type RecentEntry =
  | { kind: "nav"; url: string; title: string }
  | { kind: "search"; url: string; title: string; subtitle?: string };

function loadRecents(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function saveRecent(entry: RecentEntry) {
  if (typeof window === "undefined") return;
  try {
    const current = loadRecents().filter(r => r.url !== entry.url);
    const next = [entry, ...current].slice(0, RECENTS_MAX);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
}

interface SearchResults {
  accounts: Array<{ id: string; name: string }>;
  accountManagers: Array<{ id: string; name: string; username: string }>;
  nationalAccountManagers: Array<{ id: string; name: string; username: string }>;
  contacts: Array<{ id: string; name: string; title?: string; companyId: string; companyName?: string }>;
  rfps: Array<{ id: string; title: string; companyId: string; status: string }>;
  tasks: Array<{ id: string; title: string; status: string; companyId: string | null; companyName: string }>;
  carriers: Array<{ id: string; name: string; mcDot?: string | null; state?: string | null }>;
}
const emptyResults: SearchResults = { accounts: [], accountManagers: [], nationalAccountManagers: [], contacts: [], rfps: [], tasks: [], carriers: [] };

// Singleton open/close — any component can call openCommandPalette() to
// trigger the global palette, regardless of where it lives in the tree.
const PALETTE_EVENT = "cmdk:open";
export function openCommandPalette() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
}

function useTheme() {
  const apply = useCallback((next: "light" | "dark") => {
    try { localStorage.setItem("theme", next); } catch { /* ignore */ }
    document.documentElement.classList.toggle("dark", next === "dark");
  }, []);
  const toggle = useCallback(() => {
    const isDark = document.documentElement.classList.contains("dark");
    apply(isDark ? "light" : "dark");
  }, [apply]);
  return { toggle };
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(emptyResults);
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();
  const authBypassed = useIsAuthBypassed();
  const { openDialog: openLogTouch } = useLogTouch();
  const { toggle: toggleTheme } = useTheme();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Final unmount cleanup: cancel pending timers + in-flight search.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const destinations = useMemo(() => allVisibleDestinations(user?.role), [user?.role]);

  // Listen for global open events + cmd-k / ctrl-k.
  useEffect(() => {
    const onOpen = () => {
      setRecents(loadRecents());
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack while typing in the global-search input — that
      // behaviour now opens the palette via its own click handler.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setRecents(loadRecents());
        setOpen(prev => !prev);
        return;
      }
      // "/" focus shortcut: only when not already typing somewhere.
      if (e.key === "/" && !open) {
        const tag = target?.tagName.toLowerCase();
        const inEditable = tag === "input" || tag === "textarea" || target?.isContentEditable;
        if (!inEditable) {
          e.preventDefault();
          setRecents(loadRecents());
          setOpen(true);
        }
      }
    };
    window.addEventListener(PALETTE_EVENT, onOpen);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(PALETTE_EVENT, onOpen);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset query whenever palette closes so re-opening starts fresh.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(emptyResults);
      if (abortRef.current) abortRef.current.abort();
    }
  }, [open]);

  // Debounced /api/search lookup.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults(emptyResults);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: "include", signal: controller.signal })
        .then(r => r.ok ? r.json() : emptyResults)
        .then((data: SearchResults) => {
          if (!controller.signal.aborted) setResults(data);
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setResults(emptyResults);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const closeWith = useCallback((fn: () => void) => {
    setOpen(false);
    // Defer so dialog close animation doesn't conflict with navigation.
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      fn();
    }, 0);
  }, []);

  const goNav = (item: NavItem) => {
    saveRecent({ kind: "nav", url: item.url, title: item.title });
    closeWith(() => navigate(item.url));
  };

  const goSearch = (url: string, title: string, subtitle?: string) => {
    saveRecent({ kind: "search", url, title, subtitle });
    closeWith(() => navigate(url));
  };

  const runAction = (fn: () => void) => closeWith(fn);

  const hasSearchResults =
    (results.accounts?.length ?? 0) +
    (results.contacts?.length ?? 0) +
    (results.rfps?.length ?? 0) +
    (results.tasks?.length ?? 0) +
    (results.carriers?.length ?? 0) +
    (results.accountManagers?.length ?? 0) +
    (results.nationalAccountManagers?.length ?? 0) > 0;

  const showRecents = !query && recents.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search or run a command…"
        value={query}
        onValueChange={setQuery}
        data-testid="input-command-palette"
      />
      <CommandList data-testid="list-command-palette">
        {!loading && query.length >= 2 && !hasSearchResults && (
          <CommandEmpty data-testid="text-command-empty">No matches for "{query}"</CommandEmpty>
        )}

        {showRecents && (
          <>
            <CommandGroup heading="Recent">
              {recents.map(r => (
                <CommandItem
                  key={`recent-${r.url}`}
                  value={`recent ${r.title}`}
                  onSelect={() => closeWith(() => navigate(r.url))}
                  data-testid={`cmd-recent-${r.url.replace(/[^a-z0-9]+/gi, "-")}`}
                >
                  <Clock className="text-muted-foreground" />
                  <span className="truncate">{r.title}</span>
                  {"subtitle" in r && r.subtitle && (
                    <span className="ml-2 text-xs text-muted-foreground truncate">{r.subtitle}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Actions">
          <CommandItem
            value="log touchpoint touch call email note"
            onSelect={() => runAction(() => openLogTouch())}
            data-testid="cmd-action-log-touch"
          >
            <Plus />
            <span>Log a touchpoint</span>
          </CommandItem>
          <CommandItem
            value="new task todo reminder"
            onSelect={() => runAction(() => navigate("/tasks?new=1"))}
            data-testid="cmd-action-new-task"
          >
            <ListTodo />
            <span>New task</span>
          </CommandItem>
          <CommandItem
            value="new quote request lane spot"
            onSelect={() => runAction(() => navigate("/customer-quotes?new=1"))}
            data-testid="cmd-action-new-quote"
          >
            <FileText />
            <span>New customer quote</span>
          </CommandItem>
          <CommandItem
            value="call ringing dial phone webex"
            onSelect={() => runAction(() => navigate("/calls"))}
            data-testid="cmd-action-calls"
          >
            <Phone />
            <span>Open call performance</span>
          </CommandItem>
          <CommandItem
            value="dark mode light theme toggle"
            onSelect={() => runAction(toggleTheme)}
            data-testid="cmd-action-toggle-theme"
          >
            {document.documentElement.classList.contains("dark") ? <Sun /> : <Moon />}
            <span>Toggle dark mode</span>
          </CommandItem>
          {!authBypassed && (
            <CommandItem
              value="sign out logout exit"
              onSelect={() => runAction(() => { logout.mutate(); })}
              data-testid="cmd-action-logout"
            >
              <LogOut />
              <span>Sign out</span>
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Go to">
          {destinations.map(item => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={`nav-${item.url}`}
                value={`nav ${item.title} ${item.description}`}
                onSelect={() => goNav(item)}
                data-testid={`cmd-nav-${item.url.replace(/[^a-z0-9]+/gi, "-")}`}
              >
                <Icon />
                <span className="truncate">{item.title}</span>
                <ArrowRight className="ml-auto text-muted-foreground/40" />
              </CommandItem>
            );
          })}
        </CommandGroup>

        {loading && (
          <CommandGroup heading="Searching…">
            <CommandItem disabled value="search-loading" data-testid="cmd-search-loading">
              <span className="text-muted-foreground">Looking…</span>
            </CommandItem>
          </CommandGroup>
        )}

        {!loading && query.length >= 2 && hasSearchResults && (
          <>
            <CommandSeparator />
            {results.accounts.length > 0 && (
              <CommandGroup heading="Accounts">
                {results.accounts.map(a => (
                  <CommandItem
                    key={`acct-${a.id}`}
                    value={`account ${a.name}`}
                    onSelect={() => goSearch(`/companies/${a.id}`, a.name)}
                    data-testid={`cmd-search-account-${a.id}`}
                  >
                    <Building2 />
                    <span className="truncate">{a.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.contacts.length > 0 && (
              <CommandGroup heading="Contacts">
                {results.contacts.map(c => (
                  <CommandItem
                    key={`contact-${c.id}`}
                    value={`contact ${c.name} ${c.companyName ?? ""}`}
                    onSelect={() => goSearch(`/companies/${c.companyId}`, c.name, c.companyName)}
                    data-testid={`cmd-search-contact-${c.id}`}
                  >
                    <Contact />
                    <div className="flex-1 min-w-0">
                      <span className="truncate block">{c.name}</span>
                      <span className="text-xs text-muted-foreground truncate block">
                        {[c.companyName, c.title].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.carriers.length > 0 && (
              <CommandGroup heading="Carriers">
                {results.carriers.map(c => (
                  <CommandItem
                    key={`carrier-${c.id}`}
                    value={`carrier ${c.name} ${c.mcDot ?? ""}`}
                    onSelect={() => goSearch(`/carrier-hub/${c.id}`, c.name, c.mcDot ? `MC ${c.mcDot}` : undefined)}
                    data-testid={`cmd-search-carrier-${c.id}`}
                  >
                    <Truck />
                    <div className="flex-1 min-w-0">
                      <span className="truncate block">{c.name}</span>
                      <span className="text-xs text-muted-foreground truncate block">
                        {[c.mcDot ? `MC ${c.mcDot}` : null, c.state].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.rfps.length > 0 && (
              <CommandGroup heading="RFPs">
                {results.rfps.map(r => (
                  <CommandItem
                    key={`rfp-${r.id}`}
                    value={`rfp ${r.title}`}
                    onSelect={() => goSearch(`/companies/${r.companyId}`, r.title, r.status)}
                    data-testid={`cmd-search-rfp-${r.id}`}
                  >
                    <FileText />
                    <div className="flex-1 min-w-0">
                      <span className="truncate block">{r.title}</span>
                      <span className="text-xs text-muted-foreground capitalize">{r.status}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.tasks.length > 0 && (
              <CommandGroup heading="Tasks">
                {results.tasks.map(t => (
                  <CommandItem
                    key={`task-${t.id}`}
                    value={`task ${t.title} ${t.companyName}`}
                    onSelect={() => goSearch(t.companyId ? `/companies/${t.companyId}` : "/tasks", t.title, t.companyName)}
                    data-testid={`cmd-search-task-${t.id}`}
                  >
                    <ListTodo />
                    <div className="flex-1 min-w-0">
                      <span className="truncate block">{t.title}</span>
                      <span className="text-xs text-muted-foreground truncate block">
                        {[t.companyName, t.status].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.accountManagers.length > 0 && (
              <CommandGroup heading="Account Managers">
                {results.accountManagers.map(u => (
                  <CommandItem
                    key={`am-${u.id}`}
                    value={`am ${u.name}`}
                    onSelect={() => goSearch(`/reps/${u.id}`, u.name)}
                    data-testid={`cmd-search-am-${u.id}`}
                  >
                    <UserCircle />
                    <span className="truncate">{u.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.nationalAccountManagers.length > 0 && (
              <CommandGroup heading="Directors & NAMs">
                {results.nationalAccountManagers.map(u => (
                  <CommandItem
                    key={`nam-${u.id}`}
                    value={`nam ${u.name}`}
                    onSelect={() => goSearch(`/reps/${u.id}`, u.name)}
                    data-testid={`cmd-search-nam-${u.id}`}
                  >
                    <Crown />
                    <span className="truncate">{u.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground flex items-center justify-between" data-testid="cmd-footer">
        <span>↵ to select · ↑↓ to navigate · esc to close</span>
        <span><kbd className="rounded border bg-muted px-1 font-mono">⌘K</kbd> anywhere</span>
      </div>
    </CommandDialog>
  );
}
