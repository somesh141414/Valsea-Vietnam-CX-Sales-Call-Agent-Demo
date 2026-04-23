import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: 'Coca-Cola Customer Support — Talk to Maya',
  description:
    'Ask about Coca-Cola bundle promotions, bulk delivery, and frequently asked questions — powered by a voice AI agent.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body suppressHydrationWarning={true}>{children}</body>
    </html>
  );
}
