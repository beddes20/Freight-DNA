          {/* 2+/week filter toggle */}
          <Button
            variant={highFreqOnly ? "default" : "outline"}
            size="sm"
            className={`h-8 text-xs gap-1.5 ${highFreqOnly ? "bg-amber-500 hover:bg-amber-600 text-white border-transparent" : ""}`}
            onClick={() => setHighFreqOnly(v => !v)}
            data-testid="btn-filter-high-freq"
          >
            <Zap className="w-3.5 h-3.5" />
            2+/week{highFreqCount > 0 && ` (${highFreqCount})`}
          </Button>
