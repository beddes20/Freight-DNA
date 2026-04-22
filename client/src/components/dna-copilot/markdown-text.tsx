/**
 * Tiny markdown renderer used by the DNA Copilot message bubbles.
 * Supports bullets (`- ` / `• `), bold lines (`**text**`), and blank lines.
 */
export function MarkdownText({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="text-sm leading-relaxed space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith("- ") || line.startsWith("• ")) {
          return (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 mt-0.5">•</span>
              <span>{line.replace(/^[-•]\s/, "")}</span>
            </div>
          );
        }
        if (line.startsWith("**") && line.endsWith("**")) {
          return <p key={i} className="font-semibold">{line.replace(/\*\*/g, "")}</p>;
        }
        if (line === "") return <div key={i} className="h-1" />;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}
