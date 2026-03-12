import { Card, CardContent } from "@/components/ui/card";
import { BookOpen, FileText, ExternalLink } from "lucide-react";

export default function Playbook() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-playbook-title">Playbook</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Access sales playbooks and standard operating procedures from SharePoint.
        </p>
      </div>

      <Card>
        <CardContent className="py-20 text-center">
          <div className="flex items-center justify-center mb-4">
            <div className="relative">
              <FileText className="h-12 w-12 text-muted-foreground" />
              <ExternalLink className="h-5 w-5 text-primary absolute -top-1 -right-2" />
            </div>
          </div>
          <p className="font-semibold text-lg text-muted-foreground" data-testid="text-playbook-status">
            Not yet connected
          </p>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            This page will display playbook documents from SharePoint once connected.
            Check back soon for sales guides, templates, and reference materials.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
