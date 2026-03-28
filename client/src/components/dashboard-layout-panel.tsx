import { useState, useRef, useEffect } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GripVertical, RotateCcw, Eye, EyeOff } from "lucide-react";
import { DIRECTOR_PORTLETS, DashboardLayout, PortletDef } from "@/hooks/use-dashboard-layout";

interface Props {
  open: boolean;
  onClose: () => void;
  layout: DashboardLayout;
  onSave: (layout: DashboardLayout) => void;
  onReset: () => void;
}

export function DashboardLayoutPanel({ open, onClose, layout, onSave, onReset }: Props) {
  const [items, setItems] = useState<PortletDef[]>(() =>
    [...DIRECTOR_PORTLETS].sort((a, b) => (layout[a.id]?.order ?? 999) - (layout[b.id]?.order ?? 999))
  );
  const [visibilityMap, setVisibilityMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    DIRECTOR_PORTLETS.forEach(p => { map[p.id] = layout[p.id]?.visible ?? true; });
    return map;
  });

  useEffect(() => {
    if (!open) return;
    setItems([...DIRECTOR_PORTLETS].sort((a, b) => (layout[a.id]?.order ?? 999) - (layout[b.id]?.order ?? 999)));
    const vis: Record<string, boolean> = {};
    DIRECTOR_PORTLETS.forEach(p => { vis[p.id] = layout[p.id]?.visible ?? true; });
    setVisibilityMap(vis);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  function handleDragStart(idx: number) {
    dragItem.current = idx;
  }

  function handleDragEnter(idx: number) {
    dragOver.current = idx;
    if (dragItem.current === null || dragItem.current === idx) return;
    setItems(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragItem.current!, 1);
      next.splice(idx, 0, moved);
      dragItem.current = idx;
      return next;
    });
  }

  function handleDragEnd() {
    dragItem.current = null;
    dragOver.current = null;
    applyChanges(items, visibilityMap);
  }

  function toggleVisibility(id: string) {
    const next = { ...visibilityMap, [id]: !visibilityMap[id] };
    setVisibilityMap(next);
    applyChanges(items, next);
  }

  function applyChanges(orderedItems: PortletDef[], vis: Record<string, boolean>) {
    const next: DashboardLayout = {};
    orderedItems.forEach((p, i) => {
      next[p.id] = { visible: vis[p.id] ?? true, order: i };
    });
    onSave(next);
  }

  function handleReset() {
    const sorted = [...DIRECTOR_PORTLETS];
    setItems(sorted);
    const vis: Record<string, boolean> = {};
    sorted.forEach(p => { vis[p.id] = true; });
    setVisibilityMap(vis);
    onReset();
  }

  const visibleCount = Object.values(visibilityMap).filter(Boolean).length;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-[380px] sm:w-[420px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <SheetTitle className="text-base">Customize Dashboard</SheetTitle>
              <SheetDescription className="text-xs mt-0.5">
                Drag to reorder · toggle to show/hide · {visibleCount} of {DIRECTOR_PORTLETS.length} portlets visible
              </SheetDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={handleReset} className="gap-1.5 text-xs h-7 px-2 text-muted-foreground hover:text-foreground" data-testid="button-reset-layout">
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground px-6 pb-2 pt-2">
            Drag to reorder
          </p>
          <div className="space-y-0.5 px-3">
            {items.map((portlet, idx) => {
              const visible = visibilityMap[portlet.id] ?? true;
              return (
                <div
                  key={portlet.id}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragEnter={() => handleDragEnter(idx)}
                  onDragEnd={handleDragEnd}
                  onDragOver={e => e.preventDefault()}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-grab active:cursor-grabbing transition-all select-none ${
                    visible
                      ? "bg-card border-border hover:border-primary/30 hover:bg-muted/30"
                      : "bg-muted/30 border-dashed border-muted-foreground/20 opacity-60"
                  }`}
                  data-testid={`portlet-row-${portlet.id}`}
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium leading-tight ${visible ? "text-foreground" : "text-muted-foreground"}`}>
                        {portlet.label}
                      </span>
                      {portlet.directorOnly && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">Director</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5 leading-tight">
                      {portlet.description}
                    </p>
                  </div>

                  <button
                    onClick={() => toggleVisibility(portlet.id)}
                    className="shrink-0 flex items-center gap-1.5 text-xs px-2 py-1 rounded-md hover:bg-muted transition-colors"
                    title={visible ? "Hide this portlet" : "Show this portlet"}
                    data-testid={`toggle-visibility-${portlet.id}`}
                  >
                    {visible
                      ? <Eye className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                    }
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-4 border-t bg-muted/30">
          <p className="text-xs text-muted-foreground">
            Changes save automatically. Your layout is stored per browser.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
