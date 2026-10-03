'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import nextDynamic from 'next/dynamic';
import { useAccount, useBalance } from '@/lib/evm-wallet/hooks';
import {
  Bot,
  Briefcase,
  TrendingUp,
  MessageSquare,
  ChevronRight,
  X,
  Users,
  ShieldCheck,
  MoreHorizontal,
  UserCog,
} from 'lucide-react';
import { MobileTabBar } from '@/components/dashboard/MobileTabBar';
import { WalletAvatar } from '@/components/ui/WalletAvatar';
import { useUserSession } from '@/lib/hooks/useUserSession';
import { useContractAddresses } from '@/lib/contracts/hooks';
import { usePositions } from '@/contexts/PositionsContext';
import { logger } from '@/lib/utils/logger';
import { useSui } from '@/app/sui-providers';
import { useWalletHub, type WalletChain } from '@/contexts/WalletHubContext';
import { ChainBadge } from '@/components/wallet/ChainBadge';
import { ChainLogo, FundsTag } from '@/components/wallet/ChainLogo';
import { ReconnectBanner } from '@/components/wallet/ReconnectBanner';

// Dynamic imports for code splitting
const AgentActivity = nextDynamic(
  () =>
    import('@/components/dashboard/AgentActivity').then((mod) => ({ default: mod.AgentActivity })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

// LiveAutonomyPanel. Wallet-agnostic proof-of-life. Reads
// /api/dashboard/autonomy-status and renders cron heartbeats, trader
// stats, signals, alarms. Shown ABOVE the per-wallet AgentActivity on
// the AI Agents tab so anonymous visitors immediately see the
// autonomy machinery is alive. The visible-track-record lever the
// pool needs to attract deposits.
const LiveAutonomyPanel = nextDynamic(
  () =>
    import('@/components/dashboard/LiveAutonomyPanel').then((mod) => ({ default: mod.LiveAutonomyPanel })),
  {
    loading: () => <LoadingSkeleton height="h-64" />,
    ssr: false,
  }
);

const RiskMetrics = nextDynamic(
  () => import('@/components/dashboard/RiskMetrics').then((mod) => ({ default: mod.RiskMetrics })),
  {
    loading: () => <LoadingSkeleton height="h-32" />,
    ssr: false,
  }
);

const PositionsList = nextDynamic(
  () =>
    import('@/components/dashboard/PositionsList').then((mod) => ({ default: mod.PositionsList })),
  {
    loading: () => <LoadingSkeleton height="h-60" />,
    ssr: false,
  }
);

const ChainHedges = nextDynamic(
  () =>
    import('@/components/dashboard/ChainHedges').then((mod) => ({ default: mod.ChainHedges })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

// SUI-only mode: EVM/Cronos-bound widgets were removed with the dead-code
// cleanup. Hedging is driven by the SUI Community Pool + BlueFin auto-hedge
// cron instead of manual modals. Re-add here when other chains re-enable.


const EnhancedChat = nextDynamic(
  () =>
    import('@/components/dashboard/EnhancedChat').then((mod) => ({ default: mod.EnhancedChat })),
  {
    loading: () => null,
    ssr: false,
  }
);

const MarketLeanBoard = nextDynamic(
  () => import('@/components/dashboard/MarketLeanBoard').then((mod) => ({ default: mod.MarketLeanBoard })),
  { ssr: false },
);
const FiveMinSignalWidget = nextDynamic(
  () =>
    import('@/components/dashboard/FiveMinSignalWidget').then((mod) => ({
      default: mod.FiveMinSignalWidget,
    })),
  {
    loading: () => <LoadingSkeleton height="h-28" />,
    ssr: false,
  }
);


const CommunityPool = nextDynamic(
  () =>
    import('@/components/dashboard/CommunityPool').then((mod) => ({ default: mod.CommunityPool })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

// PortfolioOverview. Only used in the Overview tab (~220 LOC + wallet
// context deps). Lazy so it doesn't ship in the initial dashboard chunk
// when users land on the default Pool tab.
const PortfolioOverview = nextDynamic(
  () =>
    import('@/components/dashboard/PortfolioOverview').then((mod) => ({ default: mod.PortfolioOverview })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

// Platform sub-tabs. Extracted from former /dashboard/{portfolio,risk,custody}
// pages so they render as tabs inside this dashboard instead of separate routes.
const PortfolioTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/PortfolioTab').then((mod) => ({ default: mod.PortfolioTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

const RiskTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/RiskTab').then((mod) => ({ default: mod.RiskTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

const CustodyTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/CustodyTab').then((mod) => ({ default: mod.CustodyTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

// B2B admin panel. Privy quorum voting UI. Lazy so the Privy hooks
// (usePrivy, useLogin, getAccessToken) only ship when the tab is opened,
// not when landing on the default Pool tab.
const B2bAdminPanel = nextDynamic(
  () =>
    import('@/components/dashboard/B2bAdminPanel').then((mod) => ({ default: mod.B2bAdminPanel })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

// User profile + settings. Replaces the old `onboard` and `perps` tabs.
// Sign-in is handled by the navbar; this tab shows identity + preferences.
const ProfileTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/ProfileTab').then((mod) => ({ default: mod.ProfileTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

// Reusable loading skeleton
function LoadingSkeleton({ height = 'h-40' }: { height?: string }) {
  return <div className={`animate-pulse bg-system-bg-secondary ${height} rounded-[24px]`} />;
}

// Navigation. Five destinations; the ones with `views` show a segmented
// control under the title. Old tab ids keep working through LEGACY_TABS.
interface NavView {
  id: string;
  label: string;
}
interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  views?: readonly NavView[];
}

const destinations = [
  { id: 'pool', label: 'Pool', icon: Users },
  {
    id: 'portfolio',
    label: 'Portfolio',
    icon: Briefcase,
    views: [
      { id: 'summary', label: 'Summary' },
      { id: 'positions', label: 'Positions' },
      { id: 'hedges', label: 'Hedges' },
      { id: 'products', label: 'Products' },
    ],
  },
  {
    id: 'signals',
    label: 'Signals',
    icon: TrendingUp,
    views: [
      { id: 'markets', label: 'Markets' },
      { id: 'agents', label: 'Agents' },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    icon: ShieldCheck,
    views: [
      { id: 'risk', label: 'Risk' },
      { id: 'custody', label: 'Custody' },
      { id: 'admin', label: 'Admin' },
    ],
  },
  { id: 'account', label: 'Account', icon: UserCog },
] as const satisfies readonly NavItem[];

type DestId = (typeof destinations)[number]['id'];

const LEGACY_TABS: Record<string, { dest: DestId; view?: string }> = {
  community: { dest: 'pool' },
  overview: { dest: 'portfolio', view: 'summary' },
  positions: { dest: 'portfolio', view: 'positions' },
  hedges: { dest: 'portfolio', view: 'hedges' },
  agents: { dest: 'signals', view: 'agents' },
  insights: { dest: 'signals', view: 'markets' },
  risk: { dest: 'platform', view: 'risk' },
  custody: { dest: 'platform', view: 'custody' },
  admin: { dest: 'platform', view: 'admin' },
  x402: { dest: 'platform' },
  profile: { dest: 'account' },
  solana: { dest: 'pool' }, // CommunityPool reads ?tab=solana and opens the Solana chain
};

const viewsOf = (dest: DestId): readonly NavView[] =>
  (destinations.find((d) => d.id === dest) as NavItem | undefined)?.views ?? [];
const defaultView = (dest: DestId): string | null => viewsOf(dest)[0]?.id ?? null;

function ViewSwitcher({
  views,
  active,
  onSelect,
}: {
  views: readonly NavView[];
  active: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="tablist" className="inline-flex max-w-full overflow-x-auto rounded-[12px] bg-system-bg-secondary p-1 gap-0.5">
      {views.map((v) => (
        <button
          key={v.id}
          role="tab"
          aria-selected={active === v.id}
          onClick={() => onSelect(v.id)}
          className={`px-3.5 py-1.5 rounded-[9px] text-[13px] font-semibold whitespace-nowrap transition-all ${
            active === v.id ? 'bg-white text-label-primary shadow-ios-1' : 'text-label-tertiary hover:text-label-primary'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  // Unified session. Privy embedded wallet first, then anything wagmi
  // reports as a fallback. Guarantees the sidebar avatar/address/balance
  // matches the Profile tab AND the community leaderboard (all read from
  // useUserSession + useWalletProfile). Fixes the bug where wagmi's
  // useAccount would return an injected MetaMask address that drifted
  // from the Privy embedded wallet the user actually signed in with.
  const session = useUserSession();

  // Wagmi injected fallback. Kept for downstream code that needs raw
  // wagmi address (e.g. useWriteContract in HederaVaultActions). NOT
  // used for the sidebar display; that's session.address.
  const { address: evmAddress } = useAccount();
  useBalance({ address: evmAddress }); // side-effect: keeps wagmi cache warm

  // SUI wallet state
  const sui = useSui();
  const suiBalance = sui.balance;
  const hub = useWalletHub();

  // Primary display address. SUI wins if connected (SUI-native pages),
  // otherwise the unified Privy session. Deliberately does NOT fall back
  // to wagmi's evmAddress: injected wallets (MetaMask, OKX, Rabby via
  // EIP-6963) auto-connect on page load even when the user hasn't
  // clicked Sign In, causing a phantom "connected" address in the
  // sidebar. Sidebar identity requires an EXPLICIT sign-in (SUI or Privy).
  // One network at a time: the sidebar identity is the active network's wallet.
  const primaryChain: WalletChain | null = hub.isConnected ? hub.activeChain : null;
  const isConnected = primaryChain !== null;
  const address = hub.active?.address ?? '';
  const displayBalance = primaryChain === 'sui'
    ? `${suiBalance} SUI`
    : primaryChain === 'hedera' && session.balances.ready
      ? `${session.balances.hbarHuman.toFixed(4)} HBAR`
      : '';

  const contractAddresses = useContractAddresses();
  // Get portfolio count and other data from centralized context - no redundant fetches!
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { derived } = usePositions();
  // Use centralized AI service for portfolio actions
  // Portfolio count available via derived?.portfolioCount if needed

  // Pool is home: clicking "Vault" in the top nav lands on deposit/withdraw.
  const [activeDest, setActiveDest] = useState<DestId>('pool');
  const [activeView, setActiveView] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);

  const displayAddress = address || '';
  // Positions, risk and agent activity exist for SUI and Hedera wallets; a
  // Solana user is guided to the Pool tab by each surface's own empty state.
  const portfolioAddress = primaryChain === 'solana' ? '' : displayAddress;
  // `?tab=<dest>&view=<sub>` deep-links any view (old tab ids included);
  // every switch keeps the URL in step so a view can be shared. Scroll
  // resets because the sidebar is sticky.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (!tab) return;
    const legacy = LEGACY_TABS[tab];
    const dest = legacy?.dest ?? (destinations.some((d) => d.id === tab) ? (tab as DestId) : null);
    if (!dest) return;
    const view = params.get('view') ?? legacy?.view ?? null;
    setActiveDest(dest);
    setActiveView(view && viewsOf(dest).some((v) => v.id === view) ? view : defaultView(dest));
  }, []);

  const handleNavChange = useCallback((dest: DestId, view?: string) => {
    const nextView = view ?? defaultView(dest);
    setActiveDest(dest);
    setActiveView(nextView);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0 });
    const params = new URLSearchParams(window.location.search);
    if (dest === 'pool') params.delete('tab');
    else {
      params.set('tab', dest);
      params.delete('chain');
    }
    if (nextView && nextView !== defaultView(dest)) params.set('view', nextView);
    else params.delete('view');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);


  useEffect(() => {
    if (isConnected && contractAddresses) {
      logger.debug('Contract Addresses', { addresses: contractAddresses });
    }
  }, [isConnected, contractAddresses]);

  // Close mobile menu on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  return (
    <div className="min-h-screen bg-system-bg-secondary">
      {/* Mobile Header - Slim page-title bar. Primary navigation now lives in
          the bottom tab bar (see <MobileTabBar/> below). We keep only the
          current page title and the chat action here. Access to the drawer
          (secondary items: portfolio/risk/custody/account) is via the 'More'
          tab in the bottom bar. */}
      <header className="lg:hidden fixed top-[52px] left-0 right-0 z-40 bg-white/95 backdrop-blur-xl border-b border-black/5">
        <div className="flex items-center justify-between px-4 h-12">
          {/* Uses <p role=heading aria-level=1> instead of a second <h1>.
              The desktop h1 below is display:none on mobile, and vice versa,
              but audit tools count both DOM nodes. Screen readers still
              announce this as a level-1 heading via ARIA. */}
          <p role="heading" aria-level={1} className="text-[17px] font-semibold text-label-primary tracking-tight truncate m-0">
            {destinations.find((d) => d.id === activeDest)?.label}
          </p>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Sidebar. Capped at 84vw so it can't bleed on 320px viewports */}
      <aside
        className={`
        lg:hidden fixed top-0 left-0 bottom-0 w-[min(84vw,300px)] z-50 bg-white pt-safe pb-safe
        transform transition-transform duration-300 ease-out shadow-2xl
        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Mobile Menu Header */}
          <div className="flex items-center justify-between p-4 border-b border-black/5">
            <span className="text-lg font-bold text-label-primary">Menu</span>
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="p-2 -mr-2 text-label-quaternary hover:text-label-primary"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Wallet Info — mobile drawer */}
          <div className="p-4 border-b border-black/5">
            <button
              type="button"
              onClick={() => hub.openChooser(isConnected ? { reason: 'Switch to another network. Every tab follows your choice.' } : undefined)}
              title={isConnected ? 'Switch network' : 'Connect a wallet'}
              className="w-full text-left rounded-xl hover:bg-system-bg-secondary transition-colors"
            >
              <SidebarWalletCard
                address={displayAddress}
                displayName={primaryChain === 'hedera' ? session.displayName : null}
                chain={primaryChain}
                isConnected={isConnected}
                subLabel={isConnected ? displayBalance : 'Tap to connect'}
                size={40}
              />
            </button>
          </div>

          <nav className="flex-1 py-2 overflow-y-auto">
            {destinations.map((item) => {
              const Icon = item.icon;
              const isActive = activeDest === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavChange(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                    isActive ? 'bg-ios-blue/10 border-r-2 border-ios-blue' : 'hover:bg-system-bg-secondary'
                  }`}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-ios-blue' : 'text-label-quaternary'}`} />
                  <span className={`font-medium ${isActive ? 'text-ios-blue' : 'text-label-primary'}`}>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </aside>

      {/* Desktop Layout */}
      <div className="flex pt-[52px]">
        {/* Desktop Sidebar - Hidden on mobile */}
        <aside className="hidden lg:flex w-64 h-[calc(100vh-52px)] sticky top-[52px] flex-col bg-white border-r border-black/5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          {/* Wallet Section — desktop */}
          <div className="p-5 border-b border-black/5">
            <button
              type="button"
              onClick={() => hub.openChooser(isConnected ? { reason: 'Switch to another network. Every tab follows your choice.' } : undefined)}
              title={isConnected ? 'Switch network' : 'Connect a wallet'}
              className="w-full text-left rounded-xl hover:bg-system-bg-secondary transition-colors"
            >
              <SidebarWalletCard
                address={displayAddress}
                displayName={primaryChain === 'hedera' ? session.displayName : null}
                chain={primaryChain}
                isConnected={isConnected}
                subLabel={isConnected ? displayBalance : 'Tap to connect'}
                size={48}
              />
            </button>
          </div>

          <nav className="flex-1 py-4 overflow-y-auto">
            {destinations.map((item) => {
              const Icon = item.icon;
              const isActive = activeDest === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavChange(item.id)}
                  className={`
                    w-[calc(100%-16px)] mx-2 mb-1 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]
                    ${isActive ? 'bg-ios-blue shadow-[0_2px_8px_rgba(0,105,217,0.25)]' : 'hover:bg-system-bg-secondary'}
                  `}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-label-quaternary'}`} />
                  <span className={`text-[15px] font-medium tracking-[-0.01em] ${isActive ? 'text-white' : 'text-label-primary'}`}>
                    {item.label}
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 min-h-[calc(100vh-52px)] pt-12 lg:pt-0 pb-[calc(52px+env(safe-area-inset-bottom))] lg:pb-0">
          <div className="max-w-[1280px] mx-auto px-3 sm:px-5 py-3 sm:py-6 lg:px-8 lg:py-10">
            <ReconnectBanner />
            {/* Page Header — desktop-only large title. Uses the design
                token `text-large-title` (34px, per-Apple line-height +
                tracking). Sentence-case, tight tracking, no gradient. */}
            <div className="hidden lg:block mb-6">
              <h1 className="text-large-title text-label-primary tracking-[-0.02em]">
                {destinations.find((d) => d.id === activeDest)?.label}
              </h1>
            </div>
            {viewsOf(activeDest).length > 0 && (
              <div className="mb-3 sm:mb-5">
                <ViewSwitcher
                  views={viewsOf(activeDest)}
                  active={activeView}
                  onSelect={(view) => handleNavChange(activeDest, view)}
                />
              </div>
            )}

            {/* Content Area. Keyed on activeNav so React tears down + remounts
                the tab's subtree, giving each tab-switch a natural fade-in
                (paired with the animate-fade-in class). Feels closer to
                UINavigationController on iOS than a raw conditional swap. */}
            <Suspense fallback={<LoadingSkeleton height="h-96" />}>
              <div key={`${activeDest}:${activeView ?? ''}`} className="animate-fade-in">
                {renderContent()}
              </div>
            </Suspense>
          </div>
        </main>
      </div>

      {/* iOS-style bottom tab bar — primary nav on mobile. 4 tabs + More.
          The "More" button opens the drawer where the wallet controls,
          portfolio/risk/custody/account sub-pages live. Reduces the
          old 4-tap "menu → drawer → tab → close" flow to 1 tap. */}
      <MobileTabBar
        items={destinations.slice(0, 4)}
        activeId={activeDest}
        onSelect={(id) => handleNavChange(id)}
        onOpenMore={() => setMobileMenuOpen(true)}
        moreLabel="More"
        moreIcon={MoreHorizontal}
      />

      {/* Create Portfolio CTA disabled in SUI-only mode (EVM/Cronos required). */}

      {/* Chat Panel */}
      {showChat && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm lg:bg-transparent lg:backdrop-blur-none lg:pointer-events-none"
            onClick={() => setShowChat(false)}
          />
          <div className="fixed bottom-[calc(52px+env(safe-area-inset-bottom))] lg:bottom-6 left-0 right-0 lg:right-6 lg:left-auto z-50 lg:w-[440px] lg:pointer-events-auto">
            <div className="bg-white lg:rounded-[24px] shadow-2xl border-t lg:border border-black/5 overflow-hidden">
              <div className="flex items-center justify-between p-3 sm:p-4 border-b border-black/5">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-ios-blue rounded-[12px] flex items-center justify-center shadow-[0_2px_8px_rgba(0,105,217,0.25)]">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <span className="font-semibold text-[15px] text-label-primary block">
                      AI Assistant
                    </span>
                    <span className="text-[11px] text-label-quaternary">Your portfolio co-pilot</span>
                  </div>
                </div>
                <button
                  onClick={() => setShowChat(false)}
                  className="p-2 text-label-quaternary hover:text-label-primary hover:bg-system-bg-secondary rounded-full transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="h-[70vh] lg:h-[520px]">
                <EnhancedChat
                  address={displayAddress}
                  hideHeader={true}
                  onActionTrigger={(action, params) => {
                    switch (action) {
                      case 'analyze':
                        handleNavChange('signals', 'markets');
                        setShowChat(false);
                        break;
                      case 'status':
                        handleNavChange('portfolio', 'positions');
                        setShowChat(false);
                        break;
                      default:
                        // hedge/swap actions dropped: SUI-only mode hedges
                        // via the auto-hedge cron, not manual modals.
                        logger.info('Chat action triggered', {
                          component: 'DashboardPage',
                          data: { action, params },
                        });
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Chat FAB. Hidden when chat is open. Positioned above mobile tab
          bar on small screens, bottom-right on desktop. */}
      {!showChat && (
        <button
          onClick={() => setShowChat(true)}
          className="fixed bottom-[calc(64px+env(safe-area-inset-bottom))] right-4 lg:bottom-6 lg:right-6 z-40 w-12 h-12 lg:w-14 lg:h-14 bg-ios-blue hover:bg-ios-blueHover text-white rounded-full shadow-ios-3 hover:shadow-ios-3 transition-all duration-200 flex items-center justify-center active:scale-[0.96]"
          aria-label="Open AI assistant"
        >
          <MessageSquare className="w-5 h-5 lg:w-6 lg:h-6" />
        </button>
      )}
    </div>
  );

  function renderContent() {
    switch (activeDest) {
      case 'pool':
        return <CommunityPool address={primaryChain === 'hedera' ? displayAddress : undefined} />;

      case 'portfolio':
        switch (activeView) {
          case 'positions':
            return (
              <Card>
                <CardHeader title="Positions" subtitle="Your holdings and portfolios" />
                <PositionsList address={portfolioAddress} />
              </Card>
            );
          case 'hedges':
            return (
              <Card>
                <CardHeader title="Active hedges" subtitle="Positions that protect your portfolio" />
                <ChainHedges onGoToPool={() => handleNavChange('pool')} />
              </Card>
            );
          case 'products':
            return <PortfolioTab />;
          default:
            return (
              <div className="space-y-3 sm:space-y-6">
                <Card>
                  <PortfolioOverview
                    address={portfolioAddress}
                    onNavigateToPositions={() => handleNavChange('portfolio', 'positions')}
                    onNavigateToHedges={() => handleNavChange('portfolio', 'hedges')}
                  />
                </Card>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-6 items-stretch">
                  <Card className="flex flex-col">
                    <CardHeader title="Risk" />
                    <div className="flex-1">
                      <RiskMetrics address={portfolioAddress} />
                    </div>
                  </Card>
                  <Card className="flex flex-col">
                    <CardHeader
                      title="Active hedges"
                      action={
                        <button
                          onClick={() => handleNavChange('portfolio', 'hedges')}
                          className="flex items-center gap-1 text-sm text-ios-blue font-medium hover:opacity-80 transition-opacity"
                        >
                          View all <ChevronRight className="w-4 h-4" />
                        </button>
                      }
                    />
                    <div className="flex-1">
                      <ChainHedges compact onGoToPool={() => handleNavChange('pool')} />
                    </div>
                  </Card>
                </div>
              </div>
            );
        }

      case 'signals':
        if (activeView === 'agents') {
          return (
            <div className="space-y-3 sm:space-y-6">
              <Card>
                <CardHeader
                  title="Live autonomy"
                  subtitle="What the trading system is doing right now"
                  badge={<Badge color="green">ACTIVE</Badge>}
                />
                <LiveAutonomyPanel />
              </Card>
              {isConnected && (
                <Card>
                  <CardHeader title="Your agent activity" subtitle="Recent tasks and proofs for your wallet" />
                  <AgentActivity address={portfolioAddress} />
                </Card>
              )}
              <AgentAlert message={agentMessage} onDismiss={() => setAgentMessage(null)} />
            </div>
          );
        }
        return (
          <div className="space-y-3 sm:space-y-6">
            <FiveMinSignalWidget />
            <MarketLeanBoard />
            <AgentAlert message={agentMessage} onDismiss={() => setAgentMessage(null)} />
          </div>
        );

      case 'platform':
        switch (activeView) {
          case 'custody':
            return <CustodyTab />;
          case 'admin':
            return (
              <Card>
                <CardHeader title="Admin" subtitle="Treasury actions need a quorum of approvers" />
                <B2bAdminPanel />
              </Card>
            );
          default:
            return <RiskTab />;
        }

      case 'account':
        return (
          <Card>
            <CardHeader
              title="Account"
              subtitle="Your sign-in, display name and balances"
            />
            <ProfileTab />
          </Card>
        );

      default:
        return null;
    }
  }
}

// Reusable Card component. Unified radius (2xl mobile, 3xl desktop),
// softer border + shadow so panels feel like paper on a light background,
// not stamped-out modal boxes. Uses design tokens throughout.
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`bg-white rounded-2xl sm:rounded-3xl border border-label-primary/[0.06] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] overflow-hidden ${className}`}
    >
      {children}
    </section>
  );
}

// Card Header. Tightened padding scale, consistent title size that scales
// on desktop, subtitle uses text-tertiary (readable) not text-quaternary.
function CardHeader({
  title,
  subtitle,
  action,
  badge,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <header className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-label-primary/[0.06]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base sm:text-lg font-semibold text-label-primary tracking-[-0.01em]">
              {title}
            </h2>
            {badge}
          </div>
          {subtitle && (
            <p className="text-xs sm:text-sm text-label-tertiary mt-1">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
    </header>
  );
}

// AgentAlert. Shared for Overview + AI Agents tabs. Dismissable so users
// can clear it manually instead of waiting for the auto-timeout. Uses
// design tokens throughout (was raw ios-blue/5, ios-blue/20 with
// hardcoded pixel radii and mixed icon sizes).
function AgentAlert({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <aside className="p-4 sm:p-6 bg-ios-blue/5 border border-ios-blue/15 rounded-2xl">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 sm:w-11 sm:h-11 bg-ios-blue rounded-ios-xl flex items-center justify-center flex-shrink-0 shadow-ios-1">
          <Bot className="w-5 h-5 sm:w-5 sm:h-5 text-white" strokeWidth={2.2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="font-semibold text-label-primary text-sm sm:text-base">
              Agent update
            </h3>
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="p-1 -m-1 text-label-quaternary hover:text-label-secondary transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <p className="text-label-secondary text-sm sm:text-[15px] whitespace-pre-line leading-relaxed">
            {message}
          </p>
        </div>
      </div>
    </aside>
  );
}

// Badge component. Token-based colors, soft-tint variant available.
// WCAG-safe: on colored bg, text-white; on white bg, tint + colored text.
function Badge({
  children,
  color,
  variant = 'solid',
}: {
  children: React.ReactNode;
  color: 'green' | 'blue' | 'teal';
  variant?: 'solid' | 'soft';
}) {
  const solid = {
    green: 'bg-ios-green text-white',
    blue: 'bg-ios-blue text-white',
    teal: 'bg-hedera-teal text-white',
  } as const;
  const soft = {
    green: 'bg-ios-green/10 text-green-700',
    blue: 'bg-ios-blue/10 text-blue-700',
    teal: 'bg-hedera-teal/10 text-teal-700',
  } as const;
  const cls = variant === 'soft' ? soft[color] : solid[color];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full ${cls}`}
    >
      {color === 'green' && variant === 'solid' && (
        <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
      )}
      {children}
    </span>
  );
}

/**
 * SidebarWalletCard. Avatar + display name (or truncated address) + sub-label.
 * Used by both mobile and desktop sidebars to render consistent identity.
 * Same avatar seed / same name source as the community leaderboard and
 * Profile tab. Edit once, updates everywhere.
 */
function SidebarWalletCard({
  address,
  displayName,
  chain,
  isConnected,
  subLabel,
  size,
}: {
  address: string;
  displayName: string | null;
  chain: WalletChain | null;
  isConnected: boolean;
  subLabel: string;
  size: number;
}) {
  const truncated = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Not Connected';
  const primary = displayName || truncated;
  const textSize = size >= 48 ? 'text-[15px]' : 'text-sm';
  const subSize = size >= 48 ? 'text-[13px]' : 'text-xs';
  return (
    <div className="flex items-center gap-3 min-w-0">
      {chain === 'sui' || chain === 'solana' ? (
        <div
          className="rounded-full bg-[#f5f5f7] flex items-center justify-center flex-shrink-0"
          style={{ width: size, height: size }}
        >
          <ChainLogo chain={chain} size={Math.round(size * 0.55)} />
        </div>
      ) : (
        <div className="relative flex-shrink-0">
          <WalletAvatar address={address || null} name={displayName} size={size} />
          {chain === 'hedera' && isConnected && (
            <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-white p-[2px] shadow-sm">
              <ChainLogo chain="hedera" size={Math.round(size * 0.32)} />
            </span>
          )}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className={`${textSize} font-semibold text-label-primary truncate tracking-[-0.01em]`}>
          {isConnected ? primary : 'Not Connected'}
        </p>
        {isConnected && chain ? (
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <ChainBadge chain={chain} />
            <FundsTag chain={chain} />
            <span className={`${subSize} text-ios-blue`}>Switch</span>
            {subLabel && <span className={`${subSize} text-label-quaternary tabular-nums truncate`}>{subLabel}</span>}
          </div>
        ) : (
          <p className={`${subSize} text-label-quaternary tracking-[-0.003em] truncate`}>
            {subLabel}
          </p>
        )}
      </div>
    </div>
  );
}
