import fs from "node:fs/promises";
import { RunEvent } from "./types";
import { redactSecrets } from "./security";

export class EventLogWriter {
  constructor(private readonly filePath: string) {}

  async append(event: RunEvent): Promise<void> {
    const safe = redactSecrets(event);
    const line = JSON.stringify(safe);
    try {
      await fs.appendFile(this.filePath, `${line}\n`, "utf8");
    } catch (err) {
      console.error(`[orchestra] Failed to append event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
