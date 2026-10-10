/**
 * What may be tracked in this public repository.
 *
 * The repo is public so the contracts and the app can be verified, not to
 * publish how the platform is operated. The rule was prose for months and
 * drifted: host install scripts, systemd units for services that were never
 * installed, and a second scheduler definition all sat on HEAD.
 *
 * This test freezes the documentation set and bans the operational file
 * classes outright. Adding a doc is a deliberate edit to DOCS_ALLOWED below;
 * operational material belongs in the gitignored local homes instead.
 */
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .split(/\r?\n/)
  .map((f) => f.trim())
  .filter(Boolean);

/** Docs tracked when the policy was first enforced. Shrink it; grow it only on purpose. */
const DOCS_ALLOWED = new Set([
  'docs/AB_TESTING.md',
  'docs/AI_TRAINING_WORKFLOW.md',
  'docs/ARCHITECTURE.md',
  'docs/BUG_BOUNTY.md',
  'docs/CHANGELOG.md',
  'docs/CODE_OF_CONDUCT.md',
  'docs/CONTRIBUTING.md',
  'docs/CUSTODY_ATTESTATION_SPEC.md',
  'docs/DB_BACKUP.md',
  'docs/DEPLOY_RUNBOOK.md',
  'docs/GOOGLE_ADS_PLAYBOOK.md',
  'docs/INTERNAL_AUDIT_PACKET.md',
  'docs/JOBS_SERVICE_DIAGNOSIS.md',
  'docs/MSAFE_ADMINCAP_MIGRATION.md',
  'docs/NEXT_SESSION_CHECKLIST.md',
  'docs/PAPER_TO_MAINNET_READINESS.md',
  'docs/PAPER_TRADER_HORIZON_ALIGNMENT.md',
  'docs/README.md',
  'docs/ROADMAP.md',
  'docs/SECURITY.md',
  'docs/SEO_RUNBOOK.md',
  'docs/SETUP.md',
  'docs/SLO_AND_RUNBOOKS.md',
  'docs/SUI_DEPLOYMENT.md',
  'docs/VISION.md',
  'docs/guides/HEDGE_FUND_MANAGER_DECISION_FLOW.md',
  'docs/guides/TESTNET_DEMO_GUIDE.md',
  'docs/guides/X402_GASLESS_INTEGRATION.md',
  'docs/history/E2E_TEST_REPORT.md',
  'docs/history/INVESTOR_PITCH_DECK.md',
  'docs/history/MAINNET_MIGRATION_GUIDE.md',
  'docs/history/MAINNET_READINESS.md',
  'docs/history/SCALABILITY_ANALYSIS.md',
  'docs/history/march-2026-monthly-report.md',
  'docs/history/monthly-submission-april-2026.md',
  'docs/history/monthly-submission-may-2026.md',
  'docs/history/sui-directory-submission-final.md',
  'docs/history/week-11-submission.md',
  'docs/history/week-13-17-april-submission.md',
  'docs/history/week-18-22-submission.md',
  'docs/history/week-20-24-april-submission.md',
  'docs/history/week-23-27-march-submission.md',
  'docs/history/week-27-1-may-submission.md',
  'docs/history/week-27-1st-may-submission.md',
  'docs/history/week-30-3-april-submission.md',
  'docs/history/week-6-10-april-submission.md',
  'docs/history/week-8-10-may-submission.md',
  'docs/integrations/MOONLANDER_INTEGRATION.md',
  'docs/reports/COMPLETE_SYSTEM_TEST_REPORT.md',
]);

/** Top-level prose files. The last three predate enforcement and await triage. */
const TOP_LEVEL_PROSE_ALLOWED = new Set(['README.md', 'DEPLOYMENT_CHECKLIST.md', 'HACKATHON_TODO.md', 'awesomedesign.md']);

/** Local-only homes: reaching the index means someone forced an add past .gitignore. */
const LOCAL_ONLY: RegExp[] = [
  /^docs\/_ops\//,
  /^scripts\/_/,
  /^app\/api\/_/,
  /^components\/_/,
  /^\.claude\//,
  /^graphify-out\//,
  /^\.playwright-mcp\//,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)\.env\.local$/,
];

describe('tracked files policy', () => {
  it('lists the repository', () => {
    expect(tracked.length).toBeGreaterThan(500);
  });

  it('no host service definitions or install/deploy scripts', () => {
    const offenders = tracked.filter(
      (f) => f.startsWith('services/') || /\.(service|timer)$/.test(f) || /(^|\/)(install|deploy)\.sh$/.test(f),
    );
    expect(offenders).toEqual([]);
  });

  it('no document outside the frozen docs set', () => {
    const offenders = tracked.filter((f) => f.startsWith('docs/') && !DOCS_ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });

  it('no new top-level prose file', () => {
    const offenders = tracked.filter(
      (f) => !f.includes('/') && /\.(md|txt)$/i.test(f) && !TOP_LEVEL_PROSE_ALLOWED.has(f),
    );
    expect(offenders).toEqual([]);
  });

  it('nothing from a local-only home', () => {
    const offenders = tracked.filter((f) => LOCAL_ONLY.some((re) => re.test(f)));
    expect(offenders).toEqual([]);
  });
});
