import { useQuery, useMutation } from "@tanstack/react-query";
import { useUser, useClerk } from "@clerk/clerk-react";
import { queryClient, apiRequest, getQueryFn } from "@/lib/queryClient";
import type { User } from "@shared/schema";

export type SafeUser = Omit<User, "password"> & {
  isImpersonating?: boolean;
  impersonatingAdminName?: string | null;
  organizationSlug?: string;
};

export function useAuth() {
  const { isLoaded: clerkLoaded, isSignedIn } = useUser();
  const { signOut } = useClerk();

  const { data: user, isLoading: userLoading } = useQuery<SafeUser | null>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: clerkLoaded && isSignedIn === true,
    staleTime: 5 * 60 * 1000,
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

  return {
    user: isSignedIn ? (user ?? null) : null,
    isLoading,
    logout: logoutMutation,
  };
}
