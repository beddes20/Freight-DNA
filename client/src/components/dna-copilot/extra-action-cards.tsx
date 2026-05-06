/**
 * Action cards for the new tools introduced in the Copilot redesign:
 *  - draft_email        → editable subject + body, send via DraftEmailModal API
 *  - open_filtered_queue → confirm-before-navigate to a deep-linked queue
 *
 * The legacy log_touchpoint / create_task / complete_task / mark_meaningful
 * cards still live in `crm-chatbot.tsx`'s ActionCard.
 */
import { useState } from "react";
import { Check, ExternalLink, Mail, ListFilter, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

const fieldCls = "w-full mt-0.5 text-xs rounded border bg-background px-2 py-1 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-indigo-400";

export function DraftEmailCard({
  args,
  confirmed,
  failed,
  onConfirm,
  onDismiss,
}: {
  args: Record<string, string>;
  confirmed?: boolean;
  failed?: boolean;
  onConfirm: (edited: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const [subject, setSubject] = useState(args.subject || "");
  const [body, setBody] = useState(args.body || "");

  if (confirmed) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
        <Check className="h-3.5 w-3.5" /> Email draft saved.
      </div>
    );
  }
  if (failed) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
        <AlertTriangle className="h-3.5 w-3.5" /> Draft failed. Try again.
      </div>
    );
  }

  return (
    <div className="mt-2 border border-violet-200 dark:border-violet-800 rounded-xl bg-violet-50 dark:bg-violet-950/30 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Mail className="h-4 w-4" /> Draft Email
        {args.contact_name && <span className="text-muted-foreground font-normal">→ {args.contact_name}{args.company_name ? ` @ ${args.company_name}` : ""}</span>}
      </div>
      <div className="space-y-1.5">
        <div>
          <label className="text-xs text-muted-foreground">Subject</label>
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line" className={fieldCls} data-testid="email-subject-input" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Body</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Email body" rows={6} className={`${fieldCls} resize-y min-h-[120px]`} data-testid="email-body-input" />
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <Button size="sm" className="h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white flex-1" onClick={() => onConfirm({ ...args, subject, body })} data-testid="action-confirm-draft-email">
          <Check className="h-3.5 w-3.5 mr-1" /> Save draft
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
      </div>
    </div>
  );
}

export function OpenQueueCard({
  args,
  confirmed,
  failed,
  onConfirm,
  onDismiss,
}: {
  args: Record<string, string>;
  confirmed?: boolean;
  failed?: boolean;
  onConfirm: (edited: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  if (confirmed) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
        <Check className="h-3.5 w-3.5" /> Opened.
      </div>
    );
  }
  if (failed) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
        <AlertTriangle className="h-3.5 w-3.5" /> Could not open that view.
      </div>
    );
  }
  return (
    <div className="mt-2 border border-sky-200 dark:border-sky-800 rounded-xl bg-sky-50 dark:bg-sky-950/30 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
        <ListFilter className="h-4 w-4" /> Open filtered view
      </div>
      <p className="text-xs text-foreground">
        {args.label || `${args.queue}${args.filter ? ` (${args.filter})` : ""}`}
      </p>
      <p className="text-[11px] text-muted-foreground truncate" title={args.path}>{args.path}</p>
      <div className="flex gap-2 pt-1">
        <Button size="sm" className="h-7 text-xs bg-sky-600 hover:bg-sky-700 text-white flex-1" onClick={() => onConfirm(args)} data-testid="action-confirm-open-queue">
          <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
      </div>
    </div>
  );
}
