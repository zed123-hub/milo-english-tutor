import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Milo · 你的英语导师',
  description:
    '先了解你，再带你开口。Milo 根据真实交流中的表现，安排适合你的英语听说练习。',
  manifest: '/manifest.webmanifest',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
