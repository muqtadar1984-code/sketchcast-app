// Batched signing of storage URLs — one `createSignedUrls` request per
// (download name, up to SIGN_BATCH_MAX paths) instead of one `createSignedUrl`
// request per file.
//
// The Library used to sign every artifact of every lesson one HTTP request at a
// time (a teacher with 60 kits paid ~300 requests before the page could
// render), and the student view did it in a SEQUENTIAL loop. This keeps each
// caller's code shaped exactly as before — `await sign(path, download?)` — and
// coalesces every call made in the same tick into batches behind the scenes.
//
// ACCESS IS UNCHANGED. The batch endpoint (`POST /object/sign/{bucket}`) runs
// the same per-object lookup under the caller's own JWT as the single one, so
// the SESSION client still signs only what storage RLS lets that user read, and
// the SERVICE-ROLE client is only ever the one the caller already chose. A path
// the caller may not read comes back with a per-item error → null, exactly the
// `data: null` the single call gave.

/** The slice of a Supabase client this needs — both the session client and the
 * service-role client fit, and a test can hand in a fake. */
export type SignedUrlsClient = {
  storage: {
    from(bucket: string): {
      createSignedUrls(
        paths: string[],
        expiresIn: number,
        options?: { download?: string | boolean },
      ): PromiseLike<{
        data: { error: string | null; path: string | null; signedUrl: string | null }[] | null;
        error: unknown;
      }>;
    };
  };
};

export type Signer = (path: string, download?: string) => Promise<string | null>;

/** Paths per request. The endpoint takes a JSON body; this keeps each one small
 * and lets a big Library sign in a few parallel requests rather than one huge one. */
export const SIGN_BATCH_MAX = 100;

/**
 * A `sign(path, download?)` that resolves to the signed URL, or null when the
 * path could not be signed (missing, not readable by this client, or the
 * request failed). Calls made in the same tick share requests: grouped by
 * `download` (the Content-Disposition name is one option for the whole batch),
 * de-duplicated by path, chunked at `max`. Never rejects.
 */
export function batchSigner(
  client: SignedUrlsClient,
  bucket: string,
  expiresIn: number,
  { max = SIGN_BATCH_MAX }: { max?: number } = {},
): Signer {
  type Waiters = Map<string, ((url: string | null) => void)[]>;
  // download name ("" = none) → path → everyone waiting on that path
  let queue = new Map<string, Waiters>();
  let scheduled = false;

  const run = async (download: string, paths: string[], waiters: Waiters) => {
    const urls = new Map<string, string | null>();
    try {
      const { data } = await client.storage
        .from(bucket)
        .createSignedUrls(paths, expiresIn, download ? { download } : undefined);
      (data ?? []).forEach((d, i) => {
        // The API answers in request order and echoes the path; trust the echo
        // when there is one, the position when there is not.
        const p = d?.path ?? paths[i];
        if (p !== undefined && !urls.has(p)) urls.set(p, !d?.error && d?.signedUrl ? d.signedUrl : null);
      });
    } catch {
      // A failed request signs nothing — the same null the single call gave.
    }
    for (const p of paths) for (const resolve of waiters.get(p) ?? []) resolve(urls.get(p) ?? null);
  };

  const flush = () => {
    scheduled = false;
    const q = queue;
    queue = new Map();
    for (const [download, waiters] of q) {
      const paths = [...waiters.keys()];
      for (let i = 0; i < paths.length; i += max) void run(download, paths.slice(i, i + max), waiters);
    }
  };

  return (path, download) =>
    new Promise<string | null>((resolve) => {
      const key = download || "";
      let waiters = queue.get(key);
      if (!waiters) queue.set(key, (waiters = new Map()));
      const list = waiters.get(path);
      if (list) list.push(resolve);
      else waiters.set(path, [resolve]);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    });
}
