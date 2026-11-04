import { useState } from 'react';
import { EXPRESSION_HINTS, EXPRESSION_TAGS, insertLine, nextSectionHeader, SECTION_TYPES } from '../shared/music.js';
import Icon from './Icon';

// Tags of the chord chart, as in the web app: a section header ("[Strofa 2]",
// numbered after the ones already written) or an expression ({expr: Soft}) on
// its own line at the cursor. They split the chart into the sections of the
// roadmap (V1 V2 C1…) of the printed chart and mark how to play them.
// The buttons show only in the widened editor; `compact` (the normal field)
// keeps just the (i) button, which opens the legend of the tags.
export default function ChartTags({ value, onChange, textareaRef, compact = false }) {
  const [legend, setLegend] = useState(false);
  const put = (line) => {
    const el = textareaRef.current;
    const { text, caret } = insertLine(value, el ? el.selectionStart : value.length, line);
    onChange(text);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };
  const info = (
    <button
      type="button"
      className={`chart-info ${legend ? 'is-on' : ''}`}
      onClick={() => setLegend((x) => !x)}
      title={legend ? 'Nascondi la legenda' : 'Legenda di sezioni ed espressioni'}
      aria-label="Legenda di sezioni ed espressioni"
      aria-expanded={legend}
    >
      <Icon name="info" size={14} />
    </button>
  );
  return (
    <div className="chart-tags">
      {compact ? (
        <div className="chart-tags-row">
          <span className="small faint">Sezioni ed espressioni: i pulsanti per inserirle sono in “Allarga”</span>
          {info}
        </div>
      ) : (
        <>
          <div className="chart-tags-row">
            <span className="small faint">Sezioni</span>
            {SECTION_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                className="chart-tag"
                style={{ '--sec': t.color }}
                onClick={() => put(nextSectionHeader(value, t.type))}
                title={`Inserisci ${t.label} (${t.abbr})`}
              >
                <b>{t.abbr}</b> {t.label}
              </button>
            ))}
            {info}
          </div>
          <div className="chart-tags-row">
            <span className="small faint">Espressione</span>
            {EXPRESSION_TAGS.map((x) => (
              <button key={x} type="button" className="chart-tag is-expr" onClick={() => put(`{expr: ${x}}`)} title={EXPRESSION_HINTS[x] || x}>
                {x}
              </button>
            ))}
          </div>
        </>
      )}
      {legend && <ChartLegend onClose={() => setLegend(false)} />}
    </div>
  );
}

function ChartLegend({ onClose }) {
  return (
    <div className="chart-legend" role="region" aria-label="Legenda">
      <div className="chart-legend-head">
        <b>Legenda</b>
        <button type="button" className="chart-info" onClick={onClose} aria-label="Chiudi la legenda" title="Chiudi">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="chart-legend-cols">
        <section>
          <h4>Sezioni</h4>
          <ul className="chart-legend-list">
            {SECTION_TYPES.map((t) => (
              <li key={t.type}>
                <span className="chart-badge-sec" style={{ '--sec': t.color }}>
                  {t.abbr}
                </span>
                <span>
                  <b>{t.label}</b>
                  <span className="faint"> · {t.names.filter((n) => n.length > 2 && n !== t.label.toLowerCase()).slice(0, 3).join(', ')}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="small faint">Se un tipo ha più sezioni le sigle si numerano da sole: V1, V2, C1, C2…</p>
        </section>
        <section>
          <h4>Espressioni</h4>
          <ul className="chart-legend-list">
            {EXPRESSION_TAGS.map((x) => (
              <li key={x}>
                <i className="chart-legend-expr">{x}</i>
                <span className="faint">{EXPRESSION_HINTS[x]}</span>
              </li>
            ))}
          </ul>
          <p className="small faint">Puoi scrivere qualsiasi espressione: {'{expr: Testo}'}.</p>
        </section>
        <section>
          <h4>Come si scrive</h4>
          <dl className="chart-legend-syntax">
            <dt><code>[Strofa 1]</code></dt>
            <dd>Intestazione di sezione, su una riga sua (anche <code>Verse 1</code>, <code>{'{start_of_verse}'}</code>)</dd>
            <dt><code>{'{expr: Soft}'}</code></dt>
            <dd>Espressione: sotto un’intestazione è l’indicazione della sezione, altrove una nota a destra</dd>
            <dt><code>[Strofa 3 | Softly]</code></dt>
            <dd>Sezione ed espressione insieme</dd>
            <dt><code>[Ritornello 1]</code></dt>
            <dd>Riscritta senza righe sotto (o <code>{'{chorus}'}</code>): la sezione torna nella mappa senza essere ristampata</dd>
            <dt><code>Bridge x2</code></dt>
            <dd>Sezione ripetuta due volte</dd>
            <dt><code>[G]Vedo il [Em]Re</code></dt>
            <dd>Accordi ChordPro; vanno bene anche gli accordi sulla riga sopra il testo</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
