# Bedrock on Vercel without long-lived keys (OIDC)

With `CLAUDE_BACKEND=bedrock`, the app signs every Claude call with AWS credentials
(`src/utils/claude-backend.ts`). There are two ways it gets them:

| `AWS_ROLE_ARN` | Where the credentials come from |
| --- | --- |
| set | The deployment's Vercel OIDC token is exchanged with STS (`AssumeRoleWithWebIdentity`) for 1-hour role credentials. They are cached per warm instance and refreshed 5 minutes before expiry. |
| unset | The AWS SDK default chain reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, which is how PR #97 works. |

If the role exchange fails and static keys are still set, the static keys answer and the log
says `[claude] Vercel OIDC role exchange failed — using static AWS keys`. That makes the cut-over
safe. Once the static keys are removed, a failure surfaces as a Bedrock connection error.

Fixed values for SketchCast:

- AWS account: `172042957848`
- Vercel team slug: `muqtadar1984-codes-projects` (team id `team_lkIA2ivbLwrhwwPqZeNOPoK3`)
- Vercel project: `sketchcast-app` (`prj_YMT8JfDvK5LycxUUns3A0Vlvehfh`)
- OIDC issuer (Team mode): `https://oidc.vercel.com/muqtadar1984-codes-projects`
- Audience: `https://vercel.com/muqtadar1984-codes-projects`
- Role: `sketchcast-app-bedrock`

## Founder setup (one time, in the consoles)

### 1. Vercel: turn on OIDC for the project

Go to sketchcast-app, then **Settings → Security → Secure Backend Access with OIDC Federation**.
Set it to **Enabled** and set the issuer mode to **Team**. The issuer URL above assumes Team mode.
In Global mode the issuer is `https://oidc.vercel.com` and the provider and conditions below change.

### 2. AWS IAM: add the identity provider

Go to **IAM → Identity providers → Add provider**:

- Provider type: **OpenID Connect**
- Provider URL: `https://oidc.vercel.com/muqtadar1984-codes-projects`
- Audience: `https://vercel.com/muqtadar1984-codes-projects`

### 3. AWS IAM: create the role `sketchcast-app-bedrock`

Choose **IAM → Roles → Create role → Custom trust policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::172042957848:oidc-provider/oidc.vercel.com/muqtadar1984-codes-projects"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.vercel.com/muqtadar1984-codes-projects:aud": "https://vercel.com/muqtadar1984-codes-projects"
        },
        "StringLike": {
          "oidc.vercel.com/muqtadar1984-codes-projects:sub": [
            "owner:muqtadar1984-codes-projects:project:sketchcast-app:environment:production",
            "owner:muqtadar1984-codes-projects:project:sketchcast-app:environment:preview"
          ]
        }
      }
    }
  ]
}
```

The `sub` condition limits the role to this one project's production and preview deployments.
No other Vercel project in the team can assume it.

Permissions: attach the same invoke-only Bedrock policy the worker identity uses
(`sketchcast-worker-bedrock`). If that policy is inline rather than customer-managed, use this one:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeClaudeOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:*:172042957848:inference-profile/*anthropic.*",
        "arn:aws:bedrock:*::foundation-model/anthropic.*"
      ]
    }
  ]
}
```

The `*` region in the foundation-model ARN also matches the empty region that **global**
inference profiles (`global.anthropic.*`, the app's defaults) authorise against.

Keep the maximum session duration at the default of 1 hour. The app asks for 1 hour.

### 4. Vercel: environment variables

Set these for Production and Preview:

- `AWS_ROLE_ARN` = `arn:aws:iam::172042957848:role/sketchcast-app-bedrock`
- `CLAUDE_BACKEND` = `bedrock` (from PR #97, only at the cut-over)
- `BEDROCK_REGION` is optional. It defaults to `us-east-1` and is also the STS region.

**Leave `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in place for now** so they can act as the
fallback. Redeploy, because env changes only apply to new deployments.

### 5. Verify, then remove the keys

1. Make a Claude call on production, for example an Ask Coach turn or a present recap.
2. Check the Vercel runtime logs. There should be **no**
   `Vercel OIDC role exchange failed` line.
3. Check CloudTrail (us-east-1). You should see an `AssumeRoleWithWebIdentity` event for
   `sketchcast-app-bedrock` with session name `sketchcast-app`, followed by `InvokeModel` calls under
   that role.
4. Once that holds, delete `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from Vercel, redeploy, and
   check again. Then **deactivate and delete** the IAM access key they came from.

## Local dev

There is no Vercel OIDC token on a laptop unless you run `vercel env pull`, which writes a
`VERCEL_OIDC_TOKEN` that is valid for about 12 hours. Without it, leave `AWS_ROLE_ARN` unset and use
static keys or an AWS profile locally.
