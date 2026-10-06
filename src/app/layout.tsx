import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripOS — AI Travel Operations & Intelligence Platform",
  description:
    "TripOS orchestrates external travel data, specialized AI agents, document intelligence, and RAG to continuously analyze travel conditions and produce explainable operational recommendations.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {/*
         * Skip link (Phase 25). The shell repeats a header and nav before
         * every page's content, so keyboard users get a way past it. It is
         * the first focusable element in the document and only becomes
         * visible when focused — screen-reader and sighted-keyboard users
         * both find it. `#main-content` is set on each shell's <main>.
         */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-navy-900 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
