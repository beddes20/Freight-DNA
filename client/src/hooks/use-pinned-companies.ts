import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export interface PinnedCompany {
  id: string;
  userId: string;
  companyId: string;
  pinnedAt: string;
}

export function usePinnedCompanies() {
  const { toast } = useToast();

  const { data: pinned = [], isLoading } = useQuery<PinnedCompany[]>({
    queryKey: ["/api/pinned-companies"],
    staleTime: 60_000,
  });

  const pinnedSet = new Set(pinned.map((p) => p.companyId));

  const pinMutation = useMutation({
    mutationFn: (companyId: string) => apiRequest("POST", `/api/pinned-companies/${companyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pinned-companies"] });
    },
    onError: (error: Error) => {
      const msg = error?.message || "Failed to pin account";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const unpinMutation = useMutation({
    mutationFn: (companyId: string) => apiRequest("DELETE", `/api/pinned-companies/${companyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pinned-companies"] });
    },
    onError: () => {
      toast({ title: "Failed to unpin account", variant: "destructive" });
    },
  });

  const togglePin = (companyId: string) => {
    if (pinnedSet.has(companyId)) {
      unpinMutation.mutate(companyId);
    } else {
      pinMutation.mutate(companyId);
    }
  };

  const isPinned = (companyId: string) => pinnedSet.has(companyId);

  return { pinned, pinnedSet, isLoading, togglePin, isPinned, pinMutation, unpinMutation };
}
