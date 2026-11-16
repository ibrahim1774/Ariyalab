/*
 * The public hostname of OUR Blob store, from BLOB_READ_WRITE_TOKEN (vercel_blob_rw_<storeId>_<secret>), or null.
 * Only this host counts as an upload: any other *.public.blob.vercel-storage.com store is someone else's.
 * A leaf module (no imports), shared by lib/story/analyze.js, voices.js and the assets route.
 */
export function ownBlobHost() {
  const m = /^vercel_blob_rw_([a-z0-9]+)_/i.exec(String(process.env.BLOB_READ_WRITE_TOKEN || ''));
  return m ? `${m[1].toLowerCase()}.public.blob.vercel-storage.com` : null;
}
