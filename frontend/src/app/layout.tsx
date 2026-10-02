import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Velora | Clinic workspace', description: 'Secure clinic access for Velora’s synthetic development prototype.', referrer: 'no-referrer' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
