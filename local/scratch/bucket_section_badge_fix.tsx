            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{visibleItems.length}</Badge>
            {highFreqOnly && hiddenCount > 0 && (
              <span className="text-[10px] text-muted-foreground/50">(+{hiddenCount} below 2/wk hidden)</span>
            )}
