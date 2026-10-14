import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Grayscales Opportunity Intelligence",
  description: "Internal BD intake — agency directory and CSV import.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:p-2 focus:bg-white"
        >
          Skip to content
        </a>
        <Shell>
          <main id="main">{children}</main>
        </Shell>
      </body>
    </html>
  );
}
