export type BotStrategy = "all" | "ob" | "trend" | "signal";

export const strategyLabels: Record<BotStrategy, string> = {
  all: "All Bots",
  ob: "Order Block (OB)",
  trend: "Trend",
  signal: "Signal",
};

export function matchesStrategy(botName: string, strategy: string) {
  const isSignal = /\b(?:emiracle(?:x)?|emircale(?:x)?|united(?:[\s_-]+kings)?|range[\s_-]*of[\s_-]*(?:candle|chart))\b/i.test(botName);
  if (strategy === "signal") return isSignal;
  const isOrderBlock = /\bOB\b/i.test(botName);
  return strategy === "ob" ? isOrderBlock : strategy === "trend" ? !isOrderBlock && !isSignal : true;
}
