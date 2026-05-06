import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle, Loader2, AlertCircle, TrendingUp } from "lucide-react";

export default function CheckoutSuccessPage() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [details, setDetails] = useState<{ companyName: string; planName: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    if (!sessionId) {
      setStatus("error");
      return;
    }

    fetch(`/api/stripe/confirm-checkout?session_id=${encodeURIComponent(sessionId)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setDetails({ companyName: data.companyName || "", planName: data.planName || "Freight DNA Subscription" });
          setStatus("success");
        } else {
          setStatus("error");
        }
      })
      .catch(() => setStatus("error"));
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: "#0a0a0a", color: "#fff" }}
    >
      <div
        className="flex items-center justify-center w-10 h-10 rounded-full mb-8"
        style={{ border: "1.5px solid #ffb400", background: "#111" }}
      >
        <TrendingUp className="w-5 h-5" style={{ color: "#ffb400" }} />
      </div>

      {status === "loading" && (
        <>
          <Loader2 className="w-10 h-10 animate-spin mb-4" style={{ color: "#ffc333" }} />
          <p className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>Confirming your subscription…</p>
        </>
      )}

      {status === "success" && (
        <div className="max-w-md">
          <div
            className="flex items-center justify-center w-16 h-16 rounded-full mx-auto mb-6"
            style={{ background: "rgba(255,195,51,0.12)", border: "1.5px solid rgba(255,195,51,0.4)" }}
          >
            <CheckCircle className="w-8 h-8" style={{ color: "#ffc333" }} />
          </div>
          <h1
            className="text-3xl md:text-4xl font-extrabold mb-4 tracking-tight"
            style={{ letterSpacing: "-0.03em" }}
            data-testid="text-success-heading"
          >
            You're in.
          </h1>
          <p className="text-base mb-3" style={{ color: "rgba(255,255,255,0.6)" }}>
            Your subscription to <strong style={{ color: "#ffc333" }}>Freight DNA</strong> is now active.
          </p>
          {details?.planName && (
            <p className="text-sm mb-8" style={{ color: "rgba(255,255,255,0.4)" }}>
              Plan: {details.planName}
            </p>
          )}
          <p className="text-sm mb-8 leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
            Our team will be in touch shortly to get your account configured and your team onboarded. In the meantime, feel free to reach us at{" "}
            <a href="mailto:info@freight-dna.com" style={{ color: "#ffc333" }}>info@freight-dna.com</a>.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => navigate("/login")}
              className="text-sm font-bold px-8 py-3 rounded transition-all duration-150"
              style={{ background: "#ffc333", color: "#0a0a0a" }}
              data-testid="button-success-login"
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
            >
              Access Platform
            </button>
            <button
              onClick={() => navigate("/")}
              className="text-sm font-semibold px-8 py-3 rounded transition-all duration-150"
              style={{ border: "1px solid rgba(255,180,0,0.4)", color: "#ffb400", background: "transparent" }}
              data-testid="button-success-home"
            >
              Back to Home
            </button>
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="max-w-md">
          <div
            className="flex items-center justify-center w-16 h-16 rounded-full mx-auto mb-6"
            style={{ background: "rgba(255,100,100,0.1)", border: "1.5px solid rgba(255,100,100,0.3)" }}
          >
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <h1 className="text-2xl font-bold mb-3" data-testid="text-error-heading">Something went wrong</h1>
          <p className="text-sm mb-8" style={{ color: "rgba(255,255,255,0.5)" }}>
            We couldn't confirm your subscription. Please contact us at{" "}
            <a href="mailto:info@freight-dna.com" style={{ color: "#ffc333" }}>info@freight-dna.com</a> and we'll get you sorted out.
          </p>
          <button
            onClick={() => navigate("/")}
            className="text-sm font-bold px-8 py-3 rounded"
            style={{ background: "#ffc333", color: "#0a0a0a" }}
            data-testid="button-error-home"
          >
            Back to Home
          </button>
        </div>
      )}
    </div>
  );
}
