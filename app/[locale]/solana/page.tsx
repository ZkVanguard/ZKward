'use client';

/**
 * /solana — public Solana token-pool page (testnet phase). Same view the
 * dashboard's Solana tab embeds (components/solana/SolanaPoolView).
 */
import { SolanaPoolView } from '@/components/solana/SolanaPoolView';

export default function SolanaPoolPage() {
  return (
    <main className="min-h-screen bg-system-bg-primary px-4 pt-20 sm:pt-24 pb-16 sm:px-6">
      <div className="max-w-6xl mx-auto">
        <SolanaPoolView showTitle />
      </div>
    </main>
  );
}
