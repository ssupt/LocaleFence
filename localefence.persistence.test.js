"use strict";

const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const { boot, makeMutableFeedTarget, waitFor } = require("./localefence.test.js");

const requestValue = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionComplete = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
});
const openDatabase = (factory) => {
  const request = factory.open("localefence", 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("aboutUsers");
    db.createObjectStore("lookupQueue", { keyPath: "key" });
    db.createObjectStore("blockHistory", { keyPath: "id", autoIncrement: true });
  };
  return requestValue(request);
};
const readStore = async (factory, name) => {
  const db = await openDatabase(factory);
  try {
    return await requestValue(db.transaction(name, "readonly").objectStore(name).getAll());
  } finally {
    db.close();
  }
};

// Schedule a real second connection's write after hydration reads its snapshot.
// IndexedDB must serialize that writer behind the pruning transaction.
const writeDuringHydration = (factory, storeName, write) => ({
  open(name, version) {
    const request = factory.open(name, version);
    let inserted = false;
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (name, mode) => {
        const tx = transaction(name, mode);
        if (name !== storeName || inserted) return tx;
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = objectStore(name);
          const getAll = store.getAll.bind(store);
          store.getAll = (...args) => {
            const read = getAll(...args);
            read.addEventListener("success", () => {
              if (inserted) return;
              inserted = true;
              write();
            });
            return read;
          };
          return store;
        };
        return tx;
      };
    });
    return request;
  },
});

const testHydrationPreservesAnotherTabsQueueWrite = async () => {
  const factory = new IDBFactory();
  const storageValues = new Map();
  const first = boot({ currentOwner: "1", storedBlockEnabled: "false", storageValues, indexedDBImpl: factory });
  await first.hooks.getHydrationReady();
  let inserted;
  const second = boot({
    currentOwner: "1", storedBlockEnabled: "false", storageValues,
    indexedDBImpl: writeDuringHydration(factory, "lookupQueue", () => {
      inserted = first.hooks.rememberLookupRecord("Bob", { tweetText: "A new post in the first tab", tweetUrl: "" });
    }),
  });
  await second.hooks.getHydrationReady();
  const saved = await readStore(factory, "lookupQueue");
  assert.ok(inserted);
  assert.equal(saved.length, 1, "startup in a second tab must preserve a concurrently saved lookup");
  assert.equal(saved[0].username, "Bob");
  assert.equal(saved[0].ownerRestId, "1");
};

const testHydrationPreservesAnotherTabsCacheWrite = async () => {
  const factory = new IDBFactory();
  const firstDb = await openDatabase(factory);
  let write;
  const second = boot({ currentOwner: "1", storedBlockEnabled: "false",
    indexedDBImpl: writeDuringHydration(factory, "aboutUsers", () => {
      const tx = firstDb.transaction("aboutUsers", "readwrite");
      write = transactionComplete(tx);
      tx.objectStore("aboutUsers").put({
        restId: "3", screenName: "Bob", name: "Bob", country: "France", updatedAt: Date.now(),
      }, "3");
    }),
  });
  await second.hooks.getHydrationReady();
  assert.ok(write);
  await write;
  firstDb.close();
  const saved = await readStore(factory, "aboutUsers");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].screenName, "Bob");
};

const testHydrationPrunesAndRecoversInterruptedChecks = async () => {
  const factory = new IDBFactory();
  const db = await openDatabase(factory);
  const tx = db.transaction(["aboutUsers", "lookupQueue"], "readwrite");
  const done = transactionComplete(tx);
  tx.objectStore("aboutUsers").put({ restId: "2", screenName: "Alice", country: "Italy", updatedAt: 1 }, "2");
  tx.objectStore("aboutUsers").put({ restId: "3", screenName: "Bob", country: "France", updatedAt: Date.now() }, "3");
  tx.objectStore("lookupQueue").put({ key: "alice", username: "Alice", ownerRestId: "1", status: "checking", enqueuedAt: Date.now() });
  tx.objectStore("lookupQueue").put({ key: "invalid", username: "invalid/path", status: "lookup", enqueuedAt: Date.now() });
  await done;
  db.close();
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory, visibilityState: "hidden" });
  await app.hooks.getHydrationReady();
  assert.equal(app.hooks.getCachedAccount("Alice"), null);
  assert.equal(app.hooks.getCachedAccount("Bob").country, "France");
  const cache = await readStore(factory, "aboutUsers");
  const queue = await readStore(factory, "lookupQueue");
  assert.equal(cache.length, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "lookup");
  assert.equal(app.hooks.getLookupRecord("Alice").status, "lookup");
};

const testResetInvalidatesLatePersistentLookup = async () => {
  const factory = new IDBFactory();
  let finishLookup;
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory,
    fetchImpl: () => new Promise((resolve) => { finishLookup = () => resolve({
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
        about_profile: { account_based_in: "Italy" },
      } } } }),
    }); }),
  });
  await app.hooks.getHydrationReady();
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => finishLookup);
  await app.hooks.resetLocaleFenceData();
  finishLookup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.hooks.getCachedAccount("Alice"), null);
  for (const name of ["aboutUsers", "lookupQueue", "blockHistory"]) {
    assert.equal((await readStore(factory, name)).length, 0);
  }
};

const testResetDuringHydrationClearsPersistentData = async () => {
  const factory = new IDBFactory();
  const db = await openDatabase(factory);
  const tx = db.transaction(["aboutUsers", "lookupQueue", "blockHistory"], "readwrite");
  const done = transactionComplete(tx);
  tx.objectStore("aboutUsers").put({ restId: "2", screenName: "Alice", country: "Italy", updatedAt: Date.now() }, "2");
  tx.objectStore("lookupQueue").put({ key: "alice", username: "Alice", ownerRestId: "1", status: "failed", enqueuedAt: Date.now() });
  tx.objectStore("blockHistory").add({ restId: "2", ownerRestId: "1", username: "Alice", status: "blocked", blockedAt: Date.now() });
  await done;
  db.close();
  const storageValues = new Map();
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory, storageValues });
  await app.hooks.resetLocaleFenceData();
  assert.equal(app.hooks.getCachedAccount("Alice"), null);
  assert.equal(app.hooks.getLookupRecord("Alice"), undefined);
  for (const name of ["aboutUsers", "lookupQueue", "blockHistory"]) {
    assert.equal((await readStore(factory, name)).length, 0);
  }
  assert.equal([...storageValues.keys()].some((key) => key.startsWith("localefence.")), false);
};

const testHydrationKeepsConnectedViaFields = async () => {
  const factory = new IDBFactory();
  const db = await openDatabase(factory);
  const tx = db.transaction("aboutUsers", "readwrite");
  const done = transactionComplete(tx);
  tx.objectStore("aboutUsers").put({
    restId: "2", screenName: "Alice", name: "Alice", country: "France",
    source: "Russian Federation Android App", sourceCountry: "Russian Federation",
    locationWarning: true, updatedAt: Date.now(),
  }, "2");
  tx.objectStore("aboutUsers").put({
    restId: "3", screenName: "Bob", name: "Bob", country: "Italy", updatedAt: Date.now(),
  }, "3");
  tx.objectStore("aboutUsers").put({
    restId: "4", screenName: "Carol", country: "France", source: "Web",
    sourceCountry: "Italy", locationWarning: false, updatedAt: Date.now(),
  }, "4");
  await done;
  db.close();
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory });
  await app.hooks.getHydrationReady();
  const alice = app.hooks.getCachedAccount("Alice");
  assert.equal(alice.sourceCountry, "Russian Federation");
  assert.equal(alice.locationWarning, true);
  assert.equal(alice.expired, false);
  const bob = app.hooks.getCachedAccount("Bob");
  assert.equal(bob.sourceCountry, undefined, "legacy records without Connected-via data must hydrate unchanged");
  assert.equal(bob.locationWarning, undefined);
  assert.equal(bob.expired, true, "legacy metadata must refresh on encounter");
  const carol = app.hooks.getCachedAccount("Carol");
  assert.equal(carol.sourceCountry, undefined, "IndexedDB must not revive an invalid derived store country");
  assert.equal(carol.locationWarning, false, "a recorded absence of warnings must survive hydration");
  assert.equal(carol.expired, false);
  const saved = await readStore(factory, "aboutUsers");
  assert.equal(saved.find((user) => user.restId === "4").sourceCountry, undefined);
};

const testLookupPersistsMetadataAcrossReloads = async () => {
  const factory = new IDBFactory();
  const first = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory,
    fetchImpl: async () => ({ headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { screen_name: "Alice" },
        about_profile: { account_based_in: "France", source: "Italy App Store", location_accurate: true },
      } } } }),
    }),
  });
  await first.hooks.getHydrationReady();
  await first.hooks.fetchCountry("Alice");
  const reloaded = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory,
    storageValues: new Map([["localefence.matchStoreRegion", "true"]]),
    fetchImpl: async (url) => { throw new Error(`Unexpected request: ${url}`); },
  });
  await reloaded.hooks.getHydrationReady();
  const target = makeMutableFeedTarget("Alice");
  reloaded.hooks.enqueue("Alice", target.container, target.tweet);
  const cached = reloaded.hooks.getCachedAccount("Alice");
  assert.equal(cached.locationWarning, false);
  assert.equal(cached.expired, false);
  assert.equal(cached.sourceCountry, "Italy");
  assert.equal(target.cell.dataset.localefenceHidden, "true", "store matching must work after reloading persisted metadata");
  assert.equal(reloaded.hooks.getLookupRecord("Alice"), undefined, "fresh persisted metadata must avoid a new lookup");
};

const testHydrationSkipsUnchangedStorePuts = async () => {
  const factory = new IDBFactory();
  const db = await openDatabase(factory);
  const tx = db.transaction("aboutUsers", "readwrite");
  const done = transactionComplete(tx);
  const now = Date.now();
  tx.objectStore("aboutUsers").put({
    restId: "2", screenName: "Alice", name: "Alice", country: "France",
    source: "Italy App Store", sourceCountry: "Italy", locationWarning: false, updatedAt: now,
  }, "2");
  tx.objectStore("aboutUsers").put({
    restId: "3", screenName: "Bob", country: "France", source: "Web",
    sourceCountry: "Italy", locationWarning: false, updatedAt: now,
  }, "3");
  await done;
  db.close();
  const putKeys = [];
  const spiedFactory = {
    open(name, version) {
      const request = factory.open(name, version);
      request.addEventListener("success", () => {
        const opened = request.result;
        const originalTx = opened.transaction.bind(opened);
        opened.transaction = (storeName, mode) => {
          const t = originalTx(storeName, mode);
          if (storeName !== "aboutUsers") return t;
          const originalStore = t.objectStore.bind(t);
          t.objectStore = (s) => {
            const store = originalStore(s);
            const originalPut = store.put.bind(store);
            store.put = (val, key) => {
              putKeys.push(key ?? val?.restId);
              return originalPut(val, key);
            };
            return store;
          };
          return t;
        };
      });
      return request;
    },
  };
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: spiedFactory });
  await app.hooks.getHydrationReady();
  assert.deepEqual(putKeys, ["3"], "hydration must only rewrite records whose normalized data changed");
};

const testClearQueueAndHistoryDuringHydrationAreNotResurrected = async () => {
  const factory = new IDBFactory();
  const db = await openDatabase(factory);
  const tx = db.transaction(["lookupQueue", "blockHistory"], "readwrite");
  const done = transactionComplete(tx);
  tx.objectStore("lookupQueue").put({ key: "alice", username: "Alice", ownerRestId: "1", status: "failed", enqueuedAt: Date.now() });
  tx.objectStore("blockHistory").add({ restId: "2", ownerRestId: "1", username: "Alice", status: "blocked", blockedAt: Date.now() });
  await done;
  db.close();
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", indexedDBImpl: factory, visibilityState: "hidden" });
  await Promise.all([app.hooks.clearLookupRecords(), app.hooks.clearBlockHistory()]);
  assert.equal(app.hooks.getLookupRecord("Alice"), undefined);
  assert.equal(app.hooks.getBlockHistory().length, 0);
  assert.equal((await readStore(factory, "lookupQueue")).length, 0);
  assert.equal((await readStore(factory, "blockHistory")).length, 0);
};

const run = async () => {
  await testHydrationPreservesAnotherTabsQueueWrite();
  await testHydrationPreservesAnotherTabsCacheWrite();
  await testHydrationPrunesAndRecoversInterruptedChecks();
  await testResetInvalidatesLatePersistentLookup();
  await testResetDuringHydrationClearsPersistentData();
  await testHydrationKeepsConnectedViaFields();
  await testLookupPersistsMetadataAcrossReloads();
  await testHydrationSkipsUnchangedStorePuts();
  await testClearQueueAndHistoryDuringHydrationAreNotResurrected();
};
run().then(() => console.log("LocaleFence IndexedDB checks passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
