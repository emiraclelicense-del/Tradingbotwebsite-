import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EmircaleX Bot | Trade Results",
  description: "Daily trading performance dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
