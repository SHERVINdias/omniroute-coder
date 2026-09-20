import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The display face, used for the one large greeting on the empty state.
 *
 * That heading was already asking for `font-serif`, but nothing defined one, so
 * it fell through to the browser default — Times New Roman on Windows, which is
 * where most beta testers are. A deliberate serif is the difference between the
 * heading reading as designed and reading as unstyled.
 *
 * next/font self-hosts this at build time, so it is not a third-party request
 * at runtime and there is no layout shift while it loads.
 */
const displaySerif = Source_Serif_4({
  variable: "--font-display-serif",
  subsets: ["latin"],
  /* No `weight`: omitting it selects the variable font, which covers 200-900 in
   * one file rather than shipping a separate file per weight. */
  display: "swap",
});

export const metadata: Metadata = {
  title: "OmniRoute Coder - Beta",
  description: "AI-powered development environment with multi-provider support - Beta Testing",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-surface-base text-ink">
        {children}
      </body>
    </html>
  );
}
