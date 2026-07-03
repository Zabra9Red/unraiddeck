// Login (con TOTP quando richiesto) e Setup wizard del primo avvio.
import { useState } from 'react';
import { api } from '../api.js';
import { Btn, Input, Card } from '../components/ui.jsx';
import { t } from '../i18n.js';

function AuthShell({ children, subtitle }) {
  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <img src="/favicon.svg" alt="" className="w-9 h-9" />
          <div>
            <h1 className="text-xl font-bold leading-tight">{t.appName}</h1>
            {subtitle && <p className="text-xs text-overlay0">{subtitle}</p>}
          </div>
        </div>
        <Card>{children}</Card>
      </div>
    </div>
  );
}

export function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await api.post('/login', { username, password, totp: totp || undefined });
      onLogin(out.user);
    } catch (err) {
      if (err.body?.totpRequired) setTotpRequired(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-3">
        <Input label={t.username} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        <Input label={t.password} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {totpRequired && (
          <div>
            <Input label={t.totpCode} value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoFocus />
            <p className="text-[11px] text-overlay0 mt-1">{t.totpHint}</p>
          </div>
        )}
        {error && <div className="text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>}
        <Btn type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={busy || !username || !password}>
          {busy ? '…' : t.login}
        </Btn>
      </form>
    </AuthShell>
  );
}

export function Setup({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const valid = username.length >= 2 && password.length >= 8 && password === confirm;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await api.post('/setup', { username, password });
      onDone(out.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell subtitle={t.setupSubtitle}>
      <form onSubmit={submit} className="space-y-3">
        <h2 className="font-semibold">{t.setupTitle}</h2>
        <Input label={t.username} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        <Input label={`${t.password} (${t.passwordMin.toLowerCase()})`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <Input label="Conferma password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {confirm && password !== confirm && <div className="text-xs text-peach">Le password non coincidono</div>}
        {error && <div className="text-sm text-red bg-red/10 border border-red/30 rounded-lg px-3 py-2">{error}</div>}
        <Btn type="submit" variant="primary" size="lg" className="w-full justify-center" disabled={!valid || busy}>
          {busy ? '…' : t.setupCta}
        </Btn>
      </form>
    </AuthShell>
  );
}
