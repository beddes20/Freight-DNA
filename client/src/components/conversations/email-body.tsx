import { useRef, useState } from "react";
import { looksLikeHtml } from "./utils";

export function EmailBody({ body, testId }: { body: string | null; testId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(40);

  if (!body) return null;
  if (!looksLikeHtml(body)) {
    return (
      <div className="text-sm text-foreground whitespace-pre-wrap leading-snug" data-testid={testId}>
        {body.trim()}
      </div>
    );
  }
  const srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:13px;color:#0f172a;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word;}body>*:first-child{margin-top:0;}body>*:last-child{margin-bottom:0;}p{margin:0 0 6px;}img{max-width:100%;height:auto;}table{max-width:100%;}a{color:#2563eb;}div[style*="background-color:#FFD700"],div[style*="background-color: #FFD700"]{display:none;}</style></head><body>${body}</body></html>`;

  const handleLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const measured = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    setHeight(measured + 4);
  };

  return (
    <iframe
      ref={iframeRef}
      title="email-body"
      srcDoc={srcdoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      referrerPolicy="no-referrer"
      onLoad={handleLoad}
      className="w-full border-0 bg-transparent block"
      style={{ height: `${height}px` }}
      data-testid={testId}
    />
  );
}
