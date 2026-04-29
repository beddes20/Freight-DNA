import { useEffect, useMemo, useRef, useState } from "react";
import { looksLikeHtml } from "./utils";

// Theme tokens mirrored into the iframe so rendered emails blend with the
// host palette in dark and light mode. Stored as HSL value-only strings.
const THEME_VARS = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "border",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
] as const;

type ThemeVars = Record<(typeof THEME_VARS)[number], string>;

const DEFAULT_LIGHT_VARS: ThemeVars = {
  background: "210 20% 98%",
  foreground: "222 47% 11%",
  muted: "210 20% 96%",
  "muted-foreground": "215 19% 38%",
  border: "214 20% 88%",
  card: "0 0% 100%",
  "card-foreground": "222 47% 11%",
  primary: "43 100% 50%",
  "primary-foreground": "0 0% 5%",
};

function readThemeVars(): ThemeVars {
  if (typeof window === "undefined") return DEFAULT_LIGHT_VARS;
  const styles = getComputedStyle(document.documentElement);
  const out = { ...DEFAULT_LIGHT_VARS };
  for (const v of THEME_VARS) {
    const raw = styles.getPropertyValue(`--${v}`).trim();
    if (raw) (out as Record<string, string>)[v] = raw;
  }
  return out;
}

// Re-renders when the root `dark` class flips so we can re-push CSS vars
// into the iframe without forcing a srcdoc reload.
function useThemeRevision(): number {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = document.documentElement;
    const obs = new MutationObserver(() => setRev((r) => r + 1));
    obs.observe(target, { attributes: true, attributeFilter: ["class", "style"] });
    return () => obs.disconnect();
  }, []);
  return rev;
}

const HTML_QUOTE_SELECTORS = [
  ".OutlookMessageHeader",
  "#OLK_SRC_BODY_SECTION",
  ".gmail_quote",
  "[id^='divRplyFwdMsg']",
  "#divRplyFwdMsg",
  ".moz-cite-prefix",
  "#reply-intro",
];

// Splits an HTML body into the new content vs. the quoted-reply tail. If we
// can't find a confident boundary the whole body renders inline.
function splitHtmlAtQuotedBoundary(html: string): { main: string; quoted: string | null } {
  if (typeof document === "undefined") return { main: html, quoted: null };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return { main: html, quoted: null };
  }
  const container = doc.body;
  if (!container) return { main: html, quoted: null };

  let boundary: Element | null = null;
  for (const sel of HTML_QUOTE_SELECTORS) {
    const el = container.querySelector(sel);
    if (el) {
      boundary = el;
      break;
    }
  }

  // Fallback: a node whose visible text starts with "From: …" AND contains
  // both Sent/Date and Subject markers (avoids tripping on signatures).
  if (!boundary) {
    const candidates = container.querySelectorAll("div, p, span");
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const text = (el.textContent || "").replace(/\u00a0/g, " ").trim();
      if (!/^\s*From:\s+\S/i.test(text)) continue;
      if (!/\b(Sent|Date):\s+/i.test(text)) continue;
      if (!/\bSubject:\s*/i.test(text)) continue;
      boundary = el;
      break;
    }
  }

  if (!boundary) return { main: html, quoted: null };

  let topLevel: Element = boundary;
  while (topLevel.parentElement && topLevel.parentElement !== container) {
    topLevel = topLevel.parentElement;
  }

  const mainEl = document.createElement("div");
  const quotedEl = document.createElement("div");
  let crossed = false;
  for (const child of Array.from(container.childNodes)) {
    if (child === topLevel) crossed = true;
    (crossed ? quotedEl : mainEl).appendChild(child.cloneNode(true));
  }

  const mainHtml = mainEl.innerHTML.trim();
  const quotedHtml = quotedEl.innerHTML.trim();
  if (!mainHtml || !quotedHtml) return { main: html, quoted: null };
  return { main: mainHtml, quoted: quotedHtml };
}

function splitTextAtQuotedBoundary(text: string): { main: string; quoted: string | null } {
  const lines = text.split(/\r?\n/);

  for (let i = 1; i < lines.length; i++) {
    if (!/^\s*From:\s+\S/i.test(lines[i])) continue;
    const window = lines.slice(i, i + 6).join("\n");
    if (!/\b(Sent|Date):\s+/i.test(window)) continue;
    if (!/\bSubject:\s*/i.test(window)) continue;
    const main = lines.slice(0, i).join("\n").replace(/\s+$/g, "");
    const quoted = lines.slice(i).join("\n");
    if (main.trim() && quoted.trim()) return { main, quoted };
  }

  // RFC 3676 ">"-prefixed inline quoting.
  const quoteIdx = lines.findIndex((l) => /^\s*>+\s?/.test(l));
  if (quoteIdx > 0) {
    const main = lines.slice(0, quoteIdx).join("\n").replace(/\s+$/g, "");
    const quoted = lines.slice(quoteIdx).join("\n");
    if (main.trim() && quoted.trim()) return { main, quoted };
  }

  return { main: text, quoted: null };
}

// `!important` overrides on `#emailroot` block inline carrier styles from
// punching white panels through the dark theme.
const IFRAME_BASE_CSS = `
  :root { color-scheme: light dark; }
  html, body {
    margin: 0;
    padding: 0;
    background: hsl(var(--card));
    color: hsl(var(--card-foreground));
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13.5px;
    line-height: 1.55;
    word-wrap: break-word;
    overflow-wrap: break-word;
    overflow-x: hidden;
  }
  #emailroot, #emailroot * {
    background-color: transparent !important;
    color: hsl(var(--card-foreground)) !important;
    border-color: hsl(var(--border)) !important;
    font-family: inherit !important;
  }
  #emailroot p, #emailroot div, #emailroot span, #emailroot li, #emailroot td, #emailroot th {
    font-size: 13.5px !important;
    line-height: 1.55 !important;
  }
  #emailroot h1 { font-size: 1.4em !important; }
  #emailroot h2 { font-size: 1.25em !important; }
  #emailroot h3 { font-size: 1.1em !important; }
  #emailroot h1, #emailroot h2, #emailroot h3, #emailroot h4 {
    line-height: 1.3 !important;
    margin: 14px 0 6px !important;
    font-weight: 600 !important;
  }
  #emailroot p { margin: 0 0 8px !important; }
  #emailroot > *:first-child { margin-top: 0 !important; }
  #emailroot > *:last-child { margin-bottom: 0 !important; }
  #emailroot a, #emailroot a * {
    color: hsl(var(--primary)) !important;
    text-decoration: none !important;
  }
  #emailroot a:hover { text-decoration: underline !important; }
  #emailroot strong, #emailroot b { font-weight: 600 !important; }
  #emailroot img {
    max-width: 100% !important;
    height: auto !important;
    background: transparent !important;
  }
  #emailroot table {
    max-width: 100% !important;
    border-collapse: collapse !important;
    margin: 6px 0 !important;
  }
  #emailroot table, #emailroot th, #emailroot td {
    border: 1px solid hsl(var(--border)) !important;
  }
  #emailroot th, #emailroot td {
    padding: 6px 10px !important;
    vertical-align: top !important;
  }
  #emailroot th {
    background: hsl(var(--muted)) !important;
    color: hsl(var(--card-foreground)) !important;
    font-weight: 600 !important;
    text-align: left !important;
  }
  #emailroot blockquote {
    margin: 8px 0 !important;
    padding: 4px 0 4px 12px !important;
    border-left: 3px solid hsl(var(--border)) !important;
    color: hsl(var(--muted-foreground)) !important;
    background: transparent !important;
  }
  #emailroot ul, #emailroot ol { margin: 4px 0 8px 24px !important; padding: 0 !important; }
  #emailroot li { margin: 2px 0 !important; }
  #emailroot pre, #emailroot code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important;
    background: hsl(var(--muted)) !important;
    color: hsl(var(--card-foreground)) !important;
    border-radius: 4px !important;
    padding: 1px 4px !important;
  }
  #emailroot pre { padding: 8px 10px !important; overflow-x: auto !important; }
  #emailroot hr {
    border: none !important;
    border-top: 1px solid hsl(var(--border)) !important;
    margin: 10px 0 !important;
  }
  details.quoted-toggle {
    margin-top: 14px !important;
    border-top: 1px solid hsl(var(--border)) !important;
    padding-top: 10px !important;
  }
  details.quoted-toggle > summary {
    list-style: none !important;
    cursor: pointer !important;
    color: hsl(var(--muted-foreground)) !important;
    font-size: 12px !important;
    padding: 4px 10px !important;
    border: 1px solid hsl(var(--border)) !important;
    border-radius: 6px !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 6px !important;
    user-select: none !important;
    background: hsl(var(--muted)) !important;
  }
  details.quoted-toggle > summary:hover { color: hsl(var(--foreground)) !important; }
  details.quoted-toggle > summary::-webkit-details-marker { display: none !important; }
  details.quoted-toggle > summary::before {
    content: "▸";
    font-size: 10px;
    line-height: 1;
  }
  details.quoted-toggle[open] > summary::before { content: "▾"; }
  details.quoted-toggle .quoted-body {
    margin-top: 10px !important;
    padding: 10px 12px !important;
    border: 1px solid hsl(var(--border)) !important;
    border-radius: 6px !important;
    background: hsl(var(--muted)) !important;
  }
  div[style*="background-color:#FFD700"], div[style*="background-color: #FFD700"] {
    display: none !important;
  }
`;

function buildSrcdoc(main: string, quoted: string | null, vars: ThemeVars): string {
  const varsBlock = `:root{${THEME_VARS.map((k) => `--${k}:${vars[k]};`).join("")}}`;
  const quotedBlock = quoted
    ? `<details class="quoted-toggle"><summary>Show original message</summary><div class="quoted-body">${quoted}</div></details>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>${varsBlock}${IFRAME_BASE_CSS}</style></head><body><div id="emailroot">${main}${quotedBlock}</div></body></html>`;
}

export function EmailBody({ body, testId }: { body: string | null; testId: string }) {
  const themeRev = useThemeRevision();
  if (!body) return null;
  if (!looksLikeHtml(body)) {
    return <PlainTextBody body={body} testId={testId} />;
  }
  return <HtmlBody body={body} testId={testId} themeRev={themeRev} />;
}

function HtmlBody({
  body,
  testId,
  themeRev,
}: {
  body: string;
  testId: string;
  themeRev: number;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);

  const split = useMemo(() => splitHtmlAtQuotedBoundary(body), [body]);

  // srcdoc deliberately ignores theme changes — we push CSS vars via
  // setProperty below so dark/light toggles don't reload the iframe.
  const srcdoc = useMemo(
    () => buildSrcdoc(split.main, split.quoted, DEFAULT_LIGHT_VARS),
    [split.main, split.quoted],
  );

  const measure = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const measured = Math.max(
      doc.documentElement.scrollHeight,
      doc.body.scrollHeight,
      doc.body.getBoundingClientRect().height,
    );
    setHeight(measured + 8);
  };

  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const root = doc.documentElement;
    const vars = readThemeVars();
    for (const k of THEME_VARS) {
      root.style.setProperty(`--${k}`, vars[k]);
    }
  }, [themeRev, srcdoc]);

  // `<details>` toggle events don't bubble, so listen with capture=true.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const onToggle = () => requestAnimationFrame(measure);
    doc.addEventListener("toggle", onToggle, true);
    return () => doc.removeEventListener("toggle", onToggle, true);
  }, [srcdoc]);

  return (
    <iframe
      ref={iframeRef}
      title="email-body"
      srcDoc={srcdoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      referrerPolicy="no-referrer"
      onLoad={measure}
      className="w-full border-0 bg-transparent block"
      style={{ height: `${height}px` }}
      data-testid={testId}
    />
  );
}

function PlainTextBody({ body, testId }: { body: string; testId: string }) {
  const trimmed = body.replace(/^\s+|\s+$/g, "");
  const split = useMemo(() => splitTextAtQuotedBoundary(trimmed), [trimmed]);
  const [showQuoted, setShowQuoted] = useState(false);

  return (
    <div className="text-[13.5px] text-card-foreground leading-relaxed" data-testid={testId}>
      <div className="whitespace-pre-wrap break-words">{split.main || trimmed}</div>
      {split.quoted && (
        <div className="mt-3 pt-3 border-t border-border">
          <button
            type="button"
            onClick={() => setShowQuoted((s) => !s)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground bg-muted border border-border rounded-md px-2 py-1"
            data-testid={`${testId}-toggle-quoted`}
            aria-expanded={showQuoted}
          >
            <span aria-hidden>{showQuoted ? "▾" : "▸"}</span>
            {showQuoted ? "Hide original message" : "Show original message"}
          </button>
          {showQuoted && (
            <div className="whitespace-pre-wrap break-words mt-3 p-3 rounded-md border border-border bg-muted text-card-foreground">
              {split.quoted}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
