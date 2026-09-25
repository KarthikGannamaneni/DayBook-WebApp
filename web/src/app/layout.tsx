import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Expense capture',
  description: 'Expenses captured from WhatsApp, one project at a time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
