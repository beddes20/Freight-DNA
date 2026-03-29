import { useLocation } from "wouter";

const EFFECTIVE_DATE = "March 29, 2026";
const COMPANY = "Freight DNA";
const CONTACT_EMAIL = "info@freight-dna.com";
const WEBSITE = "freight-dna.com";

export default function TermsPage() {
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
          Terms of Service
        </h1>
        <p className="text-sm mb-12" style={{ color: "rgba(255,255,255,0.35)" }}>
          Effective date: {EFFECTIVE_DATE}
        </p>

        <div className="flex flex-col gap-10" style={{ color: "rgba(255,255,255,0.7)" }}>

          <Section title="1. Acceptance of Terms">
            <P>These Terms of Service ("Terms") constitute a legally binding agreement between you (or the organization you represent, "Customer") and {COMPANY} ("we," "our," or "us") governing your access to and use of the Freight DNA platform and related services (the "Service").</P>
            <P>By creating an account, accessing the platform, or clicking "I agree," you represent that you have the authority to bind your organization to these Terms. If you do not agree, do not use the Service.</P>
          </Section>

          <Section title="2. Description of Service">
            <P>Freight DNA is a cloud-based sales intelligence and CRM platform purpose-built for freight brokerage teams. Features include account and contact management, organizational charting, RFP and award tracking, freight lane analysis, goal and performance management, AI-powered insights, and related sales tools.</P>
            <P>We reserve the right to modify, enhance, or discontinue features of the Service at any time. When material changes are made, we will provide reasonable notice to active subscribers.</P>
          </Section>

          <Section title="3. Account Registration and Security">
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li>Each user account is personal and may not be shared. Your subscription fee covers a defined number of named users ("seats").</li>
              <li>You are responsible for maintaining the confidentiality of your login credentials. You are responsible for all activity that occurs under your account.</li>
              <li>You must notify us immediately at {CONTACT_EMAIL} if you suspect unauthorized access to your account.</li>
              <li>Accounts are provisioned by {COMPANY} upon execution of a subscription agreement. Self-service account creation is not currently available.</li>
            </ul>
          </Section>

          <Section title="4. Subscriptions and Payment">
            <SubHeading>Plans and pricing</SubHeading>
            <P>Freight DNA is offered on a subscription basis. Current plans, pricing, and seat limits are described on our pricing page and in your subscription agreement. Pricing is subject to change with 30 days' written notice to active subscribers.</P>

            <SubHeading>Trial period</SubHeading>
            <P>We offer a trial period for an agreed-upon fee (the "Trial Fee"). If you elect to continue as a paying subscriber after your trial, the Trial Fee will be applied as a credit toward your first annual subscription payment. The Trial Fee is non-refundable if you elect not to continue.</P>

            <SubHeading>Billing and renewal</SubHeading>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li>Subscriptions are billed monthly or annually as selected. Annual subscriptions are billed in full at the start of each subscription year.</li>
              <li>Subscriptions renew automatically unless canceled at least 30 days before the renewal date.</li>
              <li>All fees are in US dollars and exclude applicable taxes, which are your responsibility.</li>
            </ul>

            <SubHeading>Refunds</SubHeading>
            <P>Monthly subscriptions may be canceled at any time; you will retain access through the end of the billing period, with no refund for the unused portion. Annual subscriptions canceled within the first 30 days will receive a pro-rated refund for the unused months. After 30 days, annual subscriptions are non-refundable.</P>
          </Section>

          <Section title="5. Acceptable Use">
            <P>You agree not to:</P>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li>Use the Service for any unlawful purpose or in violation of any applicable law or regulation</li>
              <li>Reverse engineer, decompile, or attempt to extract the source code of the platform</li>
              <li>Resell, sublicense, or otherwise provide access to the Service to third parties without our written consent</li>
              <li>Introduce viruses, malware, or other harmful code</li>
              <li>Attempt to gain unauthorized access to our systems or another customer's data</li>
              <li>Scrape, harvest, or use automated means to extract data from the platform beyond normal use</li>
              <li>Use the Service to build a competing product</li>
            </ul>
            <P className="mt-2">We reserve the right to suspend or terminate accounts that violate these terms.</P>
          </Section>

          <Section title="6. Your Data">
            <P><strong style={{ color: "#fff" }}>Your data belongs to you.</strong> All CRM data, contacts, company records, freight data, and other business information you enter into the platform ("Customer Data") remains your property. We do not claim ownership of Customer Data.</P>
            <P>You grant {COMPANY} a limited, non-exclusive license to host, process, and transmit your Customer Data solely for the purpose of providing the Service to you. This includes transmitting relevant data to third-party AI services to power AI features you choose to use (see our Privacy Policy).</P>
            <P>Upon termination, you may request an export of your Customer Data within 90 days. After 90 days, we may delete your data from our systems.</P>
            <P>You represent that you have all necessary rights to upload and use the Customer Data you enter into the platform, and that doing so does not violate any third-party rights or applicable laws.</P>
          </Section>

          <Section title="7. AI-Powered Features">
            <P>The Service includes AI-powered features (including the DNA Guru chatbot, AI health narratives, daily sales briefs, and AI column mapping) that use large language models to generate text based on your data.</P>
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li><strong>AI outputs are not guaranteed to be accurate.</strong> They are intended as sales assistance tools, not as definitive advice. You are responsible for independently verifying any AI-generated content before acting on it.</li>
              <li>Do not enter sensitive personal information, protected health information, or classified data into AI-powered features.</li>
              <li>AI features may be unavailable during periods of third-party service outages.</li>
            </ul>
          </Section>

          <Section title="8. Intellectual Property">
            <P>{COMPANY} owns all right, title, and interest in and to the Freight DNA platform, including all software, design, trademarks, trade names, logos, and documentation. These Terms do not transfer any intellectual property rights to you except the limited license to use the Service as described herein.</P>
            <P>Feedback, suggestions, or ideas you provide to us may be used by {COMPANY} to improve the platform without any obligation to you.</P>
          </Section>

          <Section title="9. Confidentiality">
            <P>Each party agrees to keep the other's confidential information (including pricing terms, platform architecture, and Customer Data) confidential and not to disclose it to third parties without the other's prior written consent, except as required by law.</P>
          </Section>

          <Section title="10. Disclaimer of Warranties">
            <P>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE ERROR-FREE, UNINTERRUPTED, OR FREE OF HARMFUL COMPONENTS.</P>
          </Section>

          <Section title="11. Limitation of Liability">
            <P>TO THE MAXIMUM EXTENT PERMITTED BY LAW, {COMPANY.toUpperCase()} SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR LOSS OF PROFITS, REVENUE, DATA, OR BUSINESS OPPORTUNITIES, ARISING FROM OR RELATED TO YOUR USE OF THE SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.</P>
            <P>IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU EXCEED THE GREATER OF (A) THE FEES PAID BY YOU TO {COMPANY.toUpperCase()} IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED US DOLLARS ($100).</P>
          </Section>

          <Section title="12. Indemnification">
            <P>You agree to indemnify and hold harmless {COMPANY} and its officers, directors, employees, and agents from any claims, damages, losses, or expenses (including reasonable attorneys' fees) arising from: (a) your use of the Service in violation of these Terms; (b) your Customer Data; or (c) your violation of any applicable law or third-party rights.</P>
          </Section>

          <Section title="13. Term and Termination">
            <P>These Terms remain in effect for the duration of your subscription. Either party may terminate the subscription with appropriate notice as described in Section 4 (Subscriptions and Payment).</P>
            <P>We may suspend or terminate your access immediately if you breach these Terms, fail to pay fees when due, or if required by law. Upon termination, your right to access the Service ends. Sections 6, 8, 9, 10, 11, and 14 survive termination.</P>
          </Section>

          <Section title="14. Governing Law and Disputes">
            <P>These Terms are governed by the laws of the United States. Any disputes arising from these Terms or your use of the Service that cannot be resolved informally shall be submitted to binding arbitration under the rules of the American Arbitration Association, with proceedings conducted in English.</P>
            <P>Notwithstanding the above, either party may seek injunctive or equitable relief in a court of competent jurisdiction to protect intellectual property or confidential information.</P>
          </Section>

          <Section title="15. Changes to These Terms">
            <P>We may revise these Terms at any time. When we make material changes, we will notify active subscribers by email at least 14 days before the changes take effect. Your continued use of the Service after the effective date constitutes acceptance of the updated Terms.</P>
          </Section>

          <Section title="16. General">
            <ul className="list-disc pl-5 flex flex-col gap-2 text-sm leading-relaxed">
              <li><strong>Entire agreement:</strong> These Terms and any applicable subscription agreement or order form constitute the entire agreement between the parties regarding the Service.</li>
              <li><strong>Severability:</strong> If any provision of these Terms is held unenforceable, the remaining provisions continue in full force.</li>
              <li><strong>No waiver:</strong> Our failure to enforce any provision of these Terms shall not be construed as a waiver.</li>
              <li><strong>Assignment:</strong> You may not assign your rights under these Terms without our prior written consent. We may assign our rights in connection with a merger, acquisition, or sale of assets.</li>
            </ul>
          </Section>

          <Section title="17. Contact Us">
            <P>Questions about these Terms? Contact us at:</P>
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
          <button onClick={() => navigate("/privacy")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.25)" }}>Privacy Policy</button>
          <button onClick={() => navigate("/terms")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.35)" }}>Terms of Service</button>
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
