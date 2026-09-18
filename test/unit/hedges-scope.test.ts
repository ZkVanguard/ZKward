import { HEDGES_REAL_ONLY_SQL, realHedgesSql } from '@/lib/db/hedges-scope';

describe('hedges-scope — real-only SQL primitive', () => {
  it('exports the exact "simulation_mode = false" clause', () => {
    expect(HEDGES_REAL_ONLY_SQL).toBe('simulation_mode = false');
  });

  it('appends AND clause when SQL already has WHERE', () => {
    const out = realHedgesSql(`SELECT * FROM hedges WHERE status = 'closed'`);
    expect(out).toBe(
      `SELECT * FROM hedges WHERE status = 'closed' AND simulation_mode = false`,
    );
  });

  it('appends WHERE clause when SQL has none', () => {
    const out = realHedgesSql(`SELECT COUNT(*) FROM hedges`);
    expect(out).toBe(`SELECT COUNT(*) FROM hedges WHERE simulation_mode = false`);
  });

  it('recognizes WHERE case-insensitively', () => {
    const out = realHedgesSql(`SELECT * FROM hedges where status = 'active'`);
    expect(out).toBe(
      `SELECT * FROM hedges where status = 'active' AND simulation_mode = false`,
    );
  });

  it('does NOT get fooled by a column named "swhere_..."', () => {
    // \b word-boundary should prevent that — but pin the behavior.
    const out = realHedgesSql(`SELECT swhere_col FROM hedges`);
    expect(out).toBe(
      `SELECT swhere_col FROM hedges WHERE simulation_mode = false`,
    );
  });
});
