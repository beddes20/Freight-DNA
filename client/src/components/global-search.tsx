import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, Building2, UserCircle, Crown } from "lucide-react";
import { Input } from "@/components/ui/input";

interface SearchResults {
  accounts: Array<{ id: string; name: string }>;
  accountManagers: Array<{ id: string; name: string; username: string }>;
  nationalAccountManagers: Array<{ id: string; name: string; username: string }>;
}

const emptyResults: SearchResults = { accounts: [], accountManagers: [], nationalAccountManagers: [] };

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(emptyResults);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
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

  const hasResults = results.accounts.length > 0 || results.accountManagers.length > 0 || results.nationalAccountManagers.length > 0;
  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} className="relative w-64" data-testid="global-search-container">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          data-testid="input-global-search"
          placeholder="Search accounts, managers..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (query.trim() && hasResults) setOpen(true); }}
          className="pl-9 h-8"
        />
      </div>

      {showDropdown && (
        <div
          data-testid="search-results-dropdown"
          className="absolute top-full mt-1 w-full bg-popover border rounded-md shadow-lg z-50 max-h-80 overflow-auto"
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
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider" data-testid="search-group-accounts">
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

          {!loading && results.accountManagers.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider" data-testid="search-group-account-managers">
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
              <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider" data-testid="search-group-national-account-managers">
                National Account Managers
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
