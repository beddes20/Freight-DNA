import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { X, ChevronLeft, ChevronRight, Lightbulb, CheckCircle2 } from "lucide-react";
import { TourContext, TOUR_STEPS, useTour } from "@/hooks/use-tour";

function highlightTarget(target: string | undefined) {
  document.querySelectorAll(".tour-highlight").forEach(el => el.classList.remove("tour-highlight"));
  if (!target) return;
  const tryHighlight = (attempts = 0) => {
    const el = document.querySelector(`[data-tour="${target}"]`);
    if (el) {
      el.classList.add("tour-highlight");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (attempts < 8) {
      setTimeout(() => tryHighlight(attempts + 1), 200);
    }
  };
  setTimeout(() => tryHighlight(), 100);
}

function TourOverlay() {
  const { isTourActive, currentStepIndex, steps, endTour, nextStep, prevStep } = useTour();
  const [, setLocation] = useLocation();
  const isFirst = currentStepIndex === 0;
  const isLast = currentStepIndex === steps.length - 1;
  const step = steps[currentStepIndex];
  const progress = ((currentStepIndex + 1) / steps.length) * 100;

  if (!isTourActive || !step) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[7999] pointer-events-none"
        aria-hidden="true"
      />
      <div
        className="fixed bottom-6 right-6 z-[8000] w-[360px] max-h-[calc(100vh-48px)] overflow-y-auto"
        role="dialog"
        aria-label={`Tour step ${currentStepIndex + 1}: ${step.title}`}
      >
        <Card className="border-amber-400/60 shadow-2xl bg-background">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xl shrink-0">{step.emoji}</span>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Step {currentStepIndex + 1} of {steps.length}
                  </p>
                  <h3 className="font-bold text-sm leading-tight">{step.title}</h3>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={endTour}
                data-testid="button-tour-close"
                aria-label="End tour"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <Progress value={progress} className="h-1" />

            <p className="text-sm text-muted-foreground leading-relaxed">{step.description}</p>

            {step.bullets.length > 0 && (
              <ul className="space-y-1.5">
                {step.bullets.map((bullet, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-500" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            )}

            {step.tip && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 px-3 py-2">
                <Lightbulb className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                <p className="text-xs text-amber-800 dark:text-amber-200">{step.tip}</p>
              </div>
            )}

            <div className="flex items-center justify-between pt-1 gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={prevStep}
                disabled={isFirst}
                className="h-8 px-3"
                data-testid="button-tour-prev"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back
              </Button>

              <Badge variant="outline" className="text-[10px] font-mono px-2">
                {currentStepIndex + 1}/{steps.length}
              </Badge>

              {isLast ? (
                <Button
                  size="sm"
                  onClick={endTour}
                  className="h-8 px-3 bg-emerald-600 hover:bg-emerald-700 text-white"
                  data-testid="button-tour-finish"
                >
                  Finish Tour
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={nextStep}
                  className="h-8 px-3"
                  data-testid="button-tour-next"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [isTourActive, setIsTourActive] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [, setLocation] = useLocation();
  const stepIndexRef = useRef(currentStepIndex);
  stepIndexRef.current = currentStepIndex;

  const applyStep = useCallback((index: number, navigate = true) => {
    const step = TOUR_STEPS[index];
    if (!step) return;
    if (navigate && step.route) {
      setLocation(step.route);
    }
    highlightTarget(step.target);
  }, [setLocation]);

  const startTour = useCallback((startIndex = 0) => {
    setIsTourActive(true);
    setCurrentStepIndex(startIndex);
    applyStep(startIndex);
  }, [applyStep]);

  const endTour = useCallback(() => {
    setIsTourActive(false);
    document.querySelectorAll(".tour-highlight").forEach(el => el.classList.remove("tour-highlight"));
  }, []);

  const nextStep = useCallback(() => {
    setCurrentStepIndex(prev => {
      const next = Math.min(prev + 1, TOUR_STEPS.length - 1);
      applyStep(next);
      return next;
    });
  }, [applyStep]);

  const prevStep = useCallback(() => {
    setCurrentStepIndex(prev => {
      const next = Math.max(prev - 1, 0);
      applyStep(next);
      return next;
    });
  }, [applyStep]);

  useEffect(() => {
    return () => {
      document.querySelectorAll(".tour-highlight").forEach(el => el.classList.remove("tour-highlight"));
    };
  }, []);

  return (
    <TourContext.Provider value={{
      isTourActive,
      currentStepIndex,
      steps: TOUR_STEPS,
      startTour,
      endTour,
      nextStep,
      prevStep,
    }}>
      {children}
      {isTourActive && <TourOverlay />}
    </TourContext.Provider>
  );
}
