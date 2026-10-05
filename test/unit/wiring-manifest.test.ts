/**
 * Wiring manifest — guards against the "built but unwired" disease.
 *
 * Three separate incidents of shipped-but-disconnected infrastructure:
 *   • 2026-09-21: 995 LOC of prediction-market services unwired
 *   • 2026-09-27: signal_outcomes ledger — full API, 0 write call sites
 *   • 2026-09-27: trailing stop that had never fired once
 *
 * This test asserts that the named learning-loop write paths each have at
 * least one production call site OUTSIDE their defining module. If you
 * delete the last caller, this fails and you must either rewire or delete
 * the orphaned module — never leave it dark.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['lib', 'app', 'agents'];

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const allFiles = SCAN_DIRS.flatMap((d) => walkTsFiles(path.join(ROOT, d)));
const contents = new Map(allFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));

function productionCallSites(fnName: string, definingFileSuffix: string): string[] {
  const call = new RegExp(`(?<![\\w.])${fnName}\\s*\\(`);
  const hits: string[] = [];
  for (const [file, text] of contents) {
    if (file.replace(/\\/g, '/').endsWith(definingFileSuffix)) continue;
    if (call.test(text)) hits.push(path.relative(ROOT, file));
  }
  return hits;
}

describe('learning-loop write paths are wired', () => {
  const manifest: Array<{ fn: string; definedIn: string }> = [
    { fn: 'recordSignal', definedIn: 'lib/db/signal-outcomes.ts' },
    { fn: 'resolveExpiredSignals', definedIn: 'lib/db/signal-outcomes.ts' },
    { fn: 'runSignalLedgerTick', definedIn: 'lib/services/market-data/signal-ledger.ts' },
    { fn: 'getLedgerBucketRows', definedIn: 'lib/db/signal-outcomes.ts' },
    { fn: 'runFeedbackLoopEvaluation', definedIn: 'lib/services/market-data/feedback-loop.ts' },
    { fn: 'applyLoopVerdicts', definedIn: 'lib/services/market-data/feedback-loop.ts' },
    { fn: 'gateRefusals', definedIn: 'lib/services/paper-trader/entry-gates.ts' },
    { fn: 'recordInterpretation', definedIn: 'lib/db/signal-interpretations.ts' },
    { fn: 'recordSourceOutcome', definedIn: 'lib/services/ai/source-calibrator.ts' },
    { fn: 'recordOutcome', definedIn: 'lib/services/ai/probability-calibrator.ts' },
  ];

  for (const { fn, definedIn } of manifest) {
    it(`${fn} (${definedIn}) has ≥1 production call site`, () => {
      const sites = productionCallSites(fn, definedIn);
      expect(sites.length).toBeGreaterThan(0);
    });
  }
});
