import { useId } from 'react';

// Remix Icon line glyphs (24px grid).
const BOOKMARK_LINE =
  'M5 2H19C19.5523 2 20 2.44772 20 3V22.1433C20 22.4194 19.7761 22.6434 19.5 22.6434C19.4061 22.6434 19.314 22.6168 19.2344 22.5669L12 18.0313L4.76559 22.5669C4.53163 22.7136 4.22306 22.6429 4.07637 22.4089C4.02647 22.3293 4 22.2373 4 22.1433V3C4 2.44772 4.44772 2 5 2ZM18 4H6V19.4324L12 15.6707L18 19.4324V4Z';
const ADD_LINE = 'M11 11V5H13V11H19V13H13V19H11V13H5V11H11Z';

function css(root: string) {
  const light = `
    --base: #fafafa; --stripe: rgba(15,23,42,0.05); --inner: rgba(15,23,42,0.07);
    --surface: #ffffff; --peek: #f3f3f4; --stroke: rgba(47,42,34,0.08);
    --bar: #e5e9ef; --title: #cdd4de; --empty: #f1f3f6;
    --icon: #a3abb7; --accent: #3462ad;
    --shadow: rgb(47,42,34); --shadow-opacity: 0.13;`;
  const dark = `
    --base: #26262b; --stripe: rgba(255,255,255,0.035); --inner: rgba(255,255,255,0.06);
    --surface: #323238; --peek: #2c2c31; --stroke: rgba(255,255,255,0.06);
    --bar: #3f3f47; --title: #52525b; --empty: #2a2a2f;
    --icon: #7d828c; --accent: #7ea6ea;
    --shadow: #000000; --shadow-opacity: 0.36;`;
  return `
    #${root} { ${light} }
    #${root}[data-theme='dark'] { ${dark} }
    @media (prefers-color-scheme: dark) { #${root}[data-theme='auto'] { ${dark} } }
    #${root} .${root}-flood { flood-color: var(--shadow); flood-opacity: var(--shadow-opacity); }
    #${root} .${root}-line { fill: var(--empty); }
    @media (prefers-reduced-motion: no-preference) {
      #${root} .${root}-accent {
        transform-box: fill-box; transform-origin: center;
        animation: ${root}-pop 520ms cubic-bezier(0.2, 0.9, 0.3, 1.3) 240ms both;
      }
      #${root} .${root}-line { animation: ${root}-write 3.2s steps(1, end) infinite; }
      #${root} .${root}-line-2 { animation-delay: 0.4s; }
      #${root} .${root}-line-3 { animation-delay: 0.8s; }
    }
    @keyframes ${root}-pop { 0% { transform: scale(0); } 70% { transform: scale(1.08); } 100% { transform: scale(1); } }
    @keyframes ${root}-write { 0% { fill: var(--empty); } 25% { fill: var(--bar); } 75% { fill: var(--empty); } }
  `;
}

/**
 * Lody Memory's empty state: a memory note being written, with its "new memory" action.
 * Self-contained inline SVG; every id carries one per-instance prefix.
 */
export function LodyMemoryEmptyIllustration({
  theme = 'auto',
  className,
}: {
  theme?: 'light' | 'dark' | 'auto';
  className?: string;
}) {
  const root = `lme-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const id = (name: string) => `${root}-${name}`;
  return (
    <svg
      id={root}
      data-theme={theme}
      className={className}
      viewBox="0 0 160 120"
      width="160"
      height="120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <style>{css(root)}</style>
      <defs>
        <pattern
          id={id('stripes')}
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="7" stroke="var(--stripe)" strokeWidth="1" />
        </pattern>
        <filter
          id={id('shadow')}
          x="-30%"
          y="-30%"
          width="160%"
          height="170%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceAlpha" stdDeviation="4.5" result={id('blur')} />
          <feOffset in={id('blur')} dy="5" result={id('offset')} />
          <feFlood className={`${root}-flood`} result={id('color')} />
          <feComposite in={id('color')} in2={id('offset')} operator="in" result={id('drop')} />
          <feMerge>
            <feMergeNode in={id('drop')} />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect width="160" height="120" rx="18" fill="var(--base)" />
      <rect width="160" height="120" rx="18" fill={`url(#${id('stripes')})`} />
      <rect x="0.5" y="0.5" width="159" height="119" rx="17.5" stroke="var(--inner)" />

      {/* Another memory behind this one. */}
      <rect
        x="50"
        y="18"
        width="74"
        height="72"
        rx="12"
        fill="var(--peek)"
        stroke="var(--stroke)"
      />

      {/* A memory: its name, description and what it keeps, filling in line by line. */}
      <g filter={`url(#${id('shadow')})`}>
        <rect x="34" y="28" width="78" height="74" rx="12" fill="var(--surface)" />
      </g>
      <rect x="34.5" y="28.5" width="77" height="73" rx="11.5" stroke="var(--stroke)" />
      <rect x="44" y="38" width="16" height="16" rx="5" fill="var(--empty)" />
      <path d={BOOKMARK_LINE} transform="translate(47 41) scale(0.4167)" fill="var(--icon)" />
      <rect x="66" y="40.5" width="34" height="5" rx="2.5" fill="var(--title)" />
      <rect x="66" y="49" width="22" height="4" rx="2" fill="var(--bar)" />
      <rect className={`${root}-line`} x="44" y="64" width="58" height="4" rx="2" />
      <rect className={`${root}-line ${root}-line-2`} x="44" y="73" width="48" height="4" rx="2" />
      <rect className={`${root}-line ${root}-line-3`} x="44" y="82" width="34" height="4" rx="2" />

      {/* The one next step: create a memory. */}
      <g className={`${root}-accent`}>
        <circle cx="110" cy="92" r="9" fill="var(--accent)" />
        <path d={ADD_LINE} transform="translate(104.5 86.5) scale(0.4583)" fill="#ffffff" />
      </g>
    </svg>
  );
}
