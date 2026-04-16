import { WebexMyConnection } from "@/components/webex-my-connection";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";

interface CurrentUser {
  id: string;
  name: string | null;
  username: string;
  role: string;
  organizationId: string;
}

export default function ProfilePage() {
  const { data: user } = useQuery<CurrentUser>({ queryKey: ["/api/auth/me"] });

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

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Integrations</h2>
        <WebexMyConnection />
      </section>
    </div>
  );
}
