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
    getBlockPaused: () => blockPaused,
    getBlockQueue: () => blockQueue.map(({ restId, username }) => ({ restId, username })),
    getCachedAccount,
    getAboutQueryId: () => aboutQueryId,
    getLookupBackoffUntil: () => lookupBackoffUntil,
    getLookupRecord: (username) => lookupRecords.get(usernameKey(username)),
    getLookupQuota: () => lookupQuota,
    getNotificationPosition: () => notificationPosition,
    getNotificationSize: () => notificationSize,
    getRuntimeVersion: () => runtimeVersion,
    getSelectedLocations: () => [...selectedLocations],
    applyPostVisibility,
    enqueueBlock,
    fetchCountry,
    isKnownBlocked,
    isCompactLocaleFenceNav,
    isUnavailableAccount,
    pauseBlocking,
    placeLocaleFenceInNav,
    rememberLookupRecord,
    rememberUnavailableAccount,
    removeLookupRecord,
    resetLocaleFenceData,
    resolveLocaleFenceMount,
    resolveCountryAlias,
    scheduleLookupRetry,
    withLookupRequestLock,
    enqueue,
    seedCachedUser: (user) => {
      aboutUsers.set(user.restId, user);
      screenNames.set(user.screenName.toLowerCase(), user.restId);
    },
  };
})();`,
);

const boot = ({
  currentOwner,
  fetchImpl,
  navigatorImpl,
  runtimeDataset,
  storageValues,
  storedBlockEnabled = "true",
  storedBlockedAccounts,
  storedOwner,
}) => {
  const values = storageValues || new Map();
  const defaults = [
    ["localefence.blockEnabled", storedBlockEnabled],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
    ...(storedBlockedAccounts ? [["localefence.blockedAccounts", storedBlockedAccounts]] : []),
    ...(storedOwner ? [["localefence.blockOwnerRestId", storedOwner]] : []),
  ];
  defaults.forEach(([key, value]) => {
    if (!values.has(key)) values.set(key, value);
  });
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
  Object.assign(documentElement.dataset, runtimeDataset || {});
  documentElement.lang = "en";
  const document = {
    body: null,
    cookie: `twid=${encodeURIComponent(`u=${currentOwner}`)}; ct0=test-csrf`,
    createElement: makeNode,
    documentElement,
    head: makeNode(),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    readyState: "complete",
  };
  const context = {
    clearTimeout,
    console,
    document,
    getComputedStyle: () => ({ color: "rgb(15, 20, 25)", display: "block" }),
    location: { origin: "https://x.com" },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    URL,
    URLSearchParams,
  };
  if (navigatorImpl) context.navigator = navigatorImpl;
  if (fetchImpl) context.fetch = fetchImpl;
  context.globalThis = context;
  context.addEventListener = (type, listener) => listeners.set(type, listener);
  vm.runInNewContext(instrumentedSource, context);
  return {
    blockEnabled: () => context.__localefenceTest.getBlockEnabled(),
    hooks: context.__localefenceTest,
    runtime: () => documentElement.dataset.localefenceRuntime,
    stored: (key) => values.get(key) ?? null,
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

const testImmediateNormalLookups = async () => {
  const requestTimes = [];
  const resetAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const fetchImpl = async (url) => {
    if (!url.includes("AboutAccountQuery")) throw new Error(`Unexpected request: ${url}`);
    requestTimes.push(Date.now());
    const variables = JSON.parse(new URL(url).searchParams.get("variables"));
    return {
      headers: {
        get(name) {
          if (name === "x-rate-limit-remaining") return "99";
          if (name === "x-rate-limit-reset") return String(resetAt);
          return null;
        },
      },
      json: () => Promise.resolve({
        data: {
          user_result_by_screen_name: {
            result: {
              rest_id: variables.screenName === "Alice" ? "2" : "3",
              core: { name: variables.screenName, screen_name: variables.screenName },
              about_profile: { account_based_in: "France" },
            },
          },
        },
      }),
      ok: true,
      status: 200,
    };
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedBlockEnabled: "false" });
  const makeContainer = () => ({
    appendChild() {},
    querySelector() { return null; },
  });
  const makeTweet = () => ({
    closest() { return null; },
    isConnected: true,
    querySelector() { return null; },
  });
  app.hooks.enqueue("Alice", makeContainer(), makeTweet());
  app.hooks.enqueue("Bob", makeContainer(), makeTweet());
  await waitFor(() => requestTimes.length === 2);
  assert.ok(
    requestTimes[1] - requestTimes[0] < 250,
    "positive remaining quota must not introduce an artificial per-account delay",
  );
};

const testAndroidMountRecovery = () => {
  const app = boot({
    currentOwner: "1",
    runtimeDataset: { localefenceRuntime: "1.2.1" },
    storedBlockEnabled: "false",
  });
  assert.equal(app.runtime(), "1.2.4", "a stale mobile-tab marker must not prevent reinjection");
  assert.equal(app.hooks.getRuntimeVersion(), "1.2.4");
  const body = {};
  assert.equal(
    app.hooks.resolveLocaleFenceMount({
      allowStandalone: false,
      androidBrowser: true,
      body,
      compactViewport: false,
      nav: null,
    }).mount,
    body,
    "Android must mount without waiting for X's navigation DOM",
  );
  assert.equal(
    app.hooks.resolveLocaleFenceMount({
      allowStandalone: false,
      androidBrowser: false,
      body,
      compactViewport: false,
      nav: null,
    }).mount,
    null,
  );
  assert.equal(
    app.hooks.resolveLocaleFenceMount({
      allowStandalone: true,
      androidBrowser: false,
      body,
      compactViewport: false,
      nav: null,
    }).mount,
    body,
    "the mount watchdog must recover even when Firefox requests the desktop site",
  );
  const nav = {};
  const compactMount = app.hooks.resolveLocaleFenceMount({
    allowStandalone: true,
    androidBrowser: true,
    body,
    compactViewport: true,
    nav,
  });
  assert.equal(compactMount.mount, nav, "X's navigation must win over the floating fallback on Android");
  assert.equal(compactMount.mountNav, nav);
  assert.equal(
    app.hooks.isCompactLocaleFenceNav({ getBoundingClientRect: () => ({ width: 88 }) }),
    true,
    "X's measured compact navigation must hide LocaleFence's text label",
  );
  assert.equal(
    app.hooks.isCompactLocaleFenceNav({ getBoundingClientRect: () => ({ width: 240 }) }),
    false,
    "X's measured wide navigation must retain LocaleFence's text label",
  );
  const insertionPoint = {};
  const floatingRoot = { dataset: { localefenceStandalone: "true" }, parentNode: body };
  const mountedNav = {
    getBoundingClientRect: () => ({ width: 88 }),
    lastElementChild: insertionPoint,
    insertBefore(node, reference) {
      assert.equal(reference, insertionPoint);
      node.parentNode = this;
    },
  };
  app.hooks.placeLocaleFenceInNav(floatingRoot, mountedNav);
  assert.equal(floatingRoot.parentNode, mountedNav, "a mounted fallback must move into X's late navigation");
  assert.equal(floatingRoot.dataset.localefenceStandalone, "false");
  assert.equal(floatingRoot.dataset.localefenceCompact, "true");
};

const testNotificationPreferences = () => {
  const defaults = boot({
    currentOwner: "1",
    storedBlockEnabled: "false",
  });
  assert.equal(defaults.hooks.getNotificationSize(), "compact");
  assert.equal(defaults.hooks.getNotificationPosition(), "top-right");
  const selected = boot({
    currentOwner: "1",
    storageValues: new Map([
      ["localefence.notificationSize", "standard"],
      ["localefence.notificationPosition", "bottom-right"],
    ]),
    storedBlockEnabled: "false",
  });
  assert.equal(selected.hooks.getNotificationSize(), "standard");
  assert.equal(selected.hooks.getNotificationPosition(), "bottom-right");
  const invalid = boot({
    currentOwner: "1",
    storageValues: new Map([
      ["localefence.notificationSize", "huge"],
      ["localefence.notificationPosition", "center"],
    ]),
    storedBlockEnabled: "false",
  });
  assert.equal(invalid.hooks.getNotificationSize(), "compact");
  assert.equal(invalid.hooks.getNotificationPosition(), "top-right");
};

const testUiInteractionStyles = () => {
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    assert.ok(
      source.includes(`<option value="${position}">`),
      `the notification position setting must include ${position}`,
    );
  }
  assert.match(
    source,
    /\[data-localefence-trigger\]::before\s*\{[\s\S]*?background: currentColor;[\s\S]*?transition: opacity 0\.2s ease;/,
    "the sidebar trigger must use an animated hover layer that is independent of its fallback background",
  );
  assert.match(
    source,
    /\[data-localefence-trigger\]:hover::before,[\s\S]*?opacity: 0\.1;/,
    "the sidebar trigger hover layer must activate before the menu has been opened",
  );
  assert.match(
    source,
    /\[data-localefence-tabs\] button:hover,[\s\S]*?background: var\(--lf-hover\);/,
    "menu tabs must expose hover feedback",
  );
  assert.match(
    source,
    /\[data-localefence-trigger\] > svg\s*\{[\s\S]*?transform: scale\(1\.25\);/,
    "the LocaleFence glyph must fill the same visual box as X's native navigation icons",
  );
  assert.match(
    source,
    /\[data-localefence-label\]\s*\{[\s\S]*?margin-right: 16px;/,
    "the navigation label must retain X's native trailing space inside the hover pill",
  );
  assert.match(
    source,
    /--lf-toast-top-right-offset: 72px;[\s\S]*?\[data-localefence-toasts\]\[data-position="top-right"\][\s\S]*?top: var\(--lf-toast-top-right-offset\);/,
    "desktop top-right notifications must clear X's search bar",
  );
};

const testSharedLookupCacheAvoidsCrossTabRequest = async () => {
  const sharedStorage = new Map();
  let requests = 0;
  const firstTab = boot({
    currentOwner: "1",
    fetchImpl: async () => {
      requests += 1;
      return {
        headers: { get: () => null },
        json: () => Promise.resolve({
          data: {
            user_result_by_screen_name: {
              result: {
                rest_id: "2",
                core: { name: "Alice", screen_name: "Alice" },
                about_profile: { account_based_in: "France" },
              },
            },
          },
        }),
        ok: true,
        status: 200,
      };
    },
    storageValues: sharedStorage,
    storedBlockEnabled: "false",
  });
  assert.equal((await firstTab.hooks.fetchCountry("Alice")).found, true);
  assert.equal(requests, 1);

  const secondTab = boot({
    currentOwner: "1",
    fetchImpl: async () => {
      requests += 1;
      throw new Error("the second tab must reuse the shared lookup");
    },
    storageValues: sharedStorage,
    storedBlockEnabled: "false",
  });
  assert.equal(secondTab.hooks.getCachedAccount("Alice").country, "France");
  secondTab.hooks.enqueue(
    "Alice",
    { appendChild() {}, querySelector() { return null; } },
    { closest() { return null; }, isConnected: true, querySelector() { return null; } },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 1, "a cached result from another tab must not consume another X lookup");
};

const testUnavailableAccountCacheAvoidsRepeatedRequest = async () => {
  const sharedStorage = new Map();
  const firstTab = boot({ currentOwner: "1", storageValues: sharedStorage, storedBlockEnabled: "false" });
  firstTab.hooks.rememberUnavailableAccount("MissingUser", "User not found");
  let requests = 0;
  const secondTab = boot({
    currentOwner: "1",
    fetchImpl: async () => {
      requests += 1;
      throw new Error("a recently unavailable account must not be requested again");
    },
    storageValues: sharedStorage,
    storedBlockEnabled: "false",
  });
  assert.equal(secondTab.hooks.isUnavailableAccount("MissingUser"), true);
  secondTab.hooks.enqueue(
    "MissingUser",
    { appendChild() {}, querySelector() { return null; } },
    { closest() { return null; }, isConnected: true, querySelector() { return null; } },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, 0);
  assert.equal(secondTab.hooks.getLookupRecord("MissingUser"), undefined);
};

const testFreshIdentityAndDurableDeduplication = async () => {
  let aboutRequests = 0;
  const aboutRequestMethods = [];
  const blockedRestIds = [];
  const fetchImpl = (url, options) => {
    if (url.includes("AboutAccountQuery")) {
      aboutRequests += 1;
      aboutRequestMethods.push(options.method);
      assert.match(url, /\/graphql\/zs_jFPFT78rBpXv9Z3U2YQ\/AboutAccountQuery/);
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
  assert.deepEqual(aboutRequestMethods, ["POST"]);
  assert.deepEqual(blockedRestIds, ["2"], "a confirmed block must not be repeated after it is remembered");
};

const testQueryIdRecovery = async () => {
  const oldQueryId = "OldAboutQueryId123456";
  const storageValues = new Map([
    ["localefence.aboutQueryId", oldQueryId],
    ["localefence.blockEnabled", "false"],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
  ]);
  const requestedUrls = [];
  const requestedMethods = [];
  const fetchImpl = async (url, options) => {
    requestedUrls.push(url);
    requestedMethods.push(options.method);
    if (url.includes(`/graphql/${oldQueryId}/`)) {
      return { headers: { get: () => null }, ok: false, status: 404 };
    }
    return {
      json: () => Promise.resolve({
        data: {
          user_result_by_screen_name: {
            result: {
              rest_id: "2",
              core: { name: "Alice", screen_name: "Alice" },
              about_profile: { account_based_in: "Italy" },
            },
          },
        },
      }),
      ok: true,
      status: 200,
    };
  };
  const app = boot({ currentOwner: "1", fetchImpl, storageValues, storedBlockEnabled: "false" });
  const result = await app.hooks.fetchCountry("Alice");
  assert.equal(result.found, true);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], new RegExp(`/graphql/${oldQueryId}/`));
  assert.match(requestedUrls[1], /\/graphql\/zs_jFPFT78rBpXv9Z3U2YQ\//);
  assert.deepEqual(requestedMethods, ["POST", "POST"]);
  assert.equal(app.hooks.getAboutQueryId(), "zs_jFPFT78rBpXv9Z3U2YQ");
  assert.equal(app.stored("localefence.aboutQueryId"), "zs_jFPFT78rBpXv9Z3U2YQ");
};

const testPostTransportFallback = async () => {
  const requestedMethods = [];
  const fetchImpl = async (_url, options) => {
    requestedMethods.push(options.method);
    if (options.method === "POST") {
      return { headers: { get: () => null }, ok: false, status: 405 };
    }
    return {
      headers: { get: () => null },
      json: () => Promise.resolve({
        data: {
          user_result_by_screen_name: {
            result: {
              rest_id: "2",
              core: { name: "Alice", screen_name: "Alice" },
              about_profile: { account_based_in: "Italy" },
            },
          },
        },
      }),
      ok: true,
      status: 200,
    };
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedBlockEnabled: "false" });
  assert.equal((await app.hooks.fetchCountry("Alice")).found, true);
  assert.deepEqual(requestedMethods, ["POST", "GET"]);
};

const testTerminalLookupFailuresDoNotRetry = async () => {
  let httpRequests = 0;
  const oldQueryId = "OldAboutQueryId123456";
  const storageValues = new Map([["localefence.aboutQueryId", oldQueryId]]);
  const httpFailureApp = boot({
    currentOwner: "1",
    fetchImpl: async () => {
      httpRequests += 1;
      return { headers: { get: () => null }, ok: false, status: 404 };
    },
    storageValues,
    storedBlockEnabled: "false",
  });
  const httpFailure = await httpFailureApp.hooks.fetchCountry("MissingUser");
  assert.equal(httpFailure.retryable, false);
  assert.equal(httpRequests, 2, "query-ID recovery may retry once, never six times per profile");

  let graphQlRequests = 0;
  const graphQlFailureApp = boot({
    currentOwner: "1",
    fetchImpl: async () => {
      graphQlRequests += 1;
      return {
        headers: { get: () => null },
        json: () => Promise.resolve({ errors: [{ message: "User not found" }] }),
        ok: true,
        status: 200,
      };
    },
    storedBlockEnabled: "false",
  });
  const graphQlFailure = await graphQlFailureApp.hooks.fetchCountry("MissingUser");
  assert.equal(graphQlFailure.retryable, false);
  assert.equal(graphQlFailure.unavailable, true);
  assert.equal(graphQlRequests, 1);
};

const testRateLimitBackoffPersistence = async () => {
  const storageValues = new Map();
  const resetAt = Math.floor(Date.now() / 1000) + 120;
  const fetchImpl = async () => ({
    headers: {
      get(name) {
        if (name === "x-rate-limit-limit") return "100";
        if (name === "x-rate-limit-remaining") return "0";
        if (name === "x-rate-limit-reset") return String(resetAt);
        return null;
      },
    },
    ok: false,
    status: 429,
  });
  const app = boot({ currentOwner: "1", fetchImpl, storageValues, storedBlockEnabled: "false" });
  const result = await app.hooks.fetchCountry("Alice");
  assert.equal(result.status, 429);
  assert.equal(result.retryable, true);
  assert.ok(result.retryAfterMs > 115000 && result.retryAfterMs <= 121000);
  assert.equal(app.hooks.getLookupQuota().remaining, 0);
  assert.equal(app.hooks.getLookupQuota().limit, 100);
  assert.ok(app.hooks.getLookupQuota().resetAt > Date.now() + 115000);

  app.hooks.rememberLookupRecord("Alice", {
    tweetText: "Rate-limited post",
    tweetUrl: "https://x.com/Alice/status/1",
  });
  assert.equal(app.hooks.scheduleLookupRetry("Alice", result), true);
  assert.equal(app.hooks.getLookupRecord("Alice").status, "rate_limited");
  assert.equal(app.hooks.getLookupRecord("Alice").attempts, 0, "HTTP 429 must not consume an account retry");
  assert.ok(app.hooks.getLookupBackoffUntil() > Date.now() + 115000);
  assert.equal(app.stored("localefence.lookupBackoffUntil"), String(app.hooks.getLookupBackoffUntil()));

  const reloaded = boot({ currentOwner: "1", storageValues, storedBlockEnabled: "false" });
  assert.equal(
    reloaded.hooks.getLookupBackoffUntil(),
    app.hooks.getLookupBackoffUntil(),
    "the shared X quota pause must survive reloads",
  );
};

const testHeaderlessRateLimitUsesFallbackEstimate = async () => {
  const storageValues = new Map();
  const app = boot({
    currentOwner: "1",
    fetchImpl: async () => ({ headers: { get: () => null }, ok: false, status: 429 }),
    storageValues,
    storedBlockEnabled: "false",
  });
  const result = await app.hooks.fetchCountry("Alice");
  assert.equal(result.retryAfterMs, 0, "missing X timing headers must remain distinguishable");
  app.hooks.rememberLookupRecord("Alice", {});
  const before = Date.now();
  assert.equal(app.hooks.scheduleLookupRetry("Alice", result), true);
  const fallbackDelay = app.hooks.getLookupBackoffUntil() - before;
  assert.ok(
    fallbackDelay >= 14900 && fallbackDelay <= 15100,
    "a headerless HTTP 429 must use the conservative 15-second estimate",
  );
  const secondBefore = Date.now();
  assert.equal(app.hooks.scheduleLookupRetry("Alice", result), true);
  const secondFallbackDelay = app.hooks.getLookupBackoffUntil() - secondBefore;
  assert.ok(
    secondFallbackDelay >= 29900 && secondFallbackDelay <= 30100,
    "repeated headerless limits must back off exponentially instead of polling every 15 seconds",
  );
  const otherTab = boot({ currentOwner: "1", storageValues, storedBlockEnabled: "false" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  otherTab.hooks.rememberLookupRecord("Bob", {});
  const crossTabBefore = Date.now();
  assert.equal(otherTab.hooks.scheduleLookupRetry("Bob", result), true);
  const crossTabDelay = otherTab.hooks.getLookupBackoffUntil() - crossTabBefore;
  assert.ok(
    crossTabDelay >= 59900 && crossTabDelay <= 60100,
    "headerless fallback escalation must persist across X tabs and reloads",
  );
};

const testMultiDayServerBackoffIsHonored = async () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  app.hooks.rememberLookupRecord("Alice", {});
  const before = Date.now();
  assert.equal(app.hooks.scheduleLookupRetry("Alice", {
    retryAfterMs: 2 * 24 * 60 * 60 * 1000,
    status: 429,
  }), true);
  assert.ok(
    app.hooks.getLookupBackoffUntil() - before > 47 * 60 * 60 * 1000,
    "a multi-day reset reported by X must not be shortened to one day",
  );
};

const testNonRateLimitErrorIgnoresQuotaReset = async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const app = boot({
    currentOwner: "1",
    fetchImpl: async () => ({
      headers: {
        get(name) {
          if (name === "x-rate-limit-remaining") return "50";
          if (name === "x-rate-limit-reset") return String(resetAt);
          return null;
        },
      },
      ok: false,
      status: 500,
    }),
    storedBlockEnabled: "false",
  });
  const result = await app.hooks.fetchCountry("Alice");
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, 0, "a generic server error must not wait for the quota window");
  assert.ok(result.rateLimitResetAfterMs > 14 * 60 * 1000);
};

const makeQueuedTweet = () => ({
  closest() { return null; },
  isConnected: true,
  querySelector() { return null; },
});

const queueVerifiedBlock = (app, user) => {
  app.hooks.seedCachedUser(user);
  app.hooks.rememberLookupRecord(user.screenName, {
    tweetText: `Post by ${user.screenName}`,
    tweetUrl: `https://x.com/${user.screenName}/status/1`,
  });
  return app.hooks.enqueueBlock(user.screenName, user.country, makeQueuedTweet(), {
    tweetText: `Post by ${user.screenName}`,
    tweetUrl: `https://x.com/${user.screenName}/status/1`,
    verifiedUser: user,
  });
};

const testImmediateNormalBlocks = async () => {
  const requestTimes = [];
  const fetchImpl = async (url, options) => {
    if (!url.includes("blocks/create.json")) throw new Error(`Unexpected request: ${url}`);
    requestTimes.push(Date.now());
    const restId = new URLSearchParams(options.body).get("user_id");
    return { json: () => Promise.resolve({ id_str: restId }), ok: true, status: 200 };
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedOwner: "1" });
  queueVerifiedBlock(app, {
    restId: "2",
    screenName: "Bob",
    name: "Bob",
    country: "Italy",
    updatedAt: Date.now(),
  });
  queueVerifiedBlock(app, {
    restId: "3",
    screenName: "Alice",
    name: "Alice",
    country: "Italy",
    updatedAt: Date.now(),
  });
  await waitFor(() => requestTimes.length === 2);
  assert.ok(
    requestTimes[1] - requestTimes[0] < 250,
    "normal block requests must proceed without a fixed cooldown",
  );
};

const testQueuedBlockCancellation = async () => {
  const blockedRestIds = [];
  let finishFirstBlock;
  const fetchImpl = (url, options) => {
    if (!url.includes("blocks/create.json")) throw new Error(`Unexpected request: ${url}`);
    const restId = new URLSearchParams(options.body).get("user_id");
    blockedRestIds.push(restId);
    if (restId === "2") {
      return new Promise((resolve) => {
        finishFirstBlock = () => resolve({
          json: () => Promise.resolve({ id_str: restId }),
          ok: true,
          status: 200,
        });
      });
    }
    return Promise.resolve({ json: () => Promise.resolve({ id_str: restId }), ok: true, status: 200 });
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedOwner: "1" });
  queueVerifiedBlock(app, {
    restId: "2",
    screenName: "Bob",
    name: "Bob",
    country: "Italy",
    updatedAt: Date.now(),
  });
  await waitFor(() => blockedRestIds.length === 1);
  queueVerifiedBlock(app, {
    restId: "3",
    screenName: "Alice",
    name: "Alice",
    country: "Italy",
    updatedAt: Date.now(),
  });
  assert.equal(JSON.stringify(app.hooks.getBlockQueue()), JSON.stringify([{ restId: "3", username: "Alice" }]));
  await app.hooks.removeLookupRecord("Alice");
  assert.equal(app.hooks.getBlockQueue().length, 0, "removing a lookup must cancel its pending block");
  finishFirstBlock();
  await waitFor(() => app.hooks.getLookupRecord("Bob") == null);
  assert.deepEqual(blockedRestIds, ["2"], "a removed queued account must never be blocked");
};

const makeLockManager = () => {
  const tails = new Map();
  return {
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const result = previous.catch(() => {}).then(callback);
      tails.set(name, result.catch(() => {}));
      return result;
    },
  };
};

const testFirefoxForeignLockPromise = async () => {
  let callbackCount = 0;
  const locks = {
    request(name, callback) {
      assert.equal(name, "localefence:location-request");
      void Promise.resolve().then(callback);
      return Object.defineProperty({}, "then", {
        get() {
          throw new Error('Permission denied to access property "then"');
        },
      });
    },
  };
  const app = boot({
    currentOwner: "1",
    navigatorImpl: { locks },
    storedBlockEnabled: "false",
  });
  const result = await app.hooks.withLookupRequestLock(async () => {
    callbackCount += 1;
    return "completed";
  });
  assert.equal(result, "completed");
  assert.equal(callbackCount, 1);
};

const testConcurrentTabDeduplication = async () => {
  const sharedStorage = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
  ]);
  const locks = makeLockManager();
  const blockedRestIds = [];
  const fetchImpl = async (url, options) => {
    if (!url.includes("blocks/create.json")) throw new Error(`Unexpected request: ${url}`);
    const restId = new URLSearchParams(options.body).get("user_id");
    blockedRestIds.push(restId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { json: () => Promise.resolve({ id_str: restId }), ok: true, status: 200 };
  };
  const firstTab = boot({
    currentOwner: "1",
    fetchImpl,
    navigatorImpl: { locks },
    storageValues: sharedStorage,
    storedOwner: "1",
  });
  const secondTab = boot({
    currentOwner: "1",
    fetchImpl,
    navigatorImpl: { locks },
    storageValues: sharedStorage,
    storedOwner: "1",
  });
  const user = {
    restId: "2",
    screenName: "Alice",
    name: "Alice",
    country: "Italy",
    updatedAt: Date.now(),
  };
  queueVerifiedBlock(firstTab, user);
  queueVerifiedBlock(secondTab, user);
  await waitFor(() =>
    firstTab.hooks.getLookupRecord("Alice") == null && secondTab.hooks.getLookupRecord("Alice") == null,
  );
  assert.deepEqual(blockedRestIds, ["2"], "two X tabs must serialize and deduplicate the same block");
};

const testPausedStateAndOwnedVisibility = async () => {
  const sharedStorage = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
  ]);
  const firstLoad = boot({ currentOwner: "1", storageValues: sharedStorage, storedOwner: "1" });
  firstLoad.hooks.pauseBlocking("Paused for a test");
  assert.equal(firstLoad.stored("localefence.blockPaused"), "true");
  const reloaded = boot({ currentOwner: "1", storageValues: sharedStorage, storedOwner: "1" });
  assert.equal(reloaded.hooks.getBlockPaused(), true, "a safety pause must survive reloads");

  const feedCell = { dataset: {}, style: {} };
  const tweet = { closest: () => feedCell };
  reloaded.hooks.applyPostVisibility(tweet, "Italy");
  assert.equal(feedCell.dataset.localefenceHidden, "true");
  assert.equal(feedCell.style.display, undefined, "LocaleFence must not overwrite X's inline display style");
  reloaded.hooks.applyPostVisibility(tweet, "France");
  assert.equal(feedCell.dataset.localefenceHidden, undefined);
};

const testCompleteReset = async () => {
  const values = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"],
    ["localefence.futureSetting", "remove me too"],
    ["unrelated.setting", "keep me"],
  ]);
  const app = boot({ currentOwner: "1", storageValues: values, storedOwner: "1" });
  await app.hooks.resetLocaleFenceData();
  assert.equal(app.blockEnabled(), false);
  assert.equal(app.hooks.getSelectedLocations().length, 0);
  assert.equal([...values.keys()].some((key) => key.startsWith("localefence.")), false);
  assert.equal(values.get("unrelated.setting"), "keep me");
};

const run = async () => {
  testAndroidMountRecovery();
  testNotificationPreferences();
  testUiInteractionStyles();
  await testSharedLookupCacheAvoidsCrossTabRequest();
  await testUnavailableAccountCacheAvoidsRepeatedRequest();
  await testQueryIdRecovery();
  await testPostTransportFallback();
  await testTerminalLookupFailuresDoNotRetry();
  await testRateLimitBackoffPersistence();
  await testHeaderlessRateLimitUsesFallbackEstimate();
  await testMultiDayServerBackoffIsHonored();
  await testNonRateLimitErrorIgnoresQuotaReset();
  await testImmediateNormalLookups();
  await testFreshIdentityAndDurableDeduplication();
  await testImmediateNormalBlocks();
  await testQueuedBlockCancellation();
  await testFirefoxForeignLockPromise();
  await testConcurrentTabDeduplication();
  await testPausedStateAndOwnedVisibility();
  await testCompleteReset();
};

run()
  .then(() => console.log("LocaleFence safety and lifecycle checks passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
