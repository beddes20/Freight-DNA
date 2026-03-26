import { createContext, useContext, useState, useCallback, useRef } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type EasterEggContextType = {
  fire: (hint?: string) => void;
};

const EasterEggContext = createContext<EasterEggContextType>({ fire: () => {} });

export function useFireEasterEgg() {
  return useContext(EasterEggContext).fire;
}

const MESSAGES = [
  "🎉 You found a hidden gem!",
  "💰 Secret unlocked!",
  "🏆 You discovered a hidden gem!",
];

export function EasterEggProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [headline, setHeadline] = useState(MESSAGES[0]);
  const cooldownRef = useRef(false);

  const fire = useCallback((hint?: string) => {
    if (cooldownRef.current) return;
    cooldownRef.current = true;
    setHeadline(hint ? `🎉 ${hint}` : MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);
    setOpen(true);
    setTimeout(() => { cooldownRef.current = false; }, 5000);
  }, []);

  return (
    <EasterEggContext.Provider value={{ fire }}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-md text-center border-2 select-none"
          style={{ borderColor: "#ffb400", background: "#111" }}
        >
          <div className="flex flex-col items-center gap-5 py-4">
            <div className="text-6xl animate-bounce">💸</div>
            <p className="text-2xl font-extrabold tracking-tight" style={{ color: "#ffb400" }}>
              {headline}
            </p>
            <p className="text-white/90 text-base leading-relaxed">
              Take a screenshot of this screen, send it to the group chat, then go find{" "}
              <span className="font-bold text-white">Ben</span> in person for{" "}
              <span
                className="font-extrabold text-2xl"
                style={{ color: "#ffb400" }}
              >
                $100 cash.
              </span>
            </p>
            <p className="text-white/40 text-xs">
              Only one claim per discovery. First one there wins.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </EasterEggContext.Provider>
  );
}
