import { Search } from "lucide-react";
import { openCommandPalette } from "@/components/command-palette";

// The old in-place dropdown was replaced by a true command palette
// (CommandPalette) that combines navigation, actions, and search. This
// component is now just the visible trigger button in the nav so users
// still discover the feature; ⌘K from anywhere also opens the palette.
export function GlobalSearch({ navBar }: { navBar?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => openCommandPalette()}
      data-testid="button-global-search"
      className={`relative w-72 h-8 flex items-center gap-2 rounded-md border px-2.5 text-sm transition-colors text-left ${
        navBar
          ? "border-white/20 bg-white/10 text-white/70 hover:bg-white/15"
          : "border-border bg-background text-muted-foreground hover:bg-accent"
      }`}
    >
      <Search className="h-4 w-4 shrink-0 opacity-70" />
      <span className="truncate flex-1">Search or jump to…</span>
      <span className={`text-[10px] px-1 py-0.5 rounded border font-mono ${navBar ? "border-white/20 text-white/50" : "border-border text-muted-foreground/60"}`}>
        ⌘K
      </span>
    </button>
  );
}
