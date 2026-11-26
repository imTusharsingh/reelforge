import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { NotificationProvider } from "../components/ui/notifications";
import { StudioNavigationGuard } from "../components/studio-link";

export const metadata: Metadata = {
  title: "ReelForge",
  description: "Creator studio for producing and publishing Shorts",
  icons: { icon: "/brand/reelforge-mark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>
        <StudioNavigationGuard />
        <NotificationProvider>{children}</NotificationProvider>
      </body>
    </html>
  );
}
