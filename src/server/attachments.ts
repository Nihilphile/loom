import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { Attachment } from "../shared/types.ts";

const maxBytes = 10 * 1024 * 1024;
const idPattern = /^[a-f0-9-]{36}$/;

function attachmentRoot(root: string) {
  const base = realpathSync(join(root, ".newharness", "attachments"));
  const rel = relative(realpathSync(root), base);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("附件目录不属于项目");
  return base;
}

export function saveAttachment(
  root: string,
  input: { name: string; mediaType: string; base64: string },
): Attachment {
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 240 ||
    /[\x00-\x1f]/.test(input.name)
  )
    throw new Error("附件名称无效");
  if (
    typeof input.base64 !== "string" ||
    input.base64.length > Math.ceil(maxBytes / 3) * 4 ||
    input.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  )
    throw new Error("附件须为有效 Base64，最大 10 MB");
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.toString("base64") !== input.base64)
    throw new Error("附件 Base64 编码无效");
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error("附件不能为空，最大 10 MB");
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  const detected = png
    ? "image/png"
    : jpeg
      ? "image/jpeg"
      : webp
        ? "image/webp"
        : undefined;
  if (input.mediaType?.startsWith("image/") && !detected)
    throw new Error("图片只支持 PNG、JPEG、WebP");
  const attachment: Attachment = {
    id: randomUUID(),
    name: input.name,
    mediaType: detected || "application/octet-stream",
    size: bytes.length,
    kind: detected ? "image" : "file",
  };
  mkdirSync(join(root, ".newharness", "attachments"), { recursive: true });
  const dir = join(attachmentRoot(root), attachment.id);
  mkdirSync(dir);
  writeFileSync(join(dir, "content"), bytes, { flag: "wx" });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(attachment), {
    flag: "wx",
  });
  return attachment;
}

export function resolveAttachments(
  root: string,
  ids: string[],
): (Attachment & { path: string })[] {
  if (
    !Array.isArray(ids) ||
    ids.length > 12 ||
    ids.some((id) => typeof id !== "string" || !idPattern.test(id))
  )
    throw new Error("附件 ID 无效，每条消息最多 12 个附件");
  return ids.map((id) => {
    const base = attachmentRoot(root);
    const dir = realpathSync(join(base, id));
    const path = realpathSync(join(dir, "content"));
    const metadata = realpathSync(join(dir, "metadata.json"));
    for (const candidate of [dir, path, metadata]) {
      const rel = relative(base, candidate);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("附件路径越界");
    }
    const attachment = JSON.parse(readFileSync(metadata, "utf8")) as Attachment;
    if (attachment.id !== id) throw new Error("附件元数据不一致");
    return { ...attachment, path };
  });
}
