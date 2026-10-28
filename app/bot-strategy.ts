export type BotStrategy = "all" | "ob" | "confirm" | "signal";

export const strategyLabels: Record<BotStrategy, string> = {
  all: "All Bots",
  ob: "OB Touch",
  confirm: "OB Confirm",
  signal: "Signal",
};

export function matchesStrategy(botName: string, strategy: string) {
  const isSignal = /\b(?:emiracle(?:x)?|emircale(?:x)?|united(?:[\s_-]+kings)?|range[\s_-]*of[\s_-]*(?:candle|chart))\b/i.test(botName);
  if (strategy === "signal") return isSignal;
  if (strategy === "confirm") return /\bConfirm\b/i.test(botName);
  const isTouch = /\b(?:OB|Touch)\b/i.test(botName) && !/\bConfirm\b/i.test(botName);
  return strategy === "ob" || strategy === "touch" ? isTouch : true;
}
