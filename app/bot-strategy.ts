export type BotStrategy = "all" | "ob" | "signal" | "live";

export const strategyLabels: Record<BotStrategy, string> = {
  all: "All Bots",
  ob: "OB Touch",
  signal: "Signal",
  live: "Live BOT",
};

export function matchesStrategy(botName: string, strategy: string) {
  if (strategy === "live") return /\blive(?:\s+bot)?\b/i.test(botName);
  const isSignal = /\b(?:emiracle(?:x)?|emircale(?:x)?|united(?:[\s_-]+kings)?|range[\s_-]*of[\s_-]*(?:candle|chart))\b/i.test(botName);
  if (strategy === "signal") return isSignal;
  if (strategy === "confirm") return /\bConfirm\b/i.test(botName);
  const isTouch = /\b(?:OB|Touch)\b/i.test(botName) && !/\bConfirm\b/i.test(botName);
  return strategy === "ob" || strategy === "touch" ? isTouch : true;
}
