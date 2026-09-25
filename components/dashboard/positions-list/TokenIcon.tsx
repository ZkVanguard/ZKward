import { memo } from 'react';
import { Bitcoin, Coins, DollarSign } from 'lucide-react';

// Memoized token icon component for better performance
export const TokenIcon = memo(({ symbol }: { symbol: string }) => {
  const iconClasses = 'w-6 h-6';
  switch (symbol.toUpperCase()) {
    case 'BTC':
    case 'WBTC':
      return <Bitcoin className={`${iconClasses} text-orange-500`} />;
    case 'ETH':
    case 'WETH':
      return <Coins className={`${iconClasses} text-blue-400`} />;
    case 'USDC':
    case 'USDT':
      return <DollarSign className={`${iconClasses} text-green-400`} />;
    case 'CRO':
      return <Coins className={`${iconClasses} text-[#007AFF]`} />;
    default:
      return <Coins className={`${iconClasses} text-[#86868b]`} />;
  }
});
TokenIcon.displayName = 'TokenIcon';
