import { storage } from "../storage";
import { userRoles, type User } from "@shared/schema";

export type RolePromotionResult =
  | { ok: true; user: User; changed: boolean; previousRole: string; newRole: string }
  | { ok: false; reason: "invalid-role" | "not-found" | "write-failed"; detail?: string };

export async function applyRolePromotion(params: {
  actorId: string;
  actorRole: string;
  targetUserId: string;
  organizationId: string;
  newRole: string;
}): Promise<RolePromotionResult> {
  const { actorId, actorRole, targetUserId, organizationId, newRole } = params;

  if (!userRoles.includes(newRole as any)) {
    console.warn(
      `[role-promotion] REJECTED invalid-role actor=${actorId}(${actorRole}) target=${targetUserId} requested=${newRole}`,
    );
    return { ok: false, reason: "invalid-role", detail: newRole };
  }

  const before = await storage.getUser(targetUserId);
  if (!before || before.organizationId !== organizationId) {
    console.warn(
      `[role-promotion] REJECTED not-found actor=${actorId}(${actorRole}) target=${targetUserId}`,
    );
    return { ok: false, reason: "not-found" };
  }

  const previousRole = before.role;
  if (previousRole === newRole) {
    console.log(
      `[role-promotion] NOOP actor=${actorId}(${actorRole}) target=${targetUserId}(${before.name}) role=${previousRole}`,
    );
    return { ok: true, user: before, changed: false, previousRole, newRole };
  }

  let updated: User | undefined;
  try {
    updated = await storage.updateUser(targetUserId, organizationId, { role: newRole as any });
  } catch (err) {
    console.error(
      `[role-promotion] WRITE-FAILED actor=${actorId}(${actorRole}) target=${targetUserId} from=${previousRole} to=${newRole}`,
      err,
    );
    return { ok: false, reason: "write-failed", detail: String(err) };
  }
  if (!updated) {
    console.error(
      `[role-promotion] WRITE-FAILED-NORETURN actor=${actorId}(${actorRole}) target=${targetUserId} from=${previousRole} to=${newRole}`,
    );
    return { ok: false, reason: "write-failed" };
  }

  console.log(
    `[role-promotion] APPLIED actor=${actorId}(${actorRole}) target=${targetUserId}(${updated.name}) from=${previousRole} to=${newRole}`,
  );

  return { ok: true, user: updated, changed: true, previousRole, newRole };
}
