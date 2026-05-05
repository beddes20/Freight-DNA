/**
 * Task #1024 — Available Freight Action mode guardrails.
 *
 * Static checks that lock the "Action mode owns signals + links only"
 * contract on client/src/pages/available-freight.tsx:
 *   1. The signals bar component is imported and mounted when
 *      `mode !== "ops"`.
 *   2. The auto-pilot preview drawer trigger is only opened from Ops
 *      mode (no inline triggers in Action / Coverage).
 *   3. The full HiddenCountsDisclosure popover is only mounted when
 *      `mode === "ops"`.
 *   4. The prominent "Leak Console" header button is gone (replaced by
 *      a small signal pill in the AfOpsSignalsBar).
 *   5. AfImportHealthPill (the heavy popover) is only mounted in Ops
 *      mode.
 *
 * Run with: npx tsx tests/af-action-mode-ops-signals.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const AF_PATH = path.join(ROOT, "client/src/pages/available-freight.tsx");
const PILLS_PATH = path.join(ROOT, "client/src/components/freight/af-ops-signals-bar.tsx");

const af = fs.readFileSync(AF_PATH, "utf-8");
const pills = fs.readFileSync(PILLS_PATH, "utf-8");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(desc: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${desc}\n    ${detail}` : `  ✗ ${desc}`;
    console.error(msg);
    failures.push(desc);
    failed++;
  }
}

console.log("\nTask #1024 — Available Freight Action mode guardrails");

assert(
  "AfOpsSignalsBar is imported in available-freight.tsx",
  /from\s+"@\/components\/freight\/af-ops-signals-bar"/.test(af),
);

assert(
  "AfOpsSignalsBar is rendered when mode !== \"ops\"",
  /mode\s*!==\s*"ops"[\s\S]{0,400}<AfOpsSignalsBar\b/.test(af),
);

assert(
  "AutoPilotPreviewDrawer is only opened by setAutoPilotDrawerOpen(true) inside Ops mode block",
  (() => {
    const opens = Array.from(af.matchAll(/setAutoPilotDrawerOpen\(true\)/g));
    if (opens.length === 0) return false;
    const opsBlockIdx = af.indexOf("data-testid=\"button-auto-pilot-preview-ops\"");
    if (opsBlockIdx < 0) return false;
    return opens.every((m) => {
      const idx = m.index ?? -1;
      return Math.abs(idx - opsBlockIdx) < 600;
    });
  })(),
);

assert(
  "Full HiddenCountsDisclosure popover is gated to mode === \"ops\"",
  (() => {
    const matches = Array.from(af.matchAll(/<HiddenCountsDisclosure\b/g));
    if (matches.length === 0) return false;
    return matches.every((m) => {
      const idx = m.index ?? 0;
      const before = af.slice(Math.max(0, idx - 5000), idx);
      return /mode\s*===\s*"ops"/.test(before) || /panel-mode-ops/.test(before);
    });
  })(),
);

assert(
  "Prominent header \"Leak Console\" button is removed (no data-testid=\"button-leak-console\")",
  !/data-testid="button-leak-console"\b/.test(af),
);

assert(
  "AfImportHealthPill is only mounted with the Ops mode tertiary cluster or Ops panel",
  (() => {
    const matches = Array.from(af.matchAll(/<AfImportHealthPill\b/g));
    if (matches.length === 0) return false;
    return matches.every((m) => {
      const idx = m.index ?? 0;
      const before = af.slice(Math.max(0, idx - 5000), idx);
      return /mode\s*===\s*"ops"/.test(before) || /panel-mode-ops/.test(before);
    });
  })(),
);

assert(
  "AfOpsSignalsBar component renders 4 link-out pills (health, hidden, auto-pilot, leak)",
  /pill-signal-health/.test(pills) &&
    /pill-signal-hidden/.test(pills) &&
    /pill-signal-auto-pilot/.test(pills) &&
    /pill-signal-leaks/.test(pills),
);

assert(
  "AfOpsSignalsBar uses <Link> from wouter so navigation stays SPA-routed",
  /from\s+"wouter"/.test(pills) && /<Link\s+href=/.test(pills),
);

assert(
  "AfOpsSignalsBar Hidden + Auto-pilot pills point at the opsModeHref (preserves scope)",
  /href=\{opsModeHref\}/.test(pills),
);

assert(
  "AfOpsSignalsBar Health pill links to the dedicated admin imports page",
  /href="\/admin\/available-freight\/imports"/.test(pills),
);

assert(
  "AfOpsSignalsBar Leak pill links to the Leak Console",
  /href="\/leak-console"/.test(pills),
);

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
