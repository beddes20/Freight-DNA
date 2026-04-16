import { useWebexMyConnection } from "@/hooks/use-webex";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, Loader2, Video, Unplug, RefreshCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";

export function WebexMyConnection() {
  const { data, isLoading } = useWebexMyConnection();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/webex/my-connection");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/webex/my-connection"] });
      toast({ title: "Disconnected from Webex" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to disconnect", description: err?.message, variant: "destructive" });
    },
  });

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/webex/sync-my-calls", { hoursBack: 24 });
      const body = await res.json();
      toast({
        title: "Sync complete",
        description: `Pulled ${body.synced ?? 0} call${body.synced === 1 ? "" : "s"} from your Webex history.`,
      });
    } catch (err: any) {
      toast({ title: "Sync failed", description: err?.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  if (isLoading || !data) {
    return (
      <Card data-testid="card-webex-my-connection">
        <CardContent className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking your Webex connection…
        </CardContent>
      </Card>
    );
  }

  const { configured, connected, needsReauth, webexEmail, webexDisplayName, accessTokenExpiresAt } = data;

  const expiresInMin = accessTokenExpiresAt
    ? Math.max(0, Math.round((new Date(accessTokenExpiresAt).getTime() - Date.now()) / 60000))
    : null;

  return (
    <Card data-testid="card-webex-my-connection">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Video className="h-4 w-4 text-blue-600" />
            <h3 className="font-semibold text-sm">My Webex Account</h3>
            {!configured ? (
              <Badge variant="outline" className="text-xs bg-muted text-muted-foreground" data-testid="badge-webex-my-not-configured">
                Not configured
              </Badge>
            ) : needsReauth ? (
              <Badge className="text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" data-testid="badge-webex-my-needs-reauth">
                <AlertTriangle className="h-3 w-3 mr-1" /> Re-authorization required
              </Badge>
            ) : connected ? (
              <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" data-testid="badge-webex-my-connected">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
              </Badge>
            ) : (
              <Badge className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" data-testid="badge-webex-my-not-connected">
                Not connected
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {configured && connected && !needsReauth && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={syncNow}
                  disabled={syncing}
                  data-testid="button-webex-sync-my-calls"
                >
                  {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5 mr-1" />}
                  Sync my calls
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                  data-testid="button-webex-disconnect"
                >
                  <Unplug className="h-3.5 w-3.5 mr-1" />
                  Disconnect
                </Button>
              </>
            )}
            {configured && (!connected || needsReauth) && (
              <a href="/api/webex/authorize?mode=personal">
                <Button size="sm" data-testid="button-webex-connect-personal">
                  {needsReauth ? "Reconnect Webex" : "Connect my Webex account"}
                </Button>
              </a>
            )}
          </div>
        </div>

        {!configured && (
          <p className="text-xs text-muted-foreground">
            Webex isn't configured for this workspace yet. Ask an admin to finish the Webex setup.
          </p>
        )}

        {configured && !connected && !needsReauth && (
          <p className="text-xs text-muted-foreground">
            Connect your Webex account to sync your own call history, enable click-to-dial from your line,
            and share your real-time presence with teammates.
          </p>
        )}

        {configured && connected && !needsReauth && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {(webexDisplayName || webexEmail) && (
              <p data-testid="text-webex-my-identity">
                Signed in as <span className="font-medium text-foreground">{webexDisplayName ?? webexEmail}</span>
                {webexDisplayName && webexEmail ? ` (${webexEmail})` : null}
              </p>
            )}
            {expiresInMin != null && (
              <p data-testid="text-webex-my-token-expiry">
                Access token refreshes automatically — current token valid for ~{expiresInMin} min.
              </p>
            )}
          </div>
        )}

        {configured && needsReauth && (
          <div
            className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-2.5 text-xs text-red-800 dark:text-red-200"
            data-testid="banner-webex-my-needs-reauth"
          >
            <p className="font-medium mb-1">Your Webex session expired</p>
            <p>Reconnect to resume syncing your call history and presence.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
