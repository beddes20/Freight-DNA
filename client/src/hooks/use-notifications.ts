import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Notification } from "@shared/schema";

export const TASK_NOTIFICATION_TYPES = ["task_assigned", "task_completed"];

export function useNotificationCounts() {
  const { user } = useAuth();

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
    enabled: !!user,
    refetchInterval: 30000,
    staleTime: 25000,
  });

  const unread = notifications.filter((n) => !n.read);
  const taskUnread = unread.filter((n) => TASK_NOTIFICATION_TYPES.includes(n.type));
  const otherUnread = unread.filter((n) => !TASK_NOTIFICATION_TYPES.includes(n.type));

  return {
    taskCount: taskUnread.length,
    otherCount: otherUnread.length,
    otherUnreadIds: otherUnread.map((n) => n.id),
    totalCount: unread.length,
  };
}

export function useMarkNotificationsRead(types?: string[]) {
  return useMutation({
    mutationFn: async (ids?: string[]) => {
      if (ids && ids.length > 0) {
        await apiRequest("PATCH", "/api/notifications/read-all", { ids });
      } else if (types && types.length > 0) {
        await apiRequest("PATCH", "/api/notifications/read-all", { types });
      } else {
        await apiRequest("PATCH", "/api/notifications/read-all", {});
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });
}
