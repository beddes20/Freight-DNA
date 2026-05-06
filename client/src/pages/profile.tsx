import { WebexMyConnection } from "@/components/webex-my-connection";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CurrentUser {
  id: string;
  name: string | null;
  username: string;
  role: string;
  organizationId: string;
  valueiqLandingDisabled?: boolean;
}

export default function ProfilePage() {
  const { toast } = useToast();
  const { data: user } = useQuery<CurrentUser>({ queryKey: ["/api/auth/me"] });

  const togglePref = useMutation({
    mutationFn: async (valueiqLandingDisabled: boolean) =>
      apiRequest("PATCH", "/api/profile/preferences", { valueiqLandingDisabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Preference updated" });
    },
    onError: () => toast({ title: "Couldn't update preference", variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="page-profile">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="heading-profile">My Profile</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage the personal integrations connected to your FreightDNA account.
        </p>
      </div>

      {user && (
        <Card>
          <CardContent className="p-4 space-y-1">
            <p className="text-sm font-medium" data-testid="text-profile-name">{user.name || user.username}</p>
            <p className="text-xs text-muted-foreground" data-testid="text-profile-username">{user.username}</p>
            <p className="text-xs text-muted-foreground" data-testid="text-profile-role">Role: {user.role}</p>
          </CardContent>
        </Card>
      )}

      {user && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Workspace</h2>
          <Card>
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="toggle-valueiq-landing" className="text-sm font-medium">
                  Land on ValueIQ after sign-in
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  When on, you'll see your ValueIQ Threads workspace first instead of the dashboard.
                </p>
              </div>
              <Switch
                id="toggle-valueiq-landing"
                data-testid="switch-valueiq-landing"
                checked={!user.valueiqLandingDisabled}
                onCheckedChange={(checked) => togglePref.mutate(!checked)}
                disabled={togglePref.isPending}
              />
            </CardContent>
          </Card>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Integrations</h2>
        <WebexMyConnection />
      </section>
    </div>
  );
}
