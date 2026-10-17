export type BotStrategy = "all" | "ob" | "trend";

export const strategyLabels: Record<BotStrategy, string> = {
  all: "All Bots",
  ob: "Order Block (OB)",
  trend: "Trend",
};

export function matchesStrategy(botName: string, strategy: string) {
  const isOrderBlock = /\bOB\b/i.test(botName);
  return strategy === "ob" ? isOrderBlock : strategy === "trend" ? !isOrderBlock : true;
}
