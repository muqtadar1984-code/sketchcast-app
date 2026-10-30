import "server-only";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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

/** A short-lived link to an object in the books bucket; `download` names the saved file. */
export async function s3Link(key: string, download?: string): Promise<string | null> {
  const bucket = booksBucket();
  if (!bucket) return null;
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(download ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(download)}` } : {}),
  });
  return getSignedUrl(s3Client(), cmd, { expiresIn: LINK_SECONDS });
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

export async function libraryPictureLink(path: string): Promise<string | null> {
  const { data, error } = await createAdminClient().storage.from("visual-assets").createSignedUrl(path, LINK_SECONDS);
  return error ? null : data?.signedUrl ?? null;
}
