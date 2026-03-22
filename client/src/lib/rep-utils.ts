export function matchRepName(repName: string, userName: string): boolean {
  const a = repName.toLowerCase().trim();
  const b = userName.toLowerCase().trim();
  if (a === b) return true;
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  if (aParts.length === 1 && aParts[0].length > 1) {
    return bParts.some(p => p.startsWith(aParts[0]) || aParts[0].startsWith(p));
  }
  return aParts.some(p => p.length > 1 && bParts.includes(p));
}
