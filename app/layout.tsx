import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "SHOW-0 Desktop Lyrics",
  description: "SHOW-0 desktop lyrics UI handoff for v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
