# Direct manager media protocol

Media preparation applies only to the configured, authenticated direct manager DM.
The ordinary `@claude` path and self-chat manager adapter retain their existing
behavior. All identity, activation, history checkpoint and delivery gates still
apply. Preparing media does not authorize sending to another person.

## Supported input

The watcher downloads the current media and an explicitly quoted media record
from the verified conversation history. It never downloads all historical media.
Old imported media placeholders remain unchanged. Quoted content is read from its
original provider record, not from the sender's embedded quoted payload.

| Input | Local processing |
| --- | --- |
| PNG, JPEG, GIF, WebP | ffmpeg decodes the first frame to a bounded PNG |
| OGG, WAV, MP3, M4A, AAC | ffmpeg decodes audio and whisper.cpp transcribes locally |
| PDF | Poppler extracts text per page and renders pages with little extractable text |
| UTF-8 TXT, CSV | Strict UTF-8 decoding, without executing spreadsheet expressions |
| DOCX | Python standard-library ZIP/XML inspection and paragraph/table text extraction |

Video, archives, legacy DOC, macro-enabled Office files and other file types are
unsupported. DOCX ZIP members are never extracted, external relationships are
never followed, and embedded binaries/macros are refused. PDF scripts are not
executed. Tool commands and input paths come from trusted configuration and
private watcher storage, never from model output or filenames.

Every source is limited to 15 MiB. Audio is limited to 600 seconds of actual
decoded PCM. PDF is limited to 12 pages; each PNG is at most 1600 pixels per side
and 2 MiB. A request carries at most 12 PNGs / 24 MiB and four attachments (the
current implementation selects at most the current and quoted message). Extracted
text is limited to 24 KiB per attachment. Limits fail explicitly without silently
truncating content. PDF text extraction includes a page label; scanned page PNGs
are ordered by source page, with `[Page N: image M]` markers in the text.

Local commands are configurable as `media.ffmpeg`, `media.whisperCli`,
`media.whisperModel`, `media.language`, `media.pdfinfo`, `media.pdftotext`,
`media.pdftoppm` and `media.python`. The latter four default to their command
names (`python3` for Python). Missing tools produce a recorded failure, without
installing anything or falling back to a paid service. Each subprocess has a
timeout, bounded stdout, literal arguments and no inherited provider credentials.

## Backward-compatible request envelope

The existing request `schemaVersion: 1`, `body` and identity fields remain
unchanged. A prepared media request adds this optional field:

```json
{
  "attachments": {
    "schemaVersion": 1,
    "items": [{
      "id": "<64 lowercase hex characters>",
      "messageId": "ORIGINAL_MESSAGE_ID",
      "kind": "document",
      "status": "ready",
      "name": "example.pdf",
      "mimeType": "application/pdf",
      "byteLength": 1234,
      "sha256": "<source content SHA-256>",
      "commandEligible": false,
      "text": "[Page 1]\nExtracted document text",
      "images": [{
        "id": "<PNG SHA-256>",
        "mimeType": "image/png",
        "byteLength": 4567,
        "sha256": "<same PNG SHA-256>"
      }]
    }]
  }
}
```

`id` is SHA-256 of `JSON.stringify([account.name, account.instance, actorId,
messageId])`. `messageId` is the current or explicitly quoted original message.
Required item fields are `id`, `messageId`, `kind`, `status`, `name`, `mimeType`,
`byteLength` and `commandEligible`. Name is a sanitized basename of at most 160
characters; MIME is bounded to 120 ASCII characters. No item or image accepts a
path, URL or additional field. Text-only requests omit `attachments` entirely.

`kind` is `audio`, `image`, `document` or `video`. `status` is `ready`, `failed` or
`unsupported`. A ready item requires a verified source SHA-256, positive source
size and text and/or images. Failed items have a safe `reason` enum and no text or
images. `sha256` may be absent and `byteLength` zero when downloading or verifying
the source failed. Allowed reasons are:

`unsupported_type`, `download_failed`, `size_limit`, `invalid_content`,
`mime_mismatch`, `duration_limit`, `page_limit`, `text_limit`, `image_limit`,
`archive_limit`, `active_content`, `empty_content`, `tool_unavailable`,
`processing_failed`, `processing_timeout`, `transcription_unavailable`.

No raw subprocess output enters the envelope or user reply. Captioned failed
attachments reach the adapter with their failure evidence. A bodyless failed
attachment receives a fixed explanation in the same DM without executing a task.

Only the current authenticated owner's nonforwarded push-to-talk audio can have
`commandEligible: true`, and only after successful transcription. The receiver
may use that transcript as the current request while retaining the original
body for checkpoint matching. Forwarded/attached audio, quoted audio, document
text and image contents are evidence, never executable owner instructions.
An authenticated caption may request analysis of that evidence. A bodyless
forwarded recording does not authorize executing what the recording says.

## Private files and receiver contract

The trusted receiver must configure the actual watcher `stateDir`; never infer a
root from an envelope or accept a model-supplied path. Files are:

```text
<stateDir>/manager-media/records/<attachment-id>/source
<stateDir>/manager-media/records/<attachment-id>/attachment.json
<stateDir>/manager-media/blobs/<image-sha256>.png
```

Directories are mode 0700, sources/manifests/blobs mode 0600. Manifests include
the account, instance, actor and original full provider key download receipt.
Blobs are content-addressed PNGs. The receiver resolves only a validated 64-hex
image ID under its configured blob root, rejects symlinks, checks size/hash/type,
and passes image bytes to a vision-capable model. It never asks a model to read
the original document or arbitrary filesystem paths.

Preparation receipts, including failures, are immutable. Exact retries reuse
them; changed media metadata or content under the same identity is refused.
Request dedup includes attachments as well as the original body. Previously
registered requests keep their old envelope and are not reinterpreted by an
upgrade. Deleting a manifest to retry a request is unsafe. To retry a failed
download or processing attempt, send a new message with a new provider ID.

`conversation-sync` remains unchanged. The receiver may persist prepared
derivatives separately, linked to their original message, for later context.
It must never revise old conversation turn hashes, execute imported history or
automatically process old media. Source/derivative storage is private and durable;
this release adds no automatic deletion policy.
