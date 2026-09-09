import Image from 'next/image';
import logo from '../../public/logo_transparent.png';

// Shared top branding: logo + "Sovereign" (Rockwell, normal weight),
// with an optional tag to the right in the same font, muted.
export default function Brand({ size = 28, tag }: { size?: number; tag?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Image src={logo} alt="Sovereign logo" width={size} height={size} priority />
      <span className="flex items-baseline gap-1.5">
        <span className="brand-word text-lg mt-2 tracking-tight">Sovereign</span>
        {tag && <span className="brand-word text-xs text-muted">{tag}</span>}
      </span>
    </div>
  );
}
