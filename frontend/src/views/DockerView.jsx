// Vista Docker: lista container guidata dagli eventi (niente polling a regime),
// stats real-time, bulk con lock rispettato, update con dipendenti, prune, df.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket, subscribe } from '../socket.js';
import { Btn, Badge, Spinner, EmptyState, Dropdown, MenuItem, Meter } from '../components/ui.jsx';
import { Modal, ConfirmTyped } from '../components/Modal.jsx';
import { Sparkline } from '../components/charts.jsx';
import { ContainerIcon } from '../components/ContainerIcon.jsx';
import { Drawer } from '../components/Drawer.jsx';
import { UpdateModal } from '../components/UpdateModal.jsx';
import { useToast } from '../components/Toast.jsx';
import { t, fmtBytes, fmtRate, fmtUptime } from '../i18n.js';

const STATE_BADGE = {
  running: ['green', t.running],
  exited: ['red', t.exited],
  paused: ['yellow', t.paused],
  restarting: ['peach', t.restarting],
  created: ['overlay', 'creato'],
  dead: ['red', 'dead'],
};

export function DockerView() {
  const toast = useToast();
  const [containers, setContainers] = useState(null);
  const [statsMap, setStatsMap] = useState({});
  const [statsHist, setStatsHist] = useState({}); // id -> ultimi 30 punti per sparkline
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [drawer, setDrawer] = useState(null);       // container aperto
  const [confirm, setConfirm] = useState(null);     // { container, action }
  const [updateModal, setUpdateModal] = useState(null);
  const [dfModal, setDfModal] = useState(null);
  const [checking, setChecking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(null);   // id riga con menu aperto
  const refetchTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const list = await api.get('/containers');
      setContainers(list);
    } catch (e) {
      toast.error(t.error, e.message);
    }
  }, [toast]);

  // Refetch coalescato sugli eventi (gli eventi pilotano lo stato)
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => { refetchTimer.current = null; load(); }, 400);
  }, [load]);

  useEffect(() => {
    load();
    const s = getSocket();
    const unsubs = [subscribe('events'), subscribe('stats'), subscribe('notify')];
    const onEvent = () => scheduleRefetch();
    const onReconcile = (list) => setContainers(list);
    const onStats = (batch) => {
      setStatsMap((prev) => {
        const next = { ...prev };
        for (const p of batch) next[p.id] = p;
        return next;
      });
      setStatsHist((prev) => {
        const next = { ...prev };
        for (const p of batch) {
          const arr = (next[p.id] || []).concat(p);
          next[p.id] = arr.length > 30 ? arr.slice(arr.length - 30) : arr;
        }
        return next;
      });
    };
    const onUpdates = (results) => {
      setContainers((prev) => prev?.map((c) => results[c.image] ? { ...c, update: results[c.image] } : c) ?? prev);
    };
    s.on('docker:event', onEvent);
    s.on('docker:reconcile', onReconcile);
    s.on('stats:batch', onStats);
    s.on('updates:status', onUpdates);
    return () => {
      s.off('docker:event', onEvent);
      s.off('docker:reconcile', onReconcile);
      s.off('stats:batch', onStats);
      s.off('updates:status', onUpdates);
      unsubs.forEach((u) => u());
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [load, scheduleRefetch]);

  // Drawer aggiornato quando la lista cambia
  useEffect(() => {
    if (drawer) {
      const cur = containers?.find((c) => c.id === drawer.id);
      if (cur) setDrawer(cur);
    }
  }, [containers]); // eslint-disable-line react-hooks/exhaustive-deps

  const doAction = async (container, action, confirmName) => {
    try {
      await api.post(`/containers/${container.id}/action`, { action, confirmName });
      toast.ok(container.name, `${action} ok`);
      setConfirm(null);
    } catch (e) {
      if (e.status === 409) toast.warn(container.name, t.lockConflict);
      else if (e.body?.confirmRequired) setConfirm({ container, action });
      else toast.error(container.name, e.message);
    }
  };

  const askAction = (container, action) => {
    setMenuOpen(null);
    const needsTyped = ['remove', 'kill'].includes(action) || (container.isSelf && action === 'stop');
    if (needsTyped) setConfirm({ container, action });
    else doAction(container, action);
  };

  const doBulk = async (action) => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const results = await api.post('/containers/bulk', { ids, action });
      const fails = results.filter((r) => !r.ok);
      if (fails.length) toast.warn(`${action}: ${fails.length} errori`, fails.map((f) => `${f.name || f.id.slice(0, 12)}: ${f.error}`).join('\n'));
      else toast.ok(`Bulk ${action}`, `${results.length} container ok`);
      setSelected(new Set());
    } catch (e) {
      toast.error(t.error, e.message);
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      await api.post('/updates/check');
      toast.ok(t.checkUpdates, 'Check completato');
    } catch (e) {
      toast.error(t.checkUpdates, e.message);
    } finally {
      setChecking(false);
    }
  };

  const prune = async () => {
    try {
      const out = await api.post('/images/prune');
      toast.ok(t.pruneImages, `${out.deleted} immagini rimosse, ${fmtBytes(out.reclaimed)} liberati`);
    } catch (e) {
      toast.error(t.pruneImages, e.message);
    }
  };

  const openDf = async () => {
    setDfModal('loading');
    try {
      setDfModal(await api.get('/system/df'));
    } catch (e) {
      setDfModal(null);
      toast.error(t.diskSpace, e.message);
    }
  };

  const filtered = useMemo(() => {
    if (!containers) return null;
    const q = query.trim().toLowerCase();
    const list = q ? containers.filter((c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q)) : containers;
    return [...list].sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
  }, [containers, query]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectableIds = useMemo(() => (filtered || []).filter((c) => !c.isSelf).map((c) => c.id), [filtered]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  if (!filtered) return <div className="flex justify-center py-20"><Spinner className="w-8 h-8" /></div>;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder={t.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="bg-mantle border border-surface1 rounded-lg px-3 py-1.5 text-sm w-56 outline-none focus:border-blue"
        />
        <div className="grow" />
        {selected.size > 0 && (
          <div className="flex items-center gap-1.5 bg-surface0/60 rounded-lg px-2 py-1">
            <span className="text-xs text-subtext0 px-1">{t.bulkWith(selected.size)}</span>
            <Btn size="sm" variant="green" onClick={() => doBulk('start')}>{t.stStart}</Btn>
            <Btn size="sm" onClick={() => doBulk('stop')}>{t.stStop}</Btn>
            <Btn size="sm" onClick={() => doBulk('restart')}>{t.stRestart}</Btn>
            <Btn size="sm" variant="primary" onClick={() => doBulk('update')}>{t.stUpdate}</Btn>
          </div>
        )}
        <Btn size="sm" onClick={checkUpdates} disabled={checking}>{checking ? <Spinner /> : null}{t.checkUpdates}</Btn>
        <Btn size="sm" onClick={prune}>{t.pruneImages}</Btn>
        <Btn size="sm" onClick={openDf}>{t.diskSpace}</Btn>
      </div>

      {/* Lista mobile (card, tap → drawer) */}
      <div className="md:hidden space-y-2">
        {filtered.map((c) => (
          <MobileCard
            key={c.id}
            c={c}
            stats={statsMap[c.id]}
            onOpen={() => setDrawer(c)}
            onAction={askAction}
            onUpdate={() => setUpdateModal(c)}
          />
        ))}
        {!filtered.length && <EmptyState>{t.noContainers}</EmptyState>}
      </div>

      {/* Tabella container (desktop) */}
      <div className="hidden md:block overflow-x-auto bg-base border border-surface0 rounded-xl">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="text-left text-xs text-overlay0 border-b border-surface0">
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(selectableIds))}
                  className="accent-[#89b4fa]"
                  aria-label="seleziona tutti"
                />
              </th>
              <th className="px-2 py-2">{t.name}</th>
              <th className="px-2 py-2">{t.state}</th>
              <th className="px-2 py-2">{t.uptime}</th>
              <th className="px-2 py-2">{t.cpu}</th>
              <th className="px-2 py-2">{t.ram}</th>
              <th className="px-2 py-2">{t.net}</th>
              <th className="px-2 py-2 hidden lg:table-cell">{t.ports}</th>
              <th className="px-2 py-2 hidden xl:table-cell">{t.restartPolicy}</th>
              <th className="px-2 py-2 text-right">{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <Row
                key={c.id}
                c={c}
                stats={statsMap[c.id]}
                hist={statsHist[c.id]}
                selected={selected.has(c.id)}
                onSelect={() => toggleSelect(c.id)}
                onOpen={() => setDrawer(c)}
                onAction={askAction}
                onUpdate={() => { setMenuOpen(null); setUpdateModal(c); }}
                menuOpen={menuOpen === c.id}
                setMenuOpen={(open) => setMenuOpen(open ? c.id : null)}
              />
            ))}
            {!filtered.length && (
              <tr><td colSpan={10}><EmptyState>{t.noContainers}</EmptyState></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer / modali */}
      {drawer && <Drawer container={drawer} statsMap={statsMap} onClose={() => setDrawer(null)} />}
      {updateModal && <UpdateModal container={updateModal} onClose={() => setUpdateModal(null)} onDone={load} />}
      {confirm && (
        <ConfirmTyped
          title={confirm.action === 'remove' ? t.stRemove : confirm.action === 'kill' ? t.stKill : t.stStop}
          body={confirm.action === 'remove' ? t.confirmRemove(confirm.container.name) : confirm.action === 'kill' ? t.confirmKill(confirm.container.name) : `${t.stStop} "${confirm.container.name}"?`}
          expected={confirm.container.name}
          selfWarning={confirm.container.isSelf}
          onConfirm={() => doAction(confirm.container, confirm.action, confirm.container.name)}
          onClose={() => setConfirm(null)}
        />
      )}
      {dfModal && (
        <Modal title={t.diskSpace} onClose={() => setDfModal(null)}>
          {dfModal === 'loading' ? <div className="flex justify-center py-8"><Spinner className="w-6 h-6" /></div> : (
            <div className="space-y-2 text-sm">
              {[[t.dfImages, dfModal.images], [t.dfContainers, dfModal.containers], [t.dfVolumes, dfModal.volumes], [t.dfBuildCache, dfModal.buildCache]].map(([label, d]) => (
                <div key={label} className="flex justify-between border-b border-surface0 pb-2">
                  <span className="text-subtext0">{label} <span className="text-overlay0">({d.count})</span></span>
                  <span className="font-mono">{fmtBytes(d.size)}</span>
                </div>
              ))}
              <div className="text-xs text-overlay0 pt-1">Dati calcolati on-demand (docker system df).</div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// Card mobile: stato, nome, stats essenziali, azioni rapide touch-friendly.
function MobileCard({ c, stats, onOpen, onAction, onUpdate }) {
  const [bColor, bLabel] = STATE_BADGE[c.state] || ['overlay', c.state];
  const running = c.state === 'running';
  const memPct = stats?.memLimit > 0 ? (stats.mem / stats.memLimit) * 100 : 0;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return (
    <div onClick={onOpen} className="bg-base border border-surface0 rounded-xl px-3 py-2.5 cursor-pointer active:bg-surface0/30">
      <div className="flex items-center gap-2 min-w-0">
        <Badge color={bColor}>{bLabel}</Badge>
        <span className="font-medium text-sm truncate">{c.name}</span>
        {c.isSelf && <Badge color="mauve">{t.selfBadge}</Badge>}
        <div className="grow" />
        {c.update?.status === 'update' && (
          <button onClick={stop(onUpdate)} className="text-xs px-2 py-1 rounded-lg bg-blue text-crust font-medium cursor-pointer">
            {t.updBadgeUpdate}
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-xs text-subtext0">
        <span>{running && stats ? `CPU ${stats.cpu.toFixed(0)}%` : c.uptime || '—'}</span>
        {running && stats && <span>RAM {fmtBytes(stats.mem)}{memPct > 0 ? ` (${memPct.toFixed(0)}%)` : ''}</span>}
        <div className="grow" />
        <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          {running ? (
            <>
              <Btn size="sm" onClick={() => onAction(c, 'restart')}>⟳</Btn>
              <Btn size="sm" variant="warn" onClick={() => onAction(c, 'stop')}>■</Btn>
            </>
          ) : (
            <Btn size="sm" variant="green" onClick={() => onAction(c, 'start')}>▶</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ c, stats, hist, selected, onSelect, onOpen, onAction, onUpdate, menuOpen, setMenuOpen }) {
  const [bColor, bLabel] = STATE_BADGE[c.state] || ['overlay', c.state];
  const upd = c.update;
  const running = c.state === 'running';
  const memPct = stats?.memLimit > 0 ? (stats.mem / stats.memLimit) * 100 : 0;

  return (
    <tr className="border-b border-surface0/60 hover:bg-surface0/25 transition-colors cursor-pointer" onClick={onOpen}>
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        {!c.isSelf ? (
          <input type="checkbox" checked={selected} onChange={onSelect} className="accent-[#89b4fa]" aria-label={`seleziona ${c.name}`} />
        ) : <span title={t.selfBadge} className="text-blue">◆</span>}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <ContainerIcon name={c.name} iconUrl={c.iconUrl} size={32} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-medium truncate">{c.name}</span>
              {c.isSelf && <Badge color="blue" title={t.selfBadge}>self</Badge>}
              {upd?.status === 'update' && <Badge color="mauve" title={t.updateAvailable}>{t.updBadgeUpdate}</Badge>}
              {upd?.status === 'pinned' && <Badge color="teal" title={upd.reason}>{t.updBadgePinned}</Badge>}
              {upd?.status === 'local' && <Badge color="overlay" title={upd.reason}>{t.updBadgeLocal}</Badge>}
              {c.health && <Badge color={c.health === 'healthy' ? 'green' : c.health === 'starting' ? 'yellow' : 'red'}>{c.health}</Badge>}
            </div>
            <div className="text-xs text-overlay0 truncate" title={c.image}>{c.image}</div>
          </div>
        </div>
      </td>
      <td className="px-2 py-2"><Badge color={bColor}>{bLabel}</Badge></td>
      <td className="px-2 py-2 text-subtext0 whitespace-nowrap">{running && c.startedAt ? fmtUptime(Date.now() - c.startedAt) : '—'}</td>
      <td className="px-2 py-2">
        {running ? (
          <div className="flex items-center gap-2">
            <Sparkline points={hist} dataKey="cpu" max={100} width={72} height={24} />
            <span className="text-xs w-11 text-right font-mono">{stats ? `${stats.cpu.toFixed(1)}%` : '…'}</span>
          </div>
        ) : <span className="text-overlay0">—</span>}
      </td>
      <td className="px-2 py-2">
        {running && stats ? (
          <div className="w-24">
            <div className="text-xs font-mono mb-0.5">{fmtBytes(stats.mem)}</div>
            <Meter value={memPct} color={memPct > 90 ? 'red' : memPct > 70 ? 'peach' : 'green'} />
          </div>
        ) : <span className="text-overlay0">—</span>}
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        {running && stats ? (
          <div className="text-[11px] font-mono leading-tight">
            <div className="text-blue">↓ {fmtRate(stats.rx)}</div>
            <div className="text-peach">↑ {fmtRate(stats.tx)}</div>
          </div>
        ) : <span className="text-overlay0">—</span>}
      </td>
      <td className="px-2 py-2 hidden lg:table-cell">
        <div className="flex flex-wrap gap-1 max-w-40">
          {(c.ports || []).filter((p) => p.pub).slice(0, 3).map((p, i) => (
            <Badge key={i} color="overlay">{p.pub}:{p.priv}</Badge>
          ))}
          {(c.ports || []).filter((p) => p.pub).length > 3 && <Badge color="overlay">+{c.ports.filter((p) => p.pub).length - 3}</Badge>}
        </div>
      </td>
      <td className="px-2 py-2 hidden xl:table-cell text-subtext0 text-xs">{c.restartPolicy || '—'}</td>
      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {c.webui && (
            <a href={c.webui} target="_blank" rel="noreferrer noopener">
              <Btn size="sm" variant="ghost" title={t.webui}>↗ WebUI</Btn>
            </a>
          )}
          {running
            ? <Btn size="sm" variant="ghost" onClick={() => onAction(c, 'stop')} title={t.stStop}>■</Btn>
            : <Btn size="sm" variant="ghost" onClick={() => onAction(c, 'start')} title={t.stStart}>▶</Btn>}
          <Btn size="sm" variant="ghost" onClick={() => onAction(c, 'restart')} title={t.stRestart}>⟳</Btn>
          <Dropdown
            open={menuOpen}
            setOpen={setMenuOpen}
            button={<Btn size="sm" variant="ghost" onClick={() => setMenuOpen(!menuOpen)} title={t.actions}>⋯</Btn>}
          >
            <MenuItem onClick={onUpdate}>{t.stUpdate}{upd?.status === 'update' ? ' ●' : ''}</MenuItem>
            {c.state === 'paused'
              ? <MenuItem onClick={() => onAction(c, 'unpause')}>{t.stUnpause}</MenuItem>
              : <MenuItem onClick={() => onAction(c, 'pause')} disabled={!running}>{t.stPause}</MenuItem>}
            <MenuItem onClick={() => onAction(c, 'kill')} disabled={!running} danger>{t.stKill}</MenuItem>
            <MenuItem onClick={() => onAction(c, 'remove')} danger>{t.stRemove}</MenuItem>
          </Dropdown>
        </div>
      </td>
    </tr>
  );
}
