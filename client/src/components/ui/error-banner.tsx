// Re-export the existing QueryError component under the canonical
// "ErrorBanner" name in the shared UI folder so future pages can import
// the standard error treatment from one place. The underlying component
// still lives in client/src/components/query-error.tsx and is unchanged
// — this file just exposes the alias.
export { QueryError as ErrorBanner } from "@/components/query-error";
export type { } from "@/components/query-error";
