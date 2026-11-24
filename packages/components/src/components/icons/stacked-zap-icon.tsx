import { useId, type SVGProps } from 'react';

const ZAP_PATH =
  'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z';
const SCALE = 0.75;
const FRONT = `translate(-0.5 -0.5) scale(${SCALE})`;
const BACK = `translate(5.5 5.5) scale(${SCALE})`;
const GAP = 1.5;

/**
 * Ultra Fast: a solid bolt with an offset outlined bolt behind it, drawn from
 * lucide's Zap geometry so it reads as the Fast glyph doubled.
 */
export function StackedZapIcon({
  strokeWidth = 2,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'strokeWidth'> & { strokeWidth?: number }) {
  const maskId = `stacked-zap-${useId().replace(/[^\w-]/g, '')}`;
  const scaledStroke = strokeWidth / SCALE;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" stroke="none" />
        <path
          d={ZAP_PATH}
          transform={FRONT}
          fill="black"
          stroke="black"
          strokeWidth={scaledStroke + (2 * GAP) / SCALE}
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path d={ZAP_PATH} transform={BACK} strokeWidth={scaledStroke} />
      </g>
      <path d={ZAP_PATH} transform={FRONT} fill="currentColor" strokeWidth={scaledStroke} />
    </svg>
  );
}
