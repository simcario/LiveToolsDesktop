import { useLayoutEffect, useRef, useState } from 'react';

// Slide text as large as the box allows (lines never wrap unless they must).
export default function SlideText({ text, className = '', max = 160 }) {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const sync = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lines = (text || '').split('\n');
  const longest = Math.max(8, ...lines.map((l) => l.length));
  const font = Math.max(10, Math.min(max, (size.h * 0.86) / (lines.length * 1.25), (size.w * 0.94) / (longest * 0.52)));

  return (
    <div ref={box} className={`slide-text ${className}`}>
      {text ? (
        <div style={{ fontSize: font }}>
          {lines.map((l, i) => (
            <div key={i}>{l || ' '}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
