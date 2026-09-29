import fs from "node:fs/promises";
import { RunEvent } from "./types";
import { redactSecrets } from "./security";

export class EventLogWriter {
  constructor(private readonly filePath: string) {}

  async append(event: RunEvent): Promise<void> {
    const safe = redactSecrets(event);
    const line = JSON.stringify(safe);
    await fs.appendFile(this.filePath, `${line}\n`, "utf8");
  }
}
