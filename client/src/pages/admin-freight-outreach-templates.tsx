import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { FreightOutreachTemplate } from "@shared/schema";

const AVAILABLE_VARS = [
  "{{carrier_name}}", "{{rep_name}}", "{{rep_email}}", "{{customer_name}}",
  "{{lane_display}}", "{{origin}}", "{{destination}}", "{{equipment}}",
  "{{pickup_window}}", "{{load_count}}", "{{has_history}}", "{{history_phrase}}",
];

const KIND_LABELS: Record<string, { title: string; description: string }> = {
  exact_load: {
    title: "Exact load",
    description: "Sent when an opportunity has a specific shipment with pickup window and lane.",
  },
  lane_building: {
    title: "Lane building",
    description: "Sent for future-freight / capacity-development sweeps without a specific load.",
  },
};

export default function AdminFreightOutreachTemplatesPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ items: FreightOutreachTemplate[] }>({
    queryKey: ["/api/freight-outreach-templates"],
  });
  const items = data?.items ?? [];

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-screen-lg">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">Outreach email templates</h1>
        <p className="text-sm text-muted-foreground">
          Edit the subject + body the proactive freight outreach engine sends. Variables in
          double braces are substituted at send time. Unknown variables render as empty
          strings, so typos won't break sends.
        </p>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Available variables</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {AVAILABLE_VARS.map(v => (
            <code key={v} className="text-[11px] px-1.5 py-0.5 rounded bg-muted">{v}</code>
          ))}
        </CardContent>
      </Card>
      {isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        items.map(t => <TemplateEditor key={t.id} template={t} toast={toast} />)
      )}
    </div>
  );
}

function TemplateEditor({ template, toast }: { template: FreightOutreachTemplate; toast: ReturnType<typeof useToast>["toast"] }) {
  const meta = KIND_LABELS[template.kind] ?? { title: template.kind, description: "" };
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  useEffect(() => {
    setSubject(template.subject);
    setBody(template.body);
  }, [template.id, template.subject, template.body]);
  const dirty = subject !== template.subject || body !== template.body;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/freight-outreach-templates/${template.kind}`, { subject, body });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-outreach-templates"] });
      toast({ title: "Template saved" });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't save template",
        description: err?.message?.includes("Admin") ? "Only admins can edit org-wide templates." : (err?.message ?? "Please try again"),
        variant: "destructive",
      });
    },
  });

  return (
    <Card data-testid={`card-template-${template.kind}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{meta.title}</CardTitle>
        <CardDescription className="text-xs">{meta.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Subject</label>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} data-testid={`input-subject-${template.kind}`} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Body</label>
          <Textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} data-testid={`textarea-body-${template.kind}`} />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSubject(template.subject); setBody(template.body); }}
            disabled={!dirty}
            data-testid={`button-revert-${template.kind}`}
          >
            Revert
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            data-testid={`button-save-${template.kind}`}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
