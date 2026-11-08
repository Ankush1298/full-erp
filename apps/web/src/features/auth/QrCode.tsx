import { encode } from 'uqr';

/**
 * A QR code drawn locally as inline SVG. The value (here an otpauth:// URI that contains the TOTP secret) is encoded in
 * the browser and never sent anywhere: no image URL, no data URL, no third-party service. Always dark on white with a
 * four-module quiet zone, which scanners need, whatever the page theme.
 */
const QUIET_ZONE = 4;

export function QrCode({
  value,
  label,
  size = 200,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { data, size: modules } = encode(value, { ecc: 'M', border: 0 });
  const total = modules + QUIET_ZONE * 2;
  let path = '';
  for (let y = 0; y < modules; y++) {
    const row = data[y];
    if (!row) continue;
    for (let x = 0; x < modules; x++) {
      if (row[x]) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{
        display: 'block',
        margin: '0 auto',
        borderRadius: '0.5rem',
        maxWidth: '100%',
        height: 'auto',
      }}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
