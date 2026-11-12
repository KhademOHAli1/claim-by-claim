import type { Metadata } from 'next';
import '../styles.css';

export const metadata: Metadata = {
  title: 'Claim by claim | Evidence workspace',
  description: 'A synchronized, source-linked review of 47 claims in a video about Ilhan Omar. Inspect each statement, assessment and public record.',
  icons: { icon: '/favicon.svg' },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="dark"><body>{children}</body></html>;
}
