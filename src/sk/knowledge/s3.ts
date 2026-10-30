import "server-only";
import { s3GetBytes } from "@/utils/books/files";
import type { BundleReader } from "./release";

// SK S7 K1 — release bundles come from the books bucket through the app's
// existing S3 client and role (src/utils/books/files.ts: BOOKS_S3_BUCKET,
// AWS_ROLE_ARN via Vercel OIDC). If the role may not read
// books/*/editions/*, the import records the AccessDenied error; the fix is
// s3:GetObject on arn:aws:s3:::<bucket>/books/*/editions/* (design, "What
// needs you").
export const booksBundleReader: BundleReader = { getBytes: s3GetBytes };
