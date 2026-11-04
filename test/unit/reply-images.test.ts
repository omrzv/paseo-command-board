import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveReplyImages } from "../../server/reply-images";
import { withImagePaths } from "../../client/tasks/actions/agent-reply";

describe("reply images", () => {
  it("saves pasted images as private files and names them in the reply", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reply-images-"));
    const paths = await saveReplyImages([{ data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }, { data: Buffer.from("jpg").toString("base64"), mimeType: "image/jpeg" }], dir);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/\.png$/);
    expect(paths[1]).toMatch(/\.jpg$/);
    expect(await readFile(paths[0]!, "utf8")).toBe("png-bytes");
    expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toHaveLength(2);
    expect(withImagePaths("(see image)", paths)).toBe(`(see image)\n\n[Pasted image: ${paths[0]}]\n[Pasted image: ${paths[1]}]`);
    expect(withImagePaths("hi", [])).toBe("hi");
  });
});
