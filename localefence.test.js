"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "localefence.user.js"), "utf8");
const instrumentedSource = source.replace(
  /\n\}\)\(\);\s*$/,
  `
  globalThis.__localefenceTest = {
    getBlockEnabled: () => blockEnabled,
    getSelectedLocations: () => [...selectedLocations],
    isKnownBlocked,
    resolveCountryAlias,
    enqueue,
    seedCachedUser: (user) => {
      aboutUsers.set(user.restId, user);
      screenNames.set(user.screenName.toLowerCase(), user.restId);
    },
  };
})();`,
);

const boot = ({ currentOwner, fetchImpl, storedBlockEnabled = "true", storedBlockedAccounts, storedOwner }) => {
  const values = new Map([
    ["localefence.blockEnabled", storedBlockEnabled],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
    ...(storedBlockedAccounts ? [["localefence.blockedAccounts", storedBlockedAccounts]] : []),
    ...(storedOwner ? [["localefence.blockOwnerRestId", storedOwner]] : []),
  ]);
  const listeners = new Map();
  const makeNode = () => ({
    append() {},
    appendChild() {},
    closest() { return null; },
    dataset: {},
    isConnected: true,
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    remove() {},
    setAttribute() {},
    style: {},
  });
  const documentElement = makeNode();
  documentElement.lang = "en";
  const document = {
    body: null,
    cookie: `twid=${encodeURIComponent(`u=${currentOwner}`)}; ct0=test-csrf`,
    createElement: makeNode,
    documentElement,
    head: makeNode(),
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const context = {
    clearTimeout,
    console,
    document,
    getComputedStyle: () => ({ color: "rgb(15, 20, 25)", display: "block" }),
    location: { origin: "https://x.com" },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    URL,
    URLSearchParams,
  };
  if (fetchImpl) context.fetch = fetchImpl;
  context.globalThis = context;
  context.addEventListener = (type, listener) => listeners.set(type, listener);
  vm.runInNewContext(instrumentedSource, context);
  return {
    blockEnabled: () => context.__localefenceTest.getBlockEnabled(),
    hooks: context.__localefenceTest,
    storage: (key, newValue) => {
      if (newValue == null) values.delete(key);
      else values.set(key, String(newValue));
      listeners.get("storage")({ key, newValue });
    },
  };
};

assert.equal(boot({ currentOwner: "2", storedOwner: "1" }).blockEnabled(), false);
assert.equal(boot({ currentOwner: "1" }).blockEnabled(), false);

const matchingOwner = boot({ currentOwner: "1", storedOwner: "1" });
assert.equal(matchingOwner.blockEnabled(), true);
matchingOwner.storage("localefence.blockEnabled", "false");
assert.equal(matchingOwner.blockEnabled(), false);

const changedOwner = boot({ currentOwner: "1", storedOwner: "1" });
changedOwner.storage("localefence.blockOwnerRestId", "2");
assert.equal(changedOwner.blockEnabled(), false);

const enabledElsewhere = boot({ currentOwner: "1", storedBlockEnabled: "false", storedOwner: "1" });
enabledElsewhere.storage("localefence.blockEnabled", "true");
assert.equal(enabledElsewhere.blockEnabled(), true);
assert.equal(enabledElsewhere.hooks.resolveCountryAlias("Cabo Verde"), "Cape Verde");
assert.equal(enabledElsewhere.hooks.resolveCountryAlias("Eswatini"), "Swaziland");
assert.equal(enabledElsewhere.hooks.resolveCountryAlias("North Macedonia"), "Macedonia");

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for LocaleFence's asynchronous queue");
};

const testFreshIdentityAndDurableDeduplication = async () => {
  let aboutRequests = 0;
  const blockedRestIds = [];
  const fetchImpl = (url, options) => {
    if (url.includes("AboutAccountQuery")) {
      aboutRequests += 1;
      return Promise.resolve({
        headers: { get: () => null },
        json: () => Promise.resolve({
          data: {
            user_result_by_screen_name: {
              result: {
                rest_id: "2",
                core: { name: "New Alice", screen_name: "Alice" },
                about_profile: { account_based_in: "Italy" },
              },
            },
          },
        }),
        ok: true,
        status: 200,
      });
    }
    if (url.includes("blocks/create.json")) {
      blockedRestIds.push(new URLSearchParams(options.body).get("user_id"));
      return Promise.resolve({ ok: true, status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const app = boot({
    currentOwner: "1",
    fetchImpl,
    storedBlockEnabled: "false",
    storedOwner: "1",
  });
  app.hooks.seedCachedUser({
    restId: "99",
    screenName: "Alice",
    name: "Former Alice",
    country: "Italy",
    updatedAt: Date.now(),
  });
  app.storage("localefence.blockEnabled", "true");

  const makeTweet = () => ({
    closest() { return null; },
    isConnected: true,
    querySelector(selector) {
      if (selector === '[data-testid="tweetText"]') return { textContent: "A post" };
      return null;
    },
    style: {},
  });
  const makeContainer = () => {
    let badge = null;
    return {
      appendChild(node) {
        badge = node;
        node.parentElement = this;
      },
      querySelector(selector) {
        return selector === "[data-account-based-in]" ? badge : null;
      },
    };
  };

  app.hooks.enqueue("Alice", makeContainer(), makeTweet());
  await waitFor(() => blockedRestIds.length === 1);
  assert.deepEqual(blockedRestIds, ["2"], "the fresh account ID must be blocked, never the cached ID");
  assert.equal(app.hooks.isKnownBlocked("1", "2"), true);

  const reloadedApp = boot({
    currentOwner: "1",
    fetchImpl,
    storedBlockedAccounts: "1:2",
    storedOwner: "1",
  });
  reloadedApp.hooks.seedCachedUser({
    restId: "2",
    screenName: "Alice",
    name: "New Alice",
    country: "Italy",
    updatedAt: Date.now(),
  });
  reloadedApp.hooks.enqueue("Alice", makeContainer(), makeTweet());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(aboutRequests, 1, "a remembered block should not trigger another identity lookup");
  assert.deepEqual(blockedRestIds, ["2"], "a confirmed block must not be repeated after it is remembered");
};

testFreshIdentityAndDurableDeduplication()
  .then(() => console.log("LocaleFence account-safety checks passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
