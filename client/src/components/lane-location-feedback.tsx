import { CheckCircle2, AlertCircle, X } from "lucide-react";
import type { NormalizationResult } from "@/lib/laneLocationNormalizer";

export interface FieldNormState {
  result: NormalizationResult | null;
  dismissedSuggestion: boolean;
  acceptedCandidate: string | null;
}

export const EMPTY_NORM_STATE: FieldNormState = {
  result: null,
  dismissedSuggestion: false,
  acceptedCandidate: null,
};

export function LaneLocationFeedback({
  norm,
  fieldId,
  onAccept,
  onDismiss,
}: {
  norm: FieldNormState;
  fieldId: string;
  onAccept: (canonical: string, city: string, state: string) => void;
  onDismiss: () => void;
}) {
  const { result, dismissedSuggestion } = norm;
  if (!result) return null;

  if (result.status === "exact" && result.correctedFrom) {
    return (
      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1" data-testid={`hint-corrected-${fieldId}`}>
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        Auto-formatted to <span className="font-medium">{result.canonical}</span>
      </p>
    );
  }

  if (result.status === "corrected" && !dismissedSuggestion) {
    return (
      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1" data-testid={`hint-corrected-${fieldId}`}>
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        Corrected from <span className="italic">{result.correctedFrom}</span> → <span className="font-medium">{result.canonical}</span>
      </p>
    );
  }

  if (result.status === "suggested" && !dismissedSuggestion) {
    return (
      <div className="flex items-center gap-1.5 mt-1 flex-wrap" data-testid={`hint-suggested-${fieldId}`}>
        <span className="text-[11px] text-amber-600 dark:text-amber-400">Did you mean?</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] bg-amber-500/10 border border-amber-400/30 text-amber-600 dark:text-amber-400 rounded px-2 py-0.5 hover:bg-amber-500/20 transition-colors"
          onClick={() => result.city && result.state && onAccept(result.canonical!, result.city, result.state)}
          data-testid={`btn-accept-suggestion-${fieldId}`}
        >
          <CheckCircle2 className="w-3 h-3" />
          {result.canonical}
        </button>
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={onDismiss}
          data-testid={`btn-dismiss-suggestion-${fieldId}`}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  if (result.status === "ambiguous" && !dismissedSuggestion && result.candidates && result.candidates.length > 0) {
    return (
      <div className="mt-1" data-testid={`hint-ambiguous-${fieldId}`}>
        <span className="text-[11px] text-amber-600 dark:text-amber-400 block mb-1">Did you mean?</span>
        <div className="flex flex-wrap gap-1">
          {result.candidates.slice(0, 4).map(c => (
            <button
              key={`${c.city}-${c.state}`}
              type="button"
              className="inline-flex items-center gap-1 text-[11px] bg-amber-500/10 border border-amber-400/30 text-amber-600 dark:text-amber-400 rounded px-2 py-0.5 hover:bg-amber-500/20 transition-colors"
              onClick={() => onAccept(`${c.city}, ${c.state}`, c.city, c.state)}
              data-testid={`btn-candidate-${fieldId}-${c.state}`}
            >
              {c.city}, {c.state}
            </button>
          ))}
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1"
            onClick={onDismiss}
            data-testid={`btn-dismiss-ambiguous-${fieldId}`}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  if (result.status === "invalid") {
    const stateInvalid = result.state && result.state.length > 2;
    return (
      <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1" data-testid={`hint-invalid-${fieldId}`}>
        <AlertCircle className="w-3 h-3 shrink-0" />
        {stateInvalid
          ? `"${result.state}" is not a valid US state — double-check the spelling`
          : "We don't recognize this city — double-check the spelling"}
      </p>
    );
  }

  return null;
}
