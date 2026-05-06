import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { X, ExternalLink } from "lucide-react";

export type DrawerKind = "customer" | "carrier" | "lane";

export interface DrawerSpec {
  kind: DrawerKind;
  id: string;
  name: string;
  fullPagePath?: string;
}

interface DrawerContextValue {
  open: (spec: DrawerSpec) => void;
  close: () => void;
  depth: number;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

const MAX_DEPTH = 2;

const RENDERERS: Partial<Record<DrawerKind, (spec: DrawerSpec) => ReactNode>> = {};

export function registerDrawerRenderer(kind: DrawerKind, render: (spec: DrawerSpec) => ReactNode) {
  RENDERERS[kind] = render;
}

function defaultFullPagePath(spec: DrawerSpec): string {
  switch (spec.kind) {
    case "customer": return `/companies/${spec.id}`;
    case "carrier":  return `/carrier-hub/${spec.id}`;
    case "lane":     return `/lane-inbox?laneId=${encodeURIComponent(spec.id)}`;
  }
}

function DrawerBody({ spec }: { spec: DrawerSpec }) {
  const renderer = RENDERERS[spec.kind];
  if (renderer) return <>{renderer(spec)}</>;
  return (
    <div className="text-sm text-muted-foreground" data-testid={`drawer-empty-${spec.kind}`}>
      No detail renderer registered for <span className="font-mono">{spec.kind}</span>.
    </div>
  );
}

export function DetailDrawerProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<DrawerSpec[]>([]);
  const [, navigate] = useLocation();

  const open = useCallback((spec: DrawerSpec) => {
    setStack(prev => {
      const next = [...prev, spec];
      // Keep the most recent MAX_DEPTH frames so back-stack reflects latest drill-in.
      return next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next;
    });
  }, []);
  const close = useCallback(() => {
    setStack(prev => prev.slice(0, -1));
  }, []);
  const closeAll = useCallback(() => setStack([]), []);

  const value = useMemo<DrawerContextValue>(() => ({ open, close, depth: stack.length }), [open, close, stack.length]);

  return (
    <DrawerContext.Provider value={value}>
      {children}
      {stack.map((spec, idx) => {
        const isTop = idx === stack.length - 1;
        const fullPath = spec.fullPagePath ?? defaultFullPagePath(spec);
        return (
          <Sheet
            key={`${spec.kind}-${spec.id}-${idx}`}
            open={isTop}
            onOpenChange={(o) => { if (!o) close(); }}
          >
            <SheetContent
              side="right"
              className="w-[480px] sm:max-w-[480px] p-0 flex flex-col"
              data-testid={`drawer-${spec.kind}-${spec.id}`}
              aria-label={`${spec.kind} detail: ${spec.name}`}
            >
              <VisuallyHidden>
                <SheetTitle>{`${spec.kind} detail: ${spec.name}`}</SheetTitle>
                <SheetDescription>{`Side panel showing details for ${spec.name}.`}</SheetDescription>
              </VisuallyHidden>
              <div className="flex items-start justify-between gap-2 px-5 py-4 border-b">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground" data-testid="drawer-kind">
                    {spec.kind}
                  </div>
                  <h2 className="text-lg font-semibold truncate" data-testid="drawer-title">{spec.name}</h2>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 gap-1"
                    onClick={() => { closeAll(); navigate(fullPath); }}
                    data-testid="drawer-open-full-page"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open full page
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={close}
                    aria-label="Close side panel"
                    data-testid="drawer-close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <DrawerBody spec={spec} />
              </div>
            </SheetContent>
          </Sheet>
        );
      })}
    </DrawerContext.Provider>
  );
}

export function useDetailDrawer(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) {
    return {
      open: () => { /* no-op outside provider */ },
      close: () => { /* no-op outside provider */ },
      depth: 0,
    };
  }
  return ctx;
}
