// Pure prefill helper for the Convert-to-quote dialog. Lifted into
// /lib so unit tests can import without dragging in React / wouter.

export interface ConvertToQuoteDefaults {
  customerId: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  quotedAmount: string;
  notes: string;
}

// Trims the most common quoted-reply prefixes so previous outbound
// rep mail doesn't bleed into the new opp's notes. Caps the combined
// header+body to 1900 chars to leave headroom under the 2000-char
// schema cap.
export function buildConvertToQuoteDefaults(
  threadSubject: string,
  latestInboundBody: string | null | undefined,
): ConvertToQuoteDefaults {
  const header = `Converted from email thread: ${threadSubject}`;
  const cleaned = (latestInboundBody ?? "")
    .split(/\n>+\s|\nOn .{0,40}wrote:|\nFrom: /m)[0]
    .replace(/\s+/g, " ")
    .trim();
  const body = cleaned ? `\n\nLatest inbound:\n${cleaned}` : "";
  return {
    customerId: "",
    originCity: "",
    originState: "",
    destCity: "",
    destState: "",
    equipment: "Dry Van",
    quotedAmount: "",
    notes: `${header}${body}`.slice(0, 1900),
  };
}
