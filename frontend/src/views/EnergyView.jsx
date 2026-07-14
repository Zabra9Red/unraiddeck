// Tab Energia: dashboard UPS stile Grafana — tiles kWh/costo per periodo,
// gauge batteria/carico, potenza attuale in tempo reale (socket), grafico
// potenza 24h e bar chart consumi/costi per giorno e mese.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket, subscribe } from '../socket.js';
import { Btn, Badge, Card, Spinner, Input } from '../components/ui.jsx';
import { AreaPanel, BarPanel, GaugeArc } from '../components/charts.jsx';
import { useToast } from '../components/Toast.jsx';
import { t } from '../i18n.js';

const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

function fmtDay(period) { // '2026-07-07' → '07/07'
  const [, m, d] = period.split('-');
  return `${d}/${m}`;
}
function fmtMonth(period) { // '2026-07' → 'lug 26'
  const [y, m] = period.split('-');
  return `${MESI[Number(m) - 1]} ${y.slice(2)}`;
}
const fmtK = (v) => v >= 100 ? `${Math.round(v)} kWh` : v >= 1 ? `${v.toFixed(2)} kWh` : `${(v * 1000).toFixed(0)} Wh`;
const fmtE = (v) => `${v.toFixed(2)} €`;

// Tile statistica stile Grafana: etichetta, kWh grande, costo giallo sotto.
function StatTile({ label, kwh, cost, accent }) {
  return (
    <div className="bg-mantle border border-surface0 rounded-lg px-2.5 py-2 text-center">
      <div className="text-[11px] text-overlay0 truncate">{label}</div>
      <div className={`text-lg font-semibold leading-tight ${accent || ''}`}>{kwh != null ? fmtK(kwh) : '—'}</div>
      <div className="text-sm text-yellow">{cost != null ? fmtE(cost) : '—'}</div>
    </div>
  );
}

// Tabella storico ordinabile: granularità day/week/month/year, sort per data
// o per costo (asc/desc) cliccando l'intestazione.
function HistoryTable() {
  const [gran, setGran] = useState('day');
  const [within, setWithin] = useState(null); // drill-down: anno → mesi, mese → giorni
  const [rows, setRows] = useState(null);
  const [sort, setSort] = useState({ key: 'period', dir: 'desc' });

  useEffect(() => {
    setRows(null);
    const q = within ? `&within=${within}` : '';
    api.get(`/unraid/energy/breakdown?granularity=${gran}${q}`).then(setRows).catch(() => setRows([]));
  }, [gran, within]);

  const pick = (g) => { setWithin(null); setGran(g); };
  // Click su una riga anno → i suoi mesi; su una riga mese → i suoi giorni
  const drill = (r) => {
    if (gran === 'year') { setWithin(r.period); setGran('month'); }
    else if (gran === 'month') { setWithin(r.period); setGran('day'); }
  };

  const fmtP = (p) => gran === 'day' ? fmtDay(p) + `/${p.slice(2, 4)}` : gran === 'month' ? fmtMonth(p) : p.replace('-W', ' sett. ');
  const sorted = (rows || []).slice().sort((a, b) => {
    const va = sort.key === 'period' ? a.period : (a.cost ?? a.kwh);
    const vb = sort.key === 'period' ? b.period : (b.cost ?? b.kwh);
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  const toggle = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const arrow = (key) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '';

  return (
    <Card title={t.energyHistTitle}>
      <div className="flex items-center gap-1.5 text-xs mb-2 flex-wrap">
        {[['day', t.energyGranDay], ['week', t.energyGranWeek], ['month', t.energyGranMonth], ['year', t.energyGranYear]].map(([g, label]) => (
          <button
            key={g}
            onClick={() => pick(g)}
            className={`px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${gran === g && !within ? 'border-yellow text-yellow bg-yellow/10' : 'border-surface1 text-subtext0 hover:border-overlay0'}`}
          >
            {label}
          </button>
        ))}
        {within && (
          <button
            onClick={() => { const y = within.length === 4; setWithin(y ? null : within.slice(0, 4)); setGran(y ? 'year' : 'month'); }}
            className="px-2 py-0.5 rounded-md border border-yellow text-yellow bg-yellow/10 cursor-pointer"
            title={t.energyDrillBack}
          >
            ← {within.length === 4 ? within : fmtMonth(within)}
          </button>
        )}
        {gran !== 'day' && gran !== 'week' && <span className="text-overlay0">{t.energyDrillHint}</span>}
      </div>
      {!rows ? <Spinner /> : !rows.length ? (
        <div className="text-xs text-overlay0">{t.energyNoData}</div>
      ) : (
        <div className="max-h-72 overflow-y-auto pr-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-base">
              <tr className="text-xs text-subtext0 select-none">
                <th className="text-left font-medium py-1 cursor-pointer hover:text-text" onClick={() => toggle('period')}>{t.energyColPeriod}{arrow('period')}</th>
                <th className="text-right font-medium py-1 cursor-pointer hover:text-text" onClick={() => toggle('cost')}>{t.energyColKwh}{arrow('cost')}</th>
                <th className="text-right font-medium py-1 cursor-pointer hover:text-text w-24" onClick={() => toggle('cost')}>{t.energyColCost}{arrow('cost')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.period}
                  className={`border-t border-surface0 ${gran === 'year' || gran === 'month' ? 'cursor-pointer hover:bg-surface0/40' : ''}`}
                  onClick={() => drill(r)}
                >
                  <td className="py-1 text-subtext1">{fmtP(r.period)}{(gran === 'year' || gran === 'month') && <span className="text-overlay0"> ›</span>}</td>
                  <td className="py-1 text-right">{fmtK(r.kwh)}</td>
                  <td className="py-1 text-right text-yellow">{r.cost != null ? fmtE(r.cost) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function EnergyView() {
  const toast = useToast();
  const [ups, setUps] = useState(null);
  const [energy, setEnergy] = useState(null);
  const [days, setDays] = useState(null);
  const [months, setMonths] = useState(null);
  const [price, setPrice] = useState('');
  const [provider, setProvider] = useState('');
  const [alertWatts, setAlertWatts] = useState('');
  const [alertDailyKwh, setAlertDailyKwh] = useState('');
  const [saving, setSaving] = useState(false);

  const loadEnergy = () => api.get('/unraid/energy?hours=24').then((d) => {
    setEnergy(d);
    setPrice((p) => p === '' && d.config.pricePerKwh != null ? String(d.config.pricePerKwh) : p);
    setProvider((pr) => pr === '' && d.config.provider ? d.config.provider : pr);
    setAlertWatts((v) => v === '' && d.config.alertWatts != null ? String(d.config.alertWatts) : v);
    setAlertDailyKwh((v) => v === '' && d.config.alertDailyKwh != null ? String(d.config.alertDailyKwh) : v);
  }).catch(() => {});
  const loadBreakdowns = () => {
    api.get('/unraid/energy/breakdown?granularity=day').then(setDays).catch(() => {});
    api.get('/unraid/energy/breakdown?granularity=month').then(setMonths).catch(() => {});
  };

  useEffect(() => {
    api.get('/unraid/state').then((s) => setUps(s.sections?.ups)).catch(() => {});
    loadEnergy();
    loadBreakdowns();
    const t1 = setInterval(loadEnergy, 30000);
    const t2 = setInterval(loadBreakdowns, 300000);
    // Potenza in tempo reale: la sezione UPS arriva via socket a ogni poll (10s)
    const s = getSocket();
    const unsub = subscribe('unraid');
    const onSection = ({ section, data }) => { if (section === 'ups') setUps(data); };
    s.on('unraid:section', onSection);
    return () => { clearInterval(t1); clearInterval(t2); s.off('unraid:section', onSection); unsub(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/unraid/energy/config', {
        pricePerKwh: parseFloat(price),
        provider,
        alertWatts: alertWatts === '' ? null : parseFloat(alertWatts),
        alertDailyKwh: alertDailyKwh === '' ? null : parseFloat(alertDailyKwh),
      });
      toast.ok(t.energyTitle, t.energySaved);
      await loadEnergy();
      loadBreakdowns();
    } catch (e) { toast.error(t.energyTitle, e.message); }
    setSaving(false);
  };
  const onPreset = (e) => {
    const preset = energy?.presets?.find((p) => p.id === e.target.value);
    if (preset) { setPrice(String(preset.price)); setProvider(preset.label); }
    else setProvider('');
  };

  if (!energy) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;

  const { kwh, cost } = energy;
  const estYearKwh = kwh.days30 > 0 ? (kwh.days30 / 30) * 365 : null;
  const priceVal = energy.config.pricePerKwh;
  const estYearCost = estYearKwh != null && priceVal != null ? estYearKwh * priceVal : null;
  const avgW24 = energy.series?.length ? energy.series.reduce((a, p) => a + p.w, 0) / energy.series.length : null;
  const kwh24 = energy.series?.length ? energy.series.reduce((a, p) => a + p.w, 0) / 1000 : null;
  const selectedPreset = energy.presets?.find((p) => p.label === provider)?.id || '';

  const dayPoints = (days || []).slice().reverse().map((r) => ({ label: fmtDay(r.period), tick: r.period.slice(8), kwh: r.kwh, cost: r.cost }));
  const monthPoints = (months || []).slice(0, 12).reverse().map((r) => ({ label: fmtMonth(r.period), tick: fmtMonth(r.period).split(' ')[0], kwh: r.kwh, cost: r.cost }));

  return (
    <div className="space-y-3">
      {/* UPS non rilevato: diagnosi in testa alla tab */}
      {ups && !ups.detected && (
        <Card title={t.ups}>
          <div className="text-xs text-overlay0 mb-2">{t.upsNotDetected}</div>
          {ups.reason && (
            <div className="text-[11px] text-peach bg-peach/10 border border-peach/30 rounded-lg px-2 py-1.5 font-mono break-words mb-2">{ups.reason}</div>
          )}
          <ul className="text-[11px] text-subtext0 space-y-1 list-disc pl-4">
            {t.upsHints.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </Card>
      )}

      {/* Riga 1: tiles consumo/costo per periodo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-2">
        <StatTile label={t.energyToday} kwh={kwh.today} cost={cost?.today} />
        <StatTile label={t.energyYesterday} kwh={kwh.yesterday} cost={cost?.yesterday} />
        <StatTile label={t.energy7d} kwh={kwh.days7} cost={cost?.days7} />
        <StatTile label={t.energy30d} kwh={kwh.days30} cost={cost?.days30} />
        <StatTile label={t.energy365d} kwh={kwh.days365} cost={cost?.days365} />
        <StatTile label={t.energyEstYear} kwh={estYearKwh} cost={estYearCost} accent="text-yellow" />
        <div className="bg-mantle border border-surface0 rounded-lg px-2.5 py-2 text-center">
          <div className="text-[11px] text-overlay0 truncate">{t.energyAvgDailyCost}</div>
          <div className="text-lg font-semibold leading-tight text-yellow">{cost?.days30 != null ? fmtE(cost.days30 / 30) : '—'}</div>
          <div className="text-sm text-overlay0">{kwh.days30 > 0 ? fmtK(kwh.days30 / 30) : '—'}</div>
        </div>
      </div>

      {/* Riga 2: gauge + potenza attuale */}
      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-center">
          <GaugeArc
            value={ups?.chargePct}
            label={t.upsCharge}
            thresholds={[{ upTo: 0.2, color: '#f38ba8' }, { upTo: 0.5, color: '#f9e2af' }, { upTo: 1, color: '#a6e3a1' }]}
          />
          <div className="text-center">
            <div className="text-[11px] text-overlay0 mb-1">{t.energyCurrentPower}</div>
            <div className="text-4xl font-bold leading-none">{ups?.watts != null ? Math.round(ups.watts) : '—'}<span className="text-lg font-medium text-subtext0"> W</span></div>
            <div className="mt-2 flex items-center justify-center gap-2">
              <Badge color={ups?.onBattery ? 'red' : ups?.detected ? 'green' : 'overlay'}>
                {ups?.onBattery ? t.upsOnBattery : ups?.detected ? (ups.status || t.upsOnline) : t.upsNotDetected}
              </Badge>
            </div>
            {ups?.runtimeMin != null && <div className="text-xs text-subtext0 mt-1">{t.upsRuntime}: {ups.runtimeMin} min</div>}
          </div>
          <GaugeArc
            value={ups?.loadPct}
            label={t.upsLoad}
            thresholds={[{ upTo: 0.6, color: '#a6e3a1' }, { upTo: 0.85, color: '#f9e2af' }, { upTo: 1, color: '#f38ba8' }]}
          />
          <div className="text-center">
            <div className="text-[11px] text-overlay0 mb-1">{t.energyAvgPower24h}</div>
            <div className="text-3xl font-bold leading-none">{avgW24 != null ? Math.round(avgW24) : '—'}<span className="text-base font-medium text-subtext0"> W</span></div>
            <div className="text-xs text-subtext0 mt-2">{kwh24 != null ? `${fmtK(kwh24)} / 24h` : ''}</div>
          </div>
        </div>
      </Card>

      {/* Riga 3: potenza 24h */}
      <Card>
        <AreaPanel
          title={t.energyChart}
          points={energy.series || []}
          series={[{ key: 'w', color: '#f9e2af', label: 'W' }]}
          unitFmt={(v) => `${Math.round(v)} W`}
          height={110}
        />
      </Card>

      {/* Riga 4: bar chart consumi/costi */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <BarPanel title={t.energyBarDays} points={dayPoints} valueFmt={fmtK} costFmt={fmtE} />
        </Card>
        <Card>
          <BarPanel title={t.energyBarMonths} points={monthPoints} valueFmt={fmtK} costFmt={fmtE} />
        </Card>
      </div>

      {/* Storico ordinabile per data/costo */}
      <HistoryTable />

      {/* Prezzo energia */}
      <Card title={t.energyPrice}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block grow basis-48 max-w-xs">
            <span className="block text-xs text-subtext0 mb-1">{t.energyProvider}</span>
            <select
              value={selectedPreset}
              onChange={onPreset}
              className="w-full bg-mantle border border-surface1 rounded-lg px-2 py-1.5 text-sm text-text outline-none focus:border-blue"
            >
              <option value="">{t.energyProviderCustom}</option>
              {energy.presets?.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.price.toFixed(2)} €</option>)}
            </select>
          </label>
          <Input
            label={t.energyPrice}
            type="number" min="0" max="5" step="0.001" inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="max-w-28"
          />
          <Btn size="sm" onClick={save} disabled={saving || price === ''}>{t.energySave}</Btn>
        </div>
        <div className="text-[11px] text-overlay0 mt-2">{t.energyDisclaimer}</div>
        <div className="text-[11px] text-overlay0 mt-1">{t.energyPersistNote}</div>

        {/* Allarmi soglia (notifica in-app + webhook/ntfy) */}
        <div className="border-t border-surface0 mt-3 pt-3">
          <div className="text-xs font-medium text-subtext0 mb-2">{t.energyAlerts}</div>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              label={t.energyAlertWatts}
              type="number" min="1" step="1" inputMode="numeric" placeholder="es. 500"
              value={alertWatts}
              onChange={(e) => setAlertWatts(e.target.value)}
              className="max-w-32"
            />
            <Input
              label={t.energyAlertDailyKwh}
              type="number" min="0.1" step="0.1" inputMode="decimal" placeholder="es. 5"
              value={alertDailyKwh}
              onChange={(e) => setAlertDailyKwh(e.target.value)}
              className="max-w-32"
            />
            <Btn size="sm" onClick={save} disabled={saving || price === ''}>{t.energySave}</Btn>
          </div>
          <div className="text-[11px] text-overlay0 mt-2">{t.energyAlertsHint}</div>
          <div className="text-[11px] text-overlay0 mt-1">{t.energyNtfyHint}</div>
        </div>
      </Card>
    </div>
  );
}
