import { slideTags, tagInk } from '../shared/prompter.js';

// The coloured directions of a slide (Voce femminile, Finale…), on every gobbo above its text.
// Copied into LiveTools Mobile (Leggio); the web app has its own copy.
export default function SlideTags({ slide, className = '' }) {
  const tags = slideTags(slide);
  if (!tags.length) return null;
  return (
    <div className={`slide-tags ${className}`}>
      {tags.map((t, i) => (
        <span key={i} className="slide-tag" style={{ background: t.color, color: tagInk(t.color) }}>
          {t.label}
        </span>
      ))}
    </div>
  );
}
