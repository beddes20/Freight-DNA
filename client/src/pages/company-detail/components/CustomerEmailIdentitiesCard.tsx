import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Mail, AtSign, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { CustomerEmailIdentity, Company, User } from "@shared/schema";
import { CUSTOMER_EMAIL_IDENTITY_KINDS } from "@shared/schema";

type SafeUser = Omit<User, "password">;

interface Props { companyId: string }

const KIND_LABEL: Record<typeof CUSTOMER_EMAIL_IDENTITY_KINDS[number], string> = {
  contact: "Contact email",
  shared_distribution: "Shared/distribution",
  domain: "Domain",
};
const KIND_ICON: Record<typeof CUSTOMER_EMAIL_IDENTITY_KINDS[number], JSX.Element> = {
  contact: <Mail className="h-3 w-3" />,
  shared_distribution: <Users className="h-3 w-3" />,
  domain: <AtSign className="h-3 w-3" />,
};

export function CustomerEmailIdentitiesCard({ companyId }: Props) {
  const { toast } = useToast();
  const [kind, setKind] = useState<typeof CUSTOMER_EMAIL_IDENTITY_KINDS[number]>("contact");
  const [value, setValue] = useState("");

  const { data: company } = useQuery<Company>({ queryKey: ["/api/companies", companyId] });
  const { data: identities = [], isLoading } = useQuery<CustomerEmailIdentity[]>({
    queryKey: ["/api/companies", companyId, "email-identities"],
  });
  const { data: users = [] } = useQuery<SafeUser[]>({ queryKey: ["/api/users/sales"] });
  const ownerName = company?.ownerRepId
    ? users.find(u => u.id === company.ownerRepId)?.name ?? "—"
    : null;

  const createMut = useMutation({
    mutationFn: (payload: { kind: string; value: string }) =>
      apiRequest("POST", `/api/companies/${companyId}/email-identities`, payload),
    onSuccess: () => {
      setValue("");
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "email-identities"] });
      toast({ title: "Email identity added" });
    },
    onError: (err: Error) => toast({ title: "Couldn't add identity", description: err.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (identityId: string) =>
      apiRequest("DELETE", `/api/companies/${companyId}/email-identities/${identityId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "email-identities"] });
      toast({ title: "Identity removed" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Email Routing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs">
          <span className="text-muted-foreground">Account Owner (fallback when inbound email lands in an unmapped mailbox): </span>
          <span className="font-medium" data-testid="text-owner-rep-name">{ownerName ?? "— None set —"}</span>
          <p className="text-[11px] text-muted-foreground mt-1">
            Edit owner via the company's edit dialog (admin/director/NAM only).
          </p>
        </div>

        <div>
          <p className="text-xs font-medium mb-2">Email Identities</p>
          <p className="text-[11px] text-muted-foreground mb-2">
            Inbound email routes to this customer when From matches by precedence:
            contact → shared/distribution → domain.
          </p>
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : identities.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No identities configured.</p>
          ) : (
            <ul className="space-y-1">
              {identities.map(id => (
                <li key={id.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1.5"
                    data-testid={`row-identity-${id.id}`}>
                  <div className="flex items-center gap-2 text-xs">
                    <Badge variant="secondary" className="gap-1">
                      {KIND_ICON[id.kind as typeof CUSTOMER_EMAIL_IDENTITY_KINDS[number]]}
                      {KIND_LABEL[id.kind as typeof CUSTOMER_EMAIL_IDENTITY_KINDS[number]]}
                    </Badge>
                    <span className="font-mono">{id.value}</span>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                          data-testid={`button-delete-identity-${id.id}`}
                          onClick={() => deleteMut.mutate(id.id)}
                          disabled={deleteMut.isPending}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
          <Select value={kind} onValueChange={(v) => setKind(v as typeof CUSTOMER_EMAIL_IDENTITY_KINDS[number])}>
            <SelectTrigger className="w-[180px] h-8 text-xs" data-testid="select-identity-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOMER_EMAIL_IDENTITY_KINDS.map(k => (
                <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            data-testid="input-identity-value"
            placeholder={kind === "domain" ? "acme.com" : "name@acme.com"}
            value={value}
            onChange={e => setValue(e.target.value)}
            className="flex-1 min-w-[180px] h-8 text-xs"
          />
          <Button
            data-testid="button-add-identity"
            size="sm"
            disabled={!value.trim() || createMut.isPending}
            onClick={() => createMut.mutate({ kind, value: value.trim() })}
          >
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
