import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, Building2, UserCircle, Crown, Contact, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";

interface SearchResults {
  accounts: Array<{ id: string; name: string }>;
  accountManagers: Array<{ id: string; name: string; username: string }>;
  nationalAccountManagers: Array<{ id: string; name: string; username: string }>;
  contacts: Array<{ id: string; name: string; title?: string; companyId: string }>;
  rfps: Array<{ id: string; title: string; companyId: string; status: string }>;
}

const emptyResults: SearchResults = { accounts: [], accountManagers: [], nationalAccountManagers: [], contacts: [], rfps: [] };

export function GlobalSearch({ navBar }: { navBar?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(emptyResults);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const abortRef = useRef<AbortController | null>(null);

  const fetchResults = useCallback(async (q: string) => {
    if (abortRef.current) abortRef.current.abort();
    if (!q.trim()) {
      setResults(emptyResults);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        setResults(data);
        setOpen(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setResults(emptyResults);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const handleChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResults(value), 250);
  };

  const handleSelect = (path: string) => {
    setOpen(false);
    setQuery("");
    setResults(emptyResults);
    navigate(path);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      setResults(emptyResults);
    }
  };

  const hasResults =
    results.accounts.length > 0 ||
    results.accountManagers.length > 0 ||
    results.nationalAccountManagers.length > 0 ||
    results.contacts.length > 0 ||
    results.rfps.length > 0;
  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className="relative w-72" data-testid="global-search-container">
      <div className="relative">
        <Search className={`absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 ${navBar ? "text-white/60" : "text-muted-foreground"}`} />
        <Input
          ref={inputRef}
          data-testid="input-global-search"
          placeholder="Search accounts, contacts, RFPs..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (query.trim() && hasResults) setOpen(true); }}
          className={`pl-9 pr-12 h-8 ${navBar ? "bg-white/10 border-white/20 text-white placeholder:text-white/50 focus-visible:ring-white/30" : ""}`}
        />
        <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-[10px] px-1 py-0.5 rounded border font-mono pointer-events-none ${navBar ? "text-white/40 border-white/20" : "text-muted-foreground/50 border-border"}`}>
          ⌘K
        </span>
      </div>

      {showDropdown && (
        <div
          data-testid="search-results-dropdown"
          className="absolute top-full mt-1 w-full bg-popover border rounded-md shadow-lg z-50 max-h-[360px] overflow-auto"
        >
          {loading && (
            <div className="p-3 text-sm text-muted-foreground text-center" data-testid="search-loading">
              Searching...
            </div>
          )}

          {!loading && !hasResults && (
            <div className="p-3 text-sm text-muted-foreground text-center" data-testid="text-no-results">
              No results found
            </div>
          )}

          {!loading && results.accounts.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30" data-testid="search-group-accounts">
                Accounts
              </div>
              {results.accounts.map((account) => (
                <button
                  key={account.id}
                  data-testid={`search-result-account-${account.id}`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer text-left"
                  onClick={() => handleSelect(`/companies/${account.id}`)}
                >
                  <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{account.name}</span>
                </button>
              ))}
            </div>
          )}

          {!loading && results.contacts.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30" data-testid="search-group-contacts">
                Contacts
              </div>
              {results.contacts.map((contact) => (
                <button
                  key={contact.id}
                  data-testid={`search-result-contact-${contact.id}`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer text-left"
                  onClick={() => handleSelect(`/companies/${contact.companyId}`)}
                >
                  <Contact className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{contact.name}</span>
                    {contact.title && <span className="text-xs text-muted-foreground truncate block">{contact.title}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loading && results.rfps.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30" data-testid="search-group-rfps">
                RFPs
              </div>
              {results.rfps.map((rfp) => (
                <button
                  key={rfp.id}
                  data-testid={`search-result-rfp-${rfp.id}`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer text-left"
                  onClick={() => handleSelect(`/companies/${rfp.companyId}`)}
                >
                  <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{rfp.title}</span>
                    <span className="text-xs text-muted-foreground capitalize">{rfp.status}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loading && results.accountManagers.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30" data-testid="search-group-account-managers">
                Account Managers
              </div>
              {results.accountManagers.map((user) => (
                <button
                  key={user.id}
                  data-testid={`search-result-am-${user.id}`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer text-left"
                  onClick={() => handleSelect(`/reps/${user.id}`)}
                >
                  <UserCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{user.name}</span>
                </button>
              ))}
            </div>
          )}

          {!loading && results.nationalAccountManagers.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30" data-testid="search-group-national-account-managers">
                Directors & NAMs
              </div>
              {results.nationalAccountManagers.map((user) => (
                <button
                  key={user.id}
                  data-testid={`search-result-nam-${user.id}`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer text-left"
                  onClick={() => handleSelect(`/reps/${user.id}`)}
                >
                  <Crown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{user.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
