import { redirect } from 'next/navigation';

/**
 * The proof system is experimental and not in use: no trade carries a proof
 * and nothing is verified on-chain. The one accurate description of it is the
 * whitepaper section "Proofs: what exists and what does not", so this address
 * forwards there instead of keeping a second copy that can drift.
 */
export default async function ZkPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/whitepaper`);
}
