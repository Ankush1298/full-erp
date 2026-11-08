import type { FC } from 'react';

/**
 * Luminous botanical backdrop for the dark hero: three stacked SVG layers (blurred back, veined middle, crisp front)
 * that the pointer moves by different amounts, which is what gives the depth. Decorative: hidden from assistive
 * technology and never interactive. Original artwork in Anesa's palette.
 */

interface L {
  x: number;
  y: number;
  len: number;
  w: number;
  a: number;
  fill: string;
  o?: number;
  vein?: string;
}

const n = (v: number): string => v.toFixed(1);

const Leaf: FC<L> = ({ x, y, len, w, a, fill, o = 1, vein }) => {
  const h = w / 2;
  const body =
    `M0 0C${n(h * 1.15)} ${n(-len * 0.2)} ${n(h * 1.05)} ${n(-len * 0.72)} 0 ${n(-len)}` +
    `C${n(-h * 1.05)} ${n(-len * 0.72)} ${n(-h * 1.15)} ${n(-len * 0.2)} 0 0Z`;
  let veins = '';
  if (vein) {
    veins = `M0 ${n(-len * 0.04)}L0 ${n(-len * 0.94)}`;
    for (let t = 0.14; t < 0.82; t += 0.09) {
      const reach = h * 0.8 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      const rise = len * 0.12;
      veins += `M0 ${n(-len * t)}Q${n(reach * 0.5)} ${n(-len * t - rise * 0.2)} ${n(reach)} ${n(-len * t - rise)}`;
      veins += `M0 ${n(-len * t)}Q${n(-reach * 0.5)} ${n(-len * t - rise * 0.2)} ${n(-reach)} ${n(-len * t - rise)}`;
    }
  }
  return (
    <g transform={`translate(${n(x)} ${n(y)}) rotate(${n(a)})`}>
      <path d={body} fill={fill} opacity={o} />
      {vein ? (
        <path
          d={veins}
          fill="none"
          stroke={vein}
          strokeWidth={1.1}
          strokeLinecap="round"
          opacity={0.5}
        />
      ) : null}
    </g>
  );
};

const frame = {
  viewBox: '0 0 900 760',
  preserveAspectRatio: 'xMaxYMax slice',
  focusable: false,
  xmlns: 'http://www.w3.org/2000/svg',
} as const;

export const HeroFlora: FC = () => (
  <div className="flora" aria-hidden="true">
    <svg className="flora-layer" data-depth="back" {...frame}>
      <defs>
        <filter id="floraBlur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <linearGradient id="floraRose" x1="0" y1="1" x2="0.4" y2="0">
          <stop offset="0" stopColor="#e07a9b" />
          <stop offset="1" stopColor="#f6b8c8" />
        </linearGradient>
        <linearGradient id="floraViolet" x1="0" y1="1" x2="0.6" y2="0">
          <stop offset="0" stopColor="#5b3fc4" />
          <stop offset="1" stopColor="#a58bff" />
        </linearGradient>
      </defs>
      <g filter="url(#floraBlur)">
        <Leaf x={640} y={780} len={640} w={250} a={14} fill="url(#floraViolet)" o={0.55} />
        <Leaf x={820} y={780} len={560} w={230} a={-22} fill="url(#floraRose)" o={0.5} />
        <Leaf x={470} y={780} len={470} w={190} a={34} fill="url(#floraRose)" o={0.38} />
        <Leaf x={900} y={600} len={420} w={170} a={-58} fill="url(#floraViolet)" o={0.45} />
      </g>
    </svg>
    <svg className="flora-layer" data-depth="mid" {...frame}>
      <defs>
        <linearGradient id="floraIndigo" x1="0" y1="1" x2="0.5" y2="0">
          <stop offset="0" stopColor="#242c78" />
          <stop offset="1" stopColor="#4d63c4" />
        </linearGradient>
      </defs>
      <Leaf
        x={700}
        y={790}
        len={520}
        w={190}
        a={8}
        fill="url(#floraIndigo)"
        o={0.9}
        vein="#b6c4ff"
      />
      <Leaf x={560} y={800} len={400} w={150} a={-16} fill="#2a2468" o={0.92} vein="#9a8cf0" />
      <Leaf
        x={860}
        y={790}
        len={430}
        w={160}
        a={-34}
        fill="url(#floraIndigo)"
        o={0.88}
        vein="#b6c4ff"
      />
      <Leaf x={760} y={500} len={190} w={64} a={42} fill="#e58f9f" o={0.8} />
      <Leaf x={800} y={430} len={150} w={50} a={20} fill="#f0b3b6" o={0.7} />
    </svg>
    <svg className="flora-layer" data-depth="front" {...frame}>
      <defs>
        <linearGradient id="floraCyan" x1="0" y1="1" x2="0.3" y2="0">
          <stop offset="0" stopColor="#7fc7dc" />
          <stop offset="1" stopColor="#d3f0f6" />
        </linearGradient>
      </defs>
      <Leaf
        x={640}
        y={830}
        len={330}
        w={190}
        a={20}
        fill="url(#floraCyan)"
        o={0.95}
        vein="#ffffff"
      />
      <Leaf x={800} y={830} len={290} w={170} a={-18} fill="#c6e6ef" o={0.94} vein="#ffffff" />
      <Leaf x={520} y={840} len={240} w={130} a={46} fill="#8ec8e4" o={0.9} vein="#ffffff" />
      <Leaf x={700} y={840} len={150} w={80} a={-50} fill="#58b7b0" o={0.75} vein="#d8f3ef" />
    </svg>
  </div>
);
