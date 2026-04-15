import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CerebraLink — Medical AI Assistant',
  description: 'Pre-visit patient intake AI assistant for Acıbadem Hospital',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <body className="min-h-screen bg-cerebral-bg text-cerebral-text antialiased">
        {children}
      </body>
    </html>
  );
}
