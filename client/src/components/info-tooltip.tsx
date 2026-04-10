import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface InfoTooltipProps {
  /** Simple one-line description (used alone or as a subtitle under title) */
  text?: string;
  /** Optional bold heading shown at the top of the tooltip */
  title?: string;
  /** Optional bullet-point list of detail lines */
  items?: string[];
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  /** Wider tooltip for longer content (max-w-[340px] instead of 260px) */
  wide?: boolean;
  /** Custom icon size override */
  iconSize?: string;
}

export function InfoTooltip({
  text,
  title,
  items,
  className = "",
  side = "top",
  wide = false,
  iconSize = "h-3.5 w-3.5",
}: InfoTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex cursor-help text-muted-foreground/50 hover:text-muted-foreground transition-colors ${className}`}>
          <HelpCircle className={iconSize} />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={`${wide ? "max-w-[340px]" : "max-w-[280px]"} text-xs leading-relaxed p-3 space-y-1.5`}
      >
        {title && (
          <p className="font-semibold text-foreground">{title}</p>
        )}
        {text && (
          <p className="text-muted-foreground">{text}</p>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-1 mt-1">
            {items.map((item, i) => (
              <li key={i} className="flex gap-1.5 text-muted-foreground">
                <span className="mt-0.5 shrink-0 text-muted-foreground/60">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
