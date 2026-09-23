'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import nextDynamic from 'next/dynamic';
import { useAccount, useBalance } from '@/lib/evm-wallet/hooks';
import {
  Bot,
  Shield,
  Briefcase,
  TrendingUp,
  BarChart3,
  MessageSquare,
  ChevronRight,
  X,
  Settings,
  Users,
  Activity,
  ShieldCheck,
  Layers,
  MoreHorizontal,
  Coins,
  UserCog,
} from 'lucide-react';
import { MobileTabBar } from '@/components/dashboard/MobileTabBar';
import { WalletAvatar } from '@/components/ui/WalletAvatar';
import { useUserSession } from '@/lib/hooks/useUserSession';
import { useContractAddresses } from '@/lib/contracts/hooks';
import { usePositions } from '@/contexts/PositionsContext';
import { usePortfolioAction, type CustomActionPayload } from '@/contexts/AIDecisionsContext';
import { logger } from '@/lib/utils/logger';
import { useSui } from '@/app/sui-providers';
import type { PredictionMarket } from '@/lib/services/market-data/DelphiMarketService';

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

const ActiveHedges = nextDynamic(
  () =>
    import('@/components/dashboard/ActiveHedges').then((mod) => ({ default: mod.ActiveHedges })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

// SUI-only mode: EVM/Cronos-bound widgets were removed with the dead-code
// cleanup. Hedging is driven by the SUI Community Pool + BlueFin auto-hedge
// cron instead of manual modals. Re-add here when other chains re-enable.

const PredictionInsights = nextDynamic(
  () =>
    import('@/components/dashboard/PredictionInsights').then((mod) => ({
      default: mod.PredictionInsights,
    })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

const EnhancedChat = nextDynamic(
  () =>
    import('@/components/dashboard/EnhancedChat').then((mod) => ({ default: mod.EnhancedChat })),
  {
    loading: () => null,
    ssr: false,
  }
);

const SettingsModal = nextDynamic(
  () =>
    import('@/components/dashboard/SettingsModal').then((mod) => ({ default: mod.SettingsModal })),
  {
    ssr: false,
  }
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

// Hedera x402 agent payments demo. Pay-per-call inference with HCS audit trail.
const HederaAgentPayments = nextDynamic(
  () =>
    import('@/components/dashboard/HederaAgentPayments').then((mod) => ({ default: mod.HederaAgentPayments })),
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

// Navigation configuration
interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

// Primary nav. Surfaces the daily user actions (deposit + monitor).
// "Pool" first (was "Vault" — collided with the top-navbar entry link).
// Top navbar's "Vault" is the product entry; sidebar tab is the specific
// deposit/withdraw section, so keep the labels distinct.
const navItems: NavItem[] = [
  { id: 'community', label: 'Pool', icon: Users },
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'positions', label: 'Positions', icon: Briefcase },
  { id: 'hedges', label: 'Hedges', icon: Shield },
  { id: 'agents', label: 'AI Agents', icon: Bot, badge: 'Live' },
  { id: 'insights', label: 'Insights', icon: TrendingUp },
];

// Platform nav. Sub-tabs consolidated from former /dashboard/{portfolio,risk,
// custody} sub-routes. Rendered in a secondary sidebar section so they stay
// visually separated from the daily-use tabs above.
const platformItems: NavItem[] = [
  { id: 'portfolio', label: 'Portfolio', icon: Layers },
  { id: 'risk', label: 'Risk', icon: Activity },
  { id: 'custody', label: 'Custody', icon: ShieldCheck },
  { id: 'admin', label: 'B2B Admin', icon: Settings, badge: 'Privy' },
  { id: 'x402', label: 'Agent Payments', icon: Coins, badge: 'Hedera' },
  { id: 'profile', label: 'Profile', icon: UserCog },
];

type NavId = (typeof navItems)[number]['id'] | (typeof platformItems)[number]['id'];

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
  const suiAddress = sui.address;
  const suiConnected = sui.isConnected;
  const suiBalance = sui.balance;

  // Primary display address. SUI wins if connected (SUI-native pages),
  // otherwise the unified Privy session. Deliberately does NOT fall back
  // to wagmi's evmAddress: injected wallets (MetaMask, OKX, Rabby via
  // EIP-6963) auto-connect on page load even when the user hasn't
  // clicked Sign In, causing a phantom "connected" address in the
  // sidebar. Sidebar identity requires an EXPLICIT sign-in (SUI or Privy).
  const isConnected = suiConnected || session.authenticated;
  const address = suiAddress || session.address || '';
  const displayBalance = suiConnected
    ? `${suiBalance} SUI`
    : session.authenticated && session.balances.ready
      ? `${session.balances.hbarHuman.toFixed(4)} HBAR`
      : '';

  const contractAddresses = useContractAddresses();
  // Get portfolio count and other data from centralized context - no redundant fetches!
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { derived } = usePositions();
  // Use centralized AI service for portfolio actions
  const { requestCustomAction } = usePortfolioAction();
  // Portfolio count available via derived?.portfolioCount if needed

  // Default to the Pool tab. Clicking "Vault" in the top nav should land the
  // user on the actual deposit/withdraw surface, not a generic dashboard view.
  const [activeNav, setActiveNav] = useState<NavId>('community');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);

  const displayAddress = address || '';
  // SUI-only mode: portfolio asset universe is fixed to SUI/USDC.
  const portfolioAssets = ['SUI', 'USDC'];

  // useCallback stabilises the refs so memoized children (ActiveHedges,
  // MobileTabBar, etc.) don't re-render on every parent state change
  // (notification, agentMessage, etc.). Setter fns from useState are
  // stable by React contract, so the empty dep list is correct.
  const handleNavChange = useCallback((id: NavId) => {
    setActiveNav(id);
    setMobileMenuOpen(false);
  }, []);

  const openChat = useCallback(() => setShowChat(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const handleOpenHedge = useCallback(async (market: PredictionMarket) => {
    logger.info('Hedge button clicked', { component: 'DashboardPage', data: market });
    logger.info('🛡️ Opening hedge on Moonlander', { data: market.question });

    // Show initial loading notification (no setTimeout yet)
    const loadingMsg = `🛡️ Processing hedge request...`;
    logger.debug('Setting notification', { component: 'DashboardPage', data: loadingMsg });
    setNotification(loadingMsg);

    try {
      // Determine primary asset to hedge
      const primaryAsset = market.relatedAssets[0] || 'BTC';

      // Calculate notional value based on probability (higher probability = larger hedge)
      const baseNotional = 1000; // $1000 base hedge
      const notionalValue = baseNotional * (market.probability / 100);

      logger.debug('Hedge parameters', {
        component: 'DashboardPage',
        data: {
          asset: primaryAsset,
          notionalValue,
          leverage: 5,
        },
      });

      const response = await fetch('/api/agents/hedging/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId: 1,
          asset: primaryAsset,
          side: 'SHORT',
          notionalValue: Math.round(notionalValue),
          leverage: 5,
          reason: market.question,
          // Enable auto-approval for prediction market triggered hedges
          autoApprovalEnabled: true,
          autoApprovalThreshold: 50000,
          walletAddress: address, // Associate hedge with connected wallet
        }),
      });

      logger.debug('API Response status', { component: 'DashboardPage', data: response.status });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      logger.debug('API Response data', { component: 'DashboardPage', data });

      if (data.success) {
        const simulationBadge = data.simulationMode
          ? '\n\n⚠️ SIMULATION MODE'
          : '\n\n🔴 LIVE TRADING';
        const msg = `✅ Hedge Opened Successfully\n\nMarket: ${data.market}\nSide: ${data.side}\nSize: ${data.size}\nEntry: $${data.entryPrice || 'Pending'}\nLeverage: ${data.leverage}x${simulationBadge}`;
        logger.info('Setting success notification', { component: 'DashboardPage' });
        setNotification(msg);
        logger.info('✅ Moonlander hedge successful', data);

        // Auto-clear after 10 seconds
        setTimeout(() => {
          logger.debug('Clearing notification', { component: 'DashboardPage' });
          setNotification(null);
        }, 10000);
      } else {
        throw new Error(data.error || 'Hedge execution failed');
      }
    } catch (error) {
      logger.error('Hedge error', error instanceof Error ? error : undefined, {
        component: 'DashboardPage',
      });
      logger.error('❌ Moonlander hedge failed', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMsg = error instanceof Error ? error.message : 'Unknown error occurred';
      setNotification(`❌ Hedge Failed\n\n${errorMsg}\n\nCheck browser console for details.`);

      // Auto-clear error after 10 seconds
      setTimeout(() => setNotification(null), 10000);
    }
  }, []);

  const handleAgentAnalysis = async (market: PredictionMarket) => {
    logger.info('🤖 Triggering AI Agent Analysis', { market: market.question });

    // Show loading message (icons rendered in the alert component; keep
    // the text emoji-free so it composes with lucide icons upstream).
    setAgentMessage(
      'Analyzing…\n\nRisk, Hedging, and Settlement agents are evaluating your portfolio.'
    );

    try {
      // Use centralized AI service with caching
      const actionPayload: CustomActionPayload = {
        portfolioId: 1,
        currentValue: 50000,
        targetYield: 12,
        riskTolerance: 50,
        assets: market.relatedAssets,
        predictions: [
          {
            question: market.question,
            probability: market.probability,
            impact: market.impact,
            recommendation: market.recommendation || 'HOLD',
            source: market.source,
          },
        ],
        realMetrics: {
          riskScore: market.probability,
          volatility: 0.35,
          sharpeRatio: 1.2,
          hedgeSignals: market.recommendation === 'HEDGE' ? 1 : 0,
          totalValue: 50000,
        },
      };

      const data = await requestCustomAction(actionPayload, true);

      if (!data) {
        throw new Error('AI analysis returned no data');
      }

      // Format the AI response
      const agentName = 'AI Agent';
      const reasoning =
        typeof data.reasoning === 'string' ? data.reasoning.slice(0, 200) : 'Analysis complete';

      const msg = `${agentName}\n\nAction: ${data.action}\nConfidence: ${Math.round(data.confidence * 100)}%\nUrgency: ${data.urgency}\n\n${reasoning}`;

      setAgentMessage(msg);
      logger.info('AI analysis complete', { action: data.action, confidence: data.confidence });
    } catch (error) {
      logger.error('AI analysis failed', { error });
      setAgentMessage('Analysis failed.\n\nCheck the console for details or try again in a moment.');
    }

    // Auto-dismiss after 15 seconds
    setTimeout(() => setAgentMessage(null), 15000);
  };

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
          (secondary items: portfolio/risk/custody/settings) is via the 'More'
          tab in the bottom bar. */}
      <header className="lg:hidden fixed top-[52px] left-0 right-0 z-40 bg-white/95 backdrop-blur-xl border-b border-black/5">
        <div className="flex items-center justify-between px-4 h-12">
          {/* Uses <p role=heading aria-level=1> instead of a second <h1>.
              The desktop h1 below is display:none on mobile, and vice versa,
              but audit tools count both DOM nodes. Screen readers still
              announce this as a level-1 heading via ARIA. */}
          <p role="heading" aria-level={1} className="text-[17px] font-semibold text-label-primary tracking-tight truncate m-0">
            {[...navItems, ...platformItems].find((n) => n.id === activeNav)?.label}
          </p>

          <button
            onClick={() => setShowChat(true)}
            className="p-2 -mr-2 text-ios-blue active:scale-[0.96] transition-transform"
            aria-label="Open chat"
          >
            <MessageSquare className="w-5 h-5" />
          </button>
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
            <SidebarWalletCard
              address={displayAddress}
              displayName={session.displayName}
              isSui={suiConnected}
              isConnected={isConnected}
              subLabel={isConnected ? displayBalance : 'Connect Wallet'}
              size={40}
            />
          </div>

          {/* Mobile Nav */}
          <nav className="flex-1 py-2 overflow-y-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavChange(item.id)}
                  className={`
                    w-full flex items-center gap-3 px-4 py-3 text-left transition-colors
                    ${
                      isActive
                        ? 'bg-ios-blue/10 border-r-2 border-ios-blue'
                        : 'hover:bg-system-bg-secondary'
                    }
                  `}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-ios-blue' : 'text-label-quaternary'}`} />
                  <span className={`font-medium ${isActive ? 'text-ios-blue' : 'text-label-primary'}`}>
                    {item.label}
                  </span>
                  {item.badge && (
                    <span className="ml-auto px-2 py-0.5 text-xs font-semibold bg-ios-green text-white rounded-full">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Mobile Menu Footer */}
          <div className="p-4 border-t border-black/5">
            <button
              onClick={() => {
                setSettingsOpen(true);
                setMobileMenuOpen(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-system-bg-secondary rounded-[18px] transition-colors"
            >
              <Settings className="w-5 h-5 text-label-quaternary" />
              <span className="font-medium text-label-primary">Settings</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Desktop Layout */}
      <div className="flex pt-[52px]">
        {/* Desktop Sidebar - Hidden on mobile */}
        <aside className="hidden lg:flex w-64 h-[calc(100vh-52px)] sticky top-[52px] flex-col bg-white border-r border-black/5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          {/* Wallet Section — desktop */}
          <div className="p-5 border-b border-black/5">
            <SidebarWalletCard
              address={displayAddress}
              displayName={session.displayName}
              isSui={suiConnected}
              isConnected={isConnected}
              subLabel={isConnected ? displayBalance : 'Connect Wallet'}
              size={48}
            />
          </div>

          {/* Desktop Navigation */}
          <nav className="flex-1 py-4 overflow-y-auto">
            <p className="px-5 mb-3 text-[13px] font-semibold text-label-quaternary uppercase tracking-[0.06em]">
              Menu
            </p>

            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => setActiveNav(item.id)}
                  className={`
                    w-[calc(100%-16px)] mx-2 mb-1 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]
                    ${
                      isActive
                        ? 'bg-ios-blue shadow-[0_2px_8px_rgba(0,105,217,0.25)]'
                        : 'hover:bg-system-bg-secondary'
                    }
                  `}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-label-quaternary'}`} />
                  <span
                    className={`text-[15px] font-medium tracking-[-0.01em] ${isActive ? 'text-white' : 'text-label-primary'}`}
                  >
                    {item.label}
                  </span>
                  {item.badge && (
                    <span
                      className={`
                      ml-auto px-2 py-0.5 text-[11px] font-semibold rounded-full shadow-sm
                      ${isActive ? 'bg-white/20 text-white' : 'bg-ios-green text-white'}
                    `}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="my-4 mx-4 border-t border-black/5" />

            <p className="px-5 mb-3 text-[13px] font-semibold text-label-quaternary uppercase tracking-[0.06em]">
              Platform
            </p>

            {platformItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveNav(item.id)}
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

            <div className="my-4 mx-4 border-t border-black/5" />

            <button
              onClick={() => setSettingsOpen(true)}
              className="w-[calc(100%-16px)] mx-2 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left hover:bg-system-bg-secondary transition-colors duration-200"
            >
              <Settings className="w-5 h-5 text-label-quaternary" strokeWidth={2} />
              <span className="text-[15px] font-medium text-label-primary tracking-[-0.01em]">
                Settings
              </span>
            </button>
          </nav>

          {/* AI Assistant Button */}
          <div className="p-4 border-t border-black/5">
            <button
              onClick={() => setShowChat(true)}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-3 bg-ios-blue text-white rounded-[14px] text-[15px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all duration-200 shadow-[0_4px_12px_rgba(0,122,255,0.3)]"
            >
              <MessageSquare className="w-5 h-5" strokeWidth={2.5} />
              AI Assistant
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 min-h-[calc(100vh-52px)] pt-12 lg:pt-0 pb-[calc(52px+env(safe-area-inset-bottom))] lg:pb-0">
          <div className="max-w-[1280px] mx-auto px-3 sm:px-5 py-3 sm:py-6 lg:px-8 lg:py-10">
            {/* Page Header — desktop-only large title. Uses the design
                token `text-large-title` (34px, per-Apple line-height +
                tracking). Sentence-case, tight tracking, no gradient. */}
            <div className="hidden lg:block mb-8">
              <h1 className="text-large-title text-label-primary tracking-[-0.02em]">
                {[...navItems, ...platformItems].find((n) => n.id === activeNav)?.label}
              </h1>
            </div>

            {/* Content Area. Keyed on activeNav so React tears down + remounts
                the tab's subtree, giving each tab-switch a natural fade-in
                (paired with the animate-fade-in class). Feels closer to
                UINavigationController on iOS than a raw conditional swap. */}
            <Suspense fallback={<LoadingSkeleton height="h-96" />}>
              <div key={activeNav} className="animate-fade-in">
                {renderContent()}
              </div>
            </Suspense>
          </div>
        </main>
      </div>

      {/* iOS-style bottom tab bar — primary nav on mobile. 4 tabs + More.
          The "More" button opens the drawer where the wallet controls,
          portfolio/risk/custody sub-pages, and settings live. Reduces the
          old 4-tap "menu → drawer → tab → close" flow to 1 tap. */}
      <MobileTabBar
        items={navItems.slice(0, 4)}
        activeId={activeNav}
        onSelect={(id) => handleNavChange(id as NavId)}
        onOpenMore={() => setMobileMenuOpen(true)}
        moreLabel="More"
        moreIcon={MoreHorizontal}
      />

      {/* Notification Toast. Token-based, no raw Tailwind grays */}
      {notification && (
        <div className="fixed top-20 lg:top-[68px] left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300 max-w-md px-4">
          <div className="flex items-start gap-3 px-5 py-4 bg-label-primary text-white rounded-2xl shadow-ios-3">
            <div className="w-2 h-2 mt-1.5 bg-ios-green rounded-full animate-pulse flex-shrink-0" />
            <p className="text-sm font-medium whitespace-pre-line leading-relaxed">
              {notification}
            </p>
          </div>
        </div>
      )}

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
                        setActiveNav('insights');
                        setShowChat(false);
                        break;
                      case 'status':
                        setActiveNav('positions');
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

      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal isOpen={settingsOpen} onClose={closeSettings} />
      )}
    </div>
  );

  // Content renderer
  function renderContent() {
    switch (activeNav) {
      case 'overview':
        return (
          <div className="space-y-3 sm:space-y-6">
            {/* Portfolio Card */}
            <Card>
              <PortfolioOverview
                address={displayAddress}
                onNavigateToPositions={() => setActiveNav('positions')}
                onNavigateToHedges={() => setActiveNav('hedges')}
              />
            </Card>

            {/* Real-time 5-Min BTC Signal */}
            <FiveMinSignalWidget />

            {/* Stats Grid - Stack on mobile, 2 cols on tablet+ */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-6 items-stretch">
              <Card className="flex flex-col">
                <CardHeader title="Risk Metrics" />
                <div className="flex-1">
                  <RiskMetrics address={displayAddress} />
                </div>
              </Card>

              <Card className="flex flex-col">
                <CardHeader
                  title="Active Hedges"
                  action={
                    <button
                      onClick={() => setActiveNav('hedges')}
                      className="flex items-center gap-1 text-sm text-ios-blue font-medium hover:opacity-80 transition-opacity"
                    >
                      View All <ChevronRight className="w-4 h-4" />
                    </button>
                  }
                />
                <div className="flex-1">
                  <ActiveHedges
                    address={displayAddress}
                    compact
                    onOpenChat={openChat}
                  />
                </div>
              </Card>
            </div>

            {/* Agent Alert — shared component (see AgentAlert below) */}
            <AgentAlert message={agentMessage} onDismiss={() => setAgentMessage(null)} />
          </div>
        );

      case 'positions':
        return (
          <Card>
            <CardHeader title="Positions" subtitle="Manage your portfolio holdings" />
            <PositionsList address={displayAddress} onOpenHedge={handleOpenHedge} />
          </Card>
        );

      case 'hedges':
        return (
          <Card>
            <CardHeader title="Active Hedges" subtitle="Your protective positions and options" />
            <ActiveHedges
              address={displayAddress}
              onOpenChat={openChat}
            />
          </Card>
        );

      case 'agents':
        return (
          <div className="space-y-3 sm:space-y-6">
            {/* Live autonomy panel — wallet-agnostic, always visible.
                Reads /api/dashboard/autonomy-status. Proves the machine
                is alive for anonymous visitors. */}
            <Card>
              <CardHeader
                title="Live autonomy"
                subtitle="Real-time system health from cron_state"
                badge={<Badge color="green">ACTIVE</Badge>}
              />
              <LiveAutonomyPanel />
            </Card>

            {/* Per-wallet agent activity — shown ONLY when connected.
                The generic empty state added no signal for anonymous
                visitors; the live panel above serves that need better. */}
            {isConnected && (
              <Card>
                <CardHeader
                  title="Your agent activity"
                  subtitle="Recent tasks + ZK proofs for your wallet"
                />
                <AgentActivity address={displayAddress} />
              </Card>
            )}

            <AgentAlert message={agentMessage} onDismiss={() => setAgentMessage(null)} />
          </div>
        );

      case 'insights':
        return (
          <PredictionInsights
            onOpenHedge={handleOpenHedge}
            onTriggerAgentAnalysis={handleAgentAnalysis}
            assets={portfolioAssets}
          />
        );

      case 'community':
        return (
          <Card>
            <CardHeader
              title="Community Pool"
              subtitle="AI-managed collective investment fund"
              badge={<Badge color="blue">AI DRIVEN</Badge>}
            />
            <CommunityPool address={displayAddress} />
          </Card>
        );

      // Platform tabs. Extracted from former /dashboard/{portfolio,risk,custody}
      // sub-routes. Self-contained (own header + spacing), so no Card wrapper.
      case 'portfolio':
        return <PortfolioTab />;

      case 'risk':
        return <RiskTab />;

      case 'custody':
        return <CustodyTab />;

      case 'profile':
        return <ProfileTab />;

      case 'admin':
        return (
          <Card>
            <CardHeader
              title="B2B Admin Controls"
              subtitle="Privy-authenticated · quorum-gated treasury actions"
              badge={<Badge color="teal">PRIVY QUORUM</Badge>}
            />
            <B2bAdminPanel />
          </Card>
        );

      case 'x402':
        return (
          <Card>
            <CardHeader
              title="Hedera Agent Payments"
              subtitle="x402 pay-per-call inference · HCS audit trail"
              badge={<Badge color="teal">x402 · HEDERA</Badge>}
            />
            <HederaAgentPayments />
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
  isSui,
  isConnected,
  subLabel,
  size,
}: {
  address: string;
  displayName: string | null;
  isSui: boolean;
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
      {isSui ? (
        <div
          className="rounded-full flex items-center justify-center bg-[#4DA2FF] flex-shrink-0"
          style={{ width: size, height: size }}
        >
          <span className={`text-white font-semibold ${textSize}`}>SUI</span>
        </div>
      ) : (
        <WalletAvatar address={address || null} name={displayName} size={size} />
      )}
      <div className="flex-1 min-w-0">
        <p className={`${textSize} font-semibold text-label-primary truncate tracking-[-0.01em]`}>
          {isConnected ? primary : 'Not Connected'}
        </p>
        <p className={`${subSize} text-label-quaternary tracking-[-0.003em] truncate`}>
          {subLabel}
        </p>
      </div>
    </div>
  );
}
