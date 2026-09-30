import fs from "node:fs/promises";

/** Atomically write a file via sibling tmp + rename. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // Best effort cleanup.
    }
    throw err;
  }
}
