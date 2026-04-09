import { SignIn } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import { TrendingUp } from "lucide-react";

export default function LoginPage() {
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
