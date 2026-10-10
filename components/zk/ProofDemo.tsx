'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface Made {
  proof: Record<string, unknown>;
  commitment: string;
  verified: boolean;
  seconds: number;
  kilobytes: number;
  caps: { leverage_cap: number; notional_cap_cents: number };
}

type Status = 'idle' | 'proving' | 'refused' | 'busy' | 'failed';

const field = 'w-full rounded-[10px] border border-black/10 bg-white px-3 py-2 text-[15px] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40';
const label = 'block text-[12px] font-medium text-[#6e6e73] mb-1';

/**
 * Makes one hedge policy proof through the public route and shows what the
 * verifier said. The second button asks the verifier the same question under
 * a lower leverage cap, which the proof was not made for.
 */
export function ProofDemo() {
  const t = useTranslations('zkDemo');
  const [leverage, setLeverage] = useState('3');
  const [leverageCap, setLeverageCap] = useState('4');
  const [notional, setNotional] = useState('41000');
  const [notionalCap, setNotionalCap] = useState('1000000');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('SHORT');
  const [status, setStatus] = useState<Status>('idle');
  const [made, setMade] = useState<Made | null>(null);
  const [lower, setLower] = useState<'unknown' | 'checking' | 'refused' | 'accepted'>('unknown');

  async function prove() {
    setStatus('proving');
    setMade(null);
    setLower('unknown');
    const price = 82_000;
    const entryPriceCents = price * 100;
    const sizeMilli = Math.floor((Number(notional) / price) * 1000);
    const caps = { leverage_cap: Math.round(Number(leverageCap)), notional_cap_cents: Math.round(Number(notionalCap) * 100) };
    try {
      const res = await fetch('/api/zk-proof/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hedge: {
            asset: 'BTC', side, leverageX: Number(leverage), sizeMilli, entryPriceCents,
            // The declared notional covers size times price exactly.
            notionalValueUsdcCents: Math.ceil((sizeMilli * entryPriceCents) / 1000), timestampMs: Date.now(),
          },
          caps,
        }),
      });
      if (res.status === 422 || res.status === 400) return setStatus('refused');
      if (res.status === 429) return setStatus('busy');
      const data = await res.json();
      if (!res.ok || !data.success) return setStatus('failed');
      setMade({
        proof: data.proof, commitment: data.commitment, verified: data.verified === true,
        seconds: Math.round(Number(data.duration_ms) / 100) / 10, kilobytes: Math.round(JSON.stringify(data.proof).length / 1024), caps,
      });
      setStatus('idle');
    } catch {
      setStatus('failed');
    }
  }

  async function checkLower() {
    if (!made) return;
    setLower('checking');
    try {
      const res = await fetch('/api/zk-proof/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proof: made.proof, caps: { ...made.caps, leverage_cap: made.caps.leverage_cap - 1 } }),
      });
      const data = await res.json();
      setLower(data.verified === true ? 'accepted' : 'refused');
    } catch {
      setLower('unknown');
    }
  }

  function download() {
    if (!made) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ proof: made.proof, caps: made.caps })], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `zkward-proof-${made.commitment.slice(0, 12)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-[16px] border border-black/5 bg-[#f5f5f7] p-4 sm:p-6">
      <h2 className="text-[17px] font-semibold text-[#1d1d1f] mb-4">{t('hedgeHeading')}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <label className={label} htmlFor="zk-side">{t('side')}</label>
          <select id="zk-side" className={field} value={side} onChange={(e) => setSide(e.target.value as 'LONG' | 'SHORT')}>
            <option value="LONG">{t('long')}</option>
            <option value="SHORT">{t('short')}</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="zk-leverage">{t('leverage')}</label>
          <input id="zk-leverage" className={field} type="number" min={1} step={1} value={leverage} onChange={(e) => setLeverage(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="zk-notional">{t('notional')}</label>
          <input id="zk-notional" className={field} type="number" min={0} value={notional} onChange={(e) => setNotional(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="zk-leverage-cap">{t('leverageCap')}</label>
          <input id="zk-leverage-cap" className={field} type="number" min={2} step={1} value={leverageCap} onChange={(e) => setLeverageCap(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="zk-notional-cap">{t('notionalCap')}</label>
          <input id="zk-notional-cap" className={field} type="number" min={0} value={notionalCap} onChange={(e) => setNotionalCap(e.target.value)} />
        </div>
      </div>
      <p className="mt-3 text-[12px] text-[#6e6e73]">{t('hidden')}</p>

      <button
        type="button"
        onClick={prove}
        disabled={status === 'proving'}
        className="mt-4 rounded-full bg-[#007AFF] px-5 py-2.5 text-[15px] font-semibold text-white disabled:opacity-60"
      >
        {status === 'proving' ? t('proving') : t('prove')}
      </button>

      <div className="mt-4 text-[14px]" aria-live="polite">
        {status === 'refused' && <p className="text-orange-700">{t('refused')}</p>}
        {status === 'busy' && <p className="text-orange-700">{t('rateLimited')}</p>}
        {status === 'failed' && <p className="text-red-700">{t('error')}</p>}
      </div>

      {made && (
        <div className="mt-2 rounded-[12px] border border-black/5 bg-white p-4">
          <p className={`text-[15px] font-semibold ${made.verified ? 'text-green-700' : 'text-red-700'}`}>
            {made.verified ? t('verified') : t('rejected')}
          </p>
          <p className="mt-2 text-[12px] text-[#6e6e73]">{t('commitment')}</p>
          <p className="font-mono text-[12px] text-[#1d1d1f] break-all">{made.commitment}</p>
          <p className="mt-2 text-[12px] text-[#6e6e73]">{t('madeIn', { seconds: made.seconds, kb: made.kilobytes })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={checkLower} disabled={lower === 'checking'} className="rounded-full border border-black/10 px-4 py-2 text-[13px] font-medium text-[#1d1d1f] disabled:opacity-60">
              {t('checkLower', { cap: made.caps.leverage_cap - 1 })}
            </button>
            <button type="button" onClick={download} className="rounded-full border border-black/10 px-4 py-2 text-[13px] font-medium text-[#1d1d1f]">
              {t('download')}
            </button>
          </div>
          <div className="mt-2 text-[13px]" aria-live="polite">
            {lower === 'refused' && <p className="text-green-700">{t('lowerRefused')}</p>}
            {lower === 'accepted' && <p className="text-red-700">{t('lowerAccepted')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
