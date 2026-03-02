import { useEffect, useState, useCallback } from "react";

interface ConfettiPiece {
  id: number;
  x: number;
  color: string;
  delay: number;
  rotation: number;
  scale: number;
}

const COLORS = [
  "#3b82f6", "#2563eb", "#22c55e", "#16a34a",
  "#60a5fa", "#4ade80", "#38bdf8", "#34d399",
  "#818cf8", "#a78bfa", "#fbbf24", "#fb923c",
];

export function useConfetti() {
  const [show, setShow] = useState(false);

  const fire = useCallback(() => {
    setShow(true);
    setTimeout(() => setShow(false), 2500);
  }, []);

  return { show, fire, ConfettiOverlay: show ? Confetti : null };
}

function Confetti() {
  const [pieces, setPieces] = useState<ConfettiPiece[]>([]);

  useEffect(() => {
    const newPieces: ConfettiPiece[] = [];
    for (let i = 0; i < 60; i++) {
      newPieces.push({
        id: i,
        x: Math.random() * 100,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        delay: Math.random() * 0.6,
        rotation: Math.random() * 360,
        scale: 0.5 + Math.random() * 0.8,
      });
    }
    setPieces(newPieces);
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden" aria-hidden="true">
      {pieces.map((p) => (
        <div
          key={p.id}
          className="absolute animate-confetti-fall"
          style={{
            left: `${p.x}%`,
            top: "-10px",
            animationDelay: `${p.delay}s`,
            transform: `rotate(${p.rotation}deg) scale(${p.scale})`,
          }}
        >
          <div
            className="w-2.5 h-2.5 rounded-sm"
            style={{ backgroundColor: p.color }}
          />
        </div>
      ))}
    </div>
  );
}
