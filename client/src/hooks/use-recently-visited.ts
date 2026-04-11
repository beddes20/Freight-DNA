import { useState, useCallback, useEffect } from "react";

export interface RecentlyVisitedEntry {
  companyId: string;
  name: string;
  momentumLabel?: string;
  visitedAt: number;
}

const MAX_ENTRIES = 8;

function storageKey(userId: string) {
  return `recentlyVisited_v1_${userId}`;
}

function readList(userId: string): RecentlyVisitedEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    return JSON.parse(raw) as RecentlyVisitedEntry[];
  } catch {
    return [];
  }
}

function writeList(userId: string, list: RecentlyVisitedEntry[]) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function trackCompanyVisit(userId: string, entry: Omit<RecentlyVisitedEntry, "visitedAt">) {
  const list = readList(userId);
  const filtered = list.filter(e => e.companyId !== entry.companyId);
  const next: RecentlyVisitedEntry[] = [{ ...entry, visitedAt: Date.now() }, ...filtered].slice(0, MAX_ENTRIES);
  writeList(userId, next);
}

export function getRecentlyVisited(userId: string): RecentlyVisitedEntry[] {
  return readList(userId);
}

export function useRecentlyVisited(userId: string | undefined) {
  const [entries, setEntries] = useState<RecentlyVisitedEntry[]>(() => {
    if (!userId) return [];
    return readList(userId);
  });

  useEffect(() => {
    if (!userId) return;
    setEntries(readList(userId));
  }, [userId]);

  const trackVisit = useCallback((entry: Omit<RecentlyVisitedEntry, "visitedAt">) => {
    if (!userId) return;
    trackCompanyVisit(userId, entry);
    setEntries(readList(userId));
  }, [userId]);

  return { entries, trackVisit };
}
