import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ── Named stale-time constants ────────────────────────────────────────────────
// Use these instead of inline millisecond literals so cache behaviour is
// uniform and easy to reason about across the codebase.
//
//  STALE_REALTIME  –  30 s   touch-today, live alerts, anything updated by the
//                             current user in the current session
//  STALE_1MIN      –  1 min  notifications, NBA surfaces, growth scores
//  STALE_5MIN      –  5 min  default – company list, contacts, tasks, RFPs
//  STALE_15MIN     – 15 min  heavier computed data – corridors, historical,
//                             carrier metrics (server cache is ~30 min)
//  STALE_NEVER     –  ∞     truly static reference data (templates, zip DB)
//
export const STALE_REALTIME = 30_000;
export const STALE_1MIN    = 60_000;
export const STALE_5MIN    = 5 * 60_000;
export const STALE_15MIN   = 15 * 60_000;
export const STALE_NEVER   = Infinity;

function redirectToLogin() {
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  if (res.status === 401) {
    redirectToLogin();
    return res;
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (res.status === 401) {
      if (unauthorizedBehavior === "returnNull") return null;
      // Do NOT hard-redirect here — background polls getting a 401 should not
      // kick the user out of the app. Let the auth state manager (useAuth /
      // App.tsx) handle session expiry gracefully.
      throw new Error("Unauthorized");
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      // Refresh data when the user returns to the tab — this is the primary
      // mechanism that keeps the dashboard/company detail fresh after a rep
      // logs a touchpoint in another tab or window.
      refetchOnWindowFocus: true,
      // 5-minute global default. Queries that need fresher data override this
      // individually using the named constants exported above.
      // Previously Infinity — changed to prevent reps from seeing stale
      // company, task, and touchpoint data throughout a session.
      staleTime: STALE_5MIN,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
