import { useMemo } from 'react';
import { parseChart, prefersFlat, sectionType, transposeKey } from '../shared/music.js';

// ChordPro / chords-over-lyrics viewer, as ChartLines in the web app. Chords
// are transposed on the fly.
export function ChartLines({ source, semitones = 0, songKey = '' }) {
  const flat = prefersFlat(transposeKey(songKey, semitones));
  const { lines } = useMemo(() => parseChart(source, semitones, flat), [source, semitones, flat]);
  return (
    <div className="chart">
      {lines.map((l, i) => {
        if (l.type === 'empty') return <div key={i} className="chart-gap" />;
        if (l.type === 'section') {
          return (
            <div
              key={i}
              className={`chart-section ${l.kind === 'chorus' ? 'is-chorus' : ''} ${l.ref ? 'is-ref' : ''}`}
              style={{ '--sec': sectionType(l.kind)?.color }}
            >
              <span className="chart-badge-sec">{l.badge}</span>
              {l.ref && '↻ '}
              {l.label}
              {l.repeat > 1 && <span className="chart-rep"> ×{l.repeat}</span>}
              {l.expression && <span className="chart-expr">{l.expression}</span>}
            </div>
          );
        }
        if (l.type === 'comment') return <div key={i} className={l.expression ? 'chart-expr is-line' : 'chart-comment'}>{l.text}</div>;
        if (l.type === 'chords') {
          return (
            <pre key={i} className={`chart-chords ${l.plain ? 'is-tab' : ''} ${l.chorus ? 'is-chorus' : ''}`}>
              {l.text}
            </pre>
          );
        }
        return (
          <div
            key={i}
            className={`chart-line ${l.chorus ? 'is-chorus' : ''} ${l.segments.some((x) => x.chord) ? '' : 'is-plain'}`}
          >
            {l.segments.map((s, k) => (
              <span key={k} className="chart-seg">
                {s.chord && <span className="chart-chord">{s.chord}</span>}
                <span className="chart-lyric">{s.text || ' '}</span>
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
