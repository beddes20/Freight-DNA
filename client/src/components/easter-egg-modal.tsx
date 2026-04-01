import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConfetti } from "@/components/confetti";

export interface EasterEggPayload {
  type: string;
  title: string;
  message: string;
}

declare global {
  interface WindowEventMap {
    "easter-egg-won": CustomEvent<EasterEggPayload>;
  }
}

export function dispatchEasterEgg(payload: EasterEggPayload) {
  window.dispatchEvent(new CustomEvent("easter-egg-won", { detail: payload }));
}

export function EasterEggModal() {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<EasterEggPayload | null>(null);
  const { fire, ConfettiOverlay } = useConfetti();

  useEffect(() => {
    function onEgg(e: CustomEvent<EasterEggPayload>) {
      setPayload(e.detail);
      setOpen(true);
      fire();
    }
    window.addEventListener("easter-egg-won", onEgg);
    return () => window.removeEventListener("easter-egg-won", onEgg);
  }, [fire]);

  if (!payload) return null;

  return (
    <>
      {ConfettiOverlay && <ConfettiOverlay />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="easter-egg-modal">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-center leading-snug">
              {payload.title}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-4">
            <div className="text-4xl text-center select-none">🥚💰🎉</div>
            <p className="text-sm text-foreground whitespace-pre-line leading-relaxed">
              {payload.message}
            </p>
            <div className="flex justify-center pt-2">
              <Button
                data-testid="easter-egg-close"
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-8"
                onClick={() => setOpen(false)}
              >
                Let's gooo! 🔥
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
