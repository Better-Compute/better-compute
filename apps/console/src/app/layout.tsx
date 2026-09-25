import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'better-compute',
  description: 'GPU capacity, reservations, instances and fleet operations.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
