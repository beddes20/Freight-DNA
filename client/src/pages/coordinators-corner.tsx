import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { KeyRound, Search, Copy, Eye, EyeOff, ExternalLink, ShieldCheck, Building2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { Company } from "@shared/schema";

function copyToClipboard(value: string, label: string, toast: ReturnType<typeof useToast>["toast"]) {
  navigator.clipboard.writeText(value).then(() => {
    toast({ description: `${label} copied to clipboard` });
  });
}

function PasswordCell({ password }: { password: string }) {
  const [revealed, setRevealed] = useState(false);
  const { toast } = useToast();
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-sm select-none">
        {revealed ? password : "••••••••"}
      </span>
      <button
        onClick={() => setRevealed(v => !v)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title={revealed ? "Hide password" : "Reveal password"}
        data-testid={`button-toggle-password`}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        onClick={() => copyToClipboard(password, "Password", toast)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title="Copy password"
        data-testid={`button-copy-password`}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function CoordinatorsCornerPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  const { data: allCompanies = [], isLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const companies = useMemo(() => {
    return allCompanies.filter(c =>
      c.portalUrl || c.portalUsername || c.portalPassword
    );
  }, [allCompanies]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.portalUrl ?? "").toLowerCase().includes(q) ||
      (c.portalUsername ?? "").toLowerCase().includes(q)
    );
  }, [companies, search]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center border border-amber-500/20">
          <KeyRound className="h-5 w-5 text-amber-500" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Coordinators Corner</h1>
          <p className="text-sm text-muted-foreground">Customer portal credentials at a glance</p>
        </div>
        <Badge variant="secondary" className="ml-auto">
          {companies.length} {companies.length === 1 ? "account" : "accounts"} with credentials
        </Badge>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by customer name, portal URL, or username…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-credentials"
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <ShieldCheck className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium text-muted-foreground">
                {search ? "No accounts match your search" : "No portal credentials on file"}
              </p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                {search
                  ? "Try a different search term."
                  : "Portal credentials can be added on each customer's detail page."}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm" data-testid="table-credentials">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[28%]">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[30%]">Portal URL</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[18%]">Username</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[24%]">Password</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((company, idx) => (
                <tr
                  key={company.id}
                  className={`border-b last:border-0 hover:bg-muted/30 transition-colors ${idx % 2 === 0 ? "" : "bg-muted/10"}`}
                  data-testid={`row-credential-${company.id}`}
                >
                  {/* Company name */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/companies/${company.id}`}
                      className="font-medium hover:text-primary transition-colors flex items-center gap-1.5 group"
                      data-testid={`link-company-${company.id}`}
                    >
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                      {company.name}
                    </Link>
                  </td>

                  {/* Portal URL */}
                  <td className="px-4 py-3">
                    {company.portalUrl ? (
                      <a
                        href={company.portalUrl.startsWith("http") ? company.portalUrl : `https://${company.portalUrl}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[200px]"
                        title={company.portalUrl}
                        data-testid={`link-portal-url-${company.id}`}
                      >
                        <ExternalLink className="h-3 w-3 shrink-0" />
                        <span className="truncate">{company.portalUrl.replace(/^https?:\/\//, "")}</span>
                      </a>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs">—</span>
                    )}
                  </td>

                  {/* Username */}
                  <td className="px-4 py-3">
                    {company.portalUsername ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm">{company.portalUsername}</span>
                        <button
                          onClick={() => copyToClipboard(company.portalUsername!, "Username", toast)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Copy username"
                          data-testid={`button-copy-username-${company.id}`}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs">—</span>
                    )}
                  </td>

                  {/* Password */}
                  <td className="px-4 py-3">
                    {company.portalPassword ? (
                      <PasswordCell password={company.portalPassword} />
                    ) : (
                      <span className="text-muted-foreground/40 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filtered.length} of {companies.length} accounts with portal credentials
        </p>
      )}
    </div>
  );
}
