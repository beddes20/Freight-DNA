import { useLocation } from "wouter";

const EFFECTIVE_DATE = "March 29, 2026";
const COMPANY = "Freight-DNA, LLC";
const CONTACT_EMAIL = "info@freight-dna.com";
const WEBSITE = "freight-dna.com";

export default function PrivacyPage() {
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
        <h1 className="text-4xl font-extrabold mb-3 tracking-tight" style={{ letterSpacing: "-0.02em" }}>Privacy Policy</h1>
        <p className="text-sm mb-2" style={{ color: "rgba(255,255,255,0.35)" }}>Last updated: {EFFECTIVE_DATE}</p>
        <p className="text-sm mb-12 leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>
          {COMPANY} ("Freight‑DNA," "we," "us," or "our") provides a software-as-a-service platform that helps freight brokerages understand and grow their existing customer relationships (the "Service"). This Privacy Policy explains how we collect, use, and share information when you visit our website ({WEBSITE}) or use our Service, and the choices you have about that information.
        </p>
        <p className="text-sm mb-12 leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>
          By accessing our website or using the Service, you agree to the collection and use of information in accordance with this Privacy Policy.
        </p>

        <div className="flex flex-col gap-10" style={{ color: "rgba(255,255,255,0.7)" }}>

          <Section title="1. Information We Collect">
            <P>We collect information in three main ways: information you provide directly, information we obtain automatically, and information we receive from third parties.</P>

            <SubHeading>1.1 Information you provide to us</SubHeading>
            <BulletList items={[
              "Account and profile information (for example: name, business email, password, job title, company name).",
              'Contact information submitted through forms (for example: "Schedule a Demo," "Contact Us," or chat requests).',
              "Billing and payment information (for example: billing contact details, payment method details processed via our payment provider).",
              "Customer business data you upload into the Service, such as account lists, contacts, shipment history, sales activity, notes, and performance metrics relating to your customers and prospects.",
              "Communications with us, including emails, in-app messages, and support requests.",
            ]} />

            <SubHeading>1.2 Information collected automatically</SubHeading>
            <P>When you visit our website or use the Service, we may automatically collect:</P>
            <BulletList items={[
              "Usage data, such as pages viewed, features used, clicks, session duration, and referring URLs.",
              "Device and log data, such as IP address, browser type, operating system, and device identifiers.",
              "Cookies and similar technologies data, as described below.",
            ]} />

            <SubHeading>1.3 Cookies and similar technologies</SubHeading>
            <P>We use cookies and similar technologies to:</P>
            <BulletList items={[
              "Keep you signed in and maintain session security.",
              "Remember your preferences (for example, dark mode, language, or region).",
              "Understand how visitors and customers use our website and Service so we can improve them.",
            ]} />
            <P>You can control cookies through your browser settings, but disabling some cookies may limit the functionality of the website or Service.</P>

            <SubHeading>1.4 Information from third parties</SubHeading>
            <P>We may receive information about you from:</P>
            <BulletList items={[
              "Payment processors, for payment confirmation and fraud prevention.",
              "Email or calendar integration providers, if you connect them to the Service.",
              "Public business sources or third-party data providers, to help enrich customer account information at your direction.",
            ]} />

            <SubHeading>1.5 AI feature processing</SubHeading>
            <P>The Service includes AI-powered features (such as the DNA Guru chatbot, AI health narratives, and daily sales briefs) that transmit relevant portions of your Customer Data to third-party large language model providers (currently OpenAI) for processing. This may include account names, contact notes, freight lane data, and sales activity. Data transmitted for AI processing is subject to those providers' API data usage policies. We do not use your Customer Data to train AI models.</P>
          </Section>

          <Section title="2. How We Use Information">
            <P>We use the information we collect for the following purposes:</P>
            <BulletList items={[
              "To provide, operate, and maintain the Service for you and your organization.",
              "To create and manage user accounts and authenticate access.",
              "To process payments and manage subscriptions, including invoicing and collections.",
              "To personalize the Service, such as displaying relevant dashboards, reports, and recommendations.",
              "To communicate with you about the Service, including product updates, security alerts, and administrative messages.",
              "To provide customer support, troubleshoot issues, and respond to requests.",
              "To power AI-generated insights and recommendations when you use AI features.",
              "To monitor, analyze, and improve the performance, security, and usability of our website and Service.",
              "To comply with legal obligations and enforce our agreements.",
              "To protect our rights, our customers, and other users, including detecting and preventing fraud, abuse, or security incidents.",
            ]} />
            <P>We do not sell personal information in the common understanding of that term.</P>
          </Section>

          <Section title="3. Legal Bases for Processing (Where Applicable)">
            <P>Where privacy laws require a legal basis to process personal data (for example, in the European Economic Area or United Kingdom), we rely on:</P>
            <BulletList items={[
              "Performance of a contract, when we process information to provide the Service.",
              "Legitimate interests, such as improving the Service, enhancing security, and supporting customer relationships, where those interests are not overridden by your rights.",
              "Consent, where we rely on your consent (for example, for certain optional cookies or marketing communications).",
              "Compliance with legal obligations.",
            ]} />
          </Section>

          <Section title="4. How We Share Information">
            <P>We may share information in the following circumstances:</P>
            <BulletList items={[
              "Service providers and subprocessors: We use trusted third-party vendors to help us operate and deliver the Service (for example, hosting providers, payment processors, AI model providers, and email delivery services). They may only use your information as necessary to provide services to us and are contractually obligated to protect it.",
              "Within your organization: Information in your account may be shared with other authorized users within your company or organization, depending on your settings and role-based permissions.",
              "Business transfers: If Freight‑DNA, LLC is involved in a merger, acquisition, financing, or sale of all or part of its business, your information may be transferred as part of that transaction, subject to any applicable legal requirements.",
              "Legal and safety: We may share information if we believe in good faith that disclosure is reasonably necessary to comply with laws, regulations, or legal processes; to respond to lawful requests; or to protect the rights, property, or safety of Freight‑DNA, our customers, or others.",
              "With your consent: We may share information with third parties when you direct us to do so or give us your consent.",
            ]} />
            <P>We do not sell your personal information and we do not share it with third parties for their own independent marketing purposes.</P>
          </Section>

          <Section title="5. Data Retention">
            <P>We retain personal information for as long as reasonably necessary to provide the Service, comply with our legal obligations, resolve disputes, and enforce our agreements.</P>
            <P>Retention periods may vary depending on the type of data and the purposes for which we use it. We may also anonymize or aggregate information so that it no longer identifies you, in which case we may use it for legitimate business purposes without further notice to you.</P>
          </Section>

          <Section title="6. Your Rights and Choices">
            <P>Depending on your location and applicable law, you may have certain rights regarding your personal information, which can include:</P>
            <BulletList items={[
              "Accessing the personal information we hold about you.",
              "Requesting correction of inaccurate or incomplete information.",
              "Requesting deletion of some or all of your information (subject to certain exceptions).",
              "Objecting to or requesting restriction of certain processing.",
              "Withdrawing consent where we rely on consent.",
              "Porting your data to another service provider, where technically feasible.",
            ]} />
            <P>To exercise these rights, please contact us at <EmailLink />. We may need to verify your identity before completing your request and may not be able to fulfill certain requests where we have overriding legal or contractual obligations.</P>
            <P>If your account is provided by your employer or another organization, some requests may need to be routed through that organization, and we may be limited in our ability to respond directly.</P>
          </Section>

          <Section title="7. Security">
            <P>We use reasonable technical and organizational measures designed to protect personal information from unauthorized access, disclosure, alteration, or destruction. These measures may include encryption in transit, access controls, and regular monitoring for potential vulnerabilities.</P>
            <P>However, no method of transmission over the internet or method of electronic storage is completely secure, and we cannot guarantee absolute security. You are responsible for keeping your account credentials confidential and for notifying us promptly of any unauthorized use.</P>
          </Section>

          <Section title="8. International Transfers">
            <P>Our servers and service providers may be located in the United States and other jurisdictions. If you access the Service from outside the United States, your information may be transferred to, stored in, and processed in the United States or other countries that may have different data protection laws than your home jurisdiction.</P>
            <P>Where required by law, we will take appropriate steps to ensure that cross-border data transfers include appropriate safeguards.</P>
          </Section>

          <Section title="9. Children's Privacy">
            <P>Our website and Service are intended for business users and are not directed to children under 16. We do not knowingly collect personal information from children under 16. If we become aware that we have collected such information, we will take steps to delete it.</P>
          </Section>

          <Section title="10. Third-Party Links and Services">
            <P>Our website or Service may include links to third-party websites, services, or integrations. We do not control those third parties and are not responsible for their privacy practices. We encourage you to review the privacy policies of any third-party services you use.</P>
          </Section>

          <Section title="11. Changes to This Privacy Policy">
            <P>We may update this Privacy Policy from time to time. When we do, we will revise the "Last updated" date at the top and, if changes are material, we will provide additional notice (for example, by email or in-app notice). Your continued use of the website or Service after we post changes means you accept those changes.</P>
          </Section>

          <Section title="12. Contact Us">
            <P>If you have questions or concerns about this Privacy Policy or our data practices, please contact us at:</P>
            <ContactBox />
          </Section>

        </div>
      </main>

      <PageFooter />
    </div>
  );
}

function TermsPage_() { return null; }

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
        <button onClick={() => navigate("/privacy")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.35)" }}>Privacy Policy</button>
        <button onClick={() => navigate("/terms")} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.25)" }}>Terms of Service</button>
      </div>
      <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white transition-colors" style={{ color: "rgba(255,255,255,0.2)" }}>{CONTACT_EMAIL}</a>
    </footer>
  );
}
