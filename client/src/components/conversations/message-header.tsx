import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatDate } from "./utils";

// Outlook-style reading-pane header: avatar + initials, sender display
// name + email, "To: …" line, right-aligned date, optional actions slot.

function deriveDisplay(emailRaw: string | null): { name: string; email: string; initials: string } {
  if (!emailRaw) return { name: "Unknown sender", email: "", initials: "?" };
  // Accept `"Display Name" <addr@domain>` as well as a bare address.
  const named = /^\s*"?([^"<]+?)"?\s*<\s*([^>]+)\s*>\s*$/.exec(emailRaw);
  let display = "";
  let email = emailRaw.trim();
  if (named) {
    display = named[1].trim();
    email = named[2].trim();
  }
  if (!display) {
    const local = email.split("@")[0] ?? email;
    const cleaned = local.replace(/[._\-+]+/g, " ").trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    display = parts.map((p) => p[0]?.toUpperCase() + p.slice(1).toLowerCase()).join(" ");
    if (!display) display = email;
  }
  const words = display.split(/\s+/).filter(Boolean);
  let initials: string;
  if (words.length === 0) initials = email[0]?.toUpperCase() ?? "?";
  else if (words.length === 1) initials = words[0].slice(0, 2).toUpperCase();
  else initials = (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return { name: display, email, initials };
}

interface MessageHeaderProps {
  fromEmail: string | null;
  toEmail: string | null;
  ccEmail?: string | null;
  date: string;
  isOutbound: boolean;
  actions?: ReactNode;
  testIdPrefix: string;
  // Pre-existing test-ids on the from-line and date pill, kept as
  // sr-only spans so existing automation selectors still resolve.
  legacyFromTestId?: string;
  legacyDateTestId?: string;
}

export function MessageHeader({
  fromEmail,
  toEmail,
  ccEmail,
  date,
  isOutbound,
  actions,
  testIdPrefix,
  legacyFromTestId,
  legacyDateTestId,
}: MessageHeaderProps) {
  const { name, email, initials } = deriveDisplay(fromEmail);
  const recipientLine = [toEmail, ccEmail ? `cc: ${ccEmail}` : null].filter(Boolean).join(" • ");
  const formattedDate = formatDate(date);

  return (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          "shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold select-none",
          isOutbound
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground border border-border",
        )}
        aria-hidden
        data-testid={`${testIdPrefix}-avatar`}
      >
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span
            className="text-sm font-semibold text-foreground truncate max-w-full"
            data-testid={`${testIdPrefix}-name`}
            title={name}
          >
            {name}
          </span>
          {email && email !== name && (
            <span
              className="text-xs text-muted-foreground truncate"
              data-testid={`${testIdPrefix}-email`}
              title={email}
            >
              &lt;{email}&gt;
            </span>
          )}
          {legacyFromTestId && (
            <span
              data-testid={legacyFromTestId}
              className="sr-only"
            >
              {fromEmail ?? name}
            </span>
          )}
        </div>
        {recipientLine && (
          <div
            className="text-xs text-muted-foreground mt-0.5 truncate"
            title={recipientLine}
            data-testid={`${testIdPrefix}-recipients`}
          >
            <span className="font-medium text-muted-foreground/80">To:</span> {recipientLine}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 self-start">
        {actions}
        <span
          className="text-xs text-muted-foreground whitespace-nowrap"
          data-testid={`${testIdPrefix}-date`}
        >
          {formattedDate}
          {legacyDateTestId && (
            <span data-testid={legacyDateTestId} className="sr-only">
              {formattedDate}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
