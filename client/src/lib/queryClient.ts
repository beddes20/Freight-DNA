import { QueryClient, QueryFunction, MutationCache } from "@tanstack/react-query";
import { dispatchEasterEgg } from "@/components/easter-egg-modal";

function redirectToLogin() {
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

async function throwIfResNotOk(res: Response, redirect401 = false) {
  if (!res.ok) {
    if (res.status === 401 && redirect401) {
      redirectToLogin();
      return;
    }
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
      redirectToLogin();
      throw new Error("Unauthorized");
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: (data) => {
      if (data && typeof data === "object" && "easterEgg" in data && data.easterEgg) {
        dispatchEasterEgg(data.easterEgg as { type: string; title: string; message: string });
      }
    },
  }),
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
