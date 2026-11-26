import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const viewport: Viewport = { interactiveWidget: "resizes-content", viewportFit: "cover" };

export const metadata: Metadata = {
  title: "LeashPay",
  description: "An AI payments agent on a leash: it plans, the vault decides.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions (e.g. ColorZilla) add attributes to <body>; don't treat that as a hydration error. */}
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
