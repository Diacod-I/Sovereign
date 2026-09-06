'use client';

import { useEffect, useState } from 'react';

// Premium editorial / luxury faces — mostly macOS system fonts, instant swaps.
const FONTS = [
  "'Didot', 'Bodoni 72', serif",
  "'Hoefler Text', serif",
  "Baskerville, serif",
  "'Iowan Old Style', serif",
  "Palatino, 'Palatino Linotype', serif",
  "Cochin, serif",
  "Georgia, serif",
  "'Book Antiqua', serif",
  "Garamond, serif",
  "'Times New Roman', Times, serif",
  "Copperplate, serif",
  "'Snell Roundhand', cursive",
];

export default function SovereignMark({ text = 'Sovereign' }: { text?: string }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const id = setInterval(() => setI((n) => (n + 1) % FONTS.length), 110);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="sovereign-mark" aria-label={text}>
      <span className="sovereign-mark__sizer" aria-hidden="true">{text}</span>
      <span className="sovereign-mark__cycle" style={{ fontFamily: FONTS[i] }} aria-hidden="true">{text}</span>
    </span>
  );
}
