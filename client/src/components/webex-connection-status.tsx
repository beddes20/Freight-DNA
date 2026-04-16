import { useState } from "react";
import { useWebexConnectionStatus } from "@/hooks/use-webex";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, ExternalLink, Copy, Check, Video, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function WebexConnectionStatus() {
  const { data, isLoading } = useWebexConnectionStatus();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  if (isLoading || !data) {
    return (
      <Card data-testid="card-webex-status">
        <CardContent className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking Webex connection…
        </CardContent>
      </Card>
    );
  }

  const {
    configured,
    authorized,
    needsReauth,
    accessTokenExpiresAt,
    lastRefreshError,
    redirectUri,
    redirectUriSource,
    portalUrl,
  } = data;
  const expiresInMin =
    accessTokenExpiresAt != null
      ? Math.max(0, Math.round((accessTokenExpiresAt - Date.now()) / 60000))
      : null;
  const sourceLabel =
    redirectUriSource === "WEBEX_REDIRECT_URI"
      ? "from WEBEX_REDIRECT_URI"
      : redirectUriSource === "APP_URL"
      ? "from APP_URL"
      : "auto-detected from request host (set WEBEX_REDIRECT_URI to lock)";

  const copyUri = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      toast({ title: "Redirect URI copied" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <Card data-testid="card-webex-status">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Video className="h-4 w-4 text-blue-600" />
            <h3 className="font-semibold text-sm">Webex Calling Integration</h3>
            {!configured ? (
              <Badge variant="outline" className="text-xs bg-muted text-muted-foreground" data-testid="badge-webex-not-configured">
                Not configured
              </Badge>
            ) : needsReauth ? (
              <Badge className="text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" data-testid="badge-webex-needs-reauth">
                <AlertTriangle className="h-3 w-3 mr-1" /> Re-authorization required
              </Badge>
            ) : authorized ? (
              <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" data-testid="badge-webex-authorized">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
              </Badge>
            ) : (
              <Badge className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" data-testid="badge-webex-not-authorized">
                <AlertTriangle className="h-3 w-3 mr-1" /> Not connected
              </Badge>
            )}
          </div>
          {configured && (
            <a href="/api/webex/authorize">
              <Button
                size="sm"
                variant={needsReauth ? "default" : authorized ? "outline" : "default"}
                data-testid="button-webex-authorize"
              >
                {needsReauth
                  ? "Re-authorize Webex"
                  : authorized
                  ? "Re-authorize"
                  : "Authorize Webex"}
              </Button>
            </a>
          )}
        </div>

        {configured && needsReauth && (
          <div
            className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-2.5 text-xs text-red-800 dark:text-red-200"
            data-testid="banner-webex-needs-reauth"
          >
            <p className="font-medium mb-1">Webex re-authorization required</p>
            <p>
              The stored Webex refresh token was rejected (it may have been revoked
              or expired). Call sync and presence are paused until an admin
              re-authorizes.
            </p>
            {lastRefreshError && (
              <p className="mt-1 opacity-80 break-all" data-testid="text-webex-refresh-error">
                Last error: <code className="font-mono">{lastRefreshError}</code>
              </p>
            )}
            <p className="mt-1 text-[11px] opacity-80">
              All admins are emailed (and notified in-app) automatically the moment this happens, so you
              don't have to keep checking this page.
            </p>
          </div>
        )}

        {configured && authorized && !needsReauth && expiresInMin != null && (
          <p className="text-[11px] text-muted-foreground" data-testid="text-webex-token-expiry">
            Access token refreshes automatically — current token valid for ~{expiresInMin} min.
          </p>
        )}

        {!configured && (
          <p className="text-xs text-muted-foreground">
            Set <code className="px-1 py-0.5 rounded bg-muted">WEBEX_CLIENT_ID</code>,{" "}
            <code className="px-1 py-0.5 rounded bg-muted">WEBEX_CLIENT_SECRET</code>, and{" "}
            <code className="px-1 py-0.5 rounded bg-muted">WEBEX_ORG_ID</code> to enable this integration.
          </p>
        )}

        {configured && (
          <div className="space-y-2">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Redirect URI to register in Webex Developer Portal:
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
                <code className="text-xs font-mono break-all flex-1" data-testid="text-webex-redirect-uri">
                  {redirectUri}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  onClick={copyUri}
                  data-testid="button-copy-webex-redirect-uri"
                  title="Copy redirect URI"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">{sourceLabel}</p>
            </div>

            {!authorized && !needsReauth && (
              <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-200">
                <p className="font-medium mb-1">Webex is configured but not yet authorized.</p>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>Copy the redirect URI above.</li>
                  <li>
                    Open the{" "}
                    <a
                      href={portalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline inline-flex items-center gap-0.5"
                      data-testid="link-webex-portal"
                    >
                      Webex Developer Portal <ExternalLink className="h-3 w-3" />
                    </a>{" "}
                    and add it to your Service App's Redirect URIs (must match EXACTLY).
                  </li>
                  <li>Click <span className="font-semibold">Authorize Webex</span> above.</li>
                </ol>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
