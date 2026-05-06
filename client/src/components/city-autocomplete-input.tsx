import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { getCityAutocompleteSuggestions } from "@/lib/laneLocationNormalizer";
import { MapPin } from "lucide-react";

export interface CityAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onSelect: (city: string, state: string) => void;
  stateFilter?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  id?: string;
  testId?: string;
}

export function CityAutocompleteInput({
  value,
  onChange,
  onBlur,
  onSelect,
  stateFilter,
  placeholder,
  className,
  inputClassName,
  id,
  testId,
}: CityAutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(
    () => (suppressed ? [] : getCityAutocompleteSuggestions(value, stateFilter, 8)),
    [value, stateFilter, suppressed],
  );

  useEffect(() => {
    setHighlight(0);
  }, [value, stateFilter]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function handleSelect(idx: number) {
    const s = suggestions[idx];
    if (!s) return;
    onSelect(s.city, s.state);
    setOpen(false);
    setSuppressed(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (e.key === "ArrowDown" && suggestions.length > 0) {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (highlight >= 0 && highlight < suggestions.length) {
        e.preventDefault();
        handleSelect(highlight);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const showDropdown = open && suggestions.length > 0;

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <Input
        id={id}
        value={value}
        onChange={e => {
          setSuppressed(false);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setSuppressed(false);
          setOpen(true);
        }}
        onBlur={() => {
          setTimeout(() => onBlur?.(), 100);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={inputClassName}
        data-testid={testId}
        autoComplete="off"
      />
      {showDropdown && (
        <div
          className="absolute z-50 left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md max-h-64 overflow-auto"
          data-testid={testId ? `${testId}-suggestions` : undefined}
        >
          {suggestions.map((s, i) => (
            <button
              key={`${s.city}-${s.state}`}
              type="button"
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
              }`}
              onMouseDown={e => {
                e.preventDefault();
                handleSelect(i);
              }}
              onMouseEnter={() => setHighlight(i)}
              data-testid={testId ? `${testId}-option-${s.city.toLowerCase().replace(/\s+/g, "-")}-${s.state}` : undefined}
            >
              <MapPin className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="font-medium">{s.city}</span>
              <span className="text-xs text-muted-foreground">{s.state}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
