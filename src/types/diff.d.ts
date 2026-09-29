declare module "diff" {
  export interface ParsedHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }

  export interface ParsedPatch {
    oldFileName?: string;
    newFileName?: string;
    hunks: ParsedHunk[];
  }

  export function parsePatch(text: string): ParsedPatch[];
  export function applyPatch(
    source: string,
    patch: ParsedPatch | string,
    options?: { fuzzFactor?: number }
  ): string | false;
}
