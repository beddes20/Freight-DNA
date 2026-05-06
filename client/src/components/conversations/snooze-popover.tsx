import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

interface SnoozePopoverProps {
  trigger?: React.ReactNode;
  onSnooze: (until: Date) => void | Promise<void>;
  disabled?: boolean;
  testId?: string;
  // Optional controlled-open mode so a parent (e.g. an overflow menu) can
  // open the snooze panel programmatically without nesting popovers in the
  // trigger.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function laterToday(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 3);
  return d;
}

function tomorrowMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

function nextMonday(): Date {
  const d = new Date();
  const day = d.getDay();
  // 0 = Sun ... 6 = Sat. Monday = 1. If today is Monday, jump 7 days.
  const diff = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + diff);
  d.setHours(8, 0, 0, 0);
  return d;
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPresetTime(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SnoozePopover({
  trigger,
  onSnooze,
  disabled,
  testId,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: SnoozePopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) controlledOnOpenChange?.(next);
    else setUncontrolledOpen(next);
  };
  const [customValue, setCustomValue] = useState(() => toLocalInputValue(tomorrowMorning()));
  const [busy, setBusy] = useState(false);

  const presets = useMemo(() => [
    { id: "later-today", label: "Later today", date: laterToday() },
    { id: "tomorrow-morning", label: "Tomorrow morning", date: tomorrowMorning() },
    { id: "next-monday", label: "Next Monday", date: nextMonday() },
  ], [open]);

  const handlePick = async (date: Date) => {
    if (date.getTime() <= Date.now()) return;
    setBusy(true);
    try {
      await onSnooze(date);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleCustom = async () => {
    const d = new Date(customValue);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return;
    await handlePick(d);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" disabled={disabled} data-testid={testId ?? "button-snooze"}>
            <Clock className="w-4 h-4 mr-1.5" />
            Snooze
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1.5">
          Snooze until
        </div>
        <div className="flex flex-col gap-0.5">
          {presets.map(p => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => handlePick(p.date)}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm text-sm hover:bg-muted text-left disabled:opacity-50"
              data-testid={`snooze-preset-${p.id}`}
            >
              <span>{p.label}</span>
              <span className="text-xs text-muted-foreground">{formatPresetTime(p.date)}</span>
            </button>
          ))}
        </div>
        <Separator className="my-2" />
        <div className="px-2 pb-2 space-y-2">
          <Label htmlFor="snooze-custom" className="text-xs">Custom date & time</Label>
          <Input
            id="snooze-custom"
            type="datetime-local"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            min={toLocalInputValue(new Date(Date.now() + 60_000))}
            data-testid="input-snooze-custom"
          />
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={handleCustom}
            data-testid="button-snooze-custom-apply"
          >
            Snooze until selected time
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
