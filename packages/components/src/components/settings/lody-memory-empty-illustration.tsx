import { useId } from 'react';

// Remix Icon line glyphs (24px grid).
const BRAIN_LINE =
  'M9 4C10.1046 4 11 4.89543 11 6V12.8271C10.1058 12.1373 8.96602 11.7305 7.6644 11.5136L7.3356 13.4864C8.71622 13.7165 9.59743 14.1528 10.1402 14.7408C10.67 15.3147 11 16.167 11 17.5C11 18.8807 9.88071 20 8.5 20C7.11929 20 6 18.8807 6 17.5V17.1493C6.43007 17.2926 6.87634 17.4099 7.3356 17.4864L7.6644 15.5136C6.92149 15.3898 6.1752 15.1144 5.42909 14.7599C4.58157 14.3573 4 13.499 4 12.5C4 11.6653 4.20761 11.0085 4.55874 10.5257C4.90441 10.0504 5.4419 9.6703 6.24254 9.47014L7 9.28078V6C7 4.89543 7.89543 4 9 4ZM12 3.35418C11.2671 2.52376 10.1947 2 9 2C6.79086 2 5 3.79086 5 6V7.77422C4.14895 8.11644 3.45143 8.64785 2.94126 9.34933C2.29239 10.2415 2 11.3347 2 12.5C2 14.0652 2.79565 15.4367 4 16.2422V17.5C4 19.9853 6.01472 22 8.5 22C9.91363 22 11.175 21.3482 12 20.3287C12.825 21.3482 14.0864 22 15.5 22C17.9853 22 20 19.9853 20 17.5V16.2422C21.2044 15.4367 22 14.0652 22 12.5C22 11.3347 21.7076 10.2415 21.0587 9.34933C20.5486 8.64785 19.8511 8.11644 19 7.77422V6C19 3.79086 17.2091 2 15 2C13.8053 2 12.7329 2.52376 12 3.35418ZM18 17.1493V17.5C18 18.8807 16.8807 20 15.5 20C14.1193 20 13 18.8807 13 17.5C13 16.167 13.33 15.3147 13.8598 14.7408C14.4026 14.1528 15.2838 13.7165 16.6644 13.4864L16.3356 11.5136C15.034 11.7305 13.8942 12.1373 13 12.8271V6C13 4.89543 13.8954 4 15 4C16.1046 4 17 4.89543 17 6V9.28078L17.7575 9.47014C18.5581 9.6703 19.0956 10.0504 19.4413 10.5257C19.7924 11.0085 20 11.6653 20 12.5C20 13.499 19.4184 14.3573 18.5709 14.7599C17.8248 15.1144 17.0785 15.3898 16.3356 15.5136L16.6644 17.4864C17.1237 17.4099 17.5699 17.2926 18 17.1493Z';
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
      <path d={BRAIN_LINE} transform="translate(47 41) scale(0.4167)" fill="var(--icon)" />
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
