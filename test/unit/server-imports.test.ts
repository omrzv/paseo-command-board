import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("plugin server bundle", () => {
  it("never imports client modules (Paseo refuses to load such a server)", () => {
    const offenders = [join(root, "index.server.ts"), ...files(join(root, "server")), ...files(join(root, "shared"))]
      .filter((path) => /from\s+["'][^"']*\/client\//.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
