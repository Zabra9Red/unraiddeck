// Shell applicazione: stato auth (setup → login → app), tabs, banner di
// sicurezza (DISABLE_AUTH, FUSE, PASSWORD env), campanella notifiche.
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { getSocket, disconnectSocket } from './socket.js';
import { Login, Setup } from './views/Login.jsx';
import { DockerView } from './views/DockerView.jsx';
import { UnraidView } from './views/UnraidView.jsx';
import { EnergyView } from './views/EnergyView.jsx';
import { FilesView } from './views/FilesView.jsx';
import { SettingsView } from './views/SettingsView.jsx';
import { AuditView } from './views/AuditView.jsx';
import { NotificationsBell } from './components/NotificationsBell.jsx';
import { Spinner } from './components/ui.jsx';
import { t } from './i18n.js';

const TAB_IDS = ['docker', 'unraid', 'energy', 'files', 'audit', 'settings'];

// Tab iniziale: hash URL (#energy) > localStorage > default. Così il refresh
// (e il ripristino della PWA) restano sulla tab aperta.
function initialTab() {
  const h = window.location.hash.replace('#', '');
  if (TAB_IDS.includes(h)) return h;
  const saved = localStorage.getItem('unraiddeck.tab');
  return TAB_IDS.includes(saved) ? saved : 'docker';
}

export default function App() {
  const [phase, setPhase] = useState('loading'); // loading | setup | login | app
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState(initialTab);

  const selectTab = (id) => {
    setTab(id);
    try {
      history.replaceState(null, '', `#${id}`);
      localStorage.setItem('unraiddeck.tab', id);
    } catch { /* storage non disponibile */ }
  };

  const boot = async () => {
    try {
      const meta = await api.get('/meta');
      if (meta.setupRequired) { setPhase('setup'); return; }
      try {
        const meRes = await api.get('/me');
        setMe({ ...meRes.user, flags: meRes.flags, version: meRes.version, totpEnabled: meRes.user.totpEnabled });
        setPhase('app');
        getSocket();
      } catch {
        setPhase(meta.disableAuth ? 'app' : 'login');
        if (meta.disableAuth) {
          const meRes = await api.get('/me');
          setMe({ ...meRes.user, flags: meRes.flags, version: meRes.version });
          getSocket();
        }
      }
    } catch {
      setTimeout(boot, 3000); // server non ancora pronto
    }
  };
  useEffect(() => { boot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onAuthed = async () => {
    const meRes = await api.get('/me');
    setMe({ ...meRes.user, flags: meRes.flags, version: meRes.version, totpEnabled: meRes.user.totpEnabled });
    setPhase('app');
    disconnectSocket();
    getSocket();
  };
  const logout = async () => {
    await api.post('/logout').catch(() => {});
    disconnectSocket();
    setMe(null);
    setPhase('login');
  };

  if (phase === 'loading') return <div className="min-h-full flex items-center justify-center"><Spinner className="w-10 h-10" /></div>;
  if (phase === 'setup') return <Setup onDone={onAuthed} />;
  if (phase === 'login') return <Login onLogin={onAuthed} />;

  const flags = me?.flags || {};
  const tabs = [
    ['docker', t.tabDocker],
    ['unraid', t.tabUnraid],
    ['energy', t.tabEnergy],
    ['files', t.tabFiles],
    ['audit', t.tabAudit],
    ['settings', t.tabSettings],
  ];

  return (
    <div className="min-h-full flex flex-col">
      {/* Banner critici */}
      {flags.disableAuth && (
        <div className="bg-red text-crust text-center text-sm font-medium py-1.5 px-4">{t.bannerNoAuth}</div>
      )}
      {flags.fuseWarning && (
        <div className="bg-peach text-crust text-center text-sm py-1.5 px-4">{t.bannerFuse}</div>
      )}
      {flags.passwordEnvWarning && (
        <div className="bg-yellow text-crust text-center text-sm py-1.5 px-4">{t.bannerPasswordEnv}</div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-30 bg-mantle/90 backdrop-blur border-b border-surface0">
        <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-4 h-14">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="w-7 h-7" />
            <span className="font-bold hidden sm:inline">{t.appName}</span>
          </div>
          <nav className="flex gap-1">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                onClick={() => selectTab(id)}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer ${tab === id ? 'bg-surface0 text-text' : 'text-subtext0 hover:text-text hover:bg-surface0/50'}`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="grow" />
          <NotificationsBell />
          <div className="flex items-center gap-2 text-sm text-subtext0">
            <span className="hidden sm:inline">{me?.username}</span>
            {!flags.disableAuth && (
              <button onClick={logout} className="text-xs px-2 py-1 rounded-lg hover:bg-surface0 transition-colors cursor-pointer" title={t.logout}>
                {t.logout}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Contenuto */}
      <main className="grow max-w-[1400px] w-full mx-auto px-4 py-4">
        {tab === 'docker' && <DockerView />}
        {tab === 'unraid' && <UnraidView />}
        {tab === 'energy' && <EnergyView />}
        {tab === 'files' && <FilesView />}
        {tab === 'audit' && <AuditView />}
        {tab === 'settings' && <SettingsView me={me} onLogout={logout} />}
      </main>

      {/* Footer: versione corrente (allineata alle release GitHub) */}
      <footer className="text-center py-3 border-t border-surface0">
        <a
          href="https://github.com/Zabra9Red/unraiddeck/releases"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-overlay0 hover:text-subtext0 transition-colors"
        >
          {t.appName} v{me?.version}
        </a>
      </footer>
    </div>
  );
}
