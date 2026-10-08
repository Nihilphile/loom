import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveAttachment,
  resolveAttachments,
} from "../src/server/attachments.ts";

test("attachments preserve exact bytes and keep storage paths out of public descriptors", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-attachment-"));
  const bytes = Buffer.from("中文文件内容\n\0binary");
  const saved = saveAttachment(root, {
    name: "../报告.txt",
    mediaType: "text/plain",
    base64: bytes.toString("base64"),
  });
  assert.equal(saved.size, bytes.length);
  assert.equal(saved.kind, "file");
  assert(!("path" in saved));
  const resolved = resolveAttachments(root, [saved.id])[0];
  assert.deepEqual(readFileSync(resolved.path), bytes);
  assert.throws(() => resolveAttachments(root, ["../报告.txt"]), /ID/);
  assert.throws(() => resolveAttachments(root, Array(13).fill(saved.id)), /12/);
});

test("attachment boundary rejects oversized or malformed content and detects image bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-attachment-"));
  const input = {
    name: "photo.png",
    mediaType: "image/png",
    base64: Buffer.from("not an image").toString("base64"),
  };
  assert.throws(() => saveAttachment(root, input), /PNG/);
  assert.throws(
    () => saveAttachment(root, { ...input, base64: "%%%%" }),
    /Base64/,
  );
  assert.throws(
    () => saveAttachment(root, { ...input, base64: "" }),
    /不能为空/,
  );
  assert.throws(
    () =>
      saveAttachment(root, {
        ...input,
        base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      }),
    /10 MB/,
  );
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=";
  const saved = saveAttachment(root, { ...input, base64: png });
  assert.equal(saved.kind, "image");
  assert.equal(saved.mediaType, "image/png");
});
