import { useQuery, useMutation } from "@tanstack/react-query";
import { useUser, useClerk } from "@clerk/clerk-react";
import { queryClient, apiRequest, getQueryFn } from "@/lib/queryClient";
import type { User } from "@shared/schema";

export type SafeUser = Omit<User, "password"> & {
  isImpersonating?: boolean;
  impersonatingAdminName?: string | null;
  organizationSlug?: string;
};

export type UnprovisionedAccount = {
  unprovisioned: true;
  email: string | null;
};

type AuthMeResponse = SafeUser | UnprovisionedAccount | null;

function isUnprovisioned(d: AuthMeResponse): d is UnprovisionedAccount {
  return d !== null && typeof d === "object" && "unprovisioned" in d && d.unprovisioned === true;
}

const DEV_BYPASS = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

export function useAuth() {
  if (DEV_BYPASS) {
    return useAuthBypass();
  }
  return useAuthClerk();
}

function useAuthBypass() {
  const { data, isLoading } = useQuery<AuthMeResponse>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    // Role-promotion contract: keep this short so role/permission
    // changes propagate quickly. With the previous 5-minute staleTime
    // a promoted user could still see the OLD role's nav for up to
    // five minutes after the admin saved — the regression that left
    // TJ stuck on LM nav after his AM promotion.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      queryClient.clear();
    },
    onSuccess: () => {
      window.location.href = "/";
    },
  });

  const unprovisioned = isUnprovisioned(data ?? null) ? (data as UnprovisionedAccount) : null;
  const user = !unprovisioned ? ((data as SafeUser | null) ?? null) : null;

  return {
    user,
    unprovisioned,
    isLoading,
    logout: logoutMutation,
  };
}

function useAuthClerk() {
  const { isLoaded: clerkLoaded, isSignedIn } = useUser();
  const { signOut } = useClerk();

  const { data, isLoading: userLoading } = useQuery<AuthMeResponse>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: clerkLoaded && isSignedIn === true,
    // Role-promotion contract: keep this short so role/permission
    // changes propagate quickly. See useAuthBypass above.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await signOut();
      queryClient.clear();
    },
    onSuccess: () => {
      window.location.href = "/";
    },
  });

  const isLoading = !clerkLoaded || (!!isSignedIn && userLoading);

  const unprovisioned = isSignedIn && isUnprovisioned(data ?? null)
    ? (data as UnprovisionedAccount)
    : null;
  const user = isSignedIn && !unprovisioned
    ? ((data as SafeUser | null) ?? null)
    : null;

  return {
    user,
    unprovisioned,
    isLoading,
    logout: logoutMutation,
  };
}
