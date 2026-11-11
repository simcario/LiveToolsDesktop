import { useEffect, useRef, useState } from 'react';
import { initials, sendPing } from '../lib/presence';
import { rttText } from '../lib/stageNet';
import Icon from './Icon';

// Palco Sync: who of the band is connected (internet and stage network), as the
// Lineup of the web app, with the ping of who leads. A button with the count;
// a click opens the list under it.
export default function BandPanel({ band, setlist, canDrive, notify }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const others = band.filter((r) => !r.me);
  const [sent, setSent] = useState(null); // { id, at }
  const [rtt, setRtt] = useState({}); // key → ms
  const seen = useRef(new Set());

  useEffect(() => {
    if (!sent) return;
    band.forEach((r) => {
      const k = `${sent.id}:${r.key}`;
      if (r.pingAck === sent.id && !seen.current.has(k)) {
        seen.current.add(k);
        setRtt((cur) => ({ ...cur, [r.key]: Math.round(performance.now() - sent.at) }));
      }
    });
  }, [band, sent]);

  const ping = () => {
    setRtt({});
    sendPing(setlist)
      .then(setSent)
      .catch((e) => notify?.(`Ping non inviato: ${e?.message || e}`, true));
  };

  const answered = Object.keys(rtt).length;
  const cloudOthers = others.filter((r) => r.cloud).length;
  const r = open && btn.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={btn}
        className={`btn btn-sm band-btn ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Chi della band è collegato a questa scaletta (Palco Sync)"
        aria-expanded={open}
      >
        <Icon name="users" size={14} /> {others.length}
      </button>
      {open && (
        <div className="st-pop-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="st-pop band-pop" style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: r.bottom + 6 }} role="dialog" aria-label="Band collegata">
            <div className="band-head">
              <strong>
                Palco Sync · {band.length} {band.length === 1 ? 'collegato' : 'collegati'}
              </strong>
              {sent && (
                <span className="small muted">
                  {answered}/{cloudOthers} risposte
                </span>
              )}
            </div>
            <ul className="band-list">
              {band.map((m) => (
                <li key={m.key}>
                  <span className="band-avatar">{initials(m.name)}</span>
                  <span className="band-text">
                    <strong>
                      {m.me ? 'Tu' : m.other ? 'Tu, altro dispositivo' : m.name.split(' ')[0]}
                      {m.leads && <span className="band-lead">guida</span>}
                    </strong>
                    <span className="small muted">{[m.part, m.device].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
                  <span className="band-via">
                    {m.lan && (
                      <span className="t-lan" title={`Rete locale di palco · ${rttText(m.rtt)}`}>
                        LAN
                      </span>
                    )}
                    {m.cloud && (
                      <span title="Via internet">
                        <Icon name="cloud" size={13} />
                      </span>
                    )}
                    {rtt[m.key] !== undefined ? <span className="mono small">{rtt[m.key]} ms</span> : m.lan && m.rtt != null && <span className="mono small muted">{m.rtt} ms</span>}
                  </span>
                </li>
              ))}
            </ul>
            {others.length === 0 && <p className="small muted">Nessun altro ha aperto questa scaletta in questo momento.</p>}
            {canDrive && cloudOthers > 0 && (
              <button className="btn btn-sm" onClick={ping} title="Verifica che tutti ricevano i comandi via internet">
                <Icon name="radio" size={14} /> Invia ping
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
