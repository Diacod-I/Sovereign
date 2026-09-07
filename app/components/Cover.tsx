// Cover banner for an agent card. Uses the seller-provided image if present,
// else a deterministic gradient from the name. Plain <div> background so any
// image URL works without next/image remote-host config.
const PAIRS = [
  ['#2FFF00', '#0b3d0b'], ['#38bdf8', '#0b2545'], ['#f472b6', '#3b0b2b'],
  ['#f59e0b', '#3a1d05'], ['#a78bfa', '#1e1b3a'], ['#34d399', '#062a20'],
];
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export default function Cover({ name, image, className = '' }: { name: string; image?: string; className?: string }) {
  const [a, b] = PAIRS[hash(name) % PAIRS.length];
  const style = image
    ? { backgroundImage: `url(${image})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { backgroundImage: `linear-gradient(135deg, ${a}, ${b})` };
  return <div className={`h-24 w-full ${className}`} style={style} aria-hidden="true" />;
}
