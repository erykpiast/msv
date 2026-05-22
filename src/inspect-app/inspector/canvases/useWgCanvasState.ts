import { useEffect, useState } from 'react';

/**
 * Bundles the chain-expansion + chart-collapse state that `WorkingGroupCanvas`
 * needs. Keeping it in one hook lets us co-locate the (small but interrelated)
 * effect rules: chains auto-collapse when their substage leaves, and the
 * confidence chart auto-collapses whenever a chain opens.
 */
export function useWgCanvasState(opts: {
  isDebateActive: boolean;
  isAlignmentActive: boolean;
}) {
  const { isDebateActive, isAlignmentActive } = opts;

  const [isDebateExpanded, setIsDebateExpanded] = useState(false);
  const [isAlignmentExpanded, setIsAlignmentExpanded] = useState(false);
  const [isChartCollapsed, setIsChartCollapsed] = useState(false);

  useEffect(() => {
    if (!isDebateActive) setIsDebateExpanded(false);
  }, [isDebateActive]);

  useEffect(() => {
    if (!isAlignmentActive) setIsAlignmentExpanded(false);
  }, [isAlignmentActive]);

  const isAnyChainExpanded = isDebateExpanded || isAlignmentExpanded;

  // When the user opens a chain (either substage), the diagram needs more
  // vertical room — fold the confidence chart out of the way. The user can
  // still force-show it again with the chevron in the pair row.
  useEffect(() => {
    if (isAnyChainExpanded) setIsChartCollapsed(true);
  }, [isAnyChainExpanded]);

  return {
    isDebateExpanded,
    setIsDebateExpanded,
    isAlignmentExpanded,
    setIsAlignmentExpanded,
    isChartCollapsed,
    setIsChartCollapsed,
    isAnyChainExpanded,
  };
}
