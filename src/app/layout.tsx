import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { DashboardNav } from "@/components/dashboard/nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "bot-pol — Binance Prediction Research",
  description:
    "Research-first paper-trading platform for Binance Wallet Prediction Markets",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="uk"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <DashboardNav />
        {children}
      </body>
    </html>
  );
}
