#!/usr/bin/env node
// The keys saved in the board's Keys panel, for agents and scripts.
//
//   node ~/paseo-command-board/bin/keys.mjs list            names, env vars and notes (no values)
//   node ~/paseo-command-board/bin/keys.mjs get NEWSAPI     the value, by env var or name
//
// Values live in the macOS login Keychain (service "paseo-keys", label = env var);
// keys.json beside the board's data holds only the names and notes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "better-paseo");

function keys() {
  try { return JSON.parse(readFileSync(join(DATA, "keys.json"), "utf8")).keys ?? []; } catch { return []; }
}

/** The value in `security … -g` output (stderr): `password: "text"`, or `password: 0xHEX …` when not plain ASCII. */
function parse(output) {
  const line = output.split("\n").find((entry) => entry.startsWith("password: "));
  if (!line) return null;
  const rest = line.slice("password: ".length);
  const hex = /^0x([0-9A-Fa-f]+)/.exec(rest);
  if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
  if (rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  return rest;
}

const [command, wanted = ""] = process.argv.slice(2);
const all = keys();
if (!command || command === "list") {
  if (!all.length) console.log("No keys saved yet. Add them in the board's Keys panel.");
  for (const key of all) console.log(`${key.envVar}\t${key.name}${key.note ? `\t${key.note}` : ""}`);
} else if (command === "get") {
  const lower = wanted.toLowerCase();
  const key = all.find((entry) => entry.envVar.toLowerCase() === lower) ?? all.find((entry) => entry.name.toLowerCase() === lower);
  if (!key) {
    console.error(`No key "${wanted}". Saved: ${all.map((entry) => entry.envVar).join(", ") || "none"}`);
    process.exit(1);
  }
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "paseo-keys", "-a", key.id, "-g"], { encoding: "utf8" });
  const value = result.status === 0 ? parse(result.stderr ?? "") : null;
  if (value === null) {
    console.error(`Could not read ${key.envVar} from the Keychain`);
    process.exit(1);
  }
  process.stdout.write(value);
  if (process.stdout.isTTY) process.stdout.write("\n");
} else {
  console.error("Usage: keys.mjs list | get NAME");
  process.exit(2);
}
