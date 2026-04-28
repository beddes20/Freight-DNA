          {visibleItems.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-2 pl-10">
              {highFreqOnly && items.length > 0
                ? "No 2+/week lanes in this bucket."
                : "No lanes in this bucket."}
            </p>
          ) : (
            visibleItems.map(item => (
