import { createHash } from "node:crypto";

export const PROTOCOL = "spellbench/v2";
export const MAX_LINE = 8 * 1024 * 1024;
export class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
export function requireThat(condition, code = "malformed_request", message) {
  if (!condition) throw new ProtocolError(code, message);
}
export const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const nonempty = (v) => typeof v === "string" && v.length > 0;
export const uint = (v, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= 0 && v <= max;
export function keys(v, expected) {
  requireThat(
    object(v) &&
      Object.keys(v).length === expected.length &&
      expected.every((key) => Object.hasOwn(v, key)),
  );
}
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export function sortNames(names) {
  return [...names].sort((a, b) => {
    const x = [...a].map((c) => c.codePointAt(0));
    const y = [...b].map((c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return x[i] - y[i];
    }
    return x.length - y.length;
  });
}

export const digest = (v) => `sha256:${createHash("sha256").update(canonical(v)).digest("hex")}`;

export function parseLine(bytes) {
  try {
    if (bytes.length > MAX_LINE) throw new Error("line too long");
    const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    let i = 0;
    const ws = () => {
      while (/[\x20\t\r\n]/.test(s[i] ?? "!")) i++;
    };
    function string() {
      const start = i++;
      while (i < s.length) {
        if (s[i++] === '"') {
          const value = JSON.parse(s.slice(start, i));
          if (!value.isWellFormed()) throw new Error("unpaired surrogate");
          return value;
        }
        if (s[i - 1] === "\\") i++;
      }
      throw new Error("unterminated string");
    }
    function value(depth) {
      ws();
      if (s[i] === '"') return string();
      if (s[i] === "{" || s[i] === "[") {
        if (depth >= 64) throw new Error("nesting limit");
        const isObject = s[i++] === "{";
        const close = isObject ? "}" : "]";
        const out = isObject ? Object.create(null) : [];
        ws();
        if (s[i] === close) {
          i++;
          return out;
        }
        while (true) {
          ws();
          if (isObject) {
            if (s[i] !== '"') throw new Error("expected key");
            const key = string();
            if (Object.hasOwn(out, key)) throw new Error("duplicate key");
            ws();
            if (s[i++] !== ":") throw new Error("expected colon");
            out[key] = value(depth + 1);
          } else out.push(value(depth + 1));
          ws();
          if (s[i] === close) {
            i++;
            return out;
          }
          if (s[i++] !== ",") throw new Error("expected comma");
        }
      }
      for (const [literal, result] of [
        ["true", true],
        ["false", false],
        ["null", null],
      ]) {
        if (s.startsWith(literal, i)) {
          i += literal.length;
          return result;
        }
      }
      const match = /^-?(?:0|[1-9][0-9]*)/.exec(s.slice(i));
      if (!match) throw new Error("expected value");
      i += match[0].length;
      const n = Number(match[0]);
      if (!Number.isSafeInteger(n)) throw new Error("integer out of range");
      return n;
    }
    const out = value(0);
    ws();
    if (i !== s.length) throw new Error("trailing input");
    return out;
  } catch (error) {
    throw new ProtocolError("malformed_json", error.message);
  }
}

export async function* lines(input) {
  let chunks = [],
    length = 0,
    oversized = false;
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      length += part.length;
      if (length > MAX_LINE) {
        oversized = true;
        chunks = [];
      } else chunks.push(part);
      if (end < 0) break;
      yield oversized ? null : Buffer.concat(chunks);
      chunks = [];
      length = 0;
      oversized = false;
      start = end + 1;
    }
  }
  if (length) yield oversized ? null : Buffer.concat(chunks);
}

export function validateRequest(r) {
  requireThat(object(r) && nonempty(r.request_id) && typeof r.protocol === "string");
  requireThat(r.protocol === PROTOCOL, "protocol_mismatch");
  const common = ["request_type", "protocol", "request_id"];
  switch (r.request_type) {
    case "hello":
      keys(r, [...common, "protocol_minor"]);
      requireThat(uint(r.protocol_minor, 0xffffffff));
      break;
    case "step":
      keys(r, [...common, "game_id", "expected_step", "selection"]);
      requireThat(nonempty(r.game_id) && uint(r.expected_step));
      keys(r.selection, ["candidate_id", "semantic_echo"]);
      requireThat(uint(r.selection.candidate_id, 0xffffffff) && object(r.selection.semantic_echo));
      break;
    case "reset": {
      keys(r, [
        ...common,
        "game_id",
        "format",
        "seats",
        "rules",
        "game_secret",
        "max_decisions",
        "max_steps",
      ]);
      requireThat(
        nonempty(r.game_id) &&
          nonempty(r.format) &&
          typeof r.game_secret === "string" &&
          /^[0-9a-f]{64}$/.test(r.game_secret),
      );
      requireThat(uint(r.max_decisions) && uint(r.max_steps));
      requireThat(Array.isArray(r.seats) && r.seats.length === 2);
      r.seats.forEach((s, i) => {
        keys(s, ["seat", "deck"]);
        requireThat(s.seat === `p${i}`);
        deck(s.deck, true);
      });
      const rules = r.rules;
      requireThat(object(rules));
      keys(rules, [
        "opponent_decklist",
        "mulligan",
        "starting_player",
        "starting_seat",
        "card_name_domain",
        "extensions",
        "probe",
      ]);
      requireThat(["visible", "hidden"].includes(rules.opponent_decklist));
      requireThat(["none", "london"].includes(rules.mulligan));
      requireThat(["host_assigned", "toss_winner_chooses"].includes(rules.starting_player));
      requireThat(
        rules.starting_player === "host_assigned"
          ? ["p0", "p1"].includes(rules.starting_seat)
          : rules.starting_seat === null,
      );
      keys(rules.card_name_domain, ["domain_id", "names"]);
      const { names, domain_id } = rules.card_name_domain;
      requireThat(
        Array.isArray(names) &&
          names.every(cardName) &&
          new Set(names).size === names.length &&
          domain_id === digest(sortNames(names)),
      );
      requireThat(
        Array.isArray(rules.extensions) &&
          rules.extensions.every(nonempty) &&
          new Set(rules.extensions).size === rules.extensions.length &&
          typeof rules.probe === "boolean",
      );
      break;
    }
    case "validate_deck":
      keys(r, [...common, "format", "deck"]);
      requireThat(nonempty(r.format));
      deck(r.deck, false);
      break;
    case "probe_resample":
      keys(r, [...common, "game_id", "samples"]);
      requireThat(nonempty(r.game_id) && uint(r.samples, 0xffffffff) && r.samples > 0);
      break;
    default:
      throw new ProtocolError("malformed_request", "Unknown request type");
  }
}

const cardName = (v) => nonempty(v) && v.normalize("NFC") === v;
function deck(d, withId) {
  requireThat(object(d));
  const source = Object.hasOwn(d, "catalog_id") ? "catalog_id" : "decklist";
  keys(d, withId ? ["deck_id", source] : [source]);
  if (withId) requireThat(typeof d.deck_id === "string" && /^sha256:[0-9a-f]{64}$/.test(d.deck_id));
  if (source === "catalog_id") requireThat(nonempty(d.catalog_id));
  else {
    requireThat(Array.isArray(d.decklist) && d.decklist.length > 0);
    const names = new Set();
    for (const row of d.decklist) {
      keys(row, ["name", "count"]);
      requireThat(
        cardName(row.name) && uint(row.count, 0xffffffff) && row.count > 0 && !names.has(row.name),
      );
      names.add(row.name);
    }
  }
}
