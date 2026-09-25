import type { Thumbnailer } from './store/types.ts';

/**
 * A 400px WebP for list views and the side-by-side review screen, which shows
 * two images at once. A weekly session over a phone connection cannot fetch
 * 600 KB per item.
 *
 * PDFs are skipped: rasterising one needs a separate toolchain, and an invoice
 * that arrives as a PDF is usually a generated one that the owner rarely needs
 * to squint at.
 *
 * sharp is imported lazily so the bot still starts on a machine where the
 * native binary did not install — a missing thumbnail costs bandwidth, and
 * refusing to boot over it would cost the whole ledger.
 */
export const sharpThumbnailer: Thumbnailer = async (bytes, mimeType) => {
  if (mimeType === 'application/pdf') return null;
  const { default: sharp } = await import('sharp');
  const out = await sharp(bytes)
    .rotate()
    .resize({ width: 400, withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
  return new Uint8Array(out);
};
