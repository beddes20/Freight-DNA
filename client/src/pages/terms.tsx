import { useLocation } from "wouter";

const EFFECTIVE_DATE = "March 29, 2026";
const COMPANY = "Freight-DNA, LLC";
const CONTACT_EMAIL = "info@freight-dna.com";
const WEBSITE = "freight-dna.com";

export default function TermsPage() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#0a0a0a", color: "#fff" }}>
      <header
        className="w-full flex items-center justify-between px-6 md:px-12 py-4 sticky top-0 z-40"
        style={{ borderBottom: "1px solid rgba(255,180,0,0.1)", background: "rgba(10,10,10,0.95)", backdropFilter: "blur(8px)" }}
      >
        <button onClick={() => navigate("/")} className="flex flex-col gap-0.5 transition-opacity hover:opacity-80">
          <span className="text-sm font-bold tracking-tight" style={{ color: "#ffb400", letterSpacing: "-0.01em" }}>freight · dna</span>
          <span className="text-[9px] uppercase tracking-[0.2em] font-semibold" style={{ color: "rgba(255,180,0,0.45)" }}>DNA · Down Not Across</span>
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

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-16">
        <p className="text-xs uppercase tracking-[0.22em] font-semibold mb-4" style={{ color: "rgba(255,180,0,0.65)" }}>Legal</p>
        <h1 className="text-4xl font-extrabold mb-3 tracking-tight" style={{ letterSpacing: "-0.02em" }}>Terms of Service</h1>
        <p className="text-sm mb-2" style={{ color: "rgba(255,255,255,0.35)" }}>Last updated: {EFFECTIVE_DATE}</p>
        <p className="text-sm mb-12 leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>
          These Terms of Service ("Terms") govern your access to and use of the {COMPANY} website at {WEBSITE} and the Freight‑DNA software-as-a-service platform (collectively, the "Service"). By creating an account, clicking "I agree," or using the Service, you agree to be bound by these Terms on behalf of yourself and the organization you represent ("Customer," "you," or "your"). If you do not agree to these Terms, do not use the Service.
        </p>

        <div className="flex flex-col gap-10" style={{ color: "rgba(255,255,255,0.7)" }}>

          <Section title="1. Eligibility and Accounts">
            <SubHeading>1.1 Business use</SubHeading>
            <P>The Service is intended for use by businesses, not consumers. By using the Service, you represent that you are acting for business purposes and have authority to bind the organization you represent.</P>

            <SubHeading>1.2 Account registration</SubHeading>
            <P>You must provide accurate, current, and complete information when creating an account and keep it up to date. You are responsible for all activities that occur under your accounts and for keeping your passwords and access credentials secure.</P>

            <SubHeading>1.3 Authorized users</SubHeading>
            <P>You may permit your employees, contractors, or other authorized individuals to use the Service under your account ("Authorized Users") in accordance with these Terms. You are responsible for their use of the Service and for ensuring they comply with these Terms.</P>
          </Section>

          <Section title="2. Access to the Service">
            <SubHeading>2.1 License grant</SubHeading>
            <P>Subject to these Terms and timely payment of all applicable fees, Freight‑DNA grants you a limited, non-exclusive, non-transferable, non-sublicensable right to access and use the Service for your internal business purposes during the subscription term.</P>

            <SubHeading>2.2 Service modifications</SubHeading>
            <P>We may update, enhance, or modify the Service from time to time, including adding or removing features, provided that we do not materially reduce the core functionality of the Service you have purchased during your current subscription term.</P>

            <SubHeading>2.3 Availability</SubHeading>
            <P>We use reasonable efforts to keep the Service available and performing, but we do not guarantee uninterrupted or error-free operation. The Service may be temporarily unavailable for maintenance, upgrades, or unplanned outages.</P>
          </Section>

          <Section title="3. Fees and Payment">
            <SubHeading>3.1 Fees</SubHeading>
            <P>You agree to pay all fees specified in your order, subscription, or plan selection ("Fees"). Fees may be based on metrics such as number of users, features, usage, or subscription tier. Unless otherwise stated, Fees are quoted and payable in U.S. dollars.</P>

            <SubHeading>3.2 Trial period</SubHeading>
            <P>We offer a trial period for an agreed-upon fee (the "Trial Fee"). If you elect to continue as a paying subscriber after your trial, the Trial Fee will be applied as a credit toward your first annual or monthly subscription payment. The Trial Fee is non-refundable if you elect not to continue.</P>

            <SubHeading>3.3 Billing and taxes</SubHeading>
            <P>You authorize us or our payment processor to charge your designated payment method for all Fees when due. You are responsible for all applicable taxes, duties, and similar charges (excluding taxes based on our income), which will be added to your invoices as required by law.</P>

            <SubHeading>3.4 Late payments</SubHeading>
            <P>If any unpaid amount is overdue, we may charge interest at the lesser of 1.5% per month or the maximum allowed by law and may suspend your access to the Service after reasonable notice until all amounts are paid.</P>

            <SubHeading>3.5 Refunds</SubHeading>
            <P>Monthly subscriptions may be canceled at any time; you will retain access through the end of the billing period with no refund for the unused portion. Annual subscriptions canceled within the first 30 days will receive a pro-rated refund for unused months. After 30 days, annual subscriptions are non-refundable.</P>
          </Section>

          <Section title="4. Customer Data">
            <SubHeading>4.1 Ownership of Customer Data</SubHeading>
            <P>You retain all rights, title, and interest in and to the data, content, and information you or your Authorized Users submit to the Service ("Customer Data"). Freight‑DNA does not claim ownership of Customer Data.</P>

            <SubHeading>4.2 License to use Customer Data</SubHeading>
            <P>You grant Freight‑DNA a non-exclusive, worldwide, royalty-free license to host, copy, process, transmit, and display Customer Data as reasonably necessary to provide the Service, maintain and improve the Service, and comply with law.</P>

            <SubHeading>4.3 Aggregated and anonymized data</SubHeading>
            <P>We may derive and use aggregated or anonymized data that does not identify you or any individual, for purposes such as analytics, benchmarking, and improving the Service.</P>

            <SubHeading>4.4 Data protection and security</SubHeading>
            <P>We will implement reasonable technical and organizational measures to protect Customer Data, consistent with industry standards and our Privacy Policy.</P>
          </Section>

          <Section title="5. Acceptable Use">
            <P>You agree not to, and not to allow any third party to:</P>
            <BulletList items={[
              "Use the Service in violation of any applicable law or regulation, including data privacy, export control, or anti-spam laws.",
              "Use the Service to store, transmit, or process unlawful content or content that infringes any third party's intellectual property, privacy, or other rights.",
              "Attempt to gain unauthorized access to the Service or any related systems or networks.",
              "Interfere with or disrupt the integrity or performance of the Service.",
              "Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code of the Service (except to the extent such restriction is prohibited by law).",
              "Circumvent or remove any access controls, rate limits, or security measures.",
              "Use the Service to build a competing product or service or to benchmark the Service in a way that is not permitted by law or an applicable agreement.",
            ]} />
            <P>We may suspend or terminate access to the Service, in whole or in part, if we reasonably believe that a user has violated this Section or is using the Service in a way that poses a security or legal risk.</P>
          </Section>

          <Section title="6. AI-Powered Features">
            <SubHeading>6.1 How AI features work</SubHeading>
            <P>The Service includes AI-powered features — including the DNA Guru chatbot, AI health narratives, daily sales briefs, lane gap insights, and AI-assisted column mapping — that use third-party large language model providers (currently OpenAI) to generate text and insights based on your Customer Data. When you use these features, relevant data is transmitted to those providers.</P>

            <SubHeading>6.2 AI output disclaimer</SubHeading>
            <P>AI-generated content is provided for sales assistance and informational purposes only. It is not guaranteed to be accurate, complete, or current. You are responsible for independently verifying any AI-generated content before acting on it. The Service does not provide legal, tax, accounting, insurance, customs, or compliance advice, and you should consult qualified professionals for such matters.</P>

            <SubHeading>6.3 Sensitive data</SubHeading>
            <P>Do not enter sensitive personal information, protected health information, government-issued identification numbers, or classified data into AI-powered features.</P>

            <SubHeading>6.4 Availability</SubHeading>
            <P>AI features depend on third-party providers and may be unavailable during periods of provider outage or service disruption. We are not liable for interruptions to AI features caused by third-party provider downtime.</P>
          </Section>

          <Section title="7. Intellectual Property">
            <SubHeading>7.1 Freight‑DNA IP</SubHeading>
            <P>Freight‑DNA and its licensors own all rights, title, and interest in and to the Service, including all software, technology, user interfaces, designs, compilations, and associated intellectual property rights ("Freight‑DNA IP"). Except for the limited rights expressly granted in these Terms, no rights are granted to you and all such rights are reserved by Freight‑DNA and its licensors.</P>

            <SubHeading>7.2 Feedback</SubHeading>
            <P>If you provide feedback, suggestions, or ideas about the Service ("Feedback"), you agree that Freight‑DNA may use the Feedback without restriction or obligation to you, and you hereby assign all rights in the Feedback to Freight‑DNA to the extent permitted by law.</P>
          </Section>

          <Section title="8. Confidentiality">
            <SubHeading>8.1 Definition</SubHeading>
            <P>"Confidential Information" means non-public information disclosed by one party to the other that is designated as confidential or that reasonably should be understood to be confidential given the nature of the information and the circumstances of disclosure, including Customer Data, product roadmaps, pricing, and business plans.</P>

            <SubHeading>8.2 Obligations</SubHeading>
            <P>Each party agrees to use the other party's Confidential Information only as necessary to perform its obligations under these Terms and to protect such information using at least reasonable care. Confidential Information may be shared with employees, contractors, or advisors who need to know it and are bound by confidentiality obligations.</P>

            <SubHeading>8.3 Exclusions</SubHeading>
            <P>Confidential Information does not include information that: (a) is or becomes publicly available without breach of these Terms; (b) was lawfully known to the receiving party before disclosure; (c) is received from a third party without restriction; or (d) is independently developed without use of the disclosing party's Confidential Information.</P>

            <SubHeading>8.4 Required disclosure</SubHeading>
            <P>A party may disclose Confidential Information when required by law or legal process, provided it gives reasonable notice (if legally permitted) to the other party to seek protective measures.</P>
          </Section>

          <Section title="9. Disclaimers">
            <P>The Service is provided "as is" and "as available" without warranties of any kind, whether express, implied, or statutory. Freight‑DNA expressly disclaims all implied warranties, including warranties of merchantability, fitness for a particular purpose, title, and non-infringement.</P>
            <P>Without limiting the foregoing, Freight‑DNA does not warrant that the Service will meet your requirements, be compatible with any particular system, operate without interruption or error, or produce any particular business results or revenue. You are responsible for how you use the insights and data provided by the Service in running your freight brokerage or other business.</P>
            <P>The Service does not provide legal, tax, accounting, insurance, customs, or compliance advice, and you should consult qualified professionals for such matters.</P>
          </Section>

          <Section title="10. Limitation of Liability">
            <P>To the maximum extent permitted by law:</P>
            <BulletList items={[
              "In no event will Freight‑DNA be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages (including lost profits, lost revenue, lost data, or business interruption), arising out of or in connection with the Service or these Terms, even if advised of the possibility of such damages.",
              "Freight‑DNA's total aggregate liability for all claims arising out of or relating to the Service or these Terms will not exceed the amount you actually paid to Freight‑DNA for the Service during the twelve (12) months immediately preceding the event giving rise to the claim.",
            ]} />
            <P>Some jurisdictions do not allow certain limitations of liability, so some of the above limitations may not apply to you. In such cases, Freight‑DNA's liability will be limited to the fullest extent permitted by applicable law.</P>
          </Section>

          <Section title="11. Indemnification">
            <P>You agree to indemnify, defend, and hold harmless Freight‑DNA, its officers, directors, employees, and agents from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or related to:</P>
            <BulletList items={[
              "Your use of the Service in violation of these Terms or applicable law.",
              "Customer Data, including any allegation that Customer Data infringes or misappropriates the rights of a third party or violates applicable law.",
              "Any dispute between you and a third party relating to your use of the Service or your freight brokerage or related services.",
            ]} />
          </Section>

          <Section title="12. Term, Suspension, and Termination">
            <SubHeading>12.1 Term</SubHeading>
            <P>These Terms begin when you first access the Service and continue for as long as you have an account or continue to use the Service, unless terminated earlier in accordance with this Section.</P>

            <SubHeading>12.2 Termination by you</SubHeading>
            <P>You may stop using the Service at any time. If your subscription includes a committed term, cancellation will be effective at the end of the then-current term, unless otherwise specified in your order.</P>

            <SubHeading>12.3 Termination or suspension by Freight‑DNA</SubHeading>
            <P>We may suspend or terminate your access to the Service, in whole or in part, upon notice if:</P>
            <BulletList items={[
              "You materially breach these Terms and fail to cure the breach within a reasonable time after receiving notice.",
              "You fail to pay any undisputed Fees when due and do not cure within a reasonable time.",
              "We reasonably believe your use of the Service poses a security risk, violates law, or could harm other users or third parties.",
            ]} />

            <SubHeading>12.4 Effect of termination</SubHeading>
            <P>Upon termination or expiration of your subscription:</P>
            <BulletList items={[
              "Your right to access and use the Service will cease.",
              "We may delete or deactivate your account and related data in accordance with our data retention practices and applicable law.",
              "You remain responsible for all Fees incurred up to the effective date of termination.",
            ]} />
            <P>Upon request made within thirty (30) days after termination or expiration, we will make Customer Data available for export in a commercially reasonable format. After that period, we may delete Customer Data, subject to any legal obligations to retain it.</P>
          </Section>

          <Section title="13. Governing Law and Jurisdiction">
            <P>These Terms and any disputes arising out of or relating to them or the Service will be governed by and construed in accordance with the laws of the United States, without regard to conflict of law principles.</P>
            <P>The parties agree to submit to the jurisdiction of the federal and state courts of the United States for resolution of any dispute arising out of or relating to these Terms or the Service.</P>
          </Section>

          <Section title="14. Changes to These Terms">
            <P>We may update these Terms from time to time. If we make material changes, we will provide notice (for example, by email, in-app notification, or posting an updated version on our website) before the changes take effect. Your continued use of the Service after the effective date of updated Terms constitutes your acceptance of the changes.</P>
          </Section>

          <Section title="15. Miscellaneous">
            <BulletList items={[
              "Entire agreement: These Terms, together with any order forms or supplemental agreements you enter into with Freight‑DNA, constitute the entire agreement between you and Freight‑DNA regarding the Service and supersede any prior or contemporaneous agreements on the subject.",
              "Order of precedence: If there is a conflict between these Terms and an executed written agreement between you and Freight‑DNA, the executed agreement will control to the extent of the conflict.",
              "Assignment: You may not assign or transfer these Terms or your rights or obligations under them without our prior written consent, and any attempted assignment without consent is void. We may assign these Terms in connection with a merger, acquisition, or sale of all or substantially all of our assets.",
              "Independent contractors: The parties are independent contractors, and these Terms do not create any partnership, joint venture, or agency relationship.",
              "Force majeure: We will not be liable for any delay or failure to perform due to events beyond our reasonable control, such as acts of God, natural disasters, war, terrorism, labor disputes, or internet failures.",
              "Severability: If any provision of these Terms is held invalid or unenforceable, the remaining provisions will remain in full force and effect.",
              "Waiver: Our failure to enforce any provision of these Terms does not constitute a waiver of that provision or any other provision.",
              "Notices: Official notices to Freight‑DNA must be sent to info@freight-dna.com. We may send notices to you via email, in-app notifications, or by posting on our website.",
            ]} />
          </Section>

          <Section title="16. Contact Us">
            <P>Questions about these Terms? Contact us at:</P>
            <ContactBox />
          </Section>

        </div>
      </main>

      <PageFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-bold tracking-tight" style={{ color: "#fff", letterSpacing: "-0.01em" }}>{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-semibold mt-2 mb-0.5" style={{ color: "rgba(255,180,0,0.8)" }}>{children}</p>;
}

function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-sm leading-relaxed ${className}`}>{children}</p>;
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 flex flex-col gap-2">
      {items.map((item, i) => <li key={i} className="text-sm leading-relaxed">{item}</li>)}
    </ul>
  );
}

function EmailLink() {
  return <a href={`mailto:${CONTACT_EMAIL}`} className="hover:opacity-80 transition-opacity" style={{ color: "#ffc333" }}>{CONTACT_EMAIL}</a>;
}

function ContactBox() {
  return (
    <div className="mt-2 text-sm p-4 rounded-lg" style={{ background: "#0f0f0f", border: "1px solid rgba(255,180,0,0.15)" }}>
      <p className="font-semibold mb-1" style={{ color: "#ffc333" }}>{COMPANY}</p>
      <p>Email: <EmailLink /></p>
      <p>Website: <a href={`https://${WEBSITE}`} className="hover:opacity-80 transition-opacity" style={{ color: "#ffc333" }}>{WEBSITE}</a></p>
    </div>
  );
}

function PageFooter() {
  const [, navigate] = useLocation();
  return (
    <footer
      className="w-full flex flex-col sm:flex-row items-center justify-between gap-3 px-6 md:px-12 py-5 text-xs"
      style={{ borderTop: "1px solid rgba(255,180,0,0.1)", color: "rgba(255,255,255,0.2)" }}
    >
      <span>freight · dna</span>
      <div className="flex items-center gap-5">
        <button onClick={() => navigate("/privacy")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.25)" }}>Privacy Policy</button>
        <button onClick={() => navigate("/terms")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.35)" }}>Terms of Service</button>
      </div>
      <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.2)" }}>{CONTACT_EMAIL}</a>
    </footer>
  );
}
