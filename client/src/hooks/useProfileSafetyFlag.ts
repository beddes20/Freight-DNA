// Task #1109 — Profile Safety Labels feature flag.
//
// One-stop hook for the Company Profile "safe visibility" surface.
// Defaults ON; admins flip OFF via PATCH /api/feature-flags/profile_safety_labels_enabled.
// The /api/profile-safety-flag endpoint returns { enabled, configured } so the
// client can distinguish "no row → default ON" from "explicit OFF".

import { useQuery } from "@tanstack/react-query";

export const PROFILE_SAFETY_FLAG_KEY = "profile_safety_labels_enabled";

interface FlagResponse {
  enabled: boolean;
  configured: boolean;
}

export function useProfileSafetyFlag(): boolean {
  const { data } = useQuery<FlagResponse>({
    queryKey: ["/api/profile-safety-flag"],
    staleTime: 5 * 60 * 1000,
  });
  if (!data) return true;
  if (!data.configured) return true;
  return data.enabled;
}
