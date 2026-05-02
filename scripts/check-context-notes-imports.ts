/**
 * Task #950 — Context Notes import guardrail.
 *
 * Goal: every consumer of the context-notes feature must import from the
 * public barrel `@/components/context-notes` only. Deep imports into the
 * implementation files would make it impossible to refactor the panel,
 * thread, composer, or hooks without breaking distant callers.
 *
 * Allowed:
 *   import { ContextNotePanel } from "@/components/context-notes";
 *   import { ContextNoteBadge, useContextNotes } from "@/components/context-notes";
 *
 * Forbidden (outside `client/src/components/context-notes/`):
 *   import { ... } from "@/components/context-notes/ContextNoteThread";
 *   import { ... } from "@/components/context-notes/useContextNotes";
 *   import { ... } from "@/components/context-notes/types";
 *
 * Run with: npx tsx scripts/check-context-notes-imports.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const ALLOWED_BARREL = "@/components/context-notes";
const DEEP_IMPORT_RE = /from\s+["'](?:@\/components\/context-notes|\.\.?\/(?:[^"']*\/)?components\/context-notes)\/[^"']+["']/g;

function walk(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, ext));
    } else if (entry.isFile() && ext.some(e => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const SCAN_DIR = path.join(ROOT, "client", "src");
const COMPONENT_DIR = path.join(ROOT, "client", "src", "components", "context-notes");

const violations: Array<{ file: string; line: number; text: string }> = [];

for (const file of walk(SCAN_DIR, [".ts", ".tsx"])) {
  // Files inside the context-notes module itself are allowed to import
  // their siblings directly.
  if (file.startsWith(COMPONENT_DIR + path.sep) || file === COMPONENT_DIR) continue;

  const src = fs.readFileSync(file, "utf-8");
  if (!src.includes("context-notes")) continue;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DEEP_IMPORT_RE.test(line)) {
      // Allow the bare barrel import; only flag deeper paths.
      if (line.includes(`"${ALLOWED_BARREL}"`) || line.includes(`'${ALLOWED_BARREL}'`)) {
        DEEP_IMPORT_RE.lastIndex = 0;
        continue;
      }
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: line.trim(),
      });
      DEEP_IMPORT_RE.lastIndex = 0;
    }
  }
}

if (violations.length > 0) {
  console.error("✗ Deep imports of @/components/context-notes/* found:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}`);
  }
  console.error(
    `\nFix: import from the barrel "${ALLOWED_BARREL}" instead. ` +
    `The internal layout of the module is not part of its public API.`,
  );
  process.exit(1);
}

console.log("✓ No deep context-notes imports found — all consumers use the barrel.");
process.exit(0);
