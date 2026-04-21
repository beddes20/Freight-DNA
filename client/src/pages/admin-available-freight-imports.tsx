import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { CheckCircle2, AlertTriangle, RefreshCw, PlayCircle, Save, Plug } from "lucide-react";
import { Link } from "wouter";

interface ImportRow {
  id: string;
  fileName: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  expired: number;
  unmatchedCompanies: number;
  warnings: string[];
  actorUserId: string | null;
  triggeredBy: string;
  error: string | null;
  createdAt: string;
}

interface TestResult {
  ok: boolean;
  status: number;
  message: string;
}

interface ImportSummary {
  fileName: string;
  totalRows: number;
  inserted: number;
  updated: number;
  expired: number;
  unmatchedCompanies: number;
  warnings: string[];
}

export default function AdminAvailableFreightImports() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [draftUrl, setDraftUrl] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const isManager = ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(user?.role ?? "");
  const isAdmin = user?.role === "admin";

  const settingQuery = useQuery<{ url: string | null; lastImport: unknown }>({
    queryKey: ["/api/available-freight/onedrive-url"],
    enabled: isAdmin,
  });
  const importsQuery = useQuery<{ imports: ImportRow[] }>({
    queryKey: ["/api/available-freight/imports"],
    enabled: isManager,
  });

  const saveUrl = useMutation({
    mutationFn: (url: string) => apiRequest("PUT", "/api/available-freight/onedrive-url", { url }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Saved", description: "OneDrive URL updated." });
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/available-freight/onedrive-url"] });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const testUrl = useMutation<TestResult, Error, string | null>({
    mutationFn: (url) =>
      apiRequest("POST", "/api/available-freight/onedrive-url/test", url ? { url } : {}).then((r) => r.json() as Promise<TestResult>),
    onSuccess: (res) => setTestResult(res),
    onError: (err) => setTestResult({ ok: false, status: 0, message: err.message }),
  });

  const runImport = useMutation<{ summary?: ImportSummary }, Error, void>({
    mutationFn: () => apiRequest("POST", "/api/available-freight/import", {}).then((r) => r.json() as Promise<{ summary?: ImportSummary }>),
    onSuccess: (res) => {
      const s = res.summary;
      toast({
        title: "Import complete",
        description: `${s?.inserted ?? 0} new, ${s?.updated ?? 0} updated, ${s?.expired ?? 0} expired.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/available-freight/imports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/available-freight/onedrive-url"] });
    },
    onError: (err) => toast({ title: "Import failed", description: err.message, variant: "destructive" }),
  });

  if (!isManager) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>You need manager access to view this page.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const currentUrl = settingQuery.data?.url ?? "";

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="heading-admin-freight-imports">
            Available Freight — Import Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage the daily OneDrive pull and review recent import runs.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/available-freight">
            <Button variant="outline" data-testid="link-back-to-freight">Back to Available Freight</Button>
          </Link>
          <Button
            onClick={() => runImport.mutate()}
            disabled={runImport.isPending}
            data-testid="button-run-import-now"
          >
            <PlayCircle className="h-4 w-4 mr-2" />
            {runImport.isPending ? "Running..." : "Run import now"}
          </Button>
        </div>
      </div>

      {isAdmin && (
        <Card data-testid="card-onedrive-setting">
          <CardHeader>
            <CardTitle className="text-base">OneDrive Source URL</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {editing ? (
              <>
                <Label htmlFor="onedrive-url">Share link, Graph URL, or relative path</Label>
                <Input
                  id="onedrive-url"
                  value={draftUrl}
                  onChange={(e) => setDraftUrl(e.target.value)}
                  placeholder="https://1drv.ms/... or drives/{driveId}/items/{itemId}"
                  data-testid="input-onedrive-url"
                />
                <div className="flex gap-2">
                  <Button
                    onClick={() => saveUrl.mutate(draftUrl)}
                    disabled={!draftUrl.trim() || saveUrl.isPending}
                    data-testid="button-save-onedrive-url"
                  >
                    <Save className="h-4 w-4 mr-2" />
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => testUrl.mutate(draftUrl)}
                    disabled={!draftUrl.trim() || testUrl.isPending}
                    data-testid="button-test-onedrive-url-draft"
                  >
                    <Plug className="h-4 w-4 mr-2" />
                    {testUrl.isPending ? "Testing..." : "Test connection"}
                  </Button>
                  <Button variant="ghost" onClick={() => { setEditing(false); setTestResult(null); }} data-testid="button-cancel-edit-url">
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="font-mono text-sm break-all p-2 bg-muted rounded" data-testid="text-current-onedrive-url">
                  {currentUrl || <span className="italic text-muted-foreground">Not configured</span>}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => { setDraftUrl(currentUrl); setEditing(true); setTestResult(null); }}
                    data-testid="button-edit-onedrive-url"
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => testUrl.mutate(null)}
                    disabled={!currentUrl || testUrl.isPending}
                    data-testid="button-test-onedrive-url"
                  >
                    <Plug className="h-4 w-4 mr-2" />
                    {testUrl.isPending ? "Testing..." : "Test connection"}
                  </Button>
                </div>
              </>
            )}

            {testResult && (
              <Alert variant={testResult.ok ? "default" : "destructive"} data-testid={`alert-test-result-${testResult.ok ? "ok" : "fail"}`}>
                <AlertDescription>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 font-medium">
                      {testResult.ok ? (
                        <><CheckCircle2 className="h-4 w-4 text-green-600" /> Connection OK</>
                      ) : (
                        <><AlertTriangle className="h-4 w-4" /> Test failed{testResult.status ? ` (HTTP ${testResult.status})` : ""}</>
                      )}
                    </div>
                    <div className="text-sm" data-testid="text-test-message">{testResult.message}</div>
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-recent-imports">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recent Imports</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => importsQuery.refetch()}
            disabled={importsQuery.isFetching}
            data-testid="button-refresh-imports"
          >
            <RefreshCw className={`h-4 w-4 ${importsQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {importsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (importsQuery.data?.imports?.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground">No imports recorded yet.</div>
          ) : (
            <div className="space-y-2">
              {importsQuery.data!.imports.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-col gap-1 p-3 border rounded text-sm"
                  data-testid={`row-import-${row.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </span>
                    <Badge variant={row.error ? "destructive" : "secondary"} data-testid={`badge-import-trigger-${row.id}`}>
                      {row.triggeredBy}
                    </Badge>
                  </div>
                  <div className="font-medium" data-testid={`text-import-file-${row.id}`}>
                    {row.fileName ?? <span className="italic text-muted-foreground">unknown file</span>}
                  </div>
                  {row.error ? (
                    <div className="text-destructive text-sm" data-testid={`text-import-error-${row.id}`}>
                      <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
                      {row.error}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <span><strong>{row.totalRows}</strong> rows</span>
                      <span className="text-green-700 dark:text-green-400"><strong>{row.inserted}</strong> new</span>
                      <span><strong>{row.updated}</strong> updated</span>
                      <span><strong>{row.expired}</strong> expired</span>
                      {row.unmatchedCompanies > 0 && (
                        <span className="text-amber-700 dark:text-amber-400">
                          <strong>{row.unmatchedCompanies}</strong> unmatched
                        </span>
                      )}
                    </div>
                  )}
                  {row.warnings.length > 0 && (
                    <details className="text-xs text-muted-foreground" data-testid={`details-warnings-${row.id}`}>
                      <summary className="cursor-pointer">{row.warnings.length} warning(s)</summary>
                      <ul className="mt-1 list-disc list-inside space-y-0.5">
                        {row.warnings.slice(0, 20).map((w, i) => (<li key={i}>{w}</li>))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
