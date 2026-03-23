import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import vtLogoWhite from "@assets/value-truck-logo-white.png";

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [, navigate] = useLocation();
  const { login, register } = useAuth();
  const { toast } = useToast();

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
          {/* VT logo in gold-bordered circle */}
          <div
            className="flex items-center justify-center w-36 h-36 rounded-full p-5 mb-2"
            style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 40px rgba(255,180,0,0.18)" }}
          >
            <img src={vtLogoWhite} alt="Value Truck" className="w-full h-full object-contain" />
          </div>

          <div>
            <p
              className="text-sm tracking-widest uppercase font-semibold"
              style={{ color: "#ffb400" }}
              data-testid="text-dna-tagline-login"
            >
              DNA · Down Not Across
            </p>
            <p className="mt-3 text-2xl font-bold text-white">
              Growth Chart VT
            </p>
            <p className="mt-1 text-sm" style={{ color: "rgba(255,180,0,0.7)" }}>
              From farmer to hunter.
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
              className="flex items-center justify-center w-20 h-20 rounded-full p-3 mb-3"
              style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 24px rgba(255,180,0,0.18)" }}
            >
              <img src={vtLogoWhite} alt="Value Truck" className="w-full h-full object-contain" />
            </div>
            <p className="text-sm font-semibold tracking-widest" style={{ color: "#ffb400" }}>
              DNA · Down Not Across
            </p>
          </div>

          <Card
            className="border-0 shadow-2xl"
            style={{ background: "#161616", border: "1px solid rgba(255,180,0,0.15)" }}
            data-testid="card-login"
          >
            <CardHeader className="text-center space-y-2 pb-6 pt-8">
              <h1 className="text-xl font-bold text-white">
                {isRegister ? "Create your account" : "Welcome back"}
              </h1>
              <CardDescription style={{ color: "rgba(255,255,255,0.45)" }}>
                {isRegister ? "Fill in your details to get started" : "Sign in to Growth Chart VT"}
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
                    placeholder="john@valuetruck.com"
                    required
                    style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                    className="placeholder:text-white/25"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-white/70 text-xs uppercase tracking-wider">Password</Label>
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
          </Card>
        </div>
      </div>
    </div>
  );
}
