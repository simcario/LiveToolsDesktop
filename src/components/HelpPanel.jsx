// User manual (docs/MANUALE.md, bundled so it works offline), laid out like
// the preferences: chapters on the left, the text on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { openUrl } from '@tauri-apps/plugin-opener';
import manual from '../../docs/MANUALE.md?raw';
import Icon from './Icon';

const slug = (text, i) =>
  `h${i}-${text
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù]+/g, '-')
    .replace(/^-|-$/g, '')}`;

// Plain text of a heading (no **bold**, `code`, links).
const plain = (text) => text.replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

// Index: chapters (##) and sections (###); the title (#) is not listed.
const html = marked.parse(manual);
const headings = marked
  .lexer(manual)
  .filter((t) => t.type === 'heading' && t.depth >= 2 && t.depth <= 3)
  .map((t, i) => ({ depth: t.depth, text: plain(t.text), id: slug(plain(t.text), i) }));

export default function HelpPanel({ onClose }) {
  const body = useRef(null);
  const [current, setCurrent] = useState(headings[0]?.id);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? headings.filter((h) => h.text.toLowerCase().includes(q)) : headings), [q]);

  // Ids on the rendered headings, in the same order as the index.
  useEffect(() => {
    body.current.querySelectorAll('h2, h3').forEach((el, i) => {
      if (headings[i]) el.id = headings[i].id;
    });
  }, []);

  // Index follows the scroll.
  const onScroll = () => {
    const top = body.current.getBoundingClientRect().top + 24;
    let id = headings[0]?.id;
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top <= top) id = h.id;
    }
    setCurrent(id);
  };

  const go = (id) => document.getElementById(id)?.scrollIntoView({ block: 'start' });

  // Web links open in the browser; links to developer files are not followed.
  const onClick = (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/.test(href)) openUrl(href).catch(() => {});
    else if (href.startsWith('#')) go(href.slice(1));
  };

  return (
    <div className="modal-backdrop">
      <div className="prefs" role="dialog" aria-modal="true" aria-label="Manuale">
        <div className="prefs-head">
          <h2>Manuale</h2>
          <label className="prefs-search">
            <Icon name="search" size={14} />
            <input autoFocus placeholder="Cerca un capitolo" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="prefs-body">
          <nav className="prefs-nav help-nav">
            {shown.map((h) => (
              <button
                key={h.id}
                className={`${h.depth === 3 ? 'is-sub' : ''} ${current === h.id ? 'is-on' : ''}`}
                onClick={() => go(h.id)}
                title={h.text}
              >
                <span className="ellipsis">{h.text}</span>
              </button>
            ))}
            {!shown.length && <p className="hint">Nessun capitolo trovato.</p>}
          </nav>
          <div className="prefs-main help-doc" ref={body} onScroll={onScroll} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}
