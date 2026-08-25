import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripOS — AI Travel Operations & Intelligence Platform",
  description:
    "TripOS orchestrates external travel data, specialized AI agents, document intelligence, and RAG to continuously analyze travel conditions and produce explainable operational recommendations.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
