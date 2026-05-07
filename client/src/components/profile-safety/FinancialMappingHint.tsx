// Task #1109 — "May be incomplete" hint for the financial card on the
// Company Profile Overview tab. Reads the count of freight rows whose
// `customer` column fuzzy-matches the company name but is not currently
// covered by the company's `financial_alias`. Pure read; no writes.

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";

interface Props {
  companyId: string;
}

interface MappingHealth {
  unmappedRowCount: number;
  unmappedCustomerSamples: string[];
  hasFinancialAlias: boolean;
}

export function FinancialMappingHint({ companyId }: Props) {
  const { data } = useQuery<MappingHealth>({
    queryKey: ["/api/companies", companyId, "financial-mapping-health"],
    staleTime: 5 * 60 * 1000,
  });

  if (!data || data.unmappedRowCount <= 0) return null;

  const samples = data.unmappedCustomerSamples.slice(0, 3).join(", ");

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-800/40 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300"
      data-testid="hint-financial-mapping-incomplete"
    >
      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="font-medium" data-testid="hint-financial-mapping-headline">
          May be incomplete — {data.unmappedRowCount.toLocaleString()} unmapped freight row{data.unmappedRowCount === 1 ? "" : "s"} match this customer name
        </p>
        {samples && (
          <p className="text-[10px] text-amber-700/90 dark:text-amber-400/90 mt-0.5" data-testid="hint-financial-mapping-samples">
            Sample customer values: {samples}
          </p>
        )}
        {!data.hasFinancialAlias && (
          <p className="text-[10px] text-amber-700/90 dark:text-amber-400/90 mt-0.5">
            Tip: setting a Financial Alias on this account can roll those rows in.
          </p>
        )}
      </div>
    </div>
  );
}
