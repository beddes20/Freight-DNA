import { BookOpen, FolderOpen, ExternalLink, Wrench } from "lucide-react";

const resources = [
  {
    title: "Playbook",
    description: "The Value Truck sales playbook — processes, scripts, objection handling, and account strategies.",
    icon: BookOpen,
    url: "https://valuetruck-my.sharepoint.com/:w:/p/ben_beddes/IQAxq4cjYozxTJHB-zYcZtBnAYWpGDvcP6Qj_AW6ULA_Oq8?rtime=s9jxtGeA3kg&ovuser=99d7bd71-9046-4915-be1c-3aae2baf1645%2Cben.beddes%40valuetruck.com&clickparams=eyJBcHBOYW1lIjoiVGVhbXMtRGVza3RvcCIsIkFwcFZlcnNpb24iOiI0OS8yNjAyMDEwMTEyMCIsIkhhc0ZlZGVyYXRlZFVzZXIiOmZhbHNlfQ%3D%3D",
    color: "from-blue-500 to-blue-600",
    testId: "link-playbook",
  },
  {
    title: "Buckets",
    description: "Bucket structure and territory breakdown for account planning and market segmentation.",
    icon: FolderOpen,
    url: "https://valuetruck-my.sharepoint.com/:p:/r/personal/ben_beddes_valuetruck_com/_layouts/15/Doc2.aspx?action=edit&sourcedoc=%7B088c48cc-a345-4d1a-9947-b49d3cd7112c%7D&wdOrigin=TEAMS-MAGLEV.undefined_ns.rwc&wdExp=TEAMS-TREATMENT&wdhostclicktime=1749156731495&web=1",
    color: "from-green-500 to-green-600",
    testId: "link-buckets",
  },
];

export default function ToolsPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-green-500 text-white">
          <Wrench className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Tools & Resources</h1>
          <p className="text-sm text-muted-foreground">
            Quick access to team reference materials and external resources.
          </p>
        </div>
      </div>

      {/* Resources portlet */}
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Resources</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {resources.map((r) => (
            <a
              key={r.title}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={r.testId}
              className="group flex flex-col gap-3 rounded-xl border bg-background p-5 hover:border-primary/40 hover:shadow-sm transition-all"
            >
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br ${r.color} text-white`}>
                <r.icon className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm">{r.title}</span>
                  <ExternalLink className="h-3 w-3 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{r.description}</p>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
