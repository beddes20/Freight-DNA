import { useLocation } from "wouter";

const EFFECTIVE_DATE = "March 29, 2026";
const COMPANY = "Freight DNA";
const CONTACT_EMAIL = "info@freight-dna.com";
const WEBSITE = "freight-dna.com";

export default function PrivacyPage() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0a0a0a", color: "#fff" }}>
      {/* Header */}
      <header
        className="w-full flex items-center justify-between px-6 md:px-12 py-4 sticky top-0 z-40"
        style={{ borderBottom: "1px solid rgba(255,180,0,0.1)", background: "rgba(10,10,10,0.95)", backdropFilter: "blur(8px)" }}
      >
        <button
          onClick={() => navigate("/")}
          className="flex flex-col gap-0.5 transition-opacity hover:opacity-80"
        >
          <span className="text-sm font-bold tracking-tight" style={{ color: "#ffb400", letterSpacing: "-0.01em" }}>
            freight · dna
          </span>
          <span className="text-[9px] uppercase tracking-[0.2em] font-semibold" style={{ color: "rgba(255,180,0,0.45)" }}>
            DNA · Down Not Across
          </span>
        </button>
        <button
          onClick={() => navigate("/")}
          className="text-sm transition-colors"
          style={{ color: "rgba(255,255,255,0.4)" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#fff"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)"; }}
        >
          ← Back to home
        </button>
      </header>

      {/* Content */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-16">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4" style={{ color: "rgba(255,180,0,0.65)" }}>
          Legal
        </p>
        <h1 className="text-4xl font-extrabold mb-3 tracking-tight" style={{ letterSpacing: "-0.02em" }}>
          Privacy Policy
        </h1>
        <p className="text-sm mb-12" style={{ color: "rgba(255,255,255,0.35)" }}>
          Effective date: {EFFECTIVE_DATE}
        </p>

        <div className="flex flex-col gap-10" style={{ color: "rgba(255,255,255,0.7)" }}>

          <Section title="1. Overview">
            <P>{COMPANY} ("we," "our," or "us") operates the Freight DNA platform, a sales intelligence and CRM product designed for transportation brokerage companies. This Privacy Policy explains how we collect, use, disclose, and protect information about you when you use our website at {WEBSITE} and our platform (collectively, the "Service").</P>
            <P>By using the Service, you agree to the collection and use of information in accordance with this policy. If you do not agree, please do not use the Service.</P>
          </Section>

          <Section title="2. Information We Collect">
            <SubHeading>Information you provide directly</SubHeading>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed mb-4">
              <li><strong>Demo requests:</strong> When you schedule a demo, we collect your name, business email address, phone number (optional), and areas of interest.</li>
              <li><strong>Account registration:</strong> When an organization is provisioned on the platform, we collect the account administrator's name, business email address, and a password (stored as a one-way hash — we never store your plaintext password).</li>
              <li><strong>CRM and business data:</strong> Data you or your team enters into the platform — including company records, contact information, freight lanes, financial data, touchpoint notes, and other sales-related information — is stored on your behalf. This data belongs to you.</li>
              <li><strong>Communications:</strong> If you contact us by email or through the platform, we retain those communications.</li>
            </ul>
            <SubHeading>Information collected automatically</SubHeading>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li><strong>Session data:</strong> We use server-side sessions to keep you logged in. Session identifiers are stored in a secure, httpOnly cookie.</li>
              <li><strong>Usage data:</strong> We may collect basic usage information such as pages visited and features used to improve the platform.</li>
              <li><strong>IP address and browser information:</strong> Collected automatically as part of standard web server operation.</li>
            </ul>
          </Section>

          <Section title="3. How We Use Your Information">
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li>To provide, operate, and improve the Service</li>
              <li>To respond to demo requests and onboard new customers</li>
              <li>To send transactional emails (account setup, notifications, daily digest emails) that are part of the Service</li>
              <li>To process subscription payments through Stripe</li>
              <li>To power AI features using your CRM data (see Section 5)</li>
              <li>To detect and prevent fraudulent or unauthorized use</li>
              <li>To comply with legal obligations</li>
            </ul>
            <P className="mt-4">We do not sell your personal information or your organization's CRM data to any third party.</P>
          </Section>

          <Section title="4. Data Sharing and Third-Party Services">
            <P>We use the following third-party services to operate the platform. Each is bound by its own privacy policy and data processing agreements:</P>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li><strong>OpenAI:</strong> Certain AI features (including the DNA Guru chatbot, AI Sales Intel Briefs, and AI health narratives) transmit relevant portions of your CRM data to OpenAI's API for processing. Data sent to OpenAI is subject to OpenAI's API data usage policies. We do not use your data to train OpenAI models.</li>
              <li><strong>Stripe:</strong> Subscription billing and payment processing. Stripe handles all payment card data directly — we never store card numbers on our servers.</li>
              <li><strong>Resend / GoDaddy SMTP:</strong> Used to deliver transactional and notification emails on behalf of the platform.</li>
              <li><strong>PostgreSQL (hosted database):</strong> All platform data is stored in a secure PostgreSQL database.</li>
            </ul>
            <P className="mt-4">We may disclose information if required by law, regulation, legal process, or governmental request, or to protect the rights, property, or safety of {COMPANY}, our customers, or the public.</P>
          </Section>

          <Section title="5. AI Features and Your Data">
            <P>Freight DNA includes AI-powered features that process your CRM data to generate insights, summaries, and recommendations. When you use these features, relevant data (such as account notes, contact information, and freight data) is sent to OpenAI's API.</P>
            <P>We recommend that you do not enter sensitive personal information — such as Social Security numbers, personal financial data unrelated to freight operations, or health information — into the platform.</P>
            <P>AI-generated content is provided for informational and sales assistance purposes only. It should not be relied upon as professional legal, financial, or compliance advice.</P>
          </Section>

          <Section title="6. Data Retention">
            <P>We retain your data for as long as your account is active or as necessary to provide the Service. If you cancel your subscription, we will retain your data for 90 days to allow for reactivation, after which it may be deleted from our systems.</P>
            <P>You may request deletion of your data at any time by contacting us at {CONTACT_EMAIL}.</P>
          </Section>

          <Section title="7. Security">
            <P>We implement commercially reasonable technical and organizational measures to protect your information against unauthorized access, alteration, disclosure, or destruction. These measures include encrypted connections (HTTPS), hashed passwords, and server-side session management.</P>
            <P>No method of transmission over the internet or electronic storage is 100% secure. We cannot guarantee absolute security, and we encourage you to use a strong, unique password for your account.</P>
          </Section>

          <Section title="8. Your Rights">
            <P>Depending on your location, you may have the following rights with respect to your personal information:</P>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li><strong>Access:</strong> Request a copy of the personal data we hold about you.</li>
              <li><strong>Correction:</strong> Request correction of inaccurate or incomplete data.</li>
              <li><strong>Deletion:</strong> Request deletion of your personal data, subject to certain legal retention requirements.</li>
              <li><strong>Portability:</strong> Request your data in a portable format.</li>
              <li><strong>Objection:</strong> Object to certain processing of your data.</li>
            </ul>
            <P className="mt-4">To exercise any of these rights, contact us at {CONTACT_EMAIL}. We will respond within 30 days.</P>
          </Section>

          <Section title="9. Cookies">
            <P>We use a single session cookie to keep you authenticated while you use the platform. This cookie is strictly necessary for the Service to function and does not track you across other websites. We do not use advertising cookies or third-party tracking cookies.</P>
          </Section>

          <Section title="10. Children's Privacy">
            <P>The Service is intended for business use by adults. We do not knowingly collect personal information from individuals under the age of 18. If you believe a minor has provided us with personal information, please contact us at {CONTACT_EMAIL}.</P>
          </Section>

          <Section title="11. Changes to This Policy">
            <P>We may update this Privacy Policy from time to time. When we do, we will update the effective date at the top of this page and, where appropriate, notify active account holders by email. Your continued use of the Service after changes are posted constitutes your acceptance of the updated policy.</P>
          </Section>

          <Section title="12. Contact Us">
            <P>If you have any questions or concerns about this Privacy Policy or our data practices, please contact us at:</P>
            <div className="mt-3 text-sm p-4 rounded-lg" style={{ background: "#0f0f0f", border: "1px solid rgba(255,180,0,0.15)" }}>
              <p className="font-semibold" style={{ color: "#ffc333" }}>{COMPANY}</p>
              <p>Email: <a href={`mailto:${CONTACT_EMAIL}`} className="hover:opacity-80 transition-opacity" style={{ color: "#ffc333" }}>{CONTACT_EMAIL}</a></p>
              <p>Website: <a href={`https://${WEBSITE}`} className="hover:opacity-80 transition-opacity" style={{ color: "#ffc333" }}>{WEBSITE}</a></p>
            </div>
          </Section>

        </div>
      </main>

      {/* Footer */}
      <footer
        className="w-full flex flex-col sm:flex-row items-center justify-between gap-3 px-6 md:px-12 py-5 text-xs"
        style={{ borderTop: "1px solid rgba(255,180,0,0.1)", color: "rgba(255,255,255,0.2)" }}
      >
        <span>freight · dna</span>
        <div className="flex items-center gap-5">
          <button onClick={() => navigate("/privacy")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.35)" }}>Privacy Policy</button>
          <button onClick={() => navigate("/terms")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.25)" }}>Terms of Service</button>
        </div>
        <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.2)" }}>
          {CONTACT_EMAIL}
        </a>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-bold tracking-tight" style={{ color: "#fff", letterSpacing: "-0.01em" }}>
        {title}
      </h2>
      <div className="flex flex-col gap-3">
        {children}
      </div>
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-semibold mb-1 mt-2" style={{ color: "rgba(255,180,0,0.8)" }}>
      {children}
    </p>
  );
}

function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-sm leading-relaxed ${className}`}>
      {children}
    </p>
  );
}
