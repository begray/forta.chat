/**
 * Opens the Matrix SDK sync store, dropping it once if it was written by a
 * newer SDK.
 *
 * The SDK numbers its IndexedDB schema (matrix-js-sdk-bastyon 23.x: version 4,
 * 44.x: version 5). Opening a database with a lower version than it has fails
 * with a `VersionError`, so after a rollback to an older SDK the store would
 * never start and the client would run without its cache. The store is only a
 * cache of server state (Dexie is the source of truth), so it is deleted and
 * rebuilt by the next /sync.
 */

export interface StartableStore {
  startup(): Promise<void>;
}

export interface SyncStoreResetDeps<S extends StartableStore> {
  dbName: string;
  create: () => S;
  /** Runs `store.startup()` (with whatever timeout the caller wants). */
  start: (store: S) => Promise<void>;
  /** Stops a store that failed to start (e.g. its worker). */
  release: (store: S) => void;
  deleteDb: (dbName: string) => Promise<void>;
}

export function isIndexedDbVersionError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "VersionError";
}

export function deleteIndexedDb(factory: IDBFactory, dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn(`[matrix] deleting ${dbName} waits for an open connection to close`);
  });
}

/** Never throws: a store that still fails to start is returned as is, as before. */
export async function startSyncStoreWithReset<S extends StartableStore>(deps: SyncStoreResetDeps<S>): Promise<S> {
  const store = deps.create();
  try {
    await deps.start(store);
    return store;
  } catch (e) {
    if (!isIndexedDbVersionError(e)) {
      console.error("[matrix] IndexedDB startup error:", e);
      return store;
    }
    console.warn(`[matrix] ${deps.dbName} was written by a newer SDK, rebuilding it`, e);
  }

  deps.release(store);
  try {
    await deps.deleteDb(deps.dbName);
  } catch (e) {
    console.error(`[matrix] failed to delete ${deps.dbName}:`, e);
  }
  const fresh = deps.create();
  try {
    await deps.start(fresh);
  } catch (e) {
    console.error("[matrix] IndexedDB startup error after reset:", e);
  }
  return fresh;
}
