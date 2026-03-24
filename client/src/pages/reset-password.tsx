import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, TrendingUp, CheckCircle, AlertCircle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const token = params.get("token") || "";
  const { toast } = useToast();

  const resetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/reset-password", { token, password }),
    onSuccess: () => setDone(true),
    onError: (err: any) => {
      const msg = err?.message || "Failed to reset password";
      let description = msg;
      try {
        const parsed = JSON.parse(msg.split(": ").slice(1).join(": "));
        description = parsed.error || msg;
      } catch {}
      toast({ title: "Reset failed", description, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast({ title: "Passwords don't match", description: "Please make sure both passwords are identical.", variant: "destructive" });
      return;
    }
    if (password.length < 8) {
      toast({ title: "Password too short", description: "Password must be at least 8 characters.", variant: "destructive" });
      return;
    }
    resetMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#0a0a0a" }}>
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div
            className="flex items-center justify-center w-20 h-20 rounded-full mb-3"
            style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 24px rgba(255,180,0,0.18)" }}
          >
            <TrendingUp className="w-9 h-9" style={{ color: "#ffb400" }} />
          </div>
          <p className="text-lg font-bold tracking-tight" style={{ color: "#ffb400" }}>freight · dna</p>
          <p className="text-xs tracking-widest uppercase mt-1" style={{ color: "rgba(255,180,0,0.55)" }}>DNA · Down, Not Across</p>
        </div>

        <Card style={{ background: "#161616", border: "1px solid rgba(255,180,0,0.15)" }}>
          {!token ? (
            <>
              <CardHeader className="text-center space-y-2 pb-4 pt-8">
                <AlertCircle className="w-10 h-10 mx-auto" style={{ color: "#ef4444" }} />
                <h1 className="text-xl font-bold text-white">Invalid Link</h1>
                <CardDescription style={{ color: "rgba(255,255,255,0.45)" }}>
                  This password reset link is missing or invalid.
                </CardDescription>
              </CardHeader>
              <CardContent className="pb-8 text-center">
                <Button
                  variant="ghost"
                  className="text-sm"
                  style={{ color: "rgba(255,180,0,0.7)" }}
                  onClick={() => navigate("/login")}
                  data-testid="link-back-to-login"
                >
                  Back to sign in
                </Button>
              </CardContent>
            </>
          ) : done ? (
            <>
              <CardHeader className="text-center space-y-2 pb-4 pt-8">
                <CheckCircle className="w-12 h-12 mx-auto" style={{ color: "#ffb400" }} />
                <h1 className="text-xl font-bold text-white">Password Updated</h1>
                <CardDescription style={{ color: "rgba(255,255,255,0.45)" }}>
                  Your password has been reset successfully.
                </CardDescription>
              </CardHeader>
              <CardContent className="pb-8 text-center">
                <Button
                  className="font-semibold tracking-wide"
                  onClick={() => navigate("/login")}
                  data-testid="button-go-to-login"
                >
                  Sign in with new password
                </Button>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="text-center space-y-2 pb-6 pt-8">
                <h1 className="text-xl font-bold text-white">Set new password</h1>
                <CardDescription style={{ color: "rgba(255,255,255,0.45)" }}>
                  Choose a strong password — at least 8 characters
                </CardDescription>
              </CardHeader>
              <CardContent className="pb-8">
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="new-password" className="text-white/70 text-xs uppercase tracking-wider">New Password</Label>
                    <Input
                      id="new-password"
                      data-testid="input-new-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      minLength={8}
                      style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                      className="placeholder:text-white/25"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password" className="text-white/70 text-xs uppercase tracking-wider">Confirm Password</Label>
                    <Input
                      id="confirm-password"
                      data-testid="input-confirm-password"
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="••••••••"
                      required
                      style={{ background: "#1e1e1e", borderColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                      className="placeholder:text-white/25"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full mt-2 font-semibold tracking-wide"
                    disabled={resetMutation.isPending}
                    data-testid="button-submit-reset"
                  >
                    {resetMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Reset Password
                  </Button>
                </form>
              </CardContent>
            </>
          )}
        </Card>

        <p className="text-center text-xs mt-6" style={{ color: "rgba(255,255,255,0.2)" }}>
          freight-dna.com · sales intelligence platform
        </p>
      </div>
    </div>
  );
}
