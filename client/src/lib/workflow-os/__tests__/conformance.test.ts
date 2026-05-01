// Workflow OS — cross-surface conformance baseline.
//
// Permissive snapshot of which shared primitives Available Freight, Lane
// Work Queue, and Available Loads currently use. Starts as a record
// (not a hard gate) so #900/#901/#902 in flight don't break. The future
// Task D will tighten this into a CI lint that fails on regressions.
//
// We use the TypeScript compiler API to parse each page module and walk
// its `import` declarations. This is module-level inspection (real
// ImportDeclaration AST nodes), not a string regex on raw source —
// renames, comments, and whitespace can't false-positive or false-
// negative the result. We deliberately do NOT actually `import()` the
// page modules at runtime, because they pull in React, react-query,
// browser-only APIs, etc. that aren't worth booting in a unit test.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

interface SurfaceSpec {
  name: "AF" | "LWQ" | "Available Loads";
  file: string;
  // Marks set when conformance is intentionally deferred to a downstream
  // task. The audit (Task D) will require all marks to be true.
  exemptions?: Partial<Record<RequiredPrimitive, string>>;
}

type RequiredPrimitive =
  | "OwnerFilterSelect"
  | "PickupScopeSelect"
  | "StaleCountChip"
  | "BulkActionBar";

const SURFACES: SurfaceSpec[] = [
  {
    name: "AF",
    file: "client/src/pages/available-freight.tsx",
    exemptions: {
      OwnerFilterSelect: "#900 in flight — switch to shared OwnerFilterSelect lands as Task B step 1",
      PickupScopeSelect: "#900 in flight — Actionable scope shipped, shared select lands as Task B step 1",
      StaleCountChip: "#900 in flight — chip lands as Task B step 1",
      BulkActionBar: "#901 (outreach workspace) ships the bar wiring",
    },
  },
  {
    name: "LWQ",
    file: "client/src/pages/lane-work-queue.tsx",
    exemptions: {
      OwnerFilterSelect: "Future Task B — LWQ owner+actionable rollout",
      PickupScopeSelect: "Future Task B — LWQ owner+actionable rollout",
      StaleCountChip: "Future Task B — LWQ owner+actionable rollout",
      BulkActionBar: "Future Task #902 — LWQ outreach workspace rollout",
    },
  },
  {
    name: "Available Loads",
    file: "client/src/pages/carrier-intelligence-available-loads.tsx",
    exemptions: {
      OwnerFilterSelect: "Future Task C — Available Loads owner+actionable rollout",
      PickupScopeSelect: "Future Task C — Available Loads owner+actionable rollout",
      StaleCountChip: "Future Task C — Available Loads owner+actionable rollout",
      BulkActionBar: "Future Task #902 — Available Loads outreach workspace rollout",
    },
  },
];

/**
 * Module specifier we expect each primitive to be imported from. We
 * accept either the alias path (`@/components/workflow-os/X`) or the
 * relative form (`../../components/workflow-os/X`) — both resolve to
 * the same module.
 */
const PRIMITIVE_MODULES: Record<RequiredPrimitive, RegExp> = {
  OwnerFilterSelect: /(?:^|\/)components\/workflow-os\/OwnerFilterSelect$/,
  PickupScopeSelect: /(?:^|\/)components\/workflow-os\/PickupScopeSelect$/,
  StaleCountChip:    /(?:^|\/)components\/workflow-os\/StaleCountChip$/,
  BulkActionBar:     /(?:^|\/)components\/workflow-os\/BulkActionBar$/,
};

interface ImportRecord {
  /** Module specifier as written in the source (e.g. `@/components/...`). */
  moduleSpecifier: string;
  /** Named imports pulled from this module (default+namespace included). */
  importedNames: string[];
}

/**
 * Parse the file with the TypeScript compiler API and return one record
 * per `import` declaration. Module-level introspection — no regex on
 * the raw source, no runtime evaluation.
 */
export function extractImports(absPath: string): ImportRecord[] {
  const src = fs.readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(absPath, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const out: ImportRecord[] = [];
  sf.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const names: string[] = [];
    const clause = node.importClause;
    if (clause) {
      if (clause.name) names.push(clause.name.text); // default
      const nb = clause.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) {
          names.push(`* as ${nb.name.text}`);
        } else if (ts.isNamedImports(nb)) {
          for (const el of nb.elements) names.push(el.name.text);
        }
      }
    }
    out.push({ moduleSpecifier: node.moduleSpecifier.text, importedNames: names });
  });
  return out;
}

/** True if the page imports any name from the module that owns `primitive`. */
function moduleImported(imports: ImportRecord[], primitive: RequiredPrimitive): boolean {
  const modPattern = PRIMITIVE_MODULES[primitive];
  return imports.some((imp) => modPattern.test(imp.moduleSpecifier));
}

/** True if the named export is in the import list for that module. */
function namedImportPresent(imports: ImportRecord[], primitive: RequiredPrimitive): boolean {
  const modPattern = PRIMITIVE_MODULES[primitive];
  return imports.some(
    (imp) => modPattern.test(imp.moduleSpecifier) && imp.importedNames.includes(primitive),
  );
}

describe("Workflow OS conformance baseline", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      const abs = path.join(ROOT, surface.file);
      const imports = extractImports(abs);
      const src = fs.readFileSync(abs, "utf8");

      it("references the spec doc near the top of the file", () => {
        // Cross-link added by Task #907 step 9 — engineers landing in the
        // page should find the spec in the first ~25 lines.
        const head = src.split("\n").slice(0, 25).join("\n");
        expect(head).toMatch(/docs\/workflow-os-spec\.md/);
      });

      for (const prim of Object.keys(PRIMITIVE_MODULES) as RequiredPrimitive[]) {
        const exempt = surface.exemptions?.[prim];
        if (exempt) {
          it.skip(`imports shared ${prim} from @/components/workflow-os (exempt: ${exempt})`, () => {
            expect(moduleImported(imports, prim)).toBe(true);
            expect(namedImportPresent(imports, prim)).toBe(true);
          });
        } else {
          it(`imports shared ${prim} from @/components/workflow-os`, () => {
            expect(moduleImported(imports, prim)).toBe(true);
            expect(namedImportPresent(imports, prim)).toBe(true);
          });
        }
      }
    });
  }

  describe("extractImports helper", () => {
    // Sanity check: the helper itself must work, otherwise every page
    // assertion is meaningless. We point it at this very file (which
    // unambiguously imports `vitest` and `node:path`) and confirm the
    // AST walker picks both up.
    it("extracts named and default imports from a real source file via TypeScript AST", () => {
      const here = path.join(ROOT, "client/src/lib/workflow-os/__tests__/conformance.test.ts");
      const imps = extractImports(here);
      const specs = imps.map((i) => i.moduleSpecifier);
      expect(specs).toContain("vitest");
      expect(specs).toContain("node:path");
      const vitestImport = imps.find((i) => i.moduleSpecifier === "vitest");
      expect(vitestImport?.importedNames).toEqual(expect.arrayContaining(["describe", "it", "expect"]));
    });
  });
});
