// api/src/library/libraryService.ts
import { join } from "node:path";
import { scanLibrary } from "./scanner.js";
import { readJson, writeJsonAtomic } from "../store/jsonStore.js";
import type { SystemGroup } from "../types.js";

export class LibraryService {
  private cache: SystemGroup[] = [];
  constructor(private romsDir: string, private configDir: string) {}
  private get cacheFile() { return join(this.configDir, "library.json"); }

  async init(): Promise<void> {
    this.cache = await readJson<SystemGroup[]>(this.cacheFile, []);
    if (this.cache.length === 0) await this.scan();
  }
  get(): SystemGroup[] { return this.cache; }
  async scan(): Promise<SystemGroup[]> {
    this.cache = await scanLibrary(this.romsDir);
    await writeJsonAtomic(this.cacheFile, this.cache);
    return this.cache;
  }
}
