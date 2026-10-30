import "server-only";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createAdminClient } from "@/utils/supabase/admin";
import { bedrockRoleCredentials } from "@/utils/claude-backend";

// Where the book app's files are fetched from. Every link is short-lived and
// minted per request, behind the staff guard of the route that calls this.
//
//   s3             book files and book illustrations: the private bucket named
//                  by BOOKS_S3_BUCKET (region BOOKS_S3_REGION, default
//                  us-east-1). Credentials: AWS_ROLE_ARN via Vercel OIDC, the
//                  same role the app uses for Bedrock (it needs s3:GetObject on
//                  the bucket), else the default AWS chain.
//   visual-assets  library pictures, read from the shared library bucket and
//                  never copied or changed.

const LINK_SECONDS = 300;

export function booksBucket(): string | null {
  return (process.env.BOOKS_S3_BUCKET || "").trim() || null;
}

let s3: S3Client | null = null;
function s3Client(): S3Client {
  if (s3) return s3;
  const region = process.env.BOOKS_S3_REGION || "us-east-1";
  const roleArn = (process.env.AWS_ROLE_ARN || "").trim();
  s3 = roleArn ? new S3Client({ region, credentials: bedrockRoleCredentials(roleArn, region) }) : new S3Client({ region });
  return s3;
}

/** Write an object to the books bucket (the reader's replacement pictures, books/<slug>/edits/). Needs
 *  s3:PutObject on that prefix for the app's role; a refusal comes back as "denied" so the caller can say so. */
export async function s3Put(key: string, body: Uint8Array, contentType: string): Promise<"ok" | "denied" | "unset"> {
  const bucket = booksBucket();
  if (!bucket) return "unset";
  try {
    await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    return "ok";
  } catch (e) {
    const name = (e as { name?: string }).name ?? "";
    if (name === "AccessDenied" || name === "Forbidden" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403) return "denied";
    throw e;
  }
}

/** A short-lived link to an object in the books bucket; `download` names the saved file.
 *  `seconds` defaults to 5 minutes (the book app's run pages); the Library's
 *  "My books" passes its own (1 h for a cover, 10 min for a PDF) and only ever
 *  AFTER its access check (src/utils/my-books). */
export async function s3Link(key: string, download?: string, seconds: number = LINK_SECONDS): Promise<string | null> {
  const bucket = booksBucket();
  if (!bucket) return null;
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(download ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(download)}` } : {}),
  });
  return getSignedUrl(s3Client(), cmd, { expiresIn: seconds });
}

/** An object's bytes from the books bucket (server-side reads, e.g. a release
 *  bundle for SK's knowledge importer). Throws when the bucket is not set or
 *  the role may not read the key — callers record the error. */
export async function s3GetBytes(key: string): Promise<Uint8Array> {
  const bucket = booksBucket();
  if (!bucket) throw new Error("BOOKS_S3_BUCKET is not set");
  const out = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`s3://${bucket}/${key} has no body`);
  return out.Body.transformToByteArray();
}

/** Whether the app's role can read an object: a presigned link is minted
 *  without asking S3, so a denied role would only show up as an XML error page
 *  in the reader's browser. HEAD needs the same s3:GetObject, so it answers
 *  first. "denied" = 403 / AccessDenied; "missing" = 404; "unset" = no bucket. */
export async function s3Probe(key: string): Promise<"ok" | "denied" | "missing" | "unset" | "error"> {
  const bucket = booksBucket();
  if (!bucket) return "unset";
  try {
    await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return "ok";
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = err.$metadata?.httpStatusCode;
    if (status === 403 || err.name === "AccessDenied" || err.name === "Forbidden") return "denied";
    if (status === 404 || err.name === "NotFound" || err.name === "NoSuchKey") return "missing";
    return "error";
  }
}

export async function libraryPictureLink(path: string): Promise<string | null> {
  const { data, error } = await createAdminClient().storage.from("visual-assets").createSignedUrl(path, LINK_SECONDS);
  return error ? null : data?.signedUrl ?? null;
}
