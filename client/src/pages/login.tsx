import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, TrendingUp, ArrowLeft, CheckCircle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [, navigate] = useLocation();
  const { login, register } = useAuth();
  const { toast } = useToast();

  const forgotMutation = useMutation({
    mutationFn: (email: string) => apiRequest("POST", "/api/auth/forgot-password", { email }),
    onSuccess: () => setForgotSent(true),
    onError: () => toast({ title: "Error", description: "Failed to send reset email. Please try again.", variant: "destructive" }),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isRegister) {
        await register.mutateAsync({ username, password, name });
      } else {
        await login.mutateAsync({ username, password });
      }
      navigate("/");
    } catch (error: any) {
      const msg = error?.message || "Authentication failed";
      let description = msg;
      try {
        const parsed = JSON.parse(msg.split(": ").slice(1).join(": "));
        description = parsed.error || msg;
      } catch {}
      toast({ title: "Error", description, variant: "destructive" });
    }
  };

  const isPending = login.isPending || register.isPending;

  return (
    <div className="min-h-screen flex" style={{ background: "#0a0a0a" }}>

      {/* Left panel — brand */}
      <div
        className="hidden lg:flex flex-1 flex-col items-center justify-center p-12 relative overflow-hidden"
        style={{ background: "#0a0a0a" }}
      >
        {/* Subtle gold glow behind logo */}
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(255,180,0,0.08) 0%, transparent 70%)" }}
        />

        <div className="relative flex flex-col items-center text-center gap-6">
          {/* Icon mark in gold-bordered circle */}
          <div
            className="flex items-center justify-center w-36 h-36 rounded-full mb-2"
            style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 40px rgba(255,180,0,0.18)" }}
          >
            <TrendingUp className="w-16 h-16" style={{ color: "#ffb400" }} />
          </div>

          <div>
            <p
              className="text-2xl font-bold tracking-tight"
              style={{ color: "#ffb400" }}
              data-testid="text-brand-name-login"
            >
              freight · dna
            </p>
            <p
              className="mt-1 text-sm tracking-widest uppercase font-medium"
              style={{ color: "rgba(255,180,0,0.55)" }}
              data-testid="text-dna-tagline-login"
            >
              DNA · Down, Not Across
            </p>
            <p className="mt-2 text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>
              Sales intelligence for freight brokers.
            </p>
          </div>

          <div
            className="mt-4 flex flex-col gap-2 text-xs text-center"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            {[
              "Service Exceptionally",
              "Move Fast",
              "Build Relationships",
              "Hunt Opportunities",
              "Grow Relentlessly",
            ].map((m, i) => (
              <span key={i} style={{ color: i % 2 === 0 ? "rgba(255,180,0,0.5)" : "rgba(255,255,255,0.25)" }}>
                {m}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="hidden lg:block w-px" style={{ background: "rgba(255,180,0,0.15)" }} />

      {/* Right panel — login form */}
      <div
        className="flex flex-1 items-center justify-center p-6"
        style={{ background: "#0f0f0f" }}
      >
        <div className="w-full max-w-md">
          {/* Mobile-only logo */}
          <div className="flex flex-col items-center mb-8 lg:hidden">
            <div
              className="flex items-center justify-center w-20 h-20 rounded-full mb-3"
              style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 24px rgba(255,180,0,0.18)" }}
            >
              <TrendingUp className="w-9 h-9" style={{ color: "#ffb400" }} />
            </div>
            <p className="text-lg font-bold tracking-tight" style={{ color: "#ffb400" }}>
              freight · dna
            </p>
            <p className="text-xs tracking-widest uppercase mt-1" style={{ color: "rgba(255,180,0,0.55)" }}>
              DNA · Down, Not Across
            </p>
          </div>

          <Card
            className="border-0 shadow-2xl"
            style={{ background: "#161616", border: "1px solid rgba(255,180,0,0.15)" }}
            data-testid="card-login"
          >
            {showForgot ? (
              <>
                <CardHeader className="text-center space-y-2 pb-6 pt-8">
                  <h1 className="text-xl font-bold text-white">
                    {forgotSent ? "Check your email" : "Reset password"}
                  </h1>
                  <CardDescription style={{ color: "rgba(255,255,255,0.45)" }}>
                    {forgotSent
                      ? "We sent a reset link to your email. It expires in 1 hour."
                      : "Enter your email and we'll send you a reset link"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-8">
                  {forgotSent ? (
                    <div className="flex flex-col items-center gap-4 py-2">
                      <CheckCircle className="w-12 h-12" style={{ color: "#ffb400" }} />
                      <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.5)" }}>
                        Didn't get it? Check your spam folder or{" "}
                        <button
                          className="underline"
                          style={{ color: "rgba(255,180,0,0.7)" }}
                          onClick={() => { setForgotSent(false); setForgotEmail(""); }}
                        >
                          try again
                        </button>.
                      </p>
                      <Button
                        variant="ghost"
                        className="mt-2 text-xs"
                        style={{ color: "rgba(255,180,0,0.6)" }}
                        onClick={() => { setShowForgot(false); setForgotSent(false); setForgotEmail(""); }}
                      >
                        <ArrowLeft className="w-3 h-3 mr-1" /> Back to sign in
                      </Button>
                    </div>
                  ) : (
                    <form
                      onSubmit={(e) => { e.preventDefault(); forgotMutation.mutate(forgotEmail); }}
                      className="space-y-4"
                    >
                      <div className="space-y-2">
                        <Label htmlFor="forgot-email" className="text-white/70 text-xs uppercase tracking-wider">Email</Label>
                        <Input
                          id="forgot-email"
                          data-testid="input-forgot-email"
                          type="email"
                          value={forgotEmail}
                          onChange={(e) => setForgotEmail(e.target.value)}
                          placeholder="you@company.com"
                          required
                          style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                          className="placeholder:text-white/25"
                        />
                      </div>
                      <Button
                        type="submit"
                        className="w-full mt-2 font-semibold tracking-wide"
                        disabled={forgotMutation.isPending}
                        data-testid="button-send-reset"
                      >
                        {forgotMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Send Reset Link
                      </Button>
                      <div className="text-center">
                        <button
                          type="button"
                          className="text-xs hover:underline"
                          style={{ color: "rgba(255,180,0,0.6)" }}
                          onClick={() => setShowForgot(false)}
                        >
                          <ArrowLeft className="inline w-3 h-3 mr-1" />Back to sign in
                        </button>
                      </div>
                    </form>
                  )}
                </CardContent>
              </>
            ) : (
              <>
                <CardHeader className="text-center space-y-2 pb-6 pt-8">
                  <h1 className="text-xl font-bold text-white">
                    {isRegister ? "Create your account" : "Welcome back"}
                  </h1>
                  <CardDescription style={{ color: "rgba(255,255,255,0.45)" }}>
                    {isRegister ? "Fill in your details to get started" : "Sign in to your workspace"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-8">
                  <form onSubmit={handleSubmit} className="space-y-4">
                    {isRegister && (
                      <div className="space-y-2">
                        <Label htmlFor="name" className="text-white/70 text-xs uppercase tracking-wider">Full Name</Label>
                        <Input
                          id="name"
                          data-testid="input-name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="John Smith"
                          required
                          style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                          className="placeholder:text-white/25"
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="username" className="text-white/70 text-xs uppercase tracking-wider">Email</Label>
                      <Input
                        id="username"
                        data-testid="input-username"
                        type="email"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="you@company.com"
                        required
                        style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                        className="placeholder:text-white/25"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password" className="text-white/70 text-xs uppercase tracking-wider">Password</Label>
                        {!isRegister && (
                          <button
                            type="button"
                            className="text-xs hover:underline"
                            style={{ color: "rgba(255,180,0,0.55)" }}
                            onClick={() => setShowForgot(true)}
                            data-testid="link-forgot-password"
                          >
                            Forgot password?
                          </button>
                        )}
                      </div>
                      <Input
                        id="password"
                        data-testid="input-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                        className="placeholder:text-white/25"
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full mt-2 font-semibold tracking-wide"
                      disabled={isPending}
                      data-testid="button-submit-login"
                    >
                      {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {isRegister ? "Create Account" : "Sign In"}
                    </Button>
                  </form>
                  <div className="mt-5 text-center text-xs">
                    <button
                      type="button"
                      className="hover:underline transition-colors"
                      style={{ color: "rgba(255,180,0,0.6)" }}
                      onClick={() => setIsRegister(!isRegister)}
                      data-testid="button-toggle-auth-mode"
                    >
                      {isRegister
                        ? "Already have an account? Sign in"
                        : "Need an account? Register"}
                    </button>
                  </div>
                </CardContent>
              </>
            )}
          </Card>

          <p className="text-center text-xs mt-6" style={{ color: "rgba(255,255,255,0.2)" }}>
            freight-dna.com · sales intelligence platform
          </p>
        </div>
      </div>
    </div>
  );
}
