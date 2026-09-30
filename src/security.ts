import fs from "node:fs";
import path from "node:path";

const SECRET_KEY_PATTERN = /api[-_]?key|token|secret|password|authorization/i;
const SECRET_INDICATOR_PATTERN =
  /api[_-]?key|token|secret|password|authorization|sk-|AIza|ghp_|gho_|xox[bpas]-|AKIA|BEGIN/i;
const SECRET_VALUE_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /xox[bpas]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /(?<=api[_-]?key["']?\s*[:=]\s*["'])[^"']{1,200}/gi,
  /(?<=token["']?\s*[:=]\s*["'])[^"']{1,200}/gi
];

export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (!SECRET_INDICATOR_PATTERN.test(value)) {
      return value;
    }
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, "[REDACTED]");
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export function ensurePathWithinRoot(repoRoot: string, targetPath: string): string {
  const normalizedRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(normalizedRoot, resolvedTarget);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!inside) {
    throw new Error(`Path is outside selected repo root: ${relative || targetPath}`);
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(normalizedRoot);
  } catch {
    realRoot = normalizedRoot;
  }
  let ancestor = resolvedTarget;
  const remainder: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        return resolvedTarget;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      remainder.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  let realTarget: string;
  try {
    realTarget = path.join(fs.realpathSync(ancestor), ...remainder);
  } catch {
    return resolvedTarget;
  }
  const realRelative = path.relative(realRoot, realTarget);
  const realInside =
    realRelative === "" || (!realRelative.startsWith("..") && !path.isAbsolute(realRelative));
  if (!realInside) {
    throw new Error(`Path is outside selected repo root: ${relative || targetPath}`);
  }
  return resolvedTarget;
}

export function sanitizePatchPath(input: string): string {
  let p = input.trim();
  p = p.replace(/^a\//, "").replace(/^b\//, "");
  if (p === "/dev/null") {
    return p;
  }
  p = p.replace(/\\/g, "/");
  p = p.replace(/^\.\/+/, "");
  if (p === "" || p === "." || p.split("/").some((segment) => segment === "..")) {
    throw new Error(`Patch path escapes repo root: ${input}`);
  }
  return p;
}
