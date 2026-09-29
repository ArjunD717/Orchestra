import path from "node:path";

const SECRET_KEY_PATTERN = /api[-_]?key|token|secret|password|authorization/i;
const SECRET_VALUE_PATTERNS = [
  /sk-[a-zA-Z0-9]{10,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /(?<=api[_-]?key["']?\s*[:=]\s*["'])[^"']+/gi,
  /(?<=token["']?\s*[:=]\s*["'])[^"']+/gi
];

export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
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
    throw new Error(`Path is outside selected repo root: ${targetPath}`);
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
