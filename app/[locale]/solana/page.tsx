import { redirect } from 'next/navigation';

/** The Solana pool lives in the dashboard's Pool tab with the other chains. */
export default async function SolanaPoolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/dashboard?chain=solana`);
}
