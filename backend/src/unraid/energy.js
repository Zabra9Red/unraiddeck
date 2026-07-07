// Contabilità energetica UPS: integra i campioni di potenza (W) in bucket
// orari SQLite (Wh) e calcola i costi con il prezzo €/kWh configurato.
// Preset dei principali fornitori italiani = prezzi INDICATIVI, sempre
// modificabili: fa fede la bolletta dell'utente.
import { db, getSetting, setSetting } from '../core/db.js';

export const PRICE_PRESETS = [
  { id: 'arera', label: 'ARERA — Maggior Tutela', price: 0.25 },
  { id: 'enel', label: 'Enel Energia', price: 0.30 },
  { id: 'plenitude', label: 'Eni Plenitude', price: 0.29 },
  { id: 'edison', label: 'Edison', price: 0.28 },
  { id: 'a2a', label: 'A2A Energia', price: 0.30 },
  { id: 'iren', label: 'Iren', price: 0.28 },
  { id: 'sorgenia', label: 'Sorgenia', price: 0.26 },
  { id: 'octopus', label: 'Octopus Energy', price: 0.25 },
];

const RETENTION_DAYS = 730;
let lastSample = null;   // { ts, watts } — stato in RAM, i bucket sono su disco
let pruneCounter = 0;

// Integrazione trapezoidale tra due campioni consecutivi; gap oltre 5 minuti
// scartato (container fermo / UPS irraggiungibile: meglio sottostimare che inventare).
export function recordPowerSample(watts) {
  const now = Date.now();
  if (lastSample && watts != null) {
    const dtSec = (now - lastSample.ts) / 1000;
    if (dtSec > 0 && dtSec <= 300) {
      const avgW = (watts + lastSample.watts) / 2;
      let wh = avgW * dtSec / 3600;
      // Ripartizione sul confine d'ora se l'intervallo lo attraversa
      const hourMs = 3600000;
      const startHour = Math.floor(lastSample.ts / hourMs);
      const endHour = Math.floor(now / hourMs);
      const upsert = db.prepare(
        'INSERT INTO ups_energy (hour, wh, samples) VALUES (?, ?, 1) ' +
        'ON CONFLICT(hour) DO UPDATE SET wh = wh + excluded.wh, samples = samples + 1');
      if (startHour === endHour) {
        upsert.run(startHour, wh);
      } else {
        const boundary = endHour * hourMs;
        const frac = (boundary - lastSample.ts) / (now - lastSample.ts);
        upsert.run(startHour, wh * frac);
        upsert.run(endHour, wh * (1 - frac));
      }
    }
  }
  lastSample = watts != null ? { ts: now, watts } : null;

  // Retention: pulizia ~ogni 24h di campioni (poll a 60s)
  if (++pruneCounter >= 1440) {
    pruneCounter = 0;
    const cutoff = Math.floor((Date.now() - RETENTION_DAYS * 86400000) / 3600000);
    db.prepare('DELETE FROM ups_energy WHERE hour < ?').run(cutoff);
  }
}

export function getEnergyConfig() {
  return {
    pricePerKwh: getSetting('energy.pricePerKwh', null),
    provider: getSetting('energy.provider', null),
    presets: PRICE_PRESETS,
  };
}

export function setEnergyConfig({ pricePerKwh, provider }) {
  const p = Number(pricePerKwh);
  if (!Number.isFinite(p) || p < 0 || p > 5) {
    const err = new Error('Prezzo €/kWh non valido (0–5)');
    err.status = 400;
    throw err;
  }
  setSetting('energy.pricePerKwh', p);
  setSetting('energy.provider', typeof provider === 'string' ? provider.slice(0, 60) : null);
  return getEnergyConfig();
}

function sumKwh(fromMs, toMs = Date.now()) {
  const row = db.prepare('SELECT COALESCE(SUM(wh), 0) AS wh FROM ups_energy WHERE hour >= ? AND hour <= ?')
    .get(Math.floor(fromMs / 3600000), Math.floor(toMs / 3600000));
  return row.wh / 1000;
}

// Riepilogo consumi + serie oraria per il grafico (Wh nel bucket ≈ W medi sull'ora).
export function energyOverview(hours = 24) {
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight); yesterday.setDate(yesterday.getDate() - 1);

  const kwh = {
    today: sumKwh(midnight.getTime()),
    yesterday: sumKwh(yesterday.getTime(), midnight.getTime() - 1),
    days7: sumKwh(now - 7 * 86400000),
    days30: sumKwh(now - 30 * 86400000),
    days365: sumKwh(now - 365 * 86400000),
  };

  const cfg = getEnergyConfig();
  const cost = cfg.pricePerKwh != null
    ? Object.fromEntries(Object.entries(kwh).map(([k, v]) => [k, Math.round(v * cfg.pricePerKwh * 100) / 100]))
    : null;

  const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 90);
  const fromHour = Math.floor((now - h * 3600000) / 3600000);
  const rows = db.prepare('SELECT hour, wh FROM ups_energy WHERE hour >= ? ORDER BY hour').all(fromHour);
  const byHour = new Map(rows.map(r => [r.hour, r.wh]));
  const series = [];
  for (let hh = fromHour; hh <= Math.floor(now / 3600000); hh++) {
    series.push({ ts: hh * 3600000, w: Math.round((byHour.get(hh) ?? 0) * 10) / 10 });
  }

  return { config: { pricePerKwh: cfg.pricePerKwh, provider: cfg.provider }, kwh, cost, series };
}

// Ripartizione per giorno/settimana/mese/anno (ora locale del container, TZ)
// con costo per periodo se il prezzo è configurato.
const BREAKDOWN = {
  day: { fmt: '%Y-%m-%d', limit: 31 },
  week: { fmt: '%Y-W%W', limit: 26 },
  month: { fmt: '%Y-%m', limit: 24 },
  year: { fmt: '%Y', limit: 20 },
};

export function energyBreakdown(granularity = 'day') {
  const g = BREAKDOWN[granularity];
  if (!g) {
    const err = new Error('Granularità non valida (day|week|month|year)');
    err.status = 400;
    throw err;
  }
  const rows = db.prepare(
    `SELECT strftime('${g.fmt}', hour * 3600, 'unixepoch', 'localtime') AS period,
            SUM(wh) / 1000.0 AS kwh
     FROM ups_energy GROUP BY period ORDER BY period DESC LIMIT ?`).all(g.limit);
  const price = getSetting('energy.pricePerKwh', null);
  return rows.map(r => ({
    period: r.period,
    kwh: Math.round(r.kwh * 1000) / 1000,
    cost: price != null ? Math.round(r.kwh * price * 100) / 100 : null,
  }));
}
