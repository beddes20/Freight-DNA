  highFreqOnly: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const visibleItems = useMemo(() => {
    const sorted = sortItems(items);
    return highFreqOnly ? sorted.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD) : sorted;
  }, [items, highFreqOnly]);

  const hiddenCount = items.length - visibleItems.length;
