# R2

A small file service on an R2 bucket: uploads with metadata and checksums,
downloads with ranges and conditional requests, paginated listing, bulk
delete, and multipart uploads for large files.

## What it shows

| Feature | R2 API |
|---|---|
| Store `Content-Type`, `Cache-Control`, `Content-Disposition` | `put(key, body, { httpMetadata: request.headers })` |
| Custom metadata from `x-meta-*` headers | `put(..., { customMetadata })` |
| Reject a corrupt upload | `put(..., { sha256 })` |
| Optimistic writes with `If-Match` | `put(..., { onlyIf: request.headers })` returns `null` |
| Serve files with the right headers | `writeHttpMetadata(headers)`, `httpEtag` |
| `Range` requests (206) | `get(key, { range: request.headers })`, `object.range` |
| `If-None-Match` (304) and `If-Match` (412) | `get(key, { onlyIf: request.headers })` returns an object without `body` |
| Metadata only | `head(key)` |
| Folders and pages | `list({ prefix, delimiter, cursor, limit, include })` |
| Bulk delete | `delete(keys)` with up to 1,000 keys |
| Large files | `createMultipartUpload`, `resumeMultipartUpload`, `uploadPart`, `complete`, `abort` |

R2 errors, such as a checksum mismatch or a part that is too small, become a
400 response with the error message.

## Run it

From this directory:

```sh
pnpm open-orange dev     # or: pnpm wrangler dev --port 8788
```

## Try it

```sh
# Upload with HTTP metadata, custom metadata, and a checksum.
curl -X PUT localhost:8787/files/notes/a.txt \
  -H 'content-type: text/plain' -H 'cache-control: max-age=60' \
  -H 'content-disposition: attachment; filename="a.txt"' \
  -H 'x-meta-owner: ada' \
  -H "x-sha256: $(printf 'hello world' | sha256sum | cut -d' ' -f1)" \
  --data-binary 'hello world'

# A wrong checksum: 400, nothing stored.
curl -X PUT localhost:8787/files/notes/bad.txt -H 'x-sha256: 00' -d 'x'

# Download, metadata only, and a range.
curl -i localhost:8787/files/notes/a.txt
curl -I localhost:8787/files/notes/a.txt
curl -i localhost:8787/files/notes/a.txt -H 'range: bytes=6-'      # 206 "world"

# Conditional requests. Use the etag from the download.
curl -i localhost:8787/files/notes/a.txt -H 'if-none-match: "<etag>"'  # 304
curl -i localhost:8787/files/notes/a.txt -H 'if-match: "old"'          # 412
curl -X PUT localhost:8787/files/notes/a.txt -H 'if-match: "old"' -d 'x' # 412, not written

# List as folders, and page through everything two at a time.
curl -X PUT localhost:8787/files/notes/archive/c.txt -d c
curl 'localhost:8787/files?prefix=notes/&delimiter=/'
curl 'localhost:8787/files?limit=2'
curl 'localhost:8787/files?limit=2&cursor=<cursor>'

# Delete many keys at once.
curl -X POST localhost:8787/files/delete -d '{"keys":["notes/a.txt","notes/archive/c.txt"]}'

# Multipart upload of a 6 MiB file. Every part but the last must be 5 MiB or more.
head -c 5242880 /dev/urandom > part1 && head -c 1048576 /dev/urandom > part2
curl -X POST localhost:8787/uploads/videos/big.bin -H 'content-type: video/mp4'  # {"uploadId":...}
curl -X PUT 'localhost:8787/uploads/videos/big.bin?uploadId=<id>&part=1' --data-binary @part1
curl -X PUT 'localhost:8787/uploads/videos/big.bin?uploadId=<id>&part=2' --data-binary @part2
curl -X POST 'localhost:8787/uploads/videos/big.bin?uploadId=<id>' \
  -d '{"parts":[{"partNumber":1,"etag":"<etag1>"},{"partNumber":2,"etag":"<etag2>"}]}'
curl -X DELETE 'localhost:8787/uploads/videos/big.bin?uploadId=<id>'  # abort instead
```

## Restarts

Files persist across `open-orange dev` restarts.

## Store the bucket in S3, R2, or MinIO

Set these variables in the shell before `open-orange dev` to keep the `FILES`
bucket in an S3-compatible store. `<BUCKET>` in `ORANGE_R2_<BUCKET>_S3_*` is the
`bucket_name` in upper case, with other characters as `_` (`files` becomes `FILES`).
Orange reads them from the shell environment, not from `.dev.vars` or
`wrangler.jsonc`. The bucket must already exist.

| Variable | Required | Meaning |
|---|---|---|
| `ORANGE_R2_FILES_S3_ENDPOINT` | Yes | The S3 API URL |
| `ORANGE_R2_FILES_S3_ACCESS_KEY_ID` | Yes | Access key ID. Falls back to `AWS_ACCESS_KEY_ID` |
| `ORANGE_R2_FILES_S3_SECRET_ACCESS_KEY` | Yes | Secret access key. Falls back to `AWS_SECRET_ACCESS_KEY` |
| `ORANGE_R2_FILES_S3_BUCKET` | No | Bucket name. Defaults to `bucket_name` |
| `ORANGE_R2_FILES_S3_REGION` | No | Region. Defaults to `AWS_REGION`, then `auto` |

MinIO:

```sh
docker run -p 9000:9000 minio/minio server /data   # then create the "files" bucket
export ORANGE_R2_FILES_S3_ENDPOINT=http://127.0.0.1:9000
export ORANGE_R2_FILES_S3_ACCESS_KEY_ID=minioadmin
export ORANGE_R2_FILES_S3_SECRET_ACCESS_KEY=minioadmin
pnpm open-orange dev
```

Cloudflare R2:

```sh
export ORANGE_R2_FILES_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export ORANGE_R2_FILES_S3_ACCESS_KEY_ID=<r2-access-key-id>
export ORANGE_R2_FILES_S3_SECRET_ACCESS_KEY=<r2-secret>
export ORANGE_R2_FILES_S3_BUCKET=my-files
```

AWS S3:

```sh
export ORANGE_R2_FILES_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
export ORANGE_R2_FILES_S3_REGION=us-east-1
export ORANGE_R2_FILES_S3_ACCESS_KEY_ID=<aws-access-key-id>
export ORANGE_R2_FILES_S3_SECRET_ACCESS_KEY=<aws-secret>
export ORANGE_R2_FILES_S3_BUCKET=my-files
```

Neon Object Storage, with the values from the **Storage** tab of the Neon
Console's **Connect** dialog, or from `neon credentials create --scope storage:write`:

```sh
export ORANGE_R2_FILES_S3_ENDPOINT=https://<branch-id>.storage.<cell>.<region>.aws.neon.tech
export ORANGE_R2_FILES_S3_REGION=<region>
export ORANGE_R2_FILES_S3_ACCESS_KEY_ID=<neon-token-id>
export ORANGE_R2_FILES_S3_SECRET_ACCESS_KEY=<neon-s3-secret-access-key>
export ORANGE_R2_FILES_S3_BUCKET=my-files
```

The Worker code does not change.
