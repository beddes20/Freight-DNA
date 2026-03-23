const rep = {
  name: "Adan",
  fullName: "Adan Castaneda",
  manager: "Danny Beddes",
};

const goals = [
  { label: "Monthly Margin", current: 18420, target: 25000, unit: "$", pct: 74 },
  { label: "Weekly Touchpoints", current: 19, target: 25, unit: "", pct: 76 },
  { label: "Contacts Added", current: 3, target: 8, unit: "", pct: 38 },
  { label: "Load Count", current: 31, target: 40, unit: "", pct: 78 },
];

function pctColor(p: number) {
  if (p >= 80) return { dot: "#22c55e", bar: "#22c55e", label: "On Track", badge: "#dcfce7", text: "#166534" };
  if (p >= 50) return { dot: "#f59e0b", bar: "#f59e0b", label: "In Progress", badge: "#fef3c7", text: "#92400e" };
  return { dot: "#ef4444", bar: "#ef4444", label: "Needs Focus", badge: "#fee2e2", text: "#991b1b" };
}

export function Email() {
  return (
    <div style={{ backgroundColor: "#f1f5f9", minHeight: "100vh", padding: "32px 16px", fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>

        {/* Header */}
        <div style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)",
          borderRadius: "16px 16px 0 0",
          padding: "32px",
          textAlign: "center",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 16 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: "linear-gradient(135deg, #3b82f6, #001AB3)",
            }} />
            <span style={{ color: "#94a3b8", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Value Truck · Freight DNA
            </span>
          </div>
          <h1 style={{ color: "#fff", fontSize: 24, fontWeight: 700, margin: 0 }}>Weekly Progress Report</h1>
          <p style={{ color: "#94a3b8", fontSize: 13, marginTop: 6 }}>Week of March 17–23, 2026</p>

          {/* Rep pill */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            background: "rgba(255,255,255,0.1)", borderRadius: 50,
            padding: "8px 16px 8px 8px", marginTop: 20,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%",
              background: "linear-gradient(135deg, #001AB3, #3b82f6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontWeight: 700, fontSize: 13,
            }}>AC</div>
            <div style={{ textAlign: "left" }}>
              <p style={{ color: "#fff", fontSize: 14, fontWeight: 600, margin: 0 }}>{rep.fullName}</p>
              <p style={{ color: "#94a3b8", fontSize: 12, margin: 0 }}>Account Manager</p>
            </div>
          </div>
        </div>

        {/* White body */}
        <div style={{ background: "#ffffff", padding: "32px" }}>

          {/* Greeting */}
          <p style={{ color: "#1e293b", fontSize: 15, margin: "0 0 4px" }}>
            Hey <strong>{rep.name}</strong>,
          </p>
          <p style={{ color: "#475569", fontSize: 14, margin: "0 0 28px", lineHeight: 1.6 }}>
            Here's your weekly snapshot. You're making solid progress — keep pushing on <strong>Contacts Added</strong> to hit your goal.
          </p>

          {/* Activity row */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr",
            gap: 8, marginBottom: 28,
          }}>
            {[
              { label: "Touchpoints", value: "19", color: "#001AB3", delta: "+7 vs last week" },
              { label: "New Contacts", value: "3", color: "#7c3aed", delta: "+1 vs last week" },
              { label: "Tasks Done", value: "7/9", color: "#059669", delta: "2 remaining" },
              { label: "Need Attention", value: "2", color: "#dc2626", delta: "14+ days quiet" },
            ].map(({ label, value, color, delta }) => (
              <div key={label} style={{
                border: "1px solid #e2e8f0", borderRadius: 12,
                padding: "14px 12px", textAlign: "center",
              }}>
                <p style={{ color, fontSize: 22, fontWeight: 700, margin: 0 }}>{value}</p>
                <p style={{ color: "#1e293b", fontSize: 11, fontWeight: 600, margin: "2px 0" }}>{label}</p>
                <p style={{ color: "#94a3b8", fontSize: 10, margin: 0 }}>{delta}</p>
              </div>
            ))}
          </div>

          {/* Divider */}
          <hr style={{ border: "none", borderTop: "1px solid #f1f5f9", margin: "0 0 24px" }} />

          {/* Goals section */}
          <p style={{ color: "#0f172a", fontSize: 13, fontWeight: 700, margin: "0 0 14px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            🎯 Goals Progress
          </p>
          <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 16px" }}>
            Goals set by your manager, {rep.manager}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
            {goals.map((g) => {
              const c = pctColor(g.pct);
              return (
                <div key={g.label} style={{ border: "1px solid #f1f5f9", borderRadius: 12, padding: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div>
                      <p style={{ color: "#1e293b", fontSize: 14, fontWeight: 600, margin: 0 }}>{g.label}</p>
                      <p style={{ color: "#94a3b8", fontSize: 12, margin: "2px 0 0" }}>
                        {g.unit === "$" ? `$${g.current.toLocaleString()} of $${g.target.toLocaleString()}` : `${g.current} of ${g.target}`}
                      </p>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <p style={{ color: c.dot, fontSize: 22, fontWeight: 700, margin: 0 }}>{g.pct}%</p>
                      <span style={{ background: c.badge, color: c.text, fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 50 }}>
                        {c.label}
                      </span>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div style={{ background: "#f1f5f9", borderRadius: 999, height: 6, overflow: "hidden" }}>
                    <div style={{ width: `${g.pct}%`, height: "100%", background: c.bar, borderRadius: 999 }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Divider */}
          <hr style={{ border: "none", borderTop: "1px solid #f1f5f9", margin: "0 0 24px" }} />

          {/* Touchpoints breakdown */}
          <p style={{ color: "#0f172a", fontSize: 13, fontWeight: 700, margin: "0 0 14px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            ⚡ Touchpoints This Week
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 28 }}>
            {[
              { label: "Calls", value: 9, bg: "#eff6ff", color: "#1d4ed8" },
              { label: "Emails", value: 6, bg: "#f5f3ff", color: "#6d28d9" },
              { label: "Texts", value: 3, bg: "#f0fdf4", color: "#15803d" },
              { label: "Site Visits", value: 1, bg: "#fffbeb", color: "#b45309" },
            ].map(({ label, value, bg, color }) => (
              <div key={label} style={{ background: bg, borderRadius: 12, padding: "14px 8px", textAlign: "center" }}>
                <p style={{ color, fontSize: 22, fontWeight: 700, margin: 0 }}>{value}</p>
                <p style={{ color: "#64748b", fontSize: 11, margin: "2px 0 0" }}>{label}</p>
              </div>
            ))}
          </div>

          {/* Wins */}
          <p style={{ color: "#0f172a", fontSize: 13, fontWeight: 700, margin: "0 0 14px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            🏆 Wins This Week
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 32 }}>
            {[
              { emoji: "🚀", text: "Booked 6 loads with Acuity Brands after site visit" },
              { emoji: "🎉", text: "Converted Pacific Foods from spot to contract" },
            ].map((w, i) => (
              <div key={i} style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 10, padding: "10px 14px",
                display: "flex", gap: 10, alignItems: "flex-start",
              }}>
                <span style={{ fontSize: 16 }}>{w.emoji}</span>
                <p style={{ color: "#92400e", fontSize: 13, margin: 0 }}>{w.text}</p>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div style={{ textAlign: "center" }}>
            <a
              href="#"
              style={{
                display: "inline-block",
                background: "#001AB3",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                padding: "14px 32px",
                borderRadius: 50,
                textDecoration: "none",
                letterSpacing: "0.01em",
              }}
            >
              View Full Report in Portal →
            </a>
            <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 16 }}>
              Sent every Monday morning for weekly · 1st of the month for monthly
            </p>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          background: "#f8fafc", border: "1px solid #e2e8f0", borderTop: "none",
          borderRadius: "0 0 16px 16px", padding: "20px 32px", textAlign: "center",
        }}>
          <p style={{ color: "#94a3b8", fontSize: 11, margin: 0 }}>
            You're receiving this because you're on the Value Truck sales team.
          </p>
          <p style={{ color: "#94a3b8", fontSize: 11, margin: "4px 0 0" }}>
            <a href="#" style={{ color: "#001AB3", textDecoration: "none" }}>Manage notification preferences</a>
            {" · "}
            <a href="#" style={{ color: "#001AB3", textDecoration: "none" }}>Unsubscribe</a>
          </p>
        </div>

      </div>
    </div>
  );
}
