// Icona container: label net.unraid.docker.icon proxata dal server (cache
// offline, niente mixed-content). Fallback: iniziali colorate (hash del nome).
import { useState } from 'react';

const ACCENTS = ['#89b4fa', '#cba6f7', '#a6e3a1', '#fab387', '#f38ba8', '#94e2d5', '#f9e2af', '#f5c2e7'];

function hashColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

export function ContainerIcon({ name, iconUrl, size = 36 }) {
  const [failed, setFailed] = useState(false);
  const initials = name.replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
  if (iconUrl && !failed) {
    return (
      <img
        src={`/api/icons?url=${encodeURIComponent(iconUrl)}`}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="rounded-lg object-contain bg-mantle shrink-0"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className="rounded-lg flex items-center justify-center font-bold text-crust shrink-0"
      style={{ width: size, height: size, background: hashColor(name), fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
