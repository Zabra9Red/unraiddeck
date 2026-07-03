// Audit log consultabile: utente, azione, target, esito, IP.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Badge, Spinner, Btn, EmptyState } from '../components/ui.jsx';
import { t, fmtTs } from '../i18n.js';

const PAGE = 50;

export function AuditView() {
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ limit: PAGE, offset });
    if (action) params.set('action', action);
    api.get(`/audit?${params}`).then(setData).catch(() => setData({ rows: [], total: 0 }));
  }, [offset, action]);

  return (
    <Card
      title={t.auditTitle}
      right={
        <select
          value={action}
          onChange={(e) => { setAction(e.target.value); setOffset(0); }}
          className="bg-mantle border border-surface1 rounded-lg px-2 py-1 text-xs outline-none"
        >
          <option value="">tutte le azioni</option>
          <option value="auth.">auth</option>
          <option value="container.">container</option>
          <option value="exec.">exec</option>
          <option value="unraid.">unraid</option>
          <option value="updates.">updates</option>
          <option value="settings.">settings</option>
        </select>
      }
    >
      {!data ? <Spinner /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead>
                <tr className="text-left text-xs text-overlay0 border-b border-surface0">
                  <th className="py-1.5 pr-2">{t.auditWhen}</th>
                  <th className="py-1.5 pr-2">{t.auditUser}</th>
                  <th className="py-1.5 pr-2">{t.auditAction}</th>
                  <th className="py-1.5 pr-2">{t.auditTarget}</th>
                  <th className="py-1.5 pr-2">{t.auditOutcome}</th>
                  <th className="py-1.5 pr-2">IP</th>
                  <th className="py-1.5">Dettagli</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className="border-b border-surface0/50">
                    <td className="py-1.5 pr-2 whitespace-nowrap text-xs text-subtext0">{fmtTs(row.ts)}</td>
                    <td className="py-1.5 pr-2">{row.user || '—'}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{row.action}</td>
                    <td className="py-1.5 pr-2">{row.target || '—'}</td>
                    <td className="py-1.5 pr-2">
                      <Badge color={row.outcome === 'ok' ? 'green' : row.outcome === 'conflitto' ? 'yellow' : 'red'}>{row.outcome}</Badge>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-overlay0">{row.ip || '—'}</td>
                    <td className="py-1.5 text-xs text-overlay0 max-w-64 truncate" title={row.details}>{row.details || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.rows.length && <EmptyState>Nessuna voce</EmptyState>}
          <div className="flex items-center justify-between mt-3 text-xs text-overlay0">
            <span>{data.total} voci totali</span>
            <div className="flex gap-1.5">
              <Btn size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>←</Btn>
              <Btn size="sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>→</Btn>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
