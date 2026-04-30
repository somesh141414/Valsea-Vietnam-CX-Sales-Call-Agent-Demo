import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-sans',
  weight: ['400', '600', '700', '800'],
  display: 'swap',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: 'Coke CX Voice Demo — VALSEA',
  description:
    'Coke customer support voice agent demo. Accent-aware ASR across seven Southeast Asian languages — powered by VALSEA speech intelligence.',
  icons: {
    icon: '/valsea-logo.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body suppressHydrationWarning={true}>{children}</body>
    </html>
  );
}
