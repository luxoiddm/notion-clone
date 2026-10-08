import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import { SessionProvider } from '../components/SessionProvider';
import { CallProviderBridge } from '../components/CallProviderBridge';
import { AccentColorBridge } from '../components/AccentColorBridge';
import { SiteSettingsProvider } from '../components/SiteSettingsProvider';
import 'katex/dist/katex.min.css';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Workspace',
  description: 'Корпоративная база знаний и командная работа',
  icons: {
    // Все иконки идут через сервер: он отдаёт favicon, загруженный в
    // админке («Настройки сайта» → «Брендинг»), или стандартный файл из
    // public/ — поэтому смена favicon не требует пересборки.
    icon: [
      { url: '/api/site-settings/favicon/32', sizes: '32x32' },
      { url: '/api/site-settings/favicon/192', sizes: '192x192' },
    ],
    apple: { url: '/api/site-settings/favicon/180', sizes: '180x180' },
  },
};

export const viewport = {
  // Контент под вырезом и системной полоской iPhone — отступы задаём сами (env(safe-area-inset-*)).
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#161619' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={inter.variable} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SiteSettingsProvider>
            <SessionProvider>
              <AccentColorBridge />
              <CallProviderBridge>{children}</CallProviderBridge>
            </SessionProvider>
          </SiteSettingsProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
