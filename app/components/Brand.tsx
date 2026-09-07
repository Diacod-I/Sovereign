import Image from 'next/image';
import logo from '../../public/logo_transparent.png';

// Shared top branding: logo + "Sovereign" (Rockwell). Used in every navbar.
export default function Brand({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2">
      <Image src={logo} alt="Sovereign logo" width={size} height={size} priority />
      <span className="brand-word text-lg font-normal mt-3 tracking-tight">Sovereign</span>
    </div>
  );
}
