import type { ReactNode } from "react";
import { JayTraceClient } from "./jaytrace-client";
import "./console.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <JayTraceClient />
        {children}
      </body>
    </html>
  );
}
