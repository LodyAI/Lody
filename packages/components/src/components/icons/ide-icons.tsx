import type { SVGProps } from 'react';
import xcodeIconUrl from '@/assets/xcode-icon.png';
import sublimeIconUrl from '@/assets/sublime-icon.png';
import { cn } from '@/lib/utils';

export function TerminalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="64px"
      height="64px"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M6 9l4 3-4 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 15h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// App-icon launchers (Xcode, Sublime) ship as squircle PNGs with built-in
// transparent margins, so at a given box size they read noticeably smaller than
// the edge-to-edge brand SVGs above. Scale them up a touch so they visually
// match the rest of the launcher icons; the caller still controls the layout box
// via `className`.
function AppIconImage({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className={cn('scale-125 object-contain', className)}
    />
  );
}

export function XcodeIcon({ className }: { className?: string }) {
  return <AppIconImage src={xcodeIconUrl} className={className} />;
}

export function SublimeIcon({ className }: { className?: string }) {
  return <AppIconImage src={sublimeIconUrl} className={className} />;
}

export function VSCodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="64px"
      height="64px"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M29.01,5.03,23.244,2.254a1.742,1.742,0,0,0-1.989.338L2.38,19.8A1.166,1.166,0,0,0,2.3,21.447c.025.027.05.053.077.077l1.541,1.4a1.165,1.165,0,0,0,1.489.066L28.142,5.75A1.158,1.158,0,0,1,30,6.672V6.605A1.748,1.748,0,0,0,29.01,5.03Z"
        style={{ fill: '#0065a9' }}
      />
      <path
        d="M29.01,26.97l-5.766,2.777a1.745,1.745,0,0,1-1.989-.338L2.38,12.2A1.166,1.166,0,0,1,2.3,10.553c.025-.027.05-.053.077-.077l1.541-1.4A1.165,1.165,0,0,1,5.41,9.01L28.142,26.25A1.158,1.158,0,0,0,30,25.328V25.4A1.749,1.749,0,0,1,29.01,26.97Z"
        style={{ fill: '#007acc' }}
      />
      <path
        d="M23.244,29.747a1.745,1.745,0,0,1-1.989-.338A1.025,1.025,0,0,0,23,28.684V3.316a1.024,1.024,0,0,0-1.749-.724,1.744,1.744,0,0,1,1.989-.339l5.765,2.772A1.748,1.748,0,0,1,30,6.6V25.4a1.748,1.748,0,0,1-.991,1.576Z"
        style={{ fill: '#1f9cf0' }}
      />
    </svg>
  );
}

export function CursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
    </svg>
  );
}

export function AntigravityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 100 100"
      height="64"
      width="64"
      {...props}
    >
      <g clipPath="url(#clip0_6001_463)">
        <path
          d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"
          fill="#3186FF"
        />
        <mask
          id="mask0_6001_463"
          maskUnits="userSpaceOnUse"
          x="13"
          y="18"
          width="85"
          height="78"
          style={{ maskType: 'alpha' }}
        >
          <path
            d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"
            fill="black"
          />
        </mask>
        <g mask="url(#mask0_6001_463)">
          <g filter="url(#filter0_f_6001_463)">
            <ellipse
              cx="22.7873"
              cy="26.8098"
              rx="22.7873"
              ry="26.8098"
              transform="matrix(-0.112784 0.99362 -0.99362 -0.112781 66.2473 -15.5344)"
              fill="#FFE432"
            />
          </g>
          <g filter="url(#filter1_f_6001_463)">
            <ellipse
              cx="96.491"
              cy="35.1231"
              rx="29.5007"
              ry="30.1492"
              transform="rotate(76.9243 96.491 35.1231)"
              fill="#FC413D"
            />
          </g>
          <g filter="url(#filter2_f_6001_463)">
            <ellipse
              cx="9.02988"
              cy="41.6647"
              rx="30.832"
              ry="39.9417"
              transform="rotate(74.1257 9.02988 41.6647)"
              fill="#00B95C"
            />
          </g>
          <g filter="url(#filter3_f_6001_463)">
            <ellipse
              cx="9.02988"
              cy="41.6647"
              rx="30.832"
              ry="39.9417"
              transform="rotate(74.1257 9.02988 41.6647)"
              fill="#00B95C"
            />
          </g>
          <g filter="url(#filter4_f_6001_463)">
            <ellipse
              cx="11.2212"
              cy="42.8915"
              rx="30.22"
              ry="33.2695"
              transform="rotate(45.6065 11.2212 42.8915)"
              fill="#00B95C"
            />
          </g>
          <g filter="url(#filter5_f_6001_463)">
            <ellipse
              cx="75.7546"
              cy="104.822"
              rx="29.0177"
              ry="27.943"
              transform="rotate(76.9243 75.7546 104.822)"
              fill="#3186FF"
            />
          </g>
          <g filter="url(#filter6_f_6001_463)">
            <ellipse
              cx="33.5661"
              cy="35.4043"
              rx="33.5661"
              ry="35.4043"
              transform="matrix(-0.409539 0.912293 -0.912294 -0.409537 101.25 -15.1674)"
              fill="#FBBC04"
            />
          </g>
          <g filter="url(#filter7_f_6001_463)">
            <path
              d="M2.56802 149.695C-15.8116 142.48 15.5987 83.1163 23.4093 63.2203C31.22 43.3244 52.4514 33.0447 70.831 40.26C89.2107 47.4753 110.996 87.2162 103.185 107.112C95.3742 127.008 20.9477 156.91 2.56802 149.695Z"
              fill="#3186FF"
            />
          </g>
          <g filter="url(#filter8_f_6001_463)">
            <path
              d="M113.934 75.8079C109.013 81.5509 96.1724 78.6224 85.253 69.2667C74.3335 59.911 69.4704 47.6711 74.391 41.928C79.3116 36.185 92.1525 39.1136 103.072 48.4692C113.991 57.8249 118.855 70.0648 113.934 75.8079Z"
              fill="#749BFF"
            />
          </g>
          <g filter="url(#filter9_f_6001_463)">
            <ellipse
              cx="92.611"
              cy="23.7962"
              rx="44.2411"
              ry="27.5016"
              transform="rotate(34.0763 92.611 23.7962)"
              fill="#FC413D"
            />
          </g>
          <g filter="url(#filter10_f_6001_463)">
            <ellipse
              cx="23.4949"
              cy="29.5887"
              rx="23.7071"
              ry="13.7869"
              transform="rotate(112.516 23.4949 29.5887)"
              fill="#FFEE48"
            />
          </g>
        </g>
      </g>
      <defs>
        <filter
          id="filter0_f_6001_463"
          x="2.49348"
          y="-26.5423"
          width="69.0899"
          height="61.2525"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="3.89034" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter1_f_6001_463"
          x="28.7524"
          y="-32.0333"
          width="135.477"
          height="134.313"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="18.8078" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter2_f_6001_463"
          x="-62.2884"
          y="-21.9253"
          width="142.637"
          height="127.18"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="15.9884" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter3_f_6001_463"
          x="-62.2884"
          y="-21.9253"
          width="142.637"
          height="127.18"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="15.9884" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter4_f_6001_463"
          x="-52.5697"
          y="-20.8346"
          width="127.582"
          height="127.452"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="15.9884" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter5_f_6001_463"
          x="17.3619"
          y="45.4646"
          width="116.786"
          height="118.715"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="15.1937" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter6_f_6001_463"
          x="-7.44765"
          y="-60.4737"
          width="125.303"
          height="122.858"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="13.7698" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter7_f_6001_463"
          x="-27.7086"
          y="13.3597"
          width="157.119"
          height="162.029"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="12.297" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter8_f_6001_463"
          x="50.4638"
          y="16.981"
          width="87.3973"
          height="83.7738"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="11.0036" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter9_f_6001_463"
          x="34.2604"
          y="-28.457"
          width="116.701"
          height="104.506"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="9.29385" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <filter
          id="filter10_f_6001_463"
          x="-15.1522"
          y="-15.9493"
          width="77.2941"
          height="91.076"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="11.5027" result="effect1_foregroundBlur_6001_463" />
        </filter>
        <clipPath id="clip0_6001_463">
          <rect width="113" height="113" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function ZedIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="90" viewBox="0 0 90 90" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.4375 5.625C6.8842 5.625 5.625 6.8842 5.625 8.4375V70.3125H0V8.4375C0 3.7776 3.7776 0 8.4375 0H83.7925C87.551 0 89.4333 4.5442 86.7756 7.20186L40.3642 53.6133H53.4375V47.8125H59.0625V55.0195C59.0625 57.3495 57.1737 59.2383 54.8438 59.2383H34.7392L25.0712 68.9062H68.9062V33.75H74.5312V68.9062C74.5312 72.0128 72.0128 74.5312 68.9062 74.5312H19.4462L9.60248 84.375H81.5625C83.1158 84.375 84.375 83.1158 84.375 81.5625V19.6875H90V81.5625C90 86.2224 86.2224 90 81.5625 90H6.20749C2.44898 90 0.566723 85.4558 3.22438 82.7981L49.46 36.5625H36.5625V42.1875H30.9375V35.1562C30.9375 32.8263 32.8263 30.9375 35.1562 30.9375H55.085L64.9288 21.0938H21.0938V56.25H15.4688V21.0938C15.4688 17.9871 17.9871 15.4688 21.0938 15.4688H70.5538L80.3975 5.625H8.4375Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function WarpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="none"
      height="83"
      viewBox="0 0 101 83"
      width="101"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M51.0696 0.921936H88.7341C94.8309 0.921936 99.7736 6.02928 99.7736 12.3295V56.6175C99.7736 62.9179 94.8309 68.0252 88.7341 68.0252H34.835L51.0696 0.921936Z"
        fill="currentColor"
      ></path>
      <path
        d="M41.2866 13.6346H10.9455C4.90046 13.6346 0 18.7419 0 25.0421V69.3302C0 75.6305 4.90046 80.7378 10.9455 80.7378H48.2888L49.7863 74.495H26.6878L41.2866 13.6346Z"
        fill="currentColor"
      ></path>
    </svg>
  );
}

export function DevinDesktopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 263 300" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M1.84577e-10 100.797V38.6224C1.88813e-05 35.8899 1.45777 33.365 3.82414 31.9988L57.6539 0.920185C60.0203 -0.446051 62.9358 -0.446051 65.3022 0.920185L119.132 31.9988C121.498 33.3651 122.956 35.8899 122.956 38.6224V70.375C123.192 80.9262 128.769 91.103 138.577 96.7655C148.384 102.428 159.986 102.169 169.242 97.0979L196.74 81.2217C199.107 79.8554 202.022 79.8554 204.388 81.2217L258.218 112.3C260.585 113.667 262.042 116.191 262.042 118.924V181.081C262.042 183.814 260.585 186.339 258.218 187.705L204.388 218.783C202.022 220.15 199.107 220.15 196.74 218.783L169.464 203.036C160.173 197.847 148.465 197.536 138.579 203.244C128.772 208.906 123.195 219.083 122.959 229.634V261.378C122.959 264.111 121.501 266.635 119.135 268.002L65.3048 299.08C62.9384 300.447 60.0229 300.447 57.6566 299.08L3.82673 268.002C1.46036 266.635 0.00260562 264.111 0.00260562 261.378V199.221C0.0026245 196.488 1.46038 193.963 3.82675 192.597L57.6565 161.519C60.0229 160.152 62.9384 160.152 65.3048 161.519L92.8656 177.431C102.11 182.467 113.679 182.711 123.463 177.062C133.349 171.355 138.934 161.06 139.086 150.419C138.85 139.868 133.274 128.601 123.466 122.938C113.658 117.276 102.056 117.534 92.8007 122.606L65.1758 138.645C62.7991 140.025 59.8649 140.024 57.4894 138.642L3.80216 107.407C1.44816 106.038 -1.88809e-05 103.52 1.84577e-10 100.797Z" />
    </svg>
  );
}

export function WindsurfIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      clipRule="evenodd"
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M23.78 5.004h-.228a2.187 2.187 0 00-2.18 2.196v4.912c0 .98-.804 1.775-1.76 1.775a1.818 1.818 0 01-1.472-.773L13.168 5.95a2.197 2.197 0 00-1.81-.95c-1.134 0-2.154.972-2.154 2.173v4.94c0 .98-.797 1.775-1.76 1.775-.57 0-1.136-.289-1.472-.773L.408 5.098C.282 4.918 0 5.007 0 5.228v4.284c0 .216.066.426.188.604l5.475 7.889c.324.466.8.812 1.351.938 1.377.316 2.645-.754 2.645-2.117V11.89c0-.98.787-1.775 1.76-1.775h.002c.586 0 1.135.288 1.472.773l4.972 7.163a2.15 2.15 0 001.81.95c1.158 0 2.151-.973 2.151-2.173v-4.939c0-.98.787-1.775 1.76-1.775h.194c.122 0 .22-.1.22-.222V5.225a.221.221 0 00-.22-.222z" />
    </svg>
  );
}
