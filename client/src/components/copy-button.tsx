import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  iconClassName?: string;
  "data-testid"?: string;
}

export function CopyButton({ value, label, className, iconClassName, "data-testid": dataTestId }: CopyButtonProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      toast({ title: "Copied!", description: label ? `${label} copied to clipboard` : "Copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      toast({ title: "Failed to copy", variant: "destructive" });
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        copied && "text-green-600 dark:text-green-400",
        className,
      )}
      title={copied ? "Copied!" : `Copy ${label || "to clipboard"}`}
      data-testid={dataTestId}
      aria-label={`Copy ${label || value}`}
    >
      {copied
        ? <Check className={cn("h-3.5 w-3.5", iconClassName)} />
        : <Copy className={cn("h-3.5 w-3.5", iconClassName)} />
      }
    </button>
  );
}
