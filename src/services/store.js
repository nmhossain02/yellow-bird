import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createSeedState } from "../domain/catalog.js";

export class FileStore {
  constructor(path = process.env.YELLOWBIRD_DATA_PATH || ".yellowbird/state.json") {
    this.path = resolve(path);
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.state) return this.state;

    try {
      this.state = JSON.parse(await readFile(this.path, "utf8"));
      const seed = createSeedState();
      let migrated = false;
      for (const key of ["triggers", "engineProfiles"]) {
        if (!Array.isArray(this.state[key])) {
          this.state[key] = seed[key];
          migrated = true;
        }
      }
      if (migrated) await this.persist();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = createSeedState();
      await this.persist();
    }

    return this.state;
  }

  snapshot() {
    if (!this.state) throw new Error("Store has not been initialized");
    return structuredClone(this.state);
  }

  async mutate(mutator) {
    if (!this.state) throw new Error("Store has not been initialized");
    const result = await mutator(this.state);
    await this.persist();
    return result;
  }

  async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporaryPath = `${this.path}.${process.pid}.tmp`;

    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(temporaryPath, payload, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    });

    return this.writeQueue;
  }

  async reset() {
    this.state = createSeedState();
    await this.persist();
    return this.snapshot();
  }
}
