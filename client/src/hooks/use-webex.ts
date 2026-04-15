import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export function useWebexStatus() {
  const { data } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/webex/status"],
    staleTime: 5 * 60 * 1000,
  });
  return data?.configured ?? false;
}

export function useWebexPresenceBatch(phones: string[], enabled = true) {
  const stablePhones = useMemo(() => {
    const unique = [...new Set(phones)].sort();
    return unique;
  }, [phones.join(",")]);

  const { data } = useQuery<{ presenceMap: Record<string, string>; configured: boolean }>({
    queryKey: ["/api/webex/presence-batch", stablePhones],
    queryFn: async () => {
      const res = await fetch("/api/webex/presence-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phones: stablePhones }),
      });
      if (!res.ok) {
        throw new Error(`Presence batch failed: ${res.status}`);
      }
      return res.json();
    },
    enabled: enabled && stablePhones.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return data?.presenceMap ?? {};
}

const PRESENCE_COLORS: Record<string, { dot: string; label: string }> = {
  active:       { dot: "bg-green-500", label: "Available" },
  call:         { dot: "bg-yellow-500", label: "On a Call" },
  DoNotDisturb: { dot: "bg-red-500", label: "Do Not Disturb" },
  inactive:     { dot: "bg-gray-400", label: "Offline" },
  meeting:      { dot: "bg-yellow-500", label: "In Meeting" },
  presenting:   { dot: "bg-red-500", label: "Presenting" },
  pending:      { dot: "bg-gray-400", label: "Pending" },
  unknown:      { dot: "bg-gray-300", label: "Unknown" },
};

export function getPresenceStyle(status: string) {
  return PRESENCE_COLORS[status] ?? PRESENCE_COLORS.unknown;
}
