import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DayBook',
  description: 'Payments matched to invoices, straight out of WhatsApp.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
