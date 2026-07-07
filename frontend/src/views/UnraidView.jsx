// Vista Unraid: array/parity, dischi (temp da fonte passiva, SMART on-demand),
// pool, share, sistema, VM, UPS, power host. Degradazione PER-SEZIONE con
// motivo visibile e canale attivo (GraphQL/SSH) indicato.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { getSocket, subscribe } from '../socket.js';
import { Btn, Badge, Card, Spinner, EmptyState, Meter, Input } from '../components/ui.jsx';
import { Modal, ConfirmTyped } from '../components/Modal.jsx';
import { AreaPanel } from '../components/charts.jsx';
import { useToast } from '../components/Toast.jsx';
import { t, fmtBytes, fmtUptime, fmtTs } from '../i18n.js';

// Consumo elettrico UPS: potenza integrata lato backend (Wh/ora in SQLite),
// costo calcolato col prezzo €/kWh scelto (preset fornitori IT o manuale).
function EnergyPanel({ ups }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [price, setPrice] = useState('');
  const [provider, setProvider] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/unraid/energy?hours=24').then((d) => {
    setData(d);
    setPrice((p) => p === '' && d.config.pricePerKwh != null ? String(d.config.pricePerKwh) : p);
    setProvider((pr) => pr === '' && d.config.provider ? d.config.provider : pr);
  }).catch(() => {});

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/unraid/energy/config', { pricePerKwh: parseFloat(price), provider });
      toast.ok(t.energyTitle, t.energySaved);
      await load();
    } catch (e) { toast.error(t.energyTitle, e.message); }
    setSaving(false);
  };

  const onPreset = (e) => {
    const preset = data?.presets?.find((p) => p.id === e.target.value);
    if (preset) { setPrice(String(preset.price)); setProvider(preset.label); }
    else setProvider('');
  };

  if (!data) return null;
  const cur = data.config.pricePerKwh;
  const fmtE = (v) => `${v.toFixed(2)} €`;
  const fmtK = (v) => v >= 100 ? `${Math.round(v)} kWh` : `${v.toFixed(2)} kWh`;
  const stats = [
    [t.energyToday, data.kwh.today, data.cost?.today],
    [t.energy7d, data.kwh.days7, data.cost?.days7],
    [t.energy30d, data.kwh.days30, data.cost?.days30],
    [t.energy365d, data.kwh.days365, data.cost?.days365],
  ];
  const selectedPreset = data.presets?.find((p) => p.label === provider)?.id || '';

  return (
    <div className="border-t border-surface0 mt-3 pt-3 space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-subtext0">{t.energyTitle}</span>
        {ups?.watts != null && (
          <span className="text-sm font-medium">
            {ups.watts} W <span className="text-xs text-overlay0">({ups.wattsSource === 'misurata' ? t.upsPowerMeasured : t.upsPowerEstimated})</span>
          </span>
        )}
      </div>

      {ups && ups.watts == null ? (
        <div className="text-xs text-overlay0">{t.energyNoPower}</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 text-center">
            {stats.map(([label, kwh, cost]) => (
              <div key={label} className="bg-mantle border border-surface0 rounded-lg py-1.5 px-1">
                <div className="text-[11px] text-overlay0">{label}</div>
                <div className="text-sm font-medium">{fmtK(kwh)}</div>
                <div className="text-xs text-yellow">{cost != null ? fmtE(cost) : '—'}</div>
              </div>
            ))}
          </div>
          {cur == null && <div className="text-xs text-overlay0">{t.energyNoPrice}</div>}
          {data.series?.some((p) => p.w > 0) && (
            <AreaPanel
              title={t.energyChart}
              points={data.series}
              series={[{ key: 'w', color: '#f9e2af', label: 'W' }]}
              unitFmt={(v) => `${Math.round(v)} W`}
              height={80}
            />
          )}
        </>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="block grow basis-40">
          <span className="block text-xs text-subtext0 mb-1">{t.energyProvider}</span>
          <select
            value={selectedPreset}
            onChange={onPreset}
            className="w-full bg-mantle border border-surface1 rounded-lg px-2 py-1.5 text-sm text-text outline-none focus:border-blue"
          >
            <option value="">{t.energyProviderCustom}</option>
            {data.presets?.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.price.toFixed(2)} €</option>)}
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
      <div className="text-[11px] text-overlay0">{t.energyDisclaimer}</div>
    </div>
  );
}

export function UnraidView() {
  const toast = useToast();
  const [snap, setSnap] = useState(null);
  const [confirm, setConfirm] = useState(null);   // {type: 'array-stop'|'power', action}
  const [smart, setSmart] = useState(null);       // {device, loading, data}
  const [history, setHistory] = useState(null);

  const load = () => api.get('/unraid/state').then(setSnap).catch((e) => toast.error(t.error, e.message));

  useEffect(() => {
    load();
    const s = getSocket();
    const unsub = subscribe('unraid');
    const onSection = ({ section, data, error, mode }) => {
      setSnap((prev) => prev ? {
        ...prev,
        mode: mode || prev.mode,
        sections: { ...prev.sections, [section]: data },
        errors: { ...prev.errors, [section]: error },
      } : prev);
    };
    s.on('unraid:section', onSection);
    return () => { s.off('unraid:section', onSection); unsub(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;

  if (snap.mode === 'none') {
    return (
      <Card title={t.tabUnraid}>
        {snap.configured ? (
          <div className="max-w-2xl mx-auto py-6">
            <div className="text-peach font-medium mb-2">{t.unraidUnreachableTitle}</div>
            {snap.lastError && (
              <div className="text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2 mb-3 font-mono break-words">
                {snap.lastError}
              </div>
            )}
            <ul className="text-sm text-subtext1 space-y-1.5 list-disc pl-5">
              {t.unraidHints.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
            <div className="text-xs text-overlay0 mt-3">{t.unraidRetryNote}</div>
            <div className="mt-4"><Btn size="sm" onClick={load}>{t.retry}</Btn></div>
          </div>
        ) : (
          <EmptyState>
            <div className="text-subtext0 mb-1">{t.unraidUnavailable}</div>
            <div className="text-xs max-w-md mx-auto">{t.unraidModeNone}</div>
          </EmptyState>
        )}
      </Card>
    );
  }

  const sec = snap.sections || {};
  const err = snap.errors || {};

  const doParity = async (action, correct = false) => {
    try {
      await api.post('/unraid/parity', { action, correct });
      toast.ok(t.parity, `${action} ok`);
    } catch (e) { toast.error(t.parity, e.message); }
  };
  const doArray = async (action, confirmName) => {
    try {
      await api.post('/unraid/array', { action, confirmName });
      toast.ok(t.array, `${action} ok`);
      setConfirm(null);
    } catch (e) { toast.error(t.array, e.message); }
  };
  const doPower = async (action, confirmName) => {
    try {
      await api.post('/unraid/power', { action, confirmName });
      toast.warn(t.power, action === 'reboot' ? 'Riavvio host inviato' : 'Spegnimento host inviato');
      setConfirm(null);
    } catch (e) { toast.error(t.power, e.message); }
  };
  const doVm = async (vm, action) => {
    try {
      await api.post(`/unraid/vms/${encodeURIComponent(vm.uuid || vm.name)}`, { action });
      toast.ok(vm.name, `${action} ok`);
    } catch (e) { toast.error(vm.name, e.message); }
  };
  const openSmart = async (device) => {
    setSmart({ device, loading: true });
    try {
      const data = await api.get(`/unraid/smart/${device}`);
      setSmart({ device, data });
    } catch (e) {
      setSmart(null);
      toast.error(t.smart, e.message);
    }
  };
  const openHistory = async () => {
    setHistory('loading');
    try { setHistory(await api.get('/unraid/parity/history')); }
    catch (e) { setHistory(null); toast.error(t.parityHistory, e.message); }
  };

  const SectionError = ({ name }) => err[name] ? (
    <div className="text-xs text-peach bg-peach/10 border border-peach/30 rounded-lg px-2.5 py-1.5 mb-2">
      {t.sectionError(err[name])}
    </div>
  ) : null;

  const arr = sec.array;
  const sys = sec.system;
  const ups = sec.ups;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-overlay0">
        <Badge color={snap.mode === 'graphql' ? 'green' : 'yellow'}>
          {snap.mode === 'graphql' ? t.unraidModeGraphql : t.unraidModeSsh}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {/* Array + Parity */}
        <Card
          title={t.array}
          className="xl:col-span-2"
          right={arr && (
            <div className="flex gap-1.5">
              {arr.state === 'STARTED'
                ? <Btn size="sm" variant="danger" onClick={() => setConfirm({ type: 'array-stop' })}>{t.arrayStop}</Btn>
                : <Btn size="sm" variant="green" onClick={() => doArray('start')}>{t.arrayStart}</Btn>}
            </div>
          )}
        >
          <SectionError name="array" />
          {arr ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Badge color={arr.state === 'STARTED' ? 'green' : 'red'}>{arr.state}</Badge>
                {arr.capacity && (
                  <div className="grow">
                    <div className="flex justify-between text-xs text-subtext0 mb-1">
                      <span>{t.freeOf(fmtBytes(arr.capacity.free), fmtBytes(arr.capacity.total))}</span>
                      <span>{Math.round((arr.capacity.used / (arr.capacity.total || 1)) * 100)}%</span>
                    </div>
                    <Meter value={arr.capacity.used} max={arr.capacity.total} color={arr.capacity.used / arr.capacity.total > 0.9 ? 'red' : 'blue'} />
                  </div>
                )}
              </div>
              <div className="border-t border-surface0 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-subtext1">{t.parity}</span>
                  {arr.parity?.running ? (
                    <>
                      <Badge color="blue">{arr.parity.action || 'check'} {arr.parity.pct != null ? `${arr.parity.pct}%` : ''}</Badge>
                      {arr.parity.errors > 0 && <Badge color="red">{arr.parity.errors} {t.parityErrors}</Badge>}
                      <div className="grow" />
                      <Btn size="sm" onClick={() => doParity('pause')}>{t.parityPause}</Btn>
                      <Btn size="sm" onClick={() => doParity('resume')}>{t.parityResume}</Btn>
                      <Btn size="sm" variant="warn" onClick={() => doParity('cancel')}>{t.parityCancel}</Btn>
                    </>
                  ) : (
                    <>
                      <div className="grow" />
                      <Btn size="sm" onClick={() => doParity('start', false)}>{t.parityStart}</Btn>
                      <Btn size="sm" onClick={() => doParity('start', true)}>{t.parityStartCorrect}</Btn>
                      <Btn size="sm" variant="ghost" onClick={openHistory}>{t.parityHistory}</Btn>
                    </>
                  )}
                </div>
                {arr.parity?.running && arr.parity.pct != null && (
                  <Meter value={arr.parity.pct} max={100} color="mauve" className="mt-2" />
                )}
              </div>
            </div>
          ) : !err.array && <Spinner />}
        </Card>

        {/* Sistema */}
        <Card title={t.system}>
          <SectionError name="system" />
          {sys ? (
            <div className="space-y-2.5 text-sm">
              {sys.os && <div className="text-xs text-subtext0">{sys.os}{sys.unraidVersion ? ` — Unraid ${sys.unraidVersion}` : ''}</div>}
              <div>
                <div className="flex justify-between text-xs text-subtext0 mb-1">
                  <span>{t.cpu}</span><span>{sys.cpuPct != null ? `${sys.cpuPct}%` : '—'}</span>
                </div>
                <Meter value={sys.cpuPct || 0} color={sys.cpuPct > 90 ? 'red' : 'blue'} />
              </div>
              <div>
                <div className="flex justify-between text-xs text-subtext0 mb-1">
                  <span>{t.memory}</span><span>{fmtBytes(sys.memUsed)} / {fmtBytes(sys.memTotal)}</span>
                </div>
                <Meter value={sys.memUsed} max={sys.memTotal || 1} color="green" />
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-subtext0">{t.uptimeLabel}</span>
                <span>{fmtUptime((sys.uptimeSec || 0) * 1000)}</span>
              </div>
              {sys.load && (
                <div className="flex justify-between text-xs">
                  <span className="text-subtext0">{t.loadAvg}</span>
                  <span className="font-mono">{sys.load.map((l) => l.toFixed(2)).join(' · ')}</span>
                </div>
              )}
              {sys.temps && Object.keys(sys.temps).length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(sys.temps).slice(0, 4).map(([k, v]) => (
                    <Badge key={k} color="overlay">{k}: {v}°C</Badge>
                  ))}
                </div>
              )}
            </div>
          ) : !err.system && <Spinner />}
        </Card>

        {/* Dischi */}
        <Card title={t.disks} className="md:col-span-2 xl:col-span-3">
          <SectionError name="disks" />
          {sec.disks?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="text-left text-xs text-overlay0 border-b border-surface0">
                    <th className="py-1.5 pr-2">{t.disk}</th>
                    <th className="py-1.5 pr-2">Device</th>
                    <th className="py-1.5 pr-2">Tipo</th>
                    <th className="py-1.5 pr-2">{t.temp}</th>
                    <th className="py-1.5 pr-2">Errori</th>
                    <th className="py-1.5 pr-2 w-56">Utilizzo</th>
                    <th className="py-1.5 pr-2">FS</th>
                    <th className="py-1.5 text-right">{t.smart}</th>
                  </tr>
                </thead>
                <tbody>
                  {sec.disks.map((d) => (
                    <tr key={d.name} className="border-b border-surface0/50">
                      <td className="py-1.5 pr-2 font-medium">{d.name}</td>
                      <td className="py-1.5 pr-2 font-mono text-xs text-subtext0">{d.device || '—'}</td>
                      <td className="py-1.5 pr-2 text-xs text-subtext0">{d.type || '—'}</td>
                      <td className="py-1.5 pr-2">
                        {d.spunDown || d.temp == null
                          ? <Badge color="overlay">{t.spunDown}</Badge>
                          : <span className={d.temp >= 45 ? 'text-red font-medium' : d.temp >= 42 ? 'text-peach' : ''}>{d.temp}°C</span>}
                      </td>
                      <td className="py-1.5 pr-2">{d.numErrors > 0 ? <Badge color="red">{d.numErrors}</Badge> : <span className="text-overlay0">0</span>}</td>
                      <td className="py-1.5 pr-2">
                        {d.fsSize > 0 ? (
                          <div className="flex items-center gap-2">
                            <Meter value={d.fsUsed || (d.fsSize - d.fsFree)} max={d.fsSize} color={(d.fsFree / d.fsSize) < 0.1 ? 'red' : 'blue'} className="w-28" />
                            <span className="text-[11px] text-subtext0 whitespace-nowrap">{fmtBytes(d.fsFree)} liberi</span>
                          </div>
                        ) : <span className="text-overlay0 text-xs">—</span>}
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-subtext0">{d.fsType || '—'}</td>
                      <td className="py-1.5 text-right">
                        {d.device && <Btn size="sm" variant="ghost" onClick={() => openSmart(d.device)}>{t.smart}</Btn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !err.disks && <Spinner />}
        </Card>

        {/* Pool */}
        <Card title={t.pools}>
          <SectionError name="pools" />
          {sec.pools ? (
            sec.pools.length ? (
              <div className="space-y-2">
                {sec.pools.map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge color={p.degraded ? 'red' : 'green'}>{p.degraded ? t.poolDegraded : (p.health || t.poolHealthy)}</Badge>
                      <span className="truncate">{p.name}</span>
                      <span className="text-xs text-overlay0">{p.type || ''}</span>
                    </div>
                    {p.size != null && <span className="text-xs text-subtext0 whitespace-nowrap">{typeof p.size === 'number' ? fmtBytes(p.size) : p.size}</span>}
                  </div>
                ))}
              </div>
            ) : <EmptyState>Nessun pool</EmptyState>
          ) : !err.pools && <Spinner />}
        </Card>

        {/* Share */}
        <Card title={t.shares}>
          <SectionError name="shares" />
          {sec.shares ? (
            sec.shares.length ? (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {sec.shares.map((sh) => (
                  <div key={sh.name} className="flex items-center justify-between text-sm gap-2">
                    <span className="truncate">{sh.name}</span>
                    <span className="text-xs text-subtext0 whitespace-nowrap">{fmtBytes(sh.free)} liberi</span>
                  </div>
                ))}
              </div>
            ) : <EmptyState>Nessuna share</EmptyState>
          ) : !err.shares && <Spinner />}
        </Card>

        {/* UPS + Power */}
        <Card title={t.ups}>
          <SectionError name="ups" />
          {ups ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge color={ups.onBattery ? 'red' : 'green'}>{ups.onBattery ? t.upsOnBattery : (ups.status || t.upsOnline)}</Badge>
                <span className="text-xs text-overlay0">{ups.model || ''} ({ups.mode})</span>
              </div>
              {ups.chargePct != null && (
                <div>
                  <div className="flex justify-between text-xs text-subtext0 mb-1"><span>{t.upsCharge}</span><span>{ups.chargePct}%</span></div>
                  <Meter value={ups.chargePct} color={ups.chargePct < 30 ? 'red' : 'green'} />
                </div>
              )}
              <div className="flex justify-between text-xs"><span className="text-subtext0">{t.upsLoad}</span><span>{ups.loadPct != null ? `${ups.loadPct}%` : '—'}</span></div>
              <div className="flex justify-between text-xs"><span className="text-subtext0">{t.upsRuntime}</span><span>{ups.runtimeMin != null ? `${ups.runtimeMin} min` : '—'}</span></div>
            </div>
          ) : (
            <div className="text-xs text-overlay0">UPS non rilevato (apcupsd NIS 3551 / NUT 3493)</div>
          )}
          <EnergyPanel ups={ups} />
          <div className="border-t border-surface0 mt-3 pt-3">
            <div className="text-xs text-subtext0 mb-2">{t.power}</div>
            <div className="flex gap-2">
              <Btn size="sm" variant="warn" onClick={() => setConfirm({ type: 'power', action: 'reboot' })}>{t.powerReboot}</Btn>
              <Btn size="sm" variant="danger" onClick={() => setConfirm({ type: 'power', action: 'shutdown' })}>{t.powerShutdown}</Btn>
            </div>
          </div>
        </Card>

        {/* VM */}
        <Card title={t.vms} className="md:col-span-2 xl:col-span-3">
          <SectionError name="vms" />
          {sec.vms ? (
            sec.vms.length ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {sec.vms.map((vm) => (
                  <div key={vm.uuid || vm.name} className="flex items-center justify-between gap-2 bg-mantle border border-surface0 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge color={vm.state === 'running' ? 'green' : vm.state.includes('paus') ? 'yellow' : 'overlay'}>{vm.state}</Badge>
                      <span className="text-sm truncate">{vm.name}</span>
                    </div>
                    <div className="flex gap-1">
                      {vm.state === 'running' ? (
                        <>
                          <Btn size="sm" variant="ghost" title={t.vmStop} onClick={() => doVm(vm, 'stop')}>■</Btn>
                          <Btn size="sm" variant="ghost" title={t.vmReboot} onClick={() => doVm(vm, 'reboot')}>⟳</Btn>
                        </>
                      ) : (
                        <Btn size="sm" variant="ghost" title={t.vmStart} onClick={() => doVm(vm, 'start')}>▶</Btn>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : <EmptyState>Nessuna VM</EmptyState>
          ) : !err.vms && <Spinner />}
        </Card>
      </div>

      {/* Modali */}
      {confirm?.type === 'array-stop' && (
        <ConfirmTyped
          title={t.arrayStop}
          body={t.confirmArrayStop}
          expected="array"
          onConfirm={() => doArray('stop', 'array')}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.type === 'power' && (
        <ConfirmTyped
          title={confirm.action === 'reboot' ? t.powerReboot : t.powerShutdown}
          body={t.confirmPower(confirm.action)}
          expected={confirm.action}
          onConfirm={() => doPower(confirm.action, confirm.action)}
          onClose={() => setConfirm(null)}
        />
      )}
      {smart && (
        <Modal title={t.smartTitle(smart.device)} onClose={() => setSmart(null)} wide>
          {smart.loading ? <div className="flex justify-center py-8"><Spinner className="w-6 h-6" /></div> : (
            <>
              {smart.data.standby && <div className="text-sm text-peach mb-2">{t.smartStandby}</div>}
              <pre className="text-[11px] font-mono bg-crust border border-surface0 rounded-lg p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap">{smart.data.output}</pre>
            </>
          )}
        </Modal>
      )}
      {history && (
        <Modal title={t.parityHistory} onClose={() => setHistory(null)} wide>
          {history === 'loading' ? <div className="flex justify-center py-8"><Spinner className="w-6 h-6" /></div> : (
            history.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-overlay0 border-b border-surface0">
                    <th className="py-1.5">Data</th><th className="py-1.5">Durata</th><th className="py-1.5">Velocità</th><th className="py-1.5">Errori</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i} className="border-b border-surface0/50">
                      <td className="py-1.5">{h.date || '—'}</td>
                      <td className="py-1.5">{h.durationSec ? fmtUptime(h.durationSec * 1000) : '—'}</td>
                      <td className="py-1.5">{h.speed || '—'}</td>
                      <td className="py-1.5">{h.errors != null ? (h.errors > 0 ? <Badge color="red">{h.errors}</Badge> : '0') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState>Nessun check registrato</EmptyState>
          )}
        </Modal>
      )}
    </div>
  );
}
