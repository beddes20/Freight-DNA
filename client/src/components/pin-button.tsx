import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePinnedCompanies } from "@/hooks/use-pinned-companies";

interface PinButtonProps {
  companyId: string;
  className?: string;
  size?: "sm" | "default";
}

export function PinButton({ companyId, className, size = "sm" }: PinButtonProps) {
  const { isPinned, togglePin, pinMutation, unpinMutation } = usePinnedCompanies();
  const pinned = isPinned(companyId);
  const isPending = pinMutation.isPending || unpinMutation.isPending;

  return (
    <Button
      variant="ghost"
      size={size}
      className={cn(
        "h-7 w-7 p-0 rounded-full transition-colors",
        pinned
          ? "text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30"
          : "text-muted-foreground hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30",
        className,
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isPending) togglePin(companyId);
      }}
      title={pinned ? "Unpin account" : "Pin account"}
      data-testid={`button-pin-company-${companyId}`}
      aria-label={pinned ? "Unpin account" : "Pin account"}
    >
      <Star
        className={cn("h-3.5 w-3.5", pinned ? "fill-amber-500" : "fill-none")}
      />
    </Button>
  );
}
