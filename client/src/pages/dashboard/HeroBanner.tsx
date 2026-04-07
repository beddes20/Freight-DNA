import vtLogoWhite from "@assets/value-truck-logo-white.png";
import { PhoneCall, ListTodo, Settings2, Crown } from "lucide-react";
import type { SafeUser } from "./types";

interface BriefingData {
  streakToday?: number;
  streakGoal?: number;
  dueTasks?: number;
  streak?: number;
}

interface HeroBannerProps {
  currentUser: SafeUser | null | undefined;
  briefingData: BriefingData | null | undefined;
  isDirector: boolean;
  onOpenLayoutPanel: () => void;
  onAssignForcedFocus?: () => void;
  isLeadership?: boolean;
}

export function HeroBanner({ currentUser, briefingData, isDirector, onOpenLayoutPanel, onAssignForcedFocus, isLeadership }: HeroBannerProps) {
  return (
    <div
      className="relative overflow-hidden rounded-xl px-4 py-4 sm:px-6 sm:py-5 text-white"
      style={{ background: "#0d0d0d", border: "1px solid #1f1f1f" }}
      data-testid="banner-hero"
    >
      <div className="pointer-events-none absolute -top-10 -right-10 h-48 w-48 rounded-full" style={{ background: "rgba(255,180,0,0.04)" }} />
      <div className="pointer-events-none absolute -bottom-8 -right-4 h-32 w-32 rounded-full" style={{ background: "rgba(255,180,0,0.03)" }} />

      <div className="relative flex items-center gap-4">
        <div className="shrink-0">
          <p className="text-xs font-medium tracking-widest uppercase mb-1" style={{ color: "#ffb400" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h2 className="text-xl font-bold leading-tight text-white">
            {(() => {
              const h = new Date().getHours();
              const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
              const first = currentUser?.name?.split(" ")[0];
              return first ? `${greeting}, ${first}` : greeting;
            })()}
          </h2>
          <p className="mt-1.5 text-sm tracking-wide" style={{ color: "#ffc333" }} data-testid="text-dna-tagline-hero">
            <span className="font-bold">DNA</span>
            <span className="mx-2" style={{ color: "#444" }}>·</span>
            <span className="font-bold">D</span>own <span className="font-bold">N</span>ot <span className="font-bold">A</span>cross
          </p>
        </div>

        {briefingData && (
          <div className="flex-1 flex flex-wrap items-center justify-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
              style={{ background: "rgba(255,180,0,0.12)", color: "#ffc333", border: "1px solid rgba(255,180,0,0.2)" }}
              data-testid="text-hero-touches"
            >
              <PhoneCall className="h-3 w-3" />
              {briefingData.streakToday}/{briefingData.streakGoal} touches today
            </span>
            {briefingData.dueTasks != null && briefingData.dueTasks > 0 && (
              <span
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.75)", border: "1px solid rgba(255,255,255,0.12)" }}
                data-testid="text-hero-tasks"
              >
                <ListTodo className="h-3 w-3" />
                {briefingData.dueTasks} task{briefingData.dueTasks !== 1 ? "s" : ""} due
              </span>
            )}
            {briefingData.streak != null && briefingData.streak > 0 && (
              <span
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-semibold"
                style={{ background: "rgba(251,146,60,0.15)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.25)" }}
                data-testid="text-hero-streak"
              >
                🔥 {briefingData.streak}-day streak
              </span>
            )}
          </div>
        )}

        <div className="shrink-0 flex items-center gap-3">
          {isLeadership && onAssignForcedFocus && (
            <button
              onClick={onAssignForcedFocus}
              className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-purple-500/30 text-purple-300 hover:text-purple-100 hover:border-purple-400/60 hover:bg-purple-500/10 transition-all"
              title="Assign Leadership Priority to a rep"
              data-testid="button-assign-forced-focus"
            >
              <Crown className="h-3.5 w-3.5" />
              Assign Priority
            </button>
          )}
          {isDirector && (
            <button
              onClick={onOpenLayoutPanel}
              className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all"
              title="Customize dashboard layout"
              data-testid="button-edit-dashboard-layout"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Customize
            </button>
          )}
          <div
            className="hidden sm:flex items-center justify-center h-16 w-16 rounded-full p-2.5"
            style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 20px rgba(255,180,0,0.2)" }}
          >
            <img src={vtLogoWhite} alt="Value Truck" className="w-full h-full object-contain" />
          </div>
        </div>
      </div>
    </div>
  );
}
