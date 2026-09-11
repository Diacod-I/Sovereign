// app/lib/gifDuration.ts
// How long one pass of a GIF takes, read out of the file itself.
//
// There is no DOM API for this. An <img> playing a GIF exposes no duration, no
// frame count and no "it finished a loop" event, so the only way to hold a
// carousel card for exactly one pass is to parse the frame delays. That means
// walking the GIF's block structure, which is short and completely specified:
// every frame is preceded by a Graphic Control Extension carrying a 16-bit LE
// delay in hundredths of a second, and the sum of those is one pass.
//
// The one wrinkle is that the spec's delay field and what browsers actually do
// disagree at the bottom of the range. A delay of 0 or 1 centisecond means "as
// fast as possible", and every engine since Netscape has clamped that to 10cs
// rather than render a 100fps GIF. We clamp the same way, because the number we
// want is how long the animation will APPEAR to run, not what the file says.

/** Files larger than this are not parsed. See the note in `gifDurationMs`. */
const MAX_BYTES = 48 * 1024 * 1024;

/**
 * One full pass of `url`, in milliseconds, or null if it cannot be determined.
 *
 * Null is a real answer and callers must handle it: the fetch can fail, the
 * bytes may not be a GIF, and a still image has no duration at all. Falling
 * back to a fixed delay is the right response, not retrying.
 *
 * The whole file is read. A GIF interleaves its frame delays with its pixel
 * data, so there is no prefix that contains all of them, and an incremental
 * parser would still have to stream every byte. The <img> on the page has
 * already requested the same URL, so in practice this is served from cache and
 * costs a copy rather than a download.
 */
export async function gifDurationMs(url: string): Promise<number | null> {
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || '0');
    if (len > MAX_BYTES) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    bytes = new Uint8Array(buf);
  } catch {
    return null;
  }
  return parseGifDuration(bytes);
}

/** Exported for tests: the same parse, on bytes you already hold. */
export function parseGifDuration(b: Uint8Array): number | null {
  // "GIF87a" / "GIF89a". Only 89a has Graphic Control Extensions, so an 87a
  // file legitimately yields no frames rather than a parse failure.
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;

  const packed = b[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1)); // global colour table

  const u16 = (at: number) => b[at] | (b[at + 1] << 8);

  /** Walks a chain of length-prefixed sub-blocks to the terminating zero. */
  const skipSubBlocks = (at: number): number => {
    while (at < b.length && b[at] !== 0) at += b[at] + 1;
    return at + 1;
  };

  let total = 0;
  let frames = 0;
  let complete = false;

  while (p < b.length) {
    const block = b[p];

    if (block === 0x3b) { complete = true; break; } // trailer

    if (block === 0x21) {
      // Extension: 0x21, label, then sub-blocks.
      const label = b[p + 1];
      p += 2;
      if (label === 0xf9) {
        // Graphic Control: [size=4][packed][delay lo][delay hi][transparent]
        const cs = u16(p + 2);
        total += (cs > 1 ? cs : 10) * 10;
        frames += 1;
      }
      p = skipSubBlocks(p);
      continue;
    }

    if (block === 0x2c) {
      // Image descriptor: 0x2C + 9 bytes, optional local colour table, then one
      // LZW code-size byte and the pixel sub-blocks.
      p += 1;
      const local = b[p + 8];
      p += 9;
      if (local & 0x80) p += 3 * (1 << ((local & 0x07) + 1));
      p += 1;
      p = skipSubBlocks(p);
      continue;
    }

    // Anything else means we have lost the block structure. Returning what we
    // have would be a number with no meaning, so say we do not know.
    return null;
  }

  // Only trust the sum if we walked all the way to the trailer. A truncated
  // file parses cleanly right up to the point where it stops, and reporting the
  // frames we happened to reach would be a confident wrong answer: the caller
  // would hold the card for a fraction of the real loop.
  return complete && frames > 0 ? total : null;
}
