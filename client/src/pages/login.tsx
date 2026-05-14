import { useEffect } from "react";
import { SignIn } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import { TrendingUp, Loader2 } from "lucide-react";

// DEV_AUTH_BYPASS — in staging bypass mode no <ClerkProvider> is mounted
// (see client/src/App.tsx), so rendering Clerk's <SignIn> here would throw
// "useClerk must be used within <ClerkProvider />" and the ErrorBoundary
// would render "Something went wrong". The bypass user is already
// auto-authenticated server-side, so /login has nothing to do — just
// redirect to "/". Mirrors the activation check used by use-auth.ts and
// useLiveSync.ts so all three surfaces stay consistent.
const DEV_BYPASS_BUILD =
  import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === "true";
function isDevBypassActive(): boolean {
  if (DEV_BYPASS_BUILD) return true;
  if (typeof window !== "undefined" && (window as any).__AUTH_BYPASS__ === true) return true;
  return false;
}

export default function LoginPage() {
  const bypassed = isDevBypassActive();

  useEffect(() => {
    if (bypassed) {
      window.location.replace("/");
    }
  }, [bypassed]);

  if (bypassed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" data-testid="loader-login-bypass-redirect" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="mb-8 flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 text-amber-400">
          <TrendingUp className="w-8 h-8" />
          <span className="text-2xl font-bold tracking-tight">Freight DNA</span>
        </div>
        <p className="text-sm text-muted-foreground">Transportation Brokerage Intelligence</p>
      </div>

      <SignIn
        appearance={{
          baseTheme: dark,
          variables: {
            colorPrimary: "#f59e0b",
            colorBackground: "hsl(222 47% 7%)",
            colorInputBackground: "hsl(222 47% 10%)",
            colorText: "#f8fafc",
            colorTextSecondary: "#94a3b8",
            borderRadius: "0.5rem",
          },
          elements: {
            card: "shadow-2xl border border-white/10",
            headerTitle: "text-white font-semibold",
            headerSubtitle: "text-slate-400",
            formButtonPrimary: "bg-amber-500 hover:bg-amber-400 text-black font-semibold",
            footerActionLink: "text-amber-400 hover:text-amber-300",
          },
        }}
        routing="hash"
        afterSignInUrl="/"
        afterSignUpUrl="/"
      />
    </div>
  );
}
