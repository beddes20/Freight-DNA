// Task #873 — client-side mirror of server/laneCrossLinkService#laneSig.
//
// Single source of truth for building Lane Story URLs from any surface
// (Available Freight, LWQ, Today queue, Switchboard) so a stray casing
// or trim difference can't silently break a deep link.

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

export function laneSig(
  origin: string | null | undefined,
  originState: string | null | undefined,
  destination: string | null | undefined,
  destinationState: string | null | undefined,
  equipmentType: string | null | undefined,
): string {
  return [
    norm(origin),
    norm(originState),
    norm(destination),
    norm(destinationState),
    norm(equipmentType),
  ].join("|");
}

export function laneStoryHref(
  origin: string | null | undefined,
  originState: string | null | undefined,
  destination: string | null | undefined,
  destinationState: string | null | undefined,
  equipmentType: string | null | undefined,
): string {
  return `/lanes/story/${encodeURIComponent(laneSig(origin, originState, destination, destinationState, equipmentType))}`;
}
