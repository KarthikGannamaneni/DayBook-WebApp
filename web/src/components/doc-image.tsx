'use client';

import { useEffect, useState } from 'react';
import { signedUrl } from '@/lib/client';

/**
 * One document image, fetched through a signed URL minted under the viewer's own
 * session. The URL lives five minutes and is never stored, which is why this is
 * a component rather than a field on a row.
 *
 * Prefers the thumbnail when there is one: the review screen shows two images at
 * once, and a weekly session over a phone connection cannot fetch 600 KB per
 * item. `full` asks for the original, on a detail screen where the owner is
 * reading a smudged figure.
 */
export function DocImage({
  storagePath, thumbnailPath, mimeType, alt, full = false, purgedAt = null,
}: {
  storagePath: string | null;
  thumbnailPath?: string | null;
  mimeType?: string | null;
  alt: string;
  full?: boolean;
  /** Retention deleted the original. Say so, rather than failing to load it. */
  purgedAt?: string | null;
}) {
  const wanted = full ? storagePath : (thumbnailPath ?? storagePath);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setUrl(null);
    setFailed(false);
    if (!wanted) return;
    void signedUrl(wanted)
      .then((u) => { if (live) { if (u) setUrl(u); else setFailed(true); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [wanted]);

  if (purgedAt) {
    return (
      <p className="tiny" style={{ margin: '0 0 10px' }}>
        The original was deleted on {new Date(purgedAt).toLocaleDateString('en-IN')} under the
        retention policy. The amounts and dates below are kept.
      </p>
    );
  }
  if (!wanted) return null;
  if (failed) return <p className="tiny">The image could not be loaded.</p>;
  if (!url) return <div className={full ? 'thumb full' : 'thumb'} aria-hidden />;

  if (mimeType === 'application/pdf') {
    return (
      <p style={{ margin: '0 0 10px' }}>
        <a className="btn secondary small" href={url} target="_blank" rel="noreferrer">
          Open the PDF
        </a>
      </p>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element -- no image optimiser on a static export
  return <img className={full ? 'thumb full' : 'thumb'} src={url} alt={alt} />;
}
