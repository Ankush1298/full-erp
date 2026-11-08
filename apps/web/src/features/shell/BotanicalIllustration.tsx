import type { FC } from 'react';

/**
 * Decorative botanical artwork for the lower part of the Anesa sidebar (original SVG, no dependencies).
 *
 * Composition, back to front, after the owner's reference:
 *   1. blue-violet wash with a soft coral glow;
 *   2. translucent lavender leaves;
 *   3. coral / pink foliage: broad leaves, a pinnate frond and a few thin branches;
 *   4. dark indigo and royal-blue leaves with fine veins, plus small pointed leaves on thin stems;
 *   5. pale cyan / powder-blue leaves rising from the bottom edge, teal only as a small accent;
 *   6. dark lavender leaves at the bottom corners.
 * Leaves are clipped by the sidebar edges. Hidden from assistive technology and never receives pointer events.
 */

interface LeafProps {
  x: number;
  y: number;
  len: number;
  w: number;
  /** Degrees clockwise from straight up. */
  a: number;
  fill: string;
  opacity?: number;
  /** Vein colour; omit for a plain silhouette. */
  vein?: string;
  veinOpacity?: number;
}

const n = (v: number): string => v.toFixed(1);

/** One pointed leaf drawn from its base (x, y) in direction `a`, with a midrib and paired side veins. */
const Leaf: FC<LeafProps> = ({ x, y, len, w, a, fill, opacity = 1, vein, veinOpacity = 0.55 }) => {
  const h = w / 2;
  const body =
    `M0 0C${n(h * 1.15)} ${n(-len * 0.2)} ${n(h * 1.05)} ${n(-len * 0.72)} 0 ${n(-len)}` +
    `C${n(-h * 1.05)} ${n(-len * 0.72)} ${n(-h * 1.15)} ${n(-len * 0.2)} 0 0Z`;
  let veins = '';
  if (vein) {
    veins = `M0 ${n(-len * 0.04)}L0 ${n(-len * 0.93)}`;
    for (let t = 0.16; t < 0.8; t += 0.1) {
      const reach = h * 0.82 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      const rise = len * 0.13;
      veins += `M0 ${n(-len * t)}Q${n(reach * 0.5)} ${n(-len * t - rise * 0.2)} ${n(reach)} ${n(-len * t - rise)}`;
      veins += `M0 ${n(-len * t)}Q${n(-reach * 0.5)} ${n(-len * t - rise * 0.2)} ${n(-reach)} ${n(-len * t - rise)}`;
    }
  }
  return (
    <g transform={`translate(${n(x)} ${n(y)}) rotate(${n(a)})`}>
      <path d={body} fill={fill} opacity={opacity} />
      {vein && (
        <path
          d={veins}
          fill="none"
          stroke={vein}
          strokeWidth={0.7}
          strokeLinecap="round"
          opacity={veinOpacity}
        />
      )}
    </g>
  );
};

/** A thin curved branch with small leaflets along it (pinnate frond). */
const Frond: FC<{
  d: string;
  pts: ReadonlyArray<readonly [number, number, number]>;
  fill: string;
  stem: string;
  size?: number;
}> = ({ d, pts, fill, stem, size = 15 }) => (
  <g>
    <path d={d} fill="none" stroke={stem} strokeWidth={1.1} strokeLinecap="round" opacity={0.85} />
    {pts.map(([x, y, a], i) => (
      <Leaf key={i} x={x} y={y} len={size} w={size * 0.42} a={a} fill={fill} opacity={0.9} />
    ))}
  </g>
);

const INDIGO = '#2f3f86';
const ROYAL = '#4a64b4';
const NAVY = '#35306f';
const CORAL = '#e58f9f';
const ROSE = '#f0b3b6';
const LAV = '#8b78c4';
const CYAN = '#a9dcea';
const POWDER = '#c6e6ef';
const SKY = '#8ec8e4';
const TEAL = '#58b7b0';

export const BotanicalIllustration: FC = () => {
  return (
    <div className="sidenav-botanical" aria-hidden="true">
      <svg
        viewBox="0 0 240 400"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMax slice"
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="botWash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4e3f73" stopOpacity="0" />
            <stop offset="0.5" stopColor="#5a4d96" stopOpacity="0.3" />
            <stop offset="1" stopColor="#6c63ae" stopOpacity="0.85" />
          </linearGradient>
          <radialGradient id="botGlow" cx="0.3" cy="0.62" r="0.55">
            <stop offset="0" stopColor="#f2a2ad" stopOpacity="0.7" />
            <stop offset="1" stopColor="#e58f9f" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="botIndigo" x1="0" y1="1" x2="0.6" y2="0">
            <stop offset="0" stopColor="#2c3a82" />
            <stop offset="1" stopColor="#4a62b2" />
          </linearGradient>
          <linearGradient id="botCyan" x1="0" y1="1" x2="0.3" y2="0">
            <stop offset="0" stopColor="#8fcfe0" />
            <stop offset="1" stopColor="#cdeaf2" />
          </linearGradient>
        </defs>

        {/* 1. wash and glow */}
        <rect width="240" height="400" fill="url(#botWash)" />
        <rect width="240" height="400" fill="url(#botGlow)" />

        <g transform="translate(0 400) scale(1 1.3) translate(0 -400)">
          {/* 2. translucent lavender layers */}
          <Leaf x={-10} y={400} len={250} w={110} a={14} fill={LAV} opacity={0.32} />
          <Leaf x={250} y={400} len={230} w={100} a={-18} fill={LAV} opacity={0.34} />
          <Leaf x={120} y={330} len={150} w={70} a={30} fill="#9a8ad0" opacity={0.3} />
          <Leaf x={190} y={260} len={120} w={46} a={-8} fill="#7d6cbc" opacity={0.35} />

          {/* 3. coral and pink foliage behind the dark leaves */}
          <Leaf x={20} y={330} len={165} w={64} a={-12} fill={CORAL} opacity={0.85} />
          <Leaf x={60} y={350} len={150} w={58} a={16} fill={ROSE} opacity={0.8} />
          <Leaf x={150} y={340} len={140} w={52} a={-26} fill={CORAL} opacity={0.75} />
          <Leaf x={225} y={330} len={110} w={40} a={-44} fill={ROSE} opacity={0.75} />
          <Frond
            d="M-6 262C16 250 36 240 62 236"
            stem="#f3c1c4"
            fill={ROSE}
            pts={[
              [6, 258, -50],
              [6, 258, 40],
              [20, 250, -52],
              [20, 250, 36],
              [34, 243, -54],
              [34, 243, 30],
              [48, 239, -56],
              [48, 239, 26],
              [62, 236, -70],
            ]}
          />
          <Frond
            d="M236 214C214 206 196 196 180 178"
            stem="#f3c1c4"
            fill={CORAL}
            size={13}
            pts={[
              [226, 210, 40],
              [226, 210, 140],
              [212, 203, 36],
              [212, 203, 144],
              [198, 193, 30],
              [198, 193, 150],
              [186, 183, 24],
              [186, 183, 156],
              [180, 178, 8],
            ]}
          />
          <path
            d="M104 300C108 270 98 246 84 226"
            fill="none"
            stroke="#f3c1c4"
            strokeWidth={1}
            opacity={0.7}
          />
          <Leaf x={84} y={226} len={26} w={10} a={-28} fill={ROSE} opacity={0.8} />
          <Leaf x={100} y={262} len={22} w={9} a={30} fill={CORAL} opacity={0.8} />

          {/* 4a. thin stems with small pointed dark leaves (upper right of the artwork) */}
          <path
            d="M196 392C192 330 200 270 214 214"
            fill="none"
            stroke="#3d4a96"
            strokeWidth={1.2}
            opacity={0.85}
          />
          <path
            d="M170 392C166 330 172 292 184 248"
            fill="none"
            stroke="#3d4a96"
            strokeWidth={1}
            opacity={0.8}
          />
          <Leaf
            x={213}
            y={216}
            len={40}
            w={13}
            a={-12}
            fill={INDIGO}
            opacity={0.9}
            vein="#9fb2ec"
          />
          <Leaf x={204} y={262} len={36} w={12} a={-52} fill={ROYAL} opacity={0.9} vein="#b9c8f3" />
          <Leaf
            x={199}
            y={300}
            len={34}
            w={11}
            a={36}
            fill={INDIGO}
            opacity={0.88}
            vein="#9fb2ec"
          />
          <Leaf x={183} y={250} len={34} w={12} a={-30} fill={ROYAL} opacity={0.9} vein="#b9c8f3" />
          <Leaf x={177} y={292} len={30} w={10} a={40} fill={NAVY} opacity={0.9} />
          <Leaf x={168} y={330} len={28} w={10} a={-56} fill={INDIGO} opacity={0.85} />

          {/* 4b. large dark indigo and royal leaves with fine veins */}
          <Leaf
            x={-8}
            y={360}
            len={215}
            w={96}
            a={20}
            fill="url(#botIndigo)"
            vein="#a9baf0"
            veinOpacity={0.5}
          />
          <Leaf
            x={78}
            y={372}
            len={195}
            w={84}
            a={-4}
            fill={NAVY}
            opacity={0.92}
            vein="#8f9ee0"
            veinOpacity={0.42}
          />
          <Leaf
            x={128}
            y={376}
            len={170}
            w={74}
            a={34}
            fill={ROYAL}
            opacity={0.9}
            vein="#c1cff5"
            veinOpacity={0.5}
          />
          <Leaf
            x={34}
            y={392}
            len={160}
            w={66}
            a={-24}
            fill={INDIGO}
            opacity={0.9}
            vein="#9fb2ec"
            veinOpacity={0.5}
          />
          <Leaf
            x={250}
            y={372}
            len={170}
            w={74}
            a={-38}
            fill={ROYAL}
            opacity={0.88}
            vein="#c1cff5"
            veinOpacity={0.5}
          />

          {/* 5. pale cyan and powder-blue leaves from the bottom edge */}
          <Leaf
            x={-16}
            y={412}
            len={150}
            w={96}
            a={30}
            fill="url(#botCyan)"
            opacity={0.96}
            vein="#ffffff"
            veinOpacity={0.55}
          />
          <Leaf
            x={52}
            y={414}
            len={130}
            w={78}
            a={-8}
            fill={POWDER}
            opacity={0.95}
            vein="#ffffff"
            veinOpacity={0.6}
          />
          <Leaf
            x={104}
            y={416}
            len={150}
            w={84}
            a={14}
            fill={CYAN}
            opacity={0.96}
            vein="#ffffff"
            veinOpacity={0.55}
          />
          <Leaf
            x={160}
            y={414}
            len={118}
            w={70}
            a={-26}
            fill={SKY}
            opacity={0.94}
            vein="#ffffff"
            veinOpacity={0.5}
          />
          <Leaf
            x={226}
            y={414}
            len={140}
            w={84}
            a={-34}
            fill="url(#botCyan)"
            opacity={0.95}
            vein="#ffffff"
            veinOpacity={0.55}
          />
          <Leaf x={28} y={416} len={86} w={46} a={-40} fill={POWDER} opacity={0.9} />
          <Leaf x={196} y={416} len={90} w={44} a={22} fill={CYAN} opacity={0.9} />
          {/* teal accent only */}
          <Leaf
            x={84}
            y={418}
            len={70}
            w={34}
            a={46}
            fill={TEAL}
            opacity={0.75}
            vein="#d8f3ef"
            veinOpacity={0.5}
          />
          <Leaf x={140} y={420} len={58} w={28} a={-50} fill={TEAL} opacity={0.7} />
        </g>

        {/* 6. dark lavender at the bottom corners, pulling the edges together */}
        <Leaf x={-20} y={424} len={74} w={50} a={58} fill="#5b4f9a" opacity={0.8} />
        <Leaf x={258} y={424} len={80} w={52} a={-60} fill="#5b4f9a" opacity={0.82} />
      </svg>
    </div>
  );
};
