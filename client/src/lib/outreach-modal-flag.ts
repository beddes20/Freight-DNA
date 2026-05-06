/**
 * Outreach Send Modal — phased rollout flag.
 *
 * Task #946 ships the carrier outreach send modal in three phases. This
 * module is the single chokepoint that decides which phase the
 * Available Freight detail page renders. Default ships phase "a" so the
 * quick-fix bulk-action toolbar + accurate selected count land
 * immediately on merge; phases "b" (two-panel review) and "c"
 * (Available Freight tab parity, saved filters, keyboard polish) can
 * be turned on later via localStorage without a redeploy.
 *
 *   - "a" (default) — bulk actions + accurate "X of Y will receive"
 *                     count + per-recipient guardrails inside the
 *                     existing single-panel modal.
 *   - "b"           — two-panel review modal (Available + Selected
 *                     panels with the email editor secondary).
 *   - "c"           — Available Freight tab parity (multi-select on
 *                     the listing page) + saved filters + keyboard
 *                     polish.
 *   - "legacy"      — escape hatch back to the pre-#946 modal in case
 *                     something regresses in production.
 *
 * Toggle at runtime via the browser console:
 *   localStorage.setItem("freight.outreachModalPhase", "b")
 *
 * Or via URL override for one-off troubleshooting:
 *   ?outreachModal=legacy
 *
 * The single-source flag check keeps phase semantics out of call sites
 * — UI code asks `isPhaseAtLeast("b")` rather than poking storage
 * directly.
 */

export type OutreachModalPhase = "legacy" | "a" | "b" | "c";

const STORAGE_KEY = "freight.outreachModalPhase";
const URL_PARAM = "outreachModal";
const DEFAULT_PHASE: OutreachModalPhase = "a";

const PHASE_ORDER: OutreachModalPhase[] = ["legacy", "a", "b", "c"];

function normalize(value: string | null | undefined): OutreachModalPhase | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "legacy" || v === "a" || v === "b" || v === "c") return v;
  return null;
}

export function getOutreachModalPhase(): OutreachModalPhase {
  if (typeof window === "undefined") return DEFAULT_PHASE;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalize(params.get(URL_PARAM));
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore */
  }
  try {
    const fromStorage = normalize(window.localStorage.getItem(STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch {
    /* ignore */
  }
  return DEFAULT_PHASE;
}

export function isPhaseAtLeast(target: OutreachModalPhase): boolean {
  const current = getOutreachModalPhase();
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target);
}
