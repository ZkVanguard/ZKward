import type { Metadata } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const path = '/zk';
  const canonical = locale === defaultLocale ? path : `/${locale}${path}`;
  return {
    title: 'ZK-STARK proofs',
    description: 'Post-quantum verifiable AI. CUDA-accelerated STARK prover, 180-bit soundness, no trusted setup, verifiable in the browser. Every vault decision cryptographically attested.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? path : `/${l}${path}`]),
      ),
    },
    // See agents/layout.tsx — openGraph/twitter omitted so the file-
    // convention OG image survives; title.template composes 'ZK-STARK
    // proofs · ZKward'.
  };
}

export default function ZkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
