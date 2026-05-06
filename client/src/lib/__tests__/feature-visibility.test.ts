import { describe, it, expect } from "vitest";
import {
  isFeatureVisibleFor,
  isFeatureDisabledFor,
  featurePreviewLabel,
  featurePreviewTooltip,
  isAdminRole,
  type FeatureGated,
} from "../feature-visibility";

const active: FeatureGated = { status: "active" };
const preview: FeatureGated = { status: "admin_preview" };
const previewGated: FeatureGated = {
  status: "admin_preview",
  roles: ["admin", "director"],
};
const activeGated: FeatureGated = {
  status: "active",
  roles: ["admin", "director"],
};
const hidden: FeatureGated = { status: "hidden" };
const noStatus: FeatureGated = {};

describe("isAdminRole", () => {
  it("only treats role === 'admin' as admin", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("director")).toBe(false);
    expect(isAdminRole("sales")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe("isFeatureVisibleFor", () => {
  it("admin × active → visible", () => {
    expect(isFeatureVisibleFor(active, "admin")).toBe(true);
  });

  it("admin × admin_preview → visible (admin always sees previews)", () => {
    expect(isFeatureVisibleFor(preview, "admin")).toBe(true);
  });

  it("non-admin × active (no roles gate) → visible", () => {
    expect(isFeatureVisibleFor(active, "sales")).toBe(true);
  });

  it("non-admin × admin_preview (no roles gate) → hidden (in-development entries are admin-only)", () => {
    expect(isFeatureVisibleFor(preview, "sales")).toBe(false);
  });

  it("non-admin × admin_preview (roles-gated, role outside gate) → hidden", () => {
    expect(isFeatureVisibleFor(previewGated, "sales")).toBe(false);
  });

  it("non-admin × admin_preview (roles-gated, role inside gate) → still hidden (admin_preview ignores roles gate for non-admins)", () => {
    expect(isFeatureVisibleFor(previewGated, "director")).toBe(false);
  });

  it("director × admin_preview (no roles gate) → hidden (only role==='admin' sees previews)", () => {
    expect(isFeatureVisibleFor(preview, "director")).toBe(false);
  });

  it("sales_director × admin_preview (no roles gate) → hidden", () => {
    expect(isFeatureVisibleFor(preview, "sales_director")).toBe(false);
  });

  it("non-admin × active (roles-gated, role outside gate) → hidden", () => {
    expect(isFeatureVisibleFor(activeGated, "sales")).toBe(false);
  });

  it("any role × hidden → never visible", () => {
    expect(isFeatureVisibleFor(hidden, "admin")).toBe(false);
    expect(isFeatureVisibleFor(hidden, "sales")).toBe(false);
  });

  it("missing status defaults to active", () => {
    expect(isFeatureVisibleFor(noStatus, "sales")).toBe(true);
    expect(isFeatureVisibleFor(noStatus, "admin")).toBe(true);
  });

  it("non-admin with no role and no roles gate → visible for active", () => {
    expect(isFeatureVisibleFor(active, undefined)).toBe(true);
  });

  it("non-admin with no role and a roles gate → hidden", () => {
    expect(isFeatureVisibleFor(activeGated, undefined)).toBe(false);
  });
});

describe("isFeatureDisabledFor", () => {
  it("admin × active → not disabled", () => {
    expect(isFeatureDisabledFor(active, "admin")).toBe(false);
  });

  it("admin × admin_preview → NOT disabled (admin gets click-through)", () => {
    expect(isFeatureDisabledFor(preview, "admin")).toBe(false);
  });

  it("non-admin × active → not disabled", () => {
    expect(isFeatureDisabledFor(active, "sales")).toBe(false);
  });

  it("non-admin × admin_preview → disabled (greyed and click-blocked)", () => {
    expect(isFeatureDisabledFor(preview, "sales")).toBe(true);
  });

  it("director × admin_preview → disabled (only role==='admin' bypasses)", () => {
    expect(isFeatureDisabledFor(preview, "director")).toBe(true);
  });

  it("missing status defaults to active → not disabled", () => {
    expect(isFeatureDisabledFor(noStatus, "sales")).toBe(false);
  });
});

describe("featurePreviewLabel", () => {
  it("returns 'In development' for admin_preview", () => {
    expect(featurePreviewLabel("admin_preview")).toBe("In development");
  });

  it("returns null for active / hidden / undefined", () => {
    expect(featurePreviewLabel("active")).toBeNull();
    expect(featurePreviewLabel("hidden")).toBeNull();
    expect(featurePreviewLabel(undefined)).toBeNull();
  });
});

describe("featurePreviewTooltip", () => {
  it("non-admin × admin_preview → '<Title> — In development'", () => {
    expect(featurePreviewTooltip("Launchpad", "admin_preview", "sales"))
      .toBe("Launchpad — In development");
  });

  it("admin × admin_preview → adds the admin-access suffix", () => {
    expect(featurePreviewTooltip("Launchpad", "admin_preview", "admin"))
      .toBe("Launchpad — In development — admin access enabled");
  });

  it("any role × active → null (caller falls back to normal tooltip)", () => {
    expect(featurePreviewTooltip("Customers", "active", "sales")).toBeNull();
    expect(featurePreviewTooltip("Customers", "active", "admin")).toBeNull();
  });

  it("director (non-admin for preview-bypass) gets the non-admin tooltip", () => {
    expect(featurePreviewTooltip("Launchpad", "admin_preview", "director"))
      .toBe("Launchpad — In development");
  });
});
