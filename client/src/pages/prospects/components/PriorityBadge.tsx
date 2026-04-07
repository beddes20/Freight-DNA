import { Flame, Thermometer, Snowflake } from "lucide-react";

export function PriorityBadge({ priority }: { priority?: string | null }) {
  if (!priority) return null;
  if (priority === "hot") return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
      <Flame className="h-2.5 w-2.5" /> Hot
    </span>
  );
  if (priority === "warm") return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
      <Thermometer className="h-2.5 w-2.5" /> Warm
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
      <Snowflake className="h-2.5 w-2.5" /> Cold
    </span>
  );
}
