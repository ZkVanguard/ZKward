/**
 * Vercel project configuration.
 *
 * Migrated from vercel.json → vercel.ts on 2026-08-11 per the modern
 * Vercel recommendation (typed config + dynamic logic + env-var access).
 * See https://vercel.com/docs/project-configuration/vercel-ts
 */
import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  framework: 'nextjs',

  // sin1 keeps the pool's serverless functions co-located with the
  // Aiven PG-17 primary in Bangalore (~50ms same-region vs ~250ms
  // cross-region). All capital-touching crons + reads benefit; the
  // 20-conn plan-wide DB limit makes locality especially important.
  regions: ['sin1'],

  // Only auto-deploy production (main). Every other branch skips
  // Vercel's preview build via ignoreCommand.
  //
  // Vercel ignoreCommand semantics: exit 0 = SKIP the build, exit 1
  // = PROCEED with build. The `!=` in the test means:
  //   - Pushed to main: test returns false → exit 1 → BUILD ✓
  //   - Pushed to any other branch: test returns true → exit 0 → SKIP ✓
  //
  // Manual deploys still available via the main-manual deploy hook or
  // `vercel deploy --prod`.
  ignoreCommand: 'sh -c \'[ "$VERCEL_GIT_COMMIT_REF" != "main" ]\'',

  installCommand: 'npm install --legacy-peer-deps',

  build: {
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
      // Silence deprecation warnings from transitive web3 deps at build time.
      // Runtime deprecations still surface — this only affects the build log.
      NODE_OPTIONS: '--no-deprecation',
    },
  },

  // Security headers live in next.config.js's headers() block so they're
  // route-aware. Leaving this empty avoids duplication.
  headers: [],

  // ──────────────────────────────────────────────────────────────────
  // Vercel Cron — QStash alternative
  // ──────────────────────────────────────────────────────────────────
  // The Upstash QStash schedule quota is 10/10 used. Adding a new
  // cron there requires either upgrading the plan or dropping an
  // existing schedule. Vercel Cron is native to the platform, has no
  // schedule-count cap on Pro, and triggers routes via a signed
  // Bearer token (CRON_SECRET). See verifyCronRequest() — it already
  // accepts both QStash-signed and CRON_SECRET-bearer requests, so
  // routes work under either scheduler without code changes.
  //
  // Rollout: enable one route at a time here. Every route must:
  //   (1) call verifyCronRequest(request, '<RouteName>') at top,
  //   (2) use tryClaimCronRun() to survive double-fire (QStash + Vercel
  //       both wired = zero-downtime cutover),
  //   (3) heartbeat via setCronState('cron:lastRun:<route>', now).
  //
  // Once Vercel Cron owns a schedule, delete the QStash entry to
  // reclaim the quota slot.
  crons: [
    // Uncomment as we cut each schedule over. Currently empty — all
    // schedules still live in Upstash QStash. First candidate is
    // pool-nav-monitor once Substreams push is scaffolded.
    //
    // { path: '/api/cron/pool-nav-monitor', schedule: '*/15 * * * *' },
    // { path: '/api/cron/bluefin-health', schedule: '*/5 * * * *' },
  ],
};

export default config;
