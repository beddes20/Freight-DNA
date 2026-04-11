import { HelpCircle, Keyboard } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const SHORTCUTS = [
  { keys: ["Shift", "T"], description: "Log a Touch" },
];

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground text-xs">+</span>}
          <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 rounded border border-border bg-muted text-xs font-mono font-medium leading-none min-w-[1.5rem]">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          title="Keyboard shortcuts"
          data-testid="button-keyboard-shortcuts"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-3" data-testid="popover-keyboard-shortcuts">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 mb-3">
            <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Keyboard Shortcuts</span>
          </div>
          {SHORTCUTS.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <span className="text-sm text-foreground">{s.description}</span>
              <ShortcutKeys keys={s.keys} />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
