import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { PLATFORM_PRODUCT_NAME } from "@/lib/branding";

export const metadata: Metadata = {
  title: PLATFORM_PRODUCT_NAME,
  description: "Business operations dashboard"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
