import { useId } from 'react';

// Remix Icon line glyphs (24px grid).
const FILE_TEXT_LINE =
  'M21 8V20.9932C21 21.5501 20.5552 22 20.0066 22H3.9934C3.44495 22 3 21.556 3 21.0082V2.9918C3 2.45531 3.44694 2 3.99826 2H14.9968L21 8ZM19 9H14V4H5V20H19V9ZM8 7H11V9H8V7ZM8 11H16V13H8V11ZM8 15H16V17H8V15Z';
const SEARCH_LINE =
  'M18.031 16.6168L22.3137 20.8995L20.8995 22.3137L16.6168 18.031C15.0769 19.263 13.124 20 11 20C6.032 20 2 15.968 2 11C2 6.032 6.032 2 11 2C15.968 2 20 6.032 20 11C20 13.124 19.263 15.0769 18.031 16.6168ZM16.0247 15.8748C17.2475 14.6146 18 12.8956 18 11C18 7.1325 14.8675 4 11 4C7.1325 4 4 7.1325 4 11C4 14.8675 7.1325 18 11 18C12.8956 18 14.6146 17.2475 15.8748 16.0247L16.0247 15.8748Z';
const ADD_LINE = 'M11 11V5H13V11H19V13H13V19H11V13H5V11H11Z';

function css(root: string) {
  const light = `
    --base: #fafafa; --stripe: rgba(15,23,42,0.05); --inner: rgba(15,23,42,0.07);
    --surface: #ffffff; --peek: #f3f3f4; --tabs: #eef1f5; --stroke: rgba(47,42,34,0.08);
    --bar: #e5e9ef; --title: #cdd4de; --empty: #f1f3f6;
    --icon: #a3abb7; --icon-secondary: #6b7280; --accent: #3462ad;
    --shadow: rgb(47,42,34); --shadow-opacity: 0.13;`;
  const dark = `
    --base: #26262b; --stripe: rgba(255,255,255,0.035); --inner: rgba(255,255,255,0.06);
    --surface: #323238; --peek: #2c2c31; --tabs: #2a2a2f; --stroke: rgba(255,255,255,0.06);
    --bar: #3f3f47; --title: #52525b; --empty: #2a2a2f;
    --icon: #7d828c; --icon-secondary: #7d828c; --accent: #7ea6ea;
    --shadow: #000000; --shadow-opacity: 0.36;`;
  return `
    #${root} { ${light} }
    #${root}[data-theme='dark'] { ${dark} }
    @media (prefers-color-scheme: dark) { #${root}[data-theme='auto'] { ${dark} } }
    #${root} .${root}-flood { flood-color: var(--shadow); flood-opacity: var(--shadow-opacity); }
    #${root} .${root}-slot { fill: var(--empty); }
    @media (prefers-reduced-motion: no-preference) {
      #${root} .${root}-accent {
        transform-box: fill-box; transform-origin: center;
        animation: ${root}-pop 520ms cubic-bezier(0.2, 0.9, 0.3, 1.3) 240ms both;
      }
      #${root} .${root}-slot { animation: ${root}-scan 2.4s steps(1, end) infinite; }
      #${root} .${root}-slot-2 { animation-delay: 0.8s; }
      #${root} .${root}-slot-3 { animation-delay: 1.6s; }
      #${root} .${root}-caret { animation: ${root}-blink 1.2s steps(1, end) infinite; }
    }
    @keyframes ${root}-pop { 0% { transform: scale(0); } 70% { transform: scale(1.08); } 100% { transform: scale(1); } }
    @keyframes ${root}-scan { 0% { fill: var(--bar); } 33.333% { fill: var(--empty); } }
    @keyframes ${root}-blink { 0% { opacity: 1; } 50% { opacity: 0; } }
  `;
}

/**
 * Lody Memory's empty state: an empty memory window with its "new memory" action.
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
        <clipPath id={id('window')}>
          <rect x="22" y="24" width="116" height="80" rx="12" />
        </clipPath>
      </defs>

      <rect width="160" height="120" rx="18" fill="var(--base)" />
      <rect width="160" height="120" rx="18" fill={`url(#${id('stripes')})`} />
      <rect x="0.5" y="0.5" width="159" height="119" rx="17.5" stroke="var(--inner)" />

      {/* Another memory behind the open one. */}
      <rect
        x="36"
        y="16"
        width="88"
        height="40"
        rx="11"
        fill="var(--peek)"
        stroke="var(--stroke)"
      />

      <g filter={`url(#${id('shadow')})`}>
        <rect x="22" y="24" width="116" height="80" rx="12" fill="var(--surface)" />
      </g>
      <g clipPath={`url(#${id('window')})`}>
        <rect x="22" y="24" width="116" height="18" fill="var(--tabs)" />
        <rect x="28" y="28" width="44" height="16" rx="5" fill="var(--surface)" />
        <path d={FILE_TEXT_LINE} transform="translate(32 31.5) scale(0.3333)" fill="var(--icon)" />
        <rect x="43" y="33" width="22" height="4" rx="2" fill="var(--title)" />
        <rect x="80" y="33" width="20" height="4" rx="2" fill="var(--bar)" />
        <path
          d={SEARCH_LINE}
          transform="translate(123 31) scale(0.3333)"
          fill="var(--icon-secondary)"
        />

        {/* Topic list: empty slots scanned in turn. */}
        <rect className={`${root}-slot`} x="29" y="49" width="28" height="9" rx="3" />
        <rect
          className={`${root}-slot ${root}-slot-2`}
          x="29"
          y="62"
          width="28"
          height="9"
          rx="3"
        />
        <rect
          className={`${root}-slot ${root}-slot-3`}
          x="29"
          y="75"
          width="28"
          height="9"
          rx="3"
        />
        <rect x="63" y="47" width="1" height="51" fill="var(--empty)" />

        {/* MEMORY.md, still empty. */}
        <rect x="71" y="50" width="34" height="5" rx="2.5" fill="var(--title)" />
        <rect
          className={`${root}-caret`}
          x="108"
          y="49"
          width="1.5"
          height="7"
          rx="0.75"
          fill="var(--icon-secondary)"
        />
        <rect x="71" y="62" width="56" height="4" rx="2" fill="var(--bar)" />
        <rect x="71" y="70" width="40" height="4" rx="2" fill="var(--empty)" />
      </g>

      {/* The one next step: create a memory. */}
      <g className={`${root}-accent`}>
        <rect x="106" y="82" width="24" height="14" rx="7" fill="var(--accent)" />
        <path d={ADD_LINE} transform="translate(113.5 84.5) scale(0.375)" fill="#ffffff" />
      </g>
    </svg>
  );
}
