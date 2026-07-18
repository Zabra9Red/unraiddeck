// Impostazioni: cambio password, TOTP (QR + recovery codes), sessioni attive,
// credenziali registry (cifrate at-rest), soglia temperatura, test notifiche.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { Btn, Input, Card, Badge, Spinner } from '../components/ui.jsx';
import { Modal } from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import { t, fmtTs } from '../i18n.js';

export function SettingsView({ me, onLogout }) {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [totpModal, setTotpModal] = useState(null); // {uri, secret, qr} | {recoveryCodes}
  const [totpCode, setTotpCode] = useState('');
  const [pw, setPw] = useState({ old: '', new1: '', new2: '' });
  const [reg, setReg] = useState({ registry: '', username: '', password: '' });
  const [threshold, setThreshold] = useState(45);
  const [tempMin, setTempMin] = useState('');
  const [autoUpd, setAutoUpd] = useState({ enabled: false, intervalHours: 8 });

  const load = async () => {
    const [s, sess, au] = await Promise.all([api.get('/settings'), api.get('/sessions'), api.get('/settings/auto-update')]);
    setSettings(s);
    setThreshold(s.tempThreshold);
    setTempMin(s.tempMin != null ? String(s.tempMin) : '');
    setSessions(sess);
    setAutoUpd(au);
  };
  useEffect(() => { load().catch((e) => toast.error(t.error, e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changePw = async (e) => {
    e.preventDefault();
    try {
      await api.post('/password', { oldPassword: pw.old, newPassword: pw.new1 });
      toast.ok(t.changePassword, 'Password aggiornata');
      setPw({ old: '', new1: '', new2: '' });
    } catch (err) { toast.error(t.changePassword, err.message); }
  };

  const startTotp = async () => {
    try {
      const out = await api.post('/totp/setup');
      const qr = await QRCode.toDataURL(out.uri, { margin: 1, width: 220, color: { dark: '#cdd6f4', light: '#1e1e2e' } });
      setTotpModal({ ...out, qr });
      setTotpCode('');
    } catch (e) { toast.error(t.totpTitle, e.message); }
  };
  const enableTotp = async () => {
    try {
      const out = await api.post('/totp/enable', { code: totpCode });
      setTotpModal({ recoveryCodes: out.recoveryCodes });
      toast.ok(t.totpTitle, 'TOTP attivato');
    } catch (e) { toast.error(t.totpTitle, e.message); }
  };
  const disableTotp = async () => {
    try {
      await api.post('/totp/disable', { code: totpCode });
      toast.ok(t.totpTitle, 'TOTP disattivato');
      setTotpModal(null);
      setTotpCode('');
    } catch (e) { toast.error(t.totpTitle, e.message); }
  };

  const saveThreshold = async () => {
    try {
      await api.put('/settings', { tempThreshold: threshold, tempMin: tempMin === '' ? null : parseInt(tempMin, 10) });
      toast.ok(t.thresholds, `Soglie salvate (max ${threshold}°C${tempMin !== '' ? `, min ${tempMin}°C` : ''})`);
    } catch (e) { toast.error(t.thresholds, e.message); }
  };

  const saveAutoUpdate = async (next) => {
    try {
      const cfg = await api.post('/settings/auto-update', next);
      setAutoUpd(cfg);
      toast.ok(t.autoUpdateTitle, cfg.enabled ? t.autoUpdateOn(cfg.intervalHours) : t.autoUpdateOff);
    } catch (e) { toast.error(t.autoUpdateTitle, e.message); }
  };

  const addRegistry = async (e) => {
    e.preventDefault();
    try {
      await api.post('/settings/registry', reg);
      toast.ok(t.registryTitle, `${reg.registry} salvato`);
      setReg({ registry: '', username: '', password: '' });
      load();
    } catch (err) { toast.error(t.registryTitle, err.message); }
  };
  const delRegistry = async (registry) => {
    try {
      await api.del(`/settings/registry/${encodeURIComponent(registry)}`);
      load();
    } catch (e) { toast.error(t.registryTitle, e.message); }
  };

  const revokeSession = async (id) => {
    await api.del(`/sessions/${id}`).catch(() => {});
    load();
  };
  const logoutAll = async () => {
    await api.post('/logout-all').catch(() => {});
    onLogout();
  };

  if (!settings) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title={t.secTitle}>
        <form onSubmit={changePw} className="space-y-2.5">
          <div className="text-sm font-medium text-subtext1">{t.changePassword}</div>
          <Input label={t.oldPassword} type="password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} autoComplete="current-password" />
          <Input label={`${t.newPassword} (${t.passwordMin.toLowerCase()})`} type="password" value={pw.new1} onChange={(e) => setPw({ ...pw, new1: e.target.value })} autoComplete="new-password" />
          <Input label="Conferma nuova password" type="password" value={pw.new2} onChange={(e) => setPw({ ...pw, new2: e.target.value })} autoComplete="new-password" />
          <Btn type="submit" variant="primary" disabled={!pw.old || pw.new1.length < 8 || pw.new1 !== pw.new2}>{t.save}</Btn>
        </form>
        <div className="border-t border-surface0 mt-4 pt-4">
          <div className="text-sm font-medium text-subtext1 mb-2">{t.totpTitle}</div>
          {me?.totpEnabled ? (
            <div className="flex items-end gap-2">
              <Input label={t.totpCode} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" className="max-w-40" />
              <Btn variant="danger" onClick={disableTotp} disabled={!totpCode}>{t.totpDisable}</Btn>
            </div>
          ) : (
            <Btn variant="primary" onClick={startTotp}>{t.totpEnable}</Btn>
          )}
        </div>
      </Card>

      <Card title={t.sessions} right={<Btn size="sm" variant="danger" onClick={logoutAll}>{t.logoutAll}</Btn>}>
        {sessions ? (
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 text-sm border-b border-surface0/50 pb-1.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs">{s.ip || '—'}</span>
                    {s.current && <Badge color="green">{t.sessionCurrent}</Badge>}
                  </div>
                  <div className="text-[11px] text-overlay0 truncate">{s.userAgent || '—'} · {fmtTs(s.lastSeen)}</div>
                </div>
                {!s.current && <Btn size="sm" variant="ghost" onClick={() => revokeSession(s.id)}>{t.sessionRevoke}</Btn>}
              </div>
            ))}
          </div>
        ) : <Spinner />}
      </Card>

      <Card title={t.registryTitle}>
        <p className="text-xs text-overlay0 mb-3">{t.registryHint}</p>
        {settings.registryCreds.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {settings.registryCreds.map((c) => (
              <div key={c.registry} className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs">{c.registry} <span className="text-overlay0">({c.username})</span></span>
                <Btn size="sm" variant="ghost" onClick={() => delRegistry(c.registry)}>✕</Btn>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={addRegistry} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input placeholder="ghcr.io" value={reg.registry} onChange={(e) => setReg({ ...reg, registry: e.target.value })} aria-label="registry" />
          <Input placeholder={t.username} value={reg.username} onChange={(e) => setReg({ ...reg, username: e.target.value })} aria-label="username registry" />
          <Input placeholder="token/password" type="password" value={reg.password} onChange={(e) => setReg({ ...reg, password: e.target.value })} aria-label="password registry" />
          <Btn type="submit" variant="primary" className="sm:col-span-3 justify-center" disabled={!reg.registry || !reg.username || !reg.password}>{t.registryAdd}</Btn>
        </form>
      </Card>

      <Card title={t.thresholds}>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label={t.tempThresholdLabel}
            type="number" min="20" max="80"
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value || '45', 10))}
            className="max-w-28"
          />
          <Input
            label={t.tempMinLabel}
            type="number" min="0" max="50" placeholder="off"
            value={tempMin}
            onChange={(e) => setTempMin(e.target.value)}
            className="max-w-28"
          />
          <Btn variant="primary" onClick={saveThreshold}>{t.save}</Btn>
        </div>
        <div className="border-t border-surface0 mt-4 pt-4 flex items-center justify-between">
          <span className="text-sm text-subtext0">{t.notifications}</span>
          <Btn size="sm" onClick={() => api.post('/notify/test').then(() => toast.ok(t.testNotify, 'inviata')).catch((e) => toast.error(t.error, e.message))}>
            {t.testNotify}
          </Btn>
        </div>
        <div className="text-xs text-overlay0 mt-3">{t.version}: {me?.version || '—'}</div>
      </Card>

      <Card title={t.httpsLocalTitle}>
        <p className="text-sm text-subtext1 mb-2">{t.httpsLocalIntro}</p>
        <a href="/api/ca" download><Btn size="sm" variant="primary">{t.httpsLocalDownload}</Btn></a>
        <ul className="text-xs text-subtext0 space-y-1.5 list-disc pl-5 mt-3">
          <li><b>iOS</b>: {t.httpsLocalIos}</li>
          <li><b>Android</b>: {t.httpsLocalAndroid}</li>
        </ul>
        <div className="text-[11px] text-overlay0 mt-2">{t.httpsLocalNote}</div>
      </Card>

      <Card title={t.autoUpdateTitle}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer pb-1.5">
            <input
              type="checkbox"
              checked={autoUpd.enabled}
              onChange={(e) => saveAutoUpdate({ ...autoUpd, enabled: e.target.checked })}
              className="accent-[#89b4fa] w-4 h-4"
            />
            {t.autoUpdateEnable}
          </label>
          <Input
            label={t.autoUpdateInterval}
            type="number" min="1" max="168" inputMode="numeric"
            value={autoUpd.intervalHours}
            onChange={(e) => setAutoUpd({ ...autoUpd, intervalHours: parseInt(e.target.value || '8', 10) })}
            className="max-w-24"
          />
          <Btn variant="primary" onClick={() => saveAutoUpdate(autoUpd)}>{t.save}</Btn>
        </div>
        <div className="text-xs text-overlay0 mt-3">{t.autoUpdateHint}</div>
      </Card>

      {totpModal && !totpModal.recoveryCodes && (
        <Modal title={t.totpEnable} onClose={() => setTotpModal(null)}>
          <p className="text-sm text-subtext1 mb-3">{t.totpScan}</p>
          <div className="flex justify-center mb-3">
            <img src={totpModal.qr} alt="QR TOTP" className="rounded-lg border border-surface1" />
          </div>
          <div className="text-center font-mono text-xs text-overlay0 mb-3 break-all">{totpModal.secret}</div>
          <div className="flex items-end gap-2">
            <Input label={t.totpCode} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoFocus />
            <Btn variant="primary" onClick={enableTotp} disabled={totpCode.length < 6}>{t.confirm}</Btn>
          </div>
        </Modal>
      )}
      {totpModal?.recoveryCodes && (
        <Modal title={t.totpTitle} onClose={() => { setTotpModal(null); window.location.reload(); }}>
          <p className="text-sm text-peach mb-3">{t.totpRecovery}</p>
          <div className="grid grid-cols-2 gap-1.5 font-mono text-sm bg-crust border border-surface0 rounded-lg p-3">
            {totpModal.recoveryCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <div className="flex justify-end mt-4">
            <Btn variant="primary" onClick={() => { setTotpModal(null); window.location.reload(); }}>{t.close}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
