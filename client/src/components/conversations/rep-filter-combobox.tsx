import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ChevronsUpDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface User {
  id: string;
  fullName: string;
  email: string;
}

interface RepFilterComboboxProps {
  users: User[];
  value: string;
  onChange: (v: string) => void;
}

export function RepFilterCombobox({ users, value, onChange }: RepFilterComboboxProps) {
  const [open, setOpen] = useState(false);
  const allOption = { id: "all", fullName: "All reps", email: "" };
  const items = useMemo(() => [allOption, ...users], [users]);
  const current = items.find(u => u.id === value) ?? allOption;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[180px] h-8 justify-between text-xs font-normal"
          data-testid="combobox-rep-filter"
        >
          <span className="truncate">{current.fullName || current.email || "All reps"}</span>
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search reps..." className="h-9" data-testid="input-rep-search" />
          <CommandList>
            <CommandEmpty>No reps found.</CommandEmpty>
            {items.map(u => (
              <CommandItem
                key={u.id}
                value={`${u.fullName} ${u.email}`}
                onSelect={() => {
                  onChange(u.id);
                  setOpen(false);
                }}
                data-testid={`rep-option-${u.id}`}
              >
                <Check className={cn("mr-2 h-4 w-4", value === u.id ? "opacity-100" : "opacity-0")} />
                <div className="flex flex-col">
                  <span className="text-sm">{u.fullName}</span>
                  {u.email && <span className="text-[10px] text-muted-foreground">{u.email}</span>}
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
