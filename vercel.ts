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

  // The database runs in eastern Canada; functions sit in the nearest
  // region because a page read makes dozens of sequential queries, each a
  // full round trip (about 5 ms from US-east, an estimated 250 ms from
  // Asia). The SUI RPCs, the venue and the market APIs answer in 30-35 ms
  // from there too.
  regions: ['iad1'],

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

  // The platform owns the schedule so the jobs stop when only a self-hosted
  // box dies. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, which
  // verifyCronRequest accepts. A second scheduler firing the same routes is
  // safe: each sub-route claims its own run (tryClaimCronRun).
  crons: [
    { path: '/api/cron/paper-fast-tick', schedule: '* * * * *' },
    { path: '/api/cron/solana-pool', schedule: '* * * * *' },
    { path: '/api/cron/master', schedule: '*/5 * * * *' },
  ],
};

export default config;
