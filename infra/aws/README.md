# infra/aws

Provisioning scripts and templates for the S3 bucket JayTrace's collector exports to. No
resource here is created automatically — every command is dry-run first, then re-run without
`--dry-run` by a human with AWS credentials.

## Dedicated bucket setup

The example env (`apps/nest-api/.env`) currently points `JAYTRACE_BUCKET` at
`example-shared-bucket`, a bucket shared with image staging. Migrate to a dedicated bucket before
production traffic.

```bash
# 1. Preview every command (no AWS calls)
infra/aws/apply-s3-config.sh --bucket jaytrace-prod --region ap-northeast-2 --create-bucket --dry-run

# 2. Create the bucket + apply config for real
infra/aws/apply-s3-config.sh --bucket jaytrace-prod --region ap-northeast-2 --create-bucket
```

`--create-bucket` runs, in order: `create-bucket` (with `--create-bucket-configuration
LocationConstraint=<region>` for any region other than `us-east-1`), `put-public-access-block`
(blocks all four public-access settings), `put-bucket-encryption` (SSE-S3 / AES256 by default),
then the existing lifecycle + CORS steps. Omit `--create-bucket` to only reapply lifecycle/CORS
on a bucket that already exists.

Then point the collector at the new bucket:

```bash
JAYTRACE_BUCKET=jaytrace-prod
JAYTRACE_S3_PREFIX=production
AWS_REGION=ap-northeast-2
```

Also replace `YOUR_JAYTRACE_BUCKET` in `producer-iam-policy.json` and
`developer-readonly-iam-policy.json` with the real bucket name before attaching them.

## Lifecycle policy (`s3-lifecycle.json`)

Single rule, applied to every key under the bucket (prefix `""`):

| Age | Action |
| --- | --- |
| 30 days | Transition to `STANDARD_IA` |
| 90 days | Transition to `GLACIER_IR` |
| 180 days | Object expires (deleted) |
| 30 days (noncurrent versions) | Noncurrent version expires |
| 7 days (incomplete multipart uploads) | Aborted |

One policy covers all document types (front/back timeline, v1/v2 replay, wireframe) since they
share the same key prefix (`{env}/{yyyy}/{mm}/{dd}/{traceId}/...`) and S3 lifecycle filters only
match prefix/tag, not key suffix. If replay segments ever need a shorter retention than timeline
docs, move them to a separate prefix (e.g. `{env}/replay/...`) and add a second lifecycle rule —
out of scope for now.

## Cost model

Estimate:

```
daily objects  = DAU * sampleRate * segmentsPerSession
daily GB       = DAU * sampleRate * segmentsPerSession * avgSegmentSizeKB / 1e6
```

Assumptions: `mode: "always"` recording emits a v2 segment roughly every 10s, i.e. ~6
segments/min of active session; call it ~6 segments per session as a round baseline (short
sessions). Average sizes used below: front timeline ~5KB, v1 replay ~300KB, v2 segment
~2-256KB (use 50KB as a blended average), wireframe segment ~5-30KB (use 15KB average). These
are rough planning numbers, not a billing guarantee — real traffic varies with session length
and DOM complexity.

| Case | DAU | sampleRate | Segments/session | Daily objects | Daily GB (approx) |
| --- | --- | --- | --- | --- | --- |
| (a) small app | 1,000 | 0.1 | 6 | ~600 | ~0.03 GB |
| (b) mid app | 10,000 | 0.1 | 6 | ~6,000 | ~0.3 GB |
| (c) mid app, sampleRate 1.0 | 10,000 | 1.0 | 6 | ~60,000 | ~3 GB |

Case (c) shows why `sampleRate 1.0` in production is expensive: a 10x jump in sampled sessions
is a 10x jump in both object count and storage, with no extra coverage benefit since error
sessions are already escalated to 100% capture regardless of sample rate (v2 engines — rrweb web and wireframe mobile; legacy v1 snapshot/screenshot engines have no error-escalation fallback; see below). At current
Standard storage pricing (~$0.023/GB-month before IA/Glacier transitions), case (c) is roughly
10x the monthly storage bill of case (b) for the same DAU.

## Production recommended defaults

| Setting | Value | Why |
| --- | --- | --- |
| `replay.sampleRate` | `0.1` | Error escalation (v2 engines only) captures 100% of error sessions regardless of sample rate — no coverage loss for the traffic that matters most. Legacy v1 snapshot/screenshot engines gate on sample rate with no error fallback. |
| `maxRumPayloadBytes` | `1MB` (`1024 * 1024`) | Collector-side hard cap on a single RUM ingest request. |
| Replay segment | `10s` / `256KB` | Default `always`-mode flush cadence; keeps individual segment uploads small. |
| `maxRumReplayEvents` | `5000` | Caps events per wireframe/replay segment to bound memory and payload size. |
| `rumRateLimit` | `120` requests / `60s` window | Per-key ingest rate limit; matches the README quick-start defaults. |

## Spool backlog operations

If an S3 `PutObject` fails, `S3JayTraceExporter` (`packages/nestjs/src/s3-exporter.ts`) writes
the document to disk instead of dropping it — this is the spool.

- **Location:** `options.spoolDir` if set, otherwise `$TMPDIR/jaytrace-spool` (Node's `os.tmpdir()`).
- **Layout:** spool files mirror the S3 key exactly — `<spoolDir>/<same key the object would
  have had>`, e.g. `<spoolDir>/production/2026/07/11/<traceId>/front-....json`.
- **File format:** each spool file is `{ "exportError": "<Error name>: <message>", "document": <the original document> }` — **not** the raw document. Re-uploading must strip the wrapper.
- **What backlog growth means:** the exporter is failing to reach S3 (bad credentials, bucket
  policy, network partition, or bucket doesn't exist yet). Files accumulate locally and are lost
  if the host disk is wiped before re-upload.
- **Re-upload procedure:** for each spool file, extract `.document` and put it to the S3 key
  that mirrors the file's path relative to the spool root:

  ```bash
  spool_root="${TMPDIR:-/tmp}/jaytrace-spool"
  bucket="jaytrace-prod"
  find "$spool_root" -type f -name '*.json' | while read -r f; do
    key="${f#"$spool_root"/}"
    jq -c '.document' "$f" > /tmp/jaytrace-reupload.json
    aws s3 cp /tmp/jaytrace-reupload.json "s3://$bucket/$key" --content-type "application/json"
    rm -f /tmp/jaytrace-reupload.json
    # only remove the spool file after the upload above succeeds
    rm -f "$f"
  done
  ```
  
  Note: the collector's `spoolDir` option overrides the default spool location.

- **Suggested alert threshold:** page/alert when spool file count exceeds **100** — check the
  `spoolBacklog` counter on `GET /jaytrace/health` (Track B) rather than scanning the filesystem
  directly in production.

## IAM templates

- `producer-iam-policy.json` — write-only (`PutObject`, `AbortMultipartUpload`) for the
  collector's runtime credentials, scoped to `arn:aws:s3:::YOUR_JAYTRACE_BUCKET/*`.
- `developer-readonly-iam-policy.json` — `ListBucket` on the bucket + `GetObject` on its
  contents, for local console/CLI analysis users.

Both are already least-privilege for the current single-bucket, single-prefix-per-environment
key layout — no changes needed here. Replace `YOUR_JAYTRACE_BUCKET` with the real bucket name
before attaching.
