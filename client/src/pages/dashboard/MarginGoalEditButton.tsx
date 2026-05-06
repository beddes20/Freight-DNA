import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";

interface MarginGoalEditButtonProps {
  userId: string;
  goalId: string | null;
  currentTarget: number;
  onSave: (target: number) => void;
}

export function MarginGoalEditButton({ userId, goalId, currentTarget, onSave }: MarginGoalEditButtonProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentTarget > 0 ? String(Math.round(currentTarget)) : "");

  const handleSave = () => {
    const n = parseFloat(value.replace(/,/g, ""));
    if (!isNaN(n) && n > 0) {
      onSave(n);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          title={goalId ? "Edit margin goal" : "Set margin goal"}
          data-testid={`button-edit-margin-goal-${userId}`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="end">
        <p className="text-xs font-semibold mb-2">Monthly Margin Goal</p>
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            step={1000}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="e.g. 50000"
            className="h-8 text-sm"
            onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setOpen(false); }}
            data-testid={`input-margin-goal-${userId}`}
            autoFocus
          />
          <Button size="sm" className="h-8 px-2" onClick={handleSave} data-testid={`button-save-margin-goal-${userId}`}>
            Save
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5">Enter target margin in dollars for this month.</p>
      </PopoverContent>
    </Popover>
  );
}
