"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/trade-history", label: "Trade History" },
];

export default function SiteNav() {
  const pathname = usePathname();
  return <nav className="site-nav" aria-label="Main menu">
    {LINKS.map(({ href, label }) => {
      const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
      return <Link key={href} href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{label}</Link>;
    })}
  </nav>;
}
