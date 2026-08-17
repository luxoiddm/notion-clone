import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import { SessionProvider } from '../components/SessionProvider';
import { CallProviderBridge } from '../components/CallProviderBridge';
import { AccentColorBridge } from '../components/AccentColorBridge';
import { SiteSettingsProvider } from '../components/SiteSettingsProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Workspace',
  description: 'Корпоративная база знаний и командная работа',
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
