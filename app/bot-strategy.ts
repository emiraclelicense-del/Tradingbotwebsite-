export type BotStrategy = "all" | "ob" | "signal" | "live";

export const strategyLabels: Record<BotStrategy, string> = {
  all: "All Bots",
  ob: "OB Touch",
  signal: "Signal",
  live: "Live",
};

export function matchesStrategy(botName: string, strategy: string) {
  if (strategy === "live") return /\blive(?:\s+bot)?\b/i.test(botName);
  const isSignal = /\b(?:emiracle(?:x)?|emircale(?:x)?|united(?:[\s_-]+kings)?|range[\s_-]*of[\s_-]*(?:candle|chart))\b/i.test(botName);
  if (strategy === "signal") return isSignal;
  if (strategy === "confirm") return /\bConfirm\b/i.test(botName);
  const isTouch = /\b(?:OB|Touch)\b/i.test(botName) && !/\bConfirm\b/i.test(botName);
  return strategy === "ob" || strategy === "touch" ? isTouch : true;
}

export type TouchPair = "all" | "eur" | "xau" | "btc";

export const pairLabels: Record<TouchPair, string> = {
  all: "All Pairs",
  eur: "EUR",
  xau: "XAU",
  btc: "BTC",
};

// Reads the pair from the bot name, e.g. "OB Touch XAUUSD", "Touch Gold", "Touch BTC".
export function matchesPair(botName: string, pair: string) {
  if (pair === "eur") return /(?:EUR|Euro)/i.test(botName);
  if (pair === "xau") return /(?:XAU|Gold)/i.test(botName);
  if (pair === "btc") return /(?:BTC|Bitcoin)/i.test(botName);
  return true;
}
