#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { Environment } from "./environment.mjs";
import { lines, parseLine, ProtocolError, MAX_LINE } from "./wire.mjs";

const { values } = parseArgs({
  options: {
    experimental: { type: "boolean", default: false },
    engine: { type: "string" },
    timeout: { type: "string", default: "120000" },
  },
});
if (!values.experimental)
  throw new Error(
    "This is an experimental catalog spike. Pass --experimental after reading packages/forge-spellbench/README.md.",
  );
const timeoutMs = Number(values.timeout);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid --timeout");
const entry = values.engine
  ? pathToFileURL(resolve(values.engine, "node.js"))
  : import.meta.resolve("@manabrew/forge-wasm");
const api = await import(entry);
if (["0.1.0", "0.2.0"].includes(api.VERSION))
  throw new Error(
    "Published Forge-WASM lacks startingPlayerIndex and randomSeed. Build the spike's engine and use --engine packages/forge-wasm.",
  );
const hash = createHash("sha256");
for await (const bytes of createReadStream(new URL("forgeharness.js.wasm", entry)))
  hash.update(bytes);
const env = new Environment(api, {
  timeoutMs,
  fingerprint: hash.digest("hex"),
  log: (text) => process.stderr.write(`${text}\n`),
});
process.stderr.write(
  "Experimental Forge catalog spike; general SpellBench support is not implemented.\n",
);
let stopping = false;
const stop = () => {
  stopping = true;
  env.close();
  process.stdin.destroy();
};
const eof = () => {
  stopping = true;
  env.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdin.once("end", eof);
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") process.exitCode = 1;
  stop();
});
try {
  for await (const line of lines(process.stdin)) {
    if (stopping) break;
    let response;
    try {
      if (line === null) throw new ProtocolError("malformed_json", "line too long");
      response = await env.handle(parseLine(line));
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      response = env.error("", error);
    }
    const encoded = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(encoded) > MAX_LINE) throw new Error("Response exceeds framing limit");
    if (!process.stdout.write(encoded)) await once(process.stdout, "drain");
  }
} catch (error) {
  if (!stopping) {
    process.stderr.write(`Forge adapter failed: ${error.message}\n`);
    process.exitCode = 1;
  }
} finally {
  env.close();
}
