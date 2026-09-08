// Deterministic organization avatar — colored monogram from the org name.
// No external image/network; renders the same color for the same name.
const PALETTE = ['#2FFF00', '#38bdf8', '#f472b6', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const color = PALETTE[hash(name) % PALETTE.length];
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, background: `${color}1f`, color, borderColor: `${color}55`, fontSize: size * 0.4 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full border font-semibold tracking-tight"
    >
      {initials(name)}
    </span>
  );
}
