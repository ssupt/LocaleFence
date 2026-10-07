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

const run = async () => {
  await testHydrationPreservesAnotherTabsQueueWrite();
  await testHydrationPreservesAnotherTabsCacheWrite();
  await testHydrationPrunesAndRecoversInterruptedChecks();
  await testResetInvalidatesLatePersistentLookup();
  await testResetDuringHydrationClearsPersistentData();
};
run().then(() => console.log("LocaleFence IndexedDB checks passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
