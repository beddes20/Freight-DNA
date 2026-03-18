import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import vtLogoBlack from "@assets/value-truck-logo-black.png";
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
    <div className="min-h-screen flex dark:bg-[#0a1a33]" style={{ background: "linear-gradient(135deg, #001AB3 0%, #044ad3 50%, #1a6bff 100%)" }}>
      <div className="hidden lg:flex flex-1 flex-col items-center justify-center p-12 text-white">
        <img
          src={vtLogoWhite}
          alt="Value Truck"
          className="w-72 object-contain mb-8"
        />
        <p className="text-blue-100/70 text-center mt-2 text-sm tracking-widest" data-testid="text-dna-tagline-login">
          <span className="font-semibold text-white">DNA</span>
          {" · "}
          <span className="font-semibold text-white">D</span>own{" "}
          <span className="font-semibold text-white">N</span>ot{" "}
          <span className="font-semibold text-white">A</span>cross
        </p>
        <p className="text-blue-200 text-center mt-3 max-w-sm text-lg">
          From farmer to hunter.
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center p-6 lg:bg-white lg:dark:bg-[#0d1f3c] lg:rounded-l-3xl">
        <Card className="w-full max-w-md border-0 shadow-none bg-transparent lg:bg-card lg:shadow-sm lg:border" data-testid="card-login">
          <CardHeader className="text-center space-y-4 pb-6">
            <img
              src={vtLogoBlack}
              alt="Value Truck"
              className="mx-auto h-14 object-contain dark:hidden"
            />
            <img
              src={vtLogoWhite}
              alt="Value Truck"
              className="mx-auto h-14 object-contain hidden dark:block lg:dark:hidden"
            />
            <CardDescription className="text-base">
              {isRegister ? "Create your account" : "Sign in to your account"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {isRegister && (
                <div className="space-y-2">
                  <Label htmlFor="name">Full Name</Label>
                  <Input
                    id="name"
                    data-testid="input-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="John Smith"
                    required
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="username">Email</Label>
                <Input
                  id="username"
                  data-testid="input-username"
                  type="email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="john@example.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  data-testid="input-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={isPending}
                data-testid="button-submit-login"
              >
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isRegister ? "Create Account" : "Sign In"}
              </Button>
            </form>
            <div className="mt-4 text-center text-sm">
              <button
                type="button"
                className="text-primary hover:underline"
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
  );
}
