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
    getBlockHistory: () => blockHistory.map((entry) => ({ ...entry })),
    getBlockPaused: () => blockPaused,
    getBlockQueue: () => blockQueue.map(({ restId, username }) => ({ restId, username })),
    getHydrationReady: () => hydrationReady,
    getTotalBlockedCount: () => totalBlockedCount,
    getCachedAccount,
    getLocationStats,
    getLocationCount,
    getSelectedAccountCount,
    getMatchStoreRegion: () => matchStoreRegion,
    getAboutQueryId: () => aboutQueryId,
    extractAboutQueryId,
    rememberAboutQueryId,
    extractSourceCountry,
    matchAccountLocation,
    getLookupBackoffUntil: () => lookupBackoffUntil,
    getLookupRecord: (username) => lookupRecords.get(usernameKey(username)),
    getLookupQuota: () => lookupQuota,
    getNotificationPosition: () => notificationPosition,
    getNotificationSize: () => notificationSize,
    getRuntimeVersion: () => runtimeVersion,
    getSelectedLocations: () => [...selectedLocations],
    applyCountry,
    applyPostVisibility,
    buildLocaleFenceDrawerEntry,
    clearBlockHistory,
    clearCacheStores,
    clearLookupRecords,
    findLocaleFenceDrawerAnchor,
    findTweets,
    markFeedAccount,
    rowForLocaleFenceDrawerAnchor,
    enqueueBlock,
    fetchCountry,
    sendBlockRequest,
    isKnownBlocked,
    isCompactLocaleFenceNav,
    isHorizontalLocaleFenceNav,
    isMobileLocaleFenceViewport,
    isVerticalSidebarLocaleFenceNav,
    shouldUseDrawerLocaleFence,
    isUnavailableAccount,
    pauseBlocking,
    placeLocaleFenceInNav,
    rememberLookupRecord,
    rememberUnavailableAccount,
    removeLookupRecord,
    resetLocaleFenceData,
    retryLookupRecord,
    resolveLocaleFenceMount,
    resolveCountryAlias,
    scheduleLookupRetry,
    withLookupRequestLock,
    enqueue,
    seedCachedUser: (user) => {
      aboutUsers.set(user.restId, { locationWarning: false, ...user });
      screenNames.set(user.screenName.toLowerCase(), user.restId);
    },
  };
})();`,
);

const boot = ({
  currentOwner,
  feedTweets = [],
  fetchImpl,
  indexedDBImpl,
  navigatorImpl,
  runtimeDataset,
  storageBus,
  storageDelivery = (callback) => callback(),
  storageValues,
  storedBlockEnabled = "true",
  storedBlockedAccounts,
  storedOwner,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  visibilityState = "visible",
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
  const mutationObservers = [];
  const storageListener = (event) => listeners.get("storage")?.(event);
  if (storageBus) storageBus.push(storageListener);
  const publishStorage = (key, oldValue, newValue) => {
    if (oldValue === newValue) return;
    storageBus?.forEach((listener) => {
      if (listener !== storageListener) storageDelivery(() => listener({ key, oldValue, newValue }));
    });
  };
  const makeNode = () => ({
    append() {},
    appendChild(child) { this.children.push(child); return child; },
    children: [],
    attributes: {},
    closest() { return null; },
    dataset: {},
    isConnected: true,
    matches(selector) {
      if (selector === "[data-account-based-in]") return "accountBasedIn" in this.dataset;
      if (selector === "[data-account-state]") return "accountState" in this.dataset;
      return false;
    },
    querySelector(selector) {
      if (selector === "[data-account-state]") {
        return this.children.find((child) => child?.dataset?.accountState) || null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    remove() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    set textContent(value) { this.children = []; this.text = value; },
    get textContent() { return this.text || ""; },
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
    nodeType: 9,
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-testid="tweet"]') return feedTweets;
      if (selector === "[data-account-based-in]" || selector === "[data-account-username]") {
        return feedTweets.map((tweet) => tweet.querySelector("[data-account-based-in]")).filter(Boolean);
      }
      if (selector === "[data-localefence-hidden]") {
        return feedTweets
          .map((tweet) => tweet.closest?.('[data-testid="cellInnerDiv"]'))
          .filter((cell) => cell?.dataset?.localefenceHidden);
      }
      return [];
    },
    readyState: "complete",
    visibilityState,
  };
  const context = {
    AbortController,
    clearTimeout: clearTimeoutImpl,
    console,
    document,
    getComputedStyle: () => ({ color: "rgb(15, 20, 25)", display: "block" }),
    location: { origin: "https://x.com" },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
      removeItem: (key) => {
        const oldValue = values.get(key) ?? null;
        values.delete(key);
        publishStorage(key, oldValue, null);
      },
      setItem: (key, value) => {
        const oldValue = values.get(key) ?? null;
        const newValue = String(value);
        values.set(key, newValue);
        publishStorage(key, oldValue, newValue);
      },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) {
        this.target = target;
        this.options = options;
        mutationObservers.push(this);
      }
    },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: setTimeoutImpl,
    URL,
    URLSearchParams,
  };
  if (navigatorImpl) context.navigator = navigatorImpl;
  if (indexedDBImpl) context.indexedDB = indexedDBImpl;
  if (fetchImpl) context.fetch = fetchImpl;
  context.globalThis = context;
  context.addEventListener = (type, listener) => listeners.set(type, listener);
  vm.runInNewContext(instrumentedSource, context);
  return {
    blockEnabled: () => context.__localefenceTest.getBlockEnabled(),
    hooks: context.__localefenceTest,
    runtime: () => documentElement.dataset.localefenceRuntime,
    setOwner: (restId) => {
      document.cookie = `twid=${encodeURIComponent(`u=${restId}`)}; ct0=test-csrf`;
    },
    mutate: (mutations) => {
      mutationObservers.filter((observer) => observer.target === document)
        .forEach((observer) => {
          const observed = mutations.filter((mutation) =>
            mutation.type === "attributes"
              ? observer.options.attributes && observer.options.attributeFilter?.includes(mutation.attributeName)
              : observer.options.childList,
          );
          if (observed.length) observer.callback(observed);
        });
    },
    stored: (key) => values.get(key) ?? null,
    dispatchStorage: (event) => storageListener(event),
    storage: (key, newValue) => {
      if (newValue == null) context.localStorage.removeItem(key);
      else context.localStorage.setItem(key, newValue);
      storageListener({ key, newValue });
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

const makeMutableFeedTarget = (initialAuthor) => {
  let author = initialAuthor;
  let badge = null;
  const cell = { dataset: {} };
  const link = {
    nodeType: 1,
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: (name) => name === "href" ? `/${author}` : null,
    matches: (selector) => selector === "a" || selector === "a[href]",
    closest: (selector) => selector === '[data-testid="User-Name"]' ? container
      : selector === '[data-testid="tweet"]' ? tweet : null,
  };
  const container = {
    closest: (selector) => selector === '[data-testid="User-Name"]' ? container
      : selector === '[data-testid="tweet"]' ? tweet : null,
    appendChild(node) {
      badge = node;
      node.parentElement = container;
      node.closest = (selector) => selector === "[data-account-based-in]" ? node : container.closest(selector);
      node.remove = () => { badge = null; };
    },
    querySelector: (selector) => selector === "[data-account-based-in]" ? badge : null,
    querySelectorAll: (selector) => selector === 'a[href^="/"]' ? [link] : [],
  };
  const tweet = {
    isConnected: true,
    closest: (selector) => selector === '[data-testid="cellInnerDiv"]' ? cell
      : selector === '[data-testid="tweet"]' ? tweet : null,
    querySelector: (selector) => selector === '[data-testid="User-Name"]' ? container
      : selector === "[data-account-based-in]" ? badge : null,
  };
  return { cell, container, getBadge: () => badge, link, setAuthor: (next) => { author = next; }, tweet };
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
  const version = require("./package.json").version;
  assert.equal(app.runtime(), version, "a stale mobile-tab marker must not prevent reinjection");
  assert.equal(app.hooks.getRuntimeVersion(), version);
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
  assert.equal(compactMount.mount, nav, "navigation must host the trigger on every layout, including mobile");
  assert.equal(compactMount.mountNav, nav);
  const desktopMount = app.hooks.resolveLocaleFenceMount({
    allowStandalone: false,
    androidBrowser: true,
    body,
    compactViewport: false,
    nav,
  });
  assert.equal(desktopMount.mount, nav, "desktop navigation must keep hosting the sidebar entry");
  assert.equal(desktopMount.mountNav, nav);
  const bottomTabBar = {
    getBoundingClientRect: () => ({ width: 360, height: 56 }),
    clientWidth: 360,
    clientHeight: 56,
  };
  assert.equal(
    app.hooks.isHorizontalLocaleFenceNav(bottomTabBar),
    true,
    "a short full-width tab bar must be detected as horizontal",
  );
  assert.equal(
    app.hooks.resolveLocaleFenceMount({
      allowStandalone: false,
      androidBrowser: false,
      body,
      compactViewport: false,
      nav: bottomTabBar,
    }).mountNav,
    bottomTabBar,
    "mount resolution still reports the bottom bar so the layout decision can route it to the drawer",
  );
  assert.equal(
    app.hooks.shouldUseDrawerLocaleFence(bottomTabBar),
    true,
    "a horizontal bottom bar must select the side-drawer layout",
  );
  assert.equal(
    app.hooks.shouldUseDrawerLocaleFence({ getBoundingClientRect: () => ({ width: 88, height: 600 }) }),
    false,
    "a vertical sidebar must keep the desktop entry styling",
  );
  assert.equal(
    app.hooks.isVerticalSidebarLocaleFenceNav({ getBoundingClientRect: () => ({ width: 88, height: 600 }) }),
    true,
    "a measured vertical sidebar must pass positive sidebar verification",
  );
  assert.equal(
    app.hooks.isVerticalSidebarLocaleFenceNav({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    false,
    "an unmeasured or display:contents nav must never receive a sidebar button",
  );
  const horizontalLinksNav = {
    getBoundingClientRect: () => ({ width: 180, height: 140 }),
    querySelectorAll: (selector) => selector === "a[href]"
      ? [
          { getBoundingClientRect: () => ({ left: 10, top: 700, width: 48, height: 48 }) },
          { getBoundingClientRect: () => ({ left: 90, top: 700, width: 48, height: 48 }) },
        ]
      : [],
  };
  assert.equal(
    app.hooks.shouldUseDrawerLocaleFence(horizontalLinksNav),
    true,
    "an experimental nav with side-by-side links must route to the drawer even when ratio <= 1.5",
  );
  assert.equal(
    app.hooks.isVerticalSidebarLocaleFenceNav(horizontalLinksNav),
    false,
    "an experimental bottom bar must never mount a sidebar button",
  );
  assert.equal(app.hooks.isMobileLocaleFenceViewport(), false);
  assert.equal(
    app.hooks.isCompactLocaleFenceNav(bottomTabBar),
    true,
    "a bottom tab bar must stay icon-only despite reporting full viewport width",
  );
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
  const legacyRoot = { dataset: { localefenceStandalone: "true" }, parentNode: body };
  const mountedNav = {
    getBoundingClientRect: () => ({ width: 88 }),
    lastElementChild: insertionPoint,
    insertBefore(node, reference) {
      assert.equal(reference, insertionPoint);
      node.parentNode = this;
    },
  };
  app.hooks.placeLocaleFenceInNav(legacyRoot, mountedNav);
  assert.equal(legacyRoot.parentNode, mountedNav, "a legacy fallback node must move into X's sidebar navigation");
  assert.equal(legacyRoot.dataset.localefenceCompact, "true");
};

const makeDrawerAnchor = () => {
  const svgClone = () => ({
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    innerHTML: "<circle/>",
  });
  const rowClone = () => {
    const listeners = {};
    return {
      attributes: { href: "/settings" },
      dataset: {},
      children: [svgClone(), { children: [], textContent: "Settings and privacy" }],
      querySelector(selector) { return selector === "svg" ? this.children[0] : null; },
      querySelectorAll(selector) { return selector === "span" || selector === "span, div" ? [this.children[1]] : []; },
      removeAttribute(key) { delete this.attributes[key]; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      fire(type, event) { (listeners[type] || []).forEach((listener) => listener(event)); },
    };
  };
  const anchor = rowClone();
  anchor.cloneNode = () => rowClone();
  return anchor;
};

const testDrawerEntry = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  const anchor = makeDrawerAnchor();
  const entry = app.hooks.buildLocaleFenceDrawerEntry(anchor);
  assert.equal(entry.dataset.localefenceDrawerEntry, "true", "the drawer row must be marked to avoid duplicates");
  assert.equal(entry.attributes.href, undefined, "the drawer entry must not navigate away");
  assert.equal(entry.attributes["aria-label"], "LocaleFence");
  assert.equal(entry.children[1].textContent, "LocaleFence", "the cloned row must be relabeled");
  assert.ok(
    entry.children[0].innerHTML.includes("M3.75 5.5"),
    "the cloned row must carry the LocaleFence glyph",
  );
  assert.equal(anchor.attributes.href, "/settings", "the original drawer row must keep navigating");
  assert.equal(anchor.children[1].textContent, "Settings and privacy", "the original row label must be untouched");
  assert.doesNotThrow(
    () => entry.fire("click", { preventDefault() {} }),
    "activating the entry without wiring must be a safe no-op",
  );
};

const makeNestedDrawerRow = () => {
  const label = { children: [], textContent: "Settings and privacy" };
  const svg = {
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    innerHTML: "",
  };
  const anchor = {
    children: [label],
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const iconCell = {
    children: [svg],
    parentElement: null,
    querySelector: (selector) => selector === "svg" ? svg : null,
  };
  const row = {
    attributes: {},
    dataset: {},
    children: [iconCell, anchor],
    parentElement: null,
    querySelector: (selector) => {
      if (selector === "svg") return svg;
      if (selector === "span") return label;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === "span, div") return [label];
      return [];
    },
    removeAttribute() {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {},
    after() {},
    cloneNode() {
      const svgClone = {
        attributes: {},
        setAttribute(key, value) { this.attributes[key] = value; },
        innerHTML: "",
      };
      const labelClone = { children: [], textContent: "Settings and privacy" };
      const cloneListeners = {};
      return {
        attributes: {},
        dataset: {},
        children: [],
        refs: { labelClone, svgClone },
        querySelector: (selector) => selector === "svg" ? svgClone : null,
        querySelectorAll: (selector) => {
          if (selector === "span, div") return [labelClone];
          return [];
        },
        removeAttribute() {},
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(type, listener) { (cloneListeners[type] ??= []).push(listener); },
      };
    },
  };
  anchor.parentElement = row;
  iconCell.parentElement = row;
  const sibling = () => ({ children: [{}], querySelector: (selector) => selector === "svg" ? {} : null });
  row.parentElement = { children: [sibling(), sibling(), row, sibling()] };
  return { anchor, label, row, svg };
};

const testDrawerRowResolution = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  const { buildLocaleFenceDrawerEntry, rowForLocaleFenceDrawerAnchor } = app.hooks;
  const { anchor, label, row, svg } = makeNestedDrawerRow();
  assert.equal(
    rowForLocaleFenceDrawerAnchor(anchor),
    row,
    "a nested drawer link must resolve to its full row so the entry is not clipped inside it",
  );
  const entry = buildLocaleFenceDrawerEntry(anchor);
  assert.equal(entry.refs.labelClone.textContent, "LocaleFence", "the cloned row must be relabeled");
  assert.ok(
    entry.refs.svgClone.innerHTML.includes("M3.75 5.5"),
    "the cloned row must carry the LocaleFence glyph",
  );
  assert.equal(label.textContent, "Settings and privacy", "the original row label must be untouched");
  assert.equal(svg.innerHTML, "", "the original row icon must be untouched");
};

const makeDrawerLink = (href, label) => ({
  attributes: { href },
  textContent: label,
  querySelector(selector) { return selector === "svg" ? {} : null; },
  getAttribute(name) { return this.attributes[name]; },
  closest() { return null; },
});

const testFindTweetsSkipsNonElements = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  assert.doesNotThrow(() => {
    app.hooks.findTweets(null);
    app.hooks.findTweets(undefined);
    app.hooks.findTweets({ nodeType: 3, textContent: "some text node" });
    app.hooks.findTweets("a string");
  }, "text and other non-element nodes must be ignored without throwing");
};

const testDrawerAnchorTiers = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  const { findLocaleFenceDrawerAnchor } = app.hooks;
  const settings = makeDrawerLink("/settings", "Settings and privacy");
  assert.equal(
    findLocaleFenceDrawerAnchor({ querySelector: () => settings, querySelectorAll: () => [] }),
    settings,
    "an exact /settings link must win immediately",
  );
  const nested = makeDrawerLink("/settings/account", "Impostazioni");
  assert.equal(
    findLocaleFenceDrawerAnchor({ querySelector: () => null, querySelectorAll: () => [nested] }),
    nested,
    "a nested settings path must match by href substring",
  );
  const logout = makeDrawerLink("/logout", "Esci");
  const ads = makeDrawerLink("/i/ads", "Annunci");
  const scopeWithDrawer = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === "a[href]") return [ads, nested, logout];
      return [];
    },
  };
  assert.equal(
    findLocaleFenceDrawerAnchor(scopeWithDrawer),
    nested,
    "href-substring tiers must precede the logout-scoped fallbacks",
  );
  const nonSettingsScope = {
    querySelector: () => null,
    querySelectorAll: () => [ads, logout],
  };
  logout.closest = () => ({ querySelectorAll: () => [ads, logout] });
  assert.equal(
    findLocaleFenceDrawerAnchor(nonSettingsScope),
    ads,
    "the row above Log out must be used when no settings link exists",
  );
  assert.equal(
    findLocaleFenceDrawerAnchor({ querySelector: () => null, querySelectorAll: () => [] }),
    null,
    "an empty document must yield no anchor",
  );
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
    /<input data-match-store-region type="checkbox" role="switch">/,
    "the Connected via store-region setting must be a labeled switch in the Settings tab",
  );
  assert.ok(
    source.includes("Match Connected via store region"),
    "the store-region switch must say what it matches instead of relying on an unlabeled control",
  );
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
  assert.ok(
    !source.includes('localefenceStandalone = "true"'),
    "no layout may create a floating button: the trigger lives in the sidebar or the drawer",
  );
  assert.ok(
    !source.includes('[data-localefence-standalone="true"]'),
    "no stylesheet rule may target a floating button anymore",
  );
  assert.ok(
    source.includes("wiredOpenMenu"),
    "dialog wiring must be tracked so a removed overlay rebuilds on next open",
  );
  assert.ok(
    source.includes("buildLocaleFenceOverlay"),
    "the overlay must be built lazily on first open, never during boot",
  );
  assert.ok(
    source.includes("bindLocaleFenceTrigger"),
    "sidebar trigger binding must be independent of dialog wiring",
  );
  assert.match(
    source,
    /\[data-localefence-overlay\]\[data-localefence-open="true"\] \[data-localefence-menu\][\s\S]*?display: flex;/,
    "the settings dialog must be driven by the body-level overlay so the nav stacking context cannot trap it",
  );
  assert.ok(
    source.includes("data-localefence-drawer-entry"),
    "mobile layouts must inject a marked entry into X's side drawer",
  );
  assert.ok(
    source.includes("data-localefence-mini"),
    "small screens must render a minimal toast variant",
  );
  assert.ok(
    source.includes("host.replaceChildren()"),
    "a new mobile toast must replace the previous one instead of stacking",
  );
  assert.match(
    source,
    /miniToast \? 1200 :/,
    "mobile toasts must dismiss after about a second",
  );
  assert.match(
    source,
    /\[data-localefence-toast\]\[data-localefence-mini="true"\][\s\S]*?border-radius: 9999px;/,
    "the mobile toast must be a compact pill",
  );
  assert.match(
    source,
    /--lf-toast-top-right-offset: calc\(60px \+ env\(safe-area-inset-top\)\);/,
    "mobile top-right toasts must sit below the app header",
  );
  assert.ok(
    source.includes('a[href="/settings"]'),
    "the drawer entry must anchor on X's locale-independent settings link",
  );
  assert.ok(
    source.includes('aria-label="LocaleFence"'),
    "the icon-only tab trigger must expose an accessible name",
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

const testQueuedLookupDoesNotCrossOwners = async () => {
  const blockedRestIds = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("AboutAccountQuery")) {
      const { screenName } = JSON.parse(new URL(url).searchParams.get("variables"));
      return {
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: screenName === "Alice" ? "9" : "10",
          core: { name: screenName, screen_name: screenName },
          about_profile: { account_based_in: "Italy" },
        } } } }),
      };
    }
    if (url.includes("blocks/create.json")) {
      const restId = new URLSearchParams(options.body).get("user_id");
      blockedRestIds.push(restId);
      return { json: async () => ({ id_str: restId }), ok: true, status: 200 };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedBlockEnabled: "false", storedOwner: "1" });
  app.hooks.rememberLookupRecord("Alice", { tweetText: "Old feed post", tweetUrl: "" });
  assert.equal(app.hooks.getLookupRecord("Alice").ownerRestId, "1");
  app.setOwner("2");
  app.storage("localefence.blockOwnerRestId", "2");
  app.storage("localefence.blockEnabled", "true");
  app.hooks.retryLookupRecord("alice");
  await waitFor(() => app.hooks.getLookupRecord("Alice") == null);
  assert.deepEqual(blockedRestIds, [], "an old owner's queue entry must not block under the new owner");

  app.hooks.rememberLookupRecord("Bob", { tweetText: "New feed post", tweetUrl: "" });
  app.hooks.retryLookupRecord("bob");
  await waitFor(() => blockedRestIds.length === 1);
  assert.deepEqual(blockedRestIds, ["10"], "the new owner's queue entry should still block normally");
};

const testAccountSwitchDuringLookupDisablesBlocking = async () => {
  let finishLookup;
  const blockedRestIds = [];
  const fetchImpl = (url, options) => {
    if (url.includes("AboutAccountQuery")) return new Promise((resolve) => {
      finishLookup = () => resolve({
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
          about_profile: { account_based_in: "Italy" },
        } } } }),
      });
    });
    if (url.includes("blocks/create.json")) {
      blockedRestIds.push(new URLSearchParams(options.body).get("user_id"));
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedOwner: "1" });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => Boolean(finishLookup));
  app.setOwner("2");
  finishLookup();
  await waitFor(() => app.hooks.getLookupRecord("Alice") == null);
  assert.equal(app.blockEnabled(), false);
  assert.deepEqual(blockedRestIds, []);
};

const testChangedTweetDoesNotReceiveOldCountry = async () => {
  const releases = new Map();
  const fetchImpl = (url) => {
    const { screenName } = JSON.parse(new URL(url).searchParams.get("variables"));
    return new Promise((resolve) => {
      releases.set(screenName, () => resolve({
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: screenName === "Alice" ? "2" : "3",
          core: { name: screenName, screen_name: screenName },
          about_profile: { account_based_in: screenName === "Alice" ? "Italy" : "France" },
        } } } }),
      }));
    });
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedBlockEnabled: "false" });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => releases.has("Alice"));
  target.setAuthor("Bob");
  releases.get("Alice")();
  await waitFor(() => releases.has("Bob"));
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
  assert.notEqual(target.getBadge()?.dataset.accountUsername, "Alice");
  releases.get("Bob")();
  await waitFor(() => target.getBadge()?.dataset.accountUsername === "Bob");
  assert.equal(target.getBadge().dataset.accountBasedIn, "France");
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
};

const testAuthorLinkMutationClearsStaleBadge = async () => {
  const app = boot({
    currentOwner: "1",
    fetchImpl: async () => ({
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "3", core: { name: "Bob", screen_name: "Bob" },
        about_profile: { account_based_in: "France" },
      } } } }),
    }),
    storedBlockEnabled: "false",
  });
  app.hooks.seedCachedUser({
    restId: "2", screenName: "Alice", name: "Alice", country: "Italy", updatedAt: Date.now(),
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  target.setAuthor("Bob");
  app.mutate([{ type: "attributes", attributeName: "href", target: target.link, addedNodes: [], removedNodes: [] }]);
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
  assert.notEqual(target.getBadge()?.dataset.accountUsername, "Alice");
  await waitFor(() => target.getBadge()?.dataset.accountUsername === "Bob");
};

const testUnavailableAuthorMutationClearsStaleBadge = async () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  await app.hooks.getHydrationReady();
  app.hooks.seedCachedUser({
    restId: "2", screenName: "Alice", name: "Alice", country: "Italy", updatedAt: Date.now(),
  });
  app.hooks.rememberUnavailableAccount("MissingUser");
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  target.setAuthor("MissingUser");
  app.mutate([{ type: "attributes", attributeName: "href", target: target.link, addedNodes: [], removedNodes: [] }]);
  assert.equal(target.getBadge(), null, "an unavailable author must not inherit the previous author's flag");
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
  assert.equal(app.hooks.getLookupRecord("MissingUser"), undefined);
};

const testAuthorChildMutationClearsStaleBadge = async () => {
  let lookups = 0;
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", fetchImpl: async () => {
    lookups += 1;
    return {
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "3", core: { name: "Bob", screen_name: "Bob" },
        about_profile: { account_based_in: "France" },
      } } } }),
    };
  } });
  await app.hooks.getHydrationReady();
  app.hooks.seedCachedUser({
    restId: "2", screenName: "Alice", name: "Alice", country: "Italy", updatedAt: Date.now(),
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  target.setAuthor("Bob");
  app.mutate([{ type: "childList", target: target.container, addedNodes: [target.link], removedNodes: [] }]);
  assert.equal(target.getBadge(), null);
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
  await waitFor(() => target.getBadge()?.dataset.accountUsername === "Bob");
  assert.equal(target.getBadge().dataset.accountBasedIn, "France");
  assert.equal(lookups, 1);

  // LocaleFence's own badge render must not rescan the author or restart a lookup.
  let authorScans = 0;
  const queryLinks = target.container.querySelectorAll;
  target.container.querySelectorAll = (selector) => { authorScans += 1; return queryLinks(selector); };
  const badge = target.getBadge();
  badge.nodeType = 1;
  badge.matches = (selector) => selector === "[data-account-based-in]";
  badge.closest = (selector) => selector === "[data-account-based-in]" ? badge
    : target.container.closest(selector);
  app.mutate([{ type: "childList", target: target.container, addedNodes: [badge], removedNodes: [] }]);
  app.mutate([{ type: "childList", target: badge, addedNodes: [target.link], removedNodes: [] }]);
  assert.equal(authorScans, 0);
};

const makeRequestTimeouts = () => {
  const timers = new Map();
  return {
    setTimeoutImpl(callback, delay) {
      if (delay !== 20000) return setTimeout(callback, delay);
      const token = {};
      timers.set(token, callback);
      return token;
    },
    clearTimeoutImpl(token) {
      if (!timers.delete(token)) clearTimeout(token);
    },
    expire() {
      assert.equal(timers.size, 1, "the request timeout must remain active while the body is read");
      timers.values().next().value();
    },
    size: () => timers.size,
  };
};

const testReplacedAuthorHeaderClearsStaleVisibility = async () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  await app.hooks.getHydrationReady();
  app.hooks.seedCachedUser({ restId: "2", screenName: "Alice", country: "Italy", updatedAt: Date.now() });
  app.hooks.seedCachedUser({ restId: "3", screenName: "Bob", country: "France", updatedAt: Date.now() });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  const replacement = makeMutableFeedTarget("Bob");
  replacement.container.nodeType = 1;
  replacement.container.matches = (selector) => selector === '[data-testid="User-Name"]';
  target.tweet.querySelector = (selector) => selector === '[data-testid="User-Name"]' ? replacement.container : null;
  app.mutate([{ type: "childList", target: target.tweet,
    addedNodes: [replacement.container], removedNodes: [target.container] }]);
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
  assert.equal(replacement.getBadge().dataset.accountUsername, "Bob");
};

const testResponseBodiesRemainBoundedByTimeout = async () => {
  const timeouts = makeRequestTimeouts();
  let readingBody = false;
  let signal;
  const app = boot({ currentOwner: "1", storedOwner: "1", ...timeouts,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { headers: { get: () => null }, ok: true, status: 200,
        json: () => { readingBody = true; return new Promise(() => {}); },
      };
    },
  });
  const lookup = app.hooks.fetchCountry("Alice");
  await waitFor(() => readingBody);
  timeouts.expire();
  assert.equal((await lookup).reason, "timeout");
  assert.equal(signal.aborted, true);
  assert.equal(timeouts.size(), 0);

  readingBody = false;
  const block = app.hooks.sendBlockRequest("2", "https://x.com/i/api/1.1/blocks/create.json");
  const failedBlock = assert.rejects(block, /timed out; its result is unknown/);
  await waitFor(() => readingBody);
  timeouts.expire();
  await failedBlock;
  assert.equal(signal.aborted, true);
  assert.equal(timeouts.size(), 0);
};

const testResetReleasesStalledResponseBody = async () => {
  let staleSignal;
  let readingBody = false;
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false",
    navigatorImpl: { locks: makeLockManager() },
    fetchImpl: async (url, options) => {
      const { screenName } = JSON.parse(new URL(url).searchParams.get("variables"));
      if (screenName === "Alice") {
        staleSignal = options.signal;
        return { headers: { get: () => null }, ok: true, status: 200,
          json: () => { readingBody = true; return new Promise(() => {}); },
        };
      }
      return { headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "3", core: { name: "Bob", screen_name: "Bob" },
          about_profile: { account_based_in: "France" },
        } } } }),
      };
    },
  });
  const alice = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", alice.container, alice.tweet);
  await waitFor(() => readingBody);
  await app.hooks.resetLocaleFenceData();
  assert.equal(staleSignal.aborted, true);
  const bob = makeMutableFeedTarget("Bob");
  app.hooks.enqueue("Bob", bob.container, bob.tweet);
  await waitFor(() => bob.getBadge()?.dataset.accountUsername === "Bob");
  assert.equal(app.hooks.getCachedAccount("Alice"), null);
};

const testDelayedStorageDoesNotResumePause = async () => {
  const storageValues = new Map([
    ["localefence.blockEnabled", "false"], ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"], ["localefence.notificationsEnabled", "false"],
    ["localefence.blockPaused", "false"],
  ]);
  const events = [];
  const storageBus = [];
  let blockRequests = 0;
  const fetchImpl = async (url) => {
    if (url.includes("AboutAccountQuery")) return {
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "9", core: { name: "Alice", screen_name: "Alice" },
        about_profile: { account_based_in: "Italy" },
      } } } }),
    };
    blockRequests += 1;
    throw new Error("A block request failed");
  };
  const options = { currentOwner: "1", storedOwner: "1", storedBlockEnabled: "false", storageValues,
    storageBus, storageDelivery: (callback) => events.push(callback), fetchImpl };
  const first = boot(options);
  const second = boot(options);
  await Promise.all([first.hooks.getHydrationReady(), second.hooks.getHydrationReady()]);
  first.storage("localefence.blockEnabled", "true");
  const target = makeMutableFeedTarget("Alice");
  first.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => first.hooks.getBlockPaused());
  assert.equal(blockRequests, 1);
  while (events.length) events.shift()();
  first.dispatchStorage({ key: "localefence.blockPaused", newValue: "false" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(first.hooks.getBlockPaused(), true);
  assert.equal(second.hooks.getBlockPaused(), true);
  assert.equal(storageValues.get("localefence.blockPaused"), "true");
  assert.equal(blockRequests, 1, "a delayed enable or unpause event must not retry the failed block");
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
  for (const rejectStatus of [405, 422]) {
    const requestedMethods = [];
    const fetchImpl = async (_url, options) => {
      requestedMethods.push(options.method);
      if (options.method === "POST") {
        return { headers: { get: () => null }, ok: false, status: rejectStatus };
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
    assert.equal((await app.hooks.fetchCountry("Bob")).found, true);
    assert.deepEqual(
      requestedMethods,
      ["POST", "GET", "GET"],
      `HTTP ${rejectStatus} on POST must fall back to GET and stay on GET for the session`,
    );
  }
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
  return app.hooks.enqueueBlock(user.screenName, { country: user.country, viaStore: false }, makeQueuedTweet(), {
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
  reloaded.hooks.applyPostVisibility(tweet, { country: "Italy" });
  assert.equal(feedCell.dataset.localefenceHidden, "true");
  assert.equal(feedCell.style.display, undefined, "LocaleFence must not overwrite X's inline display style");
  reloaded.hooks.applyPostVisibility(tweet, { country: "France" });
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

const testResetCancelsInFlightLookup = async () => {
  let finishLookup;
  const fetchImpl = () => new Promise((resolve) => {
    finishLookup = () => resolve({
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
        about_profile: { account_based_in: "Italy" },
      } } } }),
    });
  });
  const app = boot({ currentOwner: "1", fetchImpl, storedBlockEnabled: "false" });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => Boolean(finishLookup));
  await app.hooks.resetLocaleFenceData();
  finishLookup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.stored("localefence.sharedLookupCache"), null);
  assert.equal(app.hooks.getCachedAccount("Alice"), null);
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
};

const testResetDoesNotRestoreInFlightBlockData = async () => {
  let finishBlock;
  const fetchImpl = () => new Promise((resolve) => {
    finishBlock = () => resolve({
      json: async () => ({ id_str: "2" }), ok: true, status: 200,
    });
  });
  const app = boot({ currentOwner: "1", fetchImpl, storedOwner: "1" });
  queueVerifiedBlock(app, {
    restId: "2", screenName: "Alice", name: "Alice", country: "Italy", updatedAt: Date.now(),
  });
  await waitFor(() => Boolean(finishBlock));
  await app.hooks.resetLocaleFenceData();
  finishBlock();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(app.stored("localefence.blockedAccounts"), null);
  assert.equal(app.stored("localefence.totalBlocked"), null);
  assert.equal(app.stored("localefence.blockPaused"), null);
};

const testResetCancelsAnotherTabsInFlightLookup = async () => {
  const storageValues = new Map();
  const storageBus = [];
  const feedTweets = [];
  const firstTab = boot({
    currentOwner: "1", storageBus, storageValues, storedBlockEnabled: "false",
  });
  let finishLookup;
  let lookupCount = 0;
  const secondTab = boot({
    currentOwner: "1", feedTweets, storageBus, storageValues, storedBlockEnabled: "false",
    fetchImpl: () => new Promise((resolve) => {
      lookupCount += 1;
      finishLookup = () => resolve({
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
          about_profile: { account_based_in: "Italy" },
        } } } }),
      });
    }),
  });
  const target = makeMutableFeedTarget("Alice");
  feedTweets.push(target.tweet);
  secondTab.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => Boolean(finishLookup));
  await firstTab.hooks.resetLocaleFenceData();
  await waitFor(() => secondTab.hooks.getLookupRecord("Alice") == null);
  finishLookup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(storageValues.get("localefence.sharedLookupCache"), undefined);
  assert.equal(secondTab.hooks.getCachedAccount("Alice"), null);
  assert.equal(lookupCount, 1, "reset must not immediately rescan the old feed in another tab");
  assert.equal([...storageValues.keys()].some((key) => key.startsWith("localefence.")), false);
};

const testSourceCountryExtraction = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  const extract = app.hooks.extractSourceCountry;
  assert.equal(extract("United States App Store"), "United States");
  assert.equal(extract("United Kingdom Google Play"), "United Kingdom");
  assert.equal(extract("Russian Federation Android App"), "Russian Federation");
  assert.equal(extract("Saudi Arabia App Store"), "Saudi Arabia");
  assert.equal(extract("Türkiye Android App"), "Turkey", "X's country variants must resolve to the canonical name");
  assert.equal(extract("South Korea App Store"), "Korea");
  assert.equal(extract("Google Play"), "", "a store label without a country must not guess one");
  assert.equal(extract("Web"), "");
  assert.equal(extract("Twitter for iPhone"), "");
  assert.equal(extract("North America App Store"), "", "X regions are not store-region countries");
  assert.equal(extract("  united   states  app STORE  "), "United States");
  for (const label of ["Italy", "Italy Web", "France Embassy", "United States Unknown Store", "Congo Unknown Android App"]) {
    assert.equal(extract(label), "", `an unrecognized label must not authorize a store-region match: ${label}`);
  }
};

const testStoreRegionMatchingIsOptIn = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  assert.match(
    source,
    /if \(nextEnabled && blockEnabled && !blockPaused\) \{[\s\S]*?globalThis\.confirm\(/,
    "enabling store-region matching while automatic blocking is active must confirm before applying",
  );
  const user = {
    restId: "2",
    screenName: "Alice",
    name: "Alice",
    country: "France",
    source: "Russian Federation Android App",
    sourceCountry: "Russian Federation",
    updatedAt: Date.now(),
  };
  app.storage("localefence.locations", "Italy\nRussian Federation");
  const unmatched = app.hooks.matchAccountLocation(user);
  assert.equal(unmatched.country, "", "the Connected-via store region must not match while the setting is off");
  assert.equal(unmatched.viaStore, false);
  const target = makeMutableFeedTarget("Alice");
  app.hooks.applyPostVisibility(target.tweet, user);
  assert.equal(target.cell.dataset.localefenceHidden, undefined);

  app.storage("localefence.matchStoreRegion", "true");
  assert.equal(app.hooks.getMatchStoreRegion(), true);
  const stored = app.hooks.matchAccountLocation(user);
  assert.equal(stored.country, "Russian Federation", "the store region must match once enabled");
  assert.equal(stored.viaStore, true);
  app.hooks.applyPostVisibility(target.tweet, user);
  assert.equal(target.cell.dataset.localefenceHidden, "true");

  const reported = app.hooks.matchAccountLocation({ ...user, country: "Italy" });
  assert.equal(reported.country, "Italy", "a reported-location match always wins over the store region");
  assert.equal(reported.viaStore, false);

  app.storage("localefence.matchStoreRegion", "false");
  app.hooks.applyPostVisibility(target.tweet, user);
  assert.equal(
    target.cell.dataset.localefenceHidden,
    undefined,
    "turning the setting off must release store-region matches",
  );
};

const testStoreRegionDoesNotMatchWithoutOptIn = async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    throw new Error(`Unexpected request: ${url}`);
  };
  const storageValues = new Map([["localefence.locations", "Russian Federation"]]);
  const app = boot({ currentOwner: "1", fetchImpl, storageValues, storedOwner: "1" });
  app.hooks.seedCachedUser({
    restId: "2",
    screenName: "Alice",
    name: "Alice",
    country: "France",
    source: "Russian Federation Android App",
    sourceCountry: "Russian Federation",
    updatedAt: Date.now() - 1000,
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requests, [], "an unmatchable store region must not trigger a lookup or block");
  assert.equal(app.hooks.getBlockQueue().length, 0);
  assert.equal(target.cell.dataset.localefenceHidden, undefined);
  assert.equal(target.getBadge().dataset.accountBasedIn, "France");
};

const testStoreRegionBlockNeedsFreshProof = async () => {
  const aboutRequests = [];
  const blockedRestIds = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("AboutAccountQuery")) {
      aboutRequests.push(url);
      return {
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
          about_profile: { account_based_in: "France", source: "Russian Federation Android App" },
        } } } }),
      };
    }
    if (url.includes("blocks/create.json")) {
      blockedRestIds.push(new URLSearchParams(options.body).get("user_id"));
      return { json: async () => ({ id_str: "2" }), ok: true, status: 200 };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const storageValues = new Map([
    ["localefence.locations", "Russian Federation"],
    ["localefence.matchStoreRegion", "true"],
  ]);
  const app = boot({ currentOwner: "1", fetchImpl, storageValues, storedOwner: "1" });
  app.hooks.seedCachedUser({
    restId: "2",
    screenName: "Alice",
    name: "Alice",
    country: "France",
    source: "Russian Federation Android App",
    sourceCountry: "Russian Federation",
    updatedAt: Date.now() - 1000,
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => blockedRestIds.length === 1);
  assert.deepEqual(blockedRestIds, ["2"]);
  assert.equal(aboutRequests.length, 1, "a store-region match must be proven by a fresh lookup before blocking");
  const history = app.hooks.getBlockHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].country, "Russian Federation");
  assert.equal(history[0].matchSource, "store");
  assert.equal(target.cell.dataset.localefenceHidden, "true", "a store-region match hides matching posts too");
};

const testLocationWarningIsDisplayOnly = async () => {
  const blockedRestIds = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("AboutAccountQuery")) {
      return {
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
          about_profile: { account_based_in: "France", source: "Web", location_accurate: false },
        } } } }),
      };
    }
    if (url.includes("blocks/create.json")) {
      blockedRestIds.push(new URLSearchParams(options.body).get("user_id"));
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const app = boot({ currentOwner: "1", fetchImpl, storedOwner: "1" });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => target.getBadge());
  assert.equal(app.hooks.getCachedAccount("Alice").locationWarning, true);
  const badge = target.getBadge();
  assert.match(badge.title, /Location may not be accurate/);
  assert.equal(badge.dataset.locationWarning, "true");
  assert.equal(target.cell.dataset.localefenceHidden, undefined, "the VPN warning alone must not hide posts");
  assert.deepEqual(blockedRestIds, [], "the VPN warning alone must not block");
};

const testStoreRegionHidesAfterFreshLookup = async () => {
  const fetchImpl = async (url) => {
    if (!url.includes("AboutAccountQuery")) throw new Error(`Unexpected request: ${url}`);
    return {
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { name: "Alice", screen_name: "Alice" },
        about_profile: { account_based_in: "France", source: "United States App Store" },
      } } } }),
    };
  };
  const storageValues = new Map([
    ["localefence.locations", "United States"],
    ["localefence.matchStoreRegion", "true"],
  ]);
  const app = boot({ currentOwner: "1", fetchImpl, storageValues, storedBlockEnabled: "false" });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => target.getBadge());
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  const badge = target.getBadge();
  assert.equal(badge.dataset.accountBasedIn, "France", "the badge keeps showing X's reported country");
  assert.match(badge.title, /Account based in France/);
  assert.match(badge.title, /Connected via United States App Store/);
  assert.equal(app.hooks.getCachedAccount("Alice").sourceCountry, "United States");
};

const testSharedCacheCarriesStoreRegion = async () => {
  const app = boot({
    currentOwner: "1",
    fetchImpl: async (url) => { throw new Error(`Unexpected request: ${url}`); },
    storedBlockEnabled: "false",
    storageValues: new Map([["localefence.sharedLookupCache", JSON.stringify([{
      restId: "2", screenName: "Alice", name: "Alice", country: "France",
      source: "Russian Federation Android App", sourceCountry: "Russian Federation",
      locationWarning: true, updatedAt: Date.now(),
    }])]]),
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => app.hooks.getCachedAccount("Alice") != null);
  const cached = app.hooks.getCachedAccount("Alice");
  assert.equal(cached.sourceCountry, "Russian Federation");
  assert.equal(cached.locationWarning, true);
  assert.equal(cached.expired, false);
};

const testStoreRegionStats = () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  const users = [
    { restId: "2", screenName: "Alice", country: "France", sourceCountry: "Italy" },
    { restId: "3", screenName: "Bob", sourceCountry: "Italy" },
    { restId: "4", screenName: "Carol", country: "Germany", sourceCountry: "France" },
    { restId: "5", screenName: "Dave", locationWarning: true },
  ];
  users.forEach((user) => app.hooks.seedCachedUser({ ...user, updatedAt: Date.now() }));
  assert.equal(app.hooks.getLocationStats().total, 4, "accounts without a reported country still count in the total");
  assert.equal(app.hooks.getSelectedAccountCount(), 0);
  app.storage("localefence.matchStoreRegion", "true");
  const stats = app.hooks.getLocationStats();
  assert.equal(stats.total, 4);
  assert.equal(new Map(stats.rows).get("Italy"), 2, "store matches must appear in country counts");
  assert.equal(app.hooks.getLocationCount("Europe", stats.counts), 3, "two countries in Europe must not double-count an account");
  assert.equal(app.hooks.getSelectedAccountCount(), 2);
  app.storage("localefence.locations", "Europe\nItaly\nFrance");
  assert.equal(app.hooks.getSelectedAccountCount(), 3, "overlapping selected locations must count accounts once");
  app.storage("localefence.matchStoreRegion", "false");
  const reported = app.hooks.getLocationStats();
  assert.equal(app.hooks.getLocationCount("Italy", reported.counts), 0);
  assert.equal(app.hooks.getLocationCount("Europe", reported.counts), 2);
};

const testLegacyMetadataRefresh = async () => {
  let requests = 0;
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", fetchImpl: async () => {
    requests += 1;
    return { headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { screen_name: "Alice" },
        about_profile: { account_based_in: "France", source: "Italy App Store", location_accurate: false },
      } } } }),
    };
  } });
  await app.hooks.getHydrationReady();
  app.hooks.seedCachedUser({ restId: "2", screenName: "Alice", country: "France", updatedAt: Date.now(), locationWarning: undefined });
  assert.equal(app.hooks.getCachedAccount("Alice").expired, true, "legacy cache entries need the new metadata before the normal TTL");
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.getBadge().dataset.accountBasedIn, "France", "keep displaying the old country during migration");
  await waitFor(() => target.getBadge()?.dataset.locationWarning === "true");
  assert.match(target.getBadge().title, /Connected via Italy App Store/);
  assert.equal(app.hooks.getCachedAccount("Alice").expired, false);
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(requests, 1);
};

const testNoWarningMetadataIsReusable = async () => {
  let requests = 0;
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", fetchImpl: async () => {
    requests += 1;
    return { headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { screen_name: "Alice" }, about_profile: { account_based_in: "France" },
      } } } }),
    };
  } });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => target.getBadge());
  assert.equal(app.hooks.getCachedAccount("Alice").locationWarning, false);
  assert.equal(app.hooks.getCachedAccount("Alice").expired, false);
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(requests, 1, "fresh accounts with no source or accuracy field must remain cacheable");
};

const testMetadataOnlyBadges = async () => {
  for (const [profile, expectedSource, expectedHidden] of [
    [{ source: "Web", location_accurate: false }, "unknown", undefined],
    [{ source: "Italy App Store", location_accurate: false }, "store", "true"],
  ]) {
    const target = makeMutableFeedTarget("Alice");
    const app = boot({ currentOwner: "1", storedBlockEnabled: "false", feedTweets: [target.tweet],
      storageValues: new Map([["localefence.matchStoreRegion", "true"]]),
      fetchImpl: async () => ({ headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { screen_name: "Alice" }, about_profile: profile,
        } } } }),
      }),
    });
    app.hooks.enqueue("Alice", target.container, target.tweet);
    await waitFor(() => target.getBadge());
    const badge = target.getBadge();
    assert.equal(badge.dataset.accountLocationSource, expectedSource);
    assert.equal(badge.dataset.locationWarning, "true", "X's warning must be visible without a based-in country");
    assert.ok(badge.children.some((child) => child.dataset.locationWarningMarker));
    assert.equal(badge.getAttribute("role"), "img");
    assert.match(badge.getAttribute("aria-label"), /Account location unavailable.*Connected via.*reported by X/);
    assert.equal(target.cell.dataset.localefenceHidden, expectedHidden);
    if (expectedSource === "store") {
      assert.ok(badge.children.some((child) => child.dataset.accountStoreMarker), "a store-only flag must be visibly labeled");
      assert.match(badge.title, /Store region: Italy/);
    }
    app.storage("localefence.matchStoreRegion", "false");
    assert.equal(target.cell.dataset.localefenceHidden, undefined, "changing the setting must refresh already rendered posts");
    assert.equal(target.getBadge(), badge);
  }
};

const testInvalidCachedStoreProof = async () => {
  for (const sourceLabel of ["Web", "Italy Web", `Italy App Store${" ".repeat(90)}Unknown`, undefined]) {
    const requests = [];
    const app = boot({ currentOwner: "1", storedOwner: "1", storageValues: new Map([
      ["localefence.matchStoreRegion", "true"],
      ["localefence.sharedLookupCache", JSON.stringify([{
        restId: "2", screenName: "Alice", country: "France", source: sourceLabel,
        sourceCountry: "Italy", locationWarning: false, updatedAt: Date.now(),
      }])],
    ]), fetchImpl: async (url) => { requests.push(url); throw new Error(`Unexpected request: ${url}`); } });
    const target = makeMutableFeedTarget("Alice");
    app.hooks.enqueue("Alice", target.container, target.tweet);
    assert.equal(app.hooks.getCachedAccount("Alice").sourceCountry, undefined, "a cached derived country needs a recognized raw label");
    assert.equal(target.cell.dataset.localefenceHidden, undefined);
    assert.deepEqual(requests, []);
  }
};

const testStoreBlockReasonSnapshot = async () => {
  let finishBlock;
  const app = boot({ currentOwner: "1", storedOwner: "1", storageValues: new Map([
    ["localefence.matchStoreRegion", "true"],
  ]), fetchImpl: async (url) => {
    if (url.includes("AboutAccountQuery")) return {
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { screen_name: "Alice" },
        about_profile: { account_based_in: "France", source: "Italy App Store" },
      } } } }),
    };
    assert.ok(url.includes("blocks/create.json"));
    return new Promise((resolve) => { finishBlock = () => resolve({ ok: true, status: 200, json: async () => ({ id_str: "2" }) }); });
  } });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => finishBlock);
  app.storage("localefence.locations", "France");
  app.storage("localefence.matchStoreRegion", "false");
  finishBlock();
  await waitFor(() => app.hooks.getBlockHistory().length === 1);
  const entry = app.hooks.getBlockHistory()[0];
  assert.equal(entry.country, "Italy", "history must preserve the reason when the block request was sent");
  assert.equal(entry.matchSource, "store", "later settings must not rewrite the reason for a real block");
};

const testStoreBlockCancelledWhileWaitingForLock = async () => {
  const locks = makeLockManager();
  let release;
  const held = locks.request("localefence:block-request:1", () => new Promise((resolve) => { release = resolve; }));
  let blockRequests = 0;
  const app = boot({ currentOwner: "1", storedOwner: "1", navigatorImpl: { locks },
    storageValues: new Map([["localefence.matchStoreRegion", "true"]]), fetchImpl: async (url) => {
      if (url.includes("blocks/create.json")) { blockRequests += 1; throw new Error("Cancelled block was sent"); }
      return { headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { screen_name: "Alice" },
          about_profile: { account_based_in: "France", source: "Italy App Store" },
        } } } }),
      };
    },
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => app.hooks.getLookupRecord("Alice")?.status === "awaiting_block");
  app.storage("localefence.matchStoreRegion", "false");
  release();
  await held;
  await locks.request("localefence:block-request:1", () => {});
  assert.equal(blockRequests, 0, "turning off store matching must cancel blocks waiting on another tab");
  assert.equal(app.hooks.getBlockHistory().length, 0);
};

const testChangedStoreRegionCancelsBlock = async () => {
  let blockRequests = 0;
  const app = boot({ currentOwner: "1", storedOwner: "1",
    storageValues: new Map([["localefence.matchStoreRegion", "true"]]), fetchImpl: async (url) => {
      if (url.includes("blocks/create.json")) { blockRequests += 1; throw new Error("Stale store match was blocked"); }
      return { headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { screen_name: "Alice" },
          about_profile: { account_based_in: "France", source: "Web", location_accurate: true },
        } } } }),
      };
    },
  });
  app.hooks.seedCachedUser({ restId: "2", screenName: "Alice", country: "France",
    source: "Italy App Store", sourceCountry: "Italy", locationWarning: true, updatedAt: Date.now() - 1000,
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  assert.equal(target.getBadge().dataset.locationWarning, "true");
  await waitFor(() => app.hooks.getCachedAccount("Alice").source === "Web" && !app.hooks.getLookupRecord("Alice"));
  assert.equal(blockRequests, 0, "the fresh store region must decide whether to block");
  assert.equal(target.cell.dataset.localefenceHidden, undefined, "a stale store match must release the post after lookup");
  assert.equal(target.getBadge().dataset.locationWarning, undefined);
  assert.ok(!target.getBadge().children.some((child) => child.dataset.locationWarningMarker));
  assert.match(target.getBadge().title, /Connected via Web/);
  assert.doesNotMatch(target.getBadge().title, /Location may not be accurate/);
};

const testInactiveBlockingRejectsStoreQueue = () => {
  const app = boot({ currentOwner: "1", storedOwner: "1", storedBlockEnabled: "false",
    storageValues: new Map([["localefence.matchStoreRegion", "true"]]),
  });
  const user = { restId: "2", screenName: "Alice", country: "France", sourceCountry: "Italy", updatedAt: Date.now() };
  const matched = app.hooks.matchAccountLocation(user);
  assert.equal(app.hooks.enqueueBlock("Alice", matched, null, { verifiedUser: user }), false);
  app.storage("localefence.blockEnabled", "true");
  app.hooks.pauseBlocking("Paused for test");
  assert.equal(app.hooks.enqueueBlock("Alice", matched, null, { verifiedUser: user }), false);
  assert.equal(app.hooks.getBlockQueue().length, 0, "disabled or paused blocking must not enqueue store matches");
};

const testCrossTabPauseExclusionAndCounterInsideLock = async () => {
  const sharedStorage = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
  ]);
  const locks = makeLockManager();
  const delayedEvents = [];
  const storageBus = [];
  const blocked = [];
  let failFirst = true;
  const fetchImpl = async (_url, options) => {
    const restId = new URLSearchParams(options.body).get("user_id");
    blocked.push(restId);
    if (failFirst) {
      failFirst = false;
      throw new Error("Simulated X failure");
    }
    return { ok: true, status: 200, json: async () => ({ id_str: restId }) };
  };
  const common = {
    currentOwner: "1", storedOwner: "1", storageValues: sharedStorage,
    storageBus, storageDelivery: (fn) => delayedEvents.push(fn),
    navigatorImpl: { locks }, fetchImpl,
  };
  const tabA = boot(common);
  const tabB = boot(common);
  queueVerifiedBlock(tabA, { restId: "2", screenName: "Alice", country: "Italy", updatedAt: Date.now() });
  queueVerifiedBlock(tabB, { restId: "3", screenName: "Bob", country: "Italy", updatedAt: Date.now() });
  await waitFor(() => tabA.hooks.getBlockPaused() && tabB.hooks.getBlockPaused());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(blocked, ["2"], "a waiting tab must honor another tab's safety pause before storage events arrive");

  // Exclusion written in storage before storage events arrive must also cancel a waiting block.
  const exclusionStorage = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
  ]);
  let releaseLock;
  const manualLocks = {
    request: (_name, cb) => new Promise((resolve) => { releaseLock = () => resolve(cb()); }),
  };
  const exclusionBlocked = [];
  const tabC = boot({
    currentOwner: "1", storedOwner: "1", storageValues: exclusionStorage,
    navigatorImpl: { locks: manualLocks },
    fetchImpl: async (_url, options) => {
      exclusionBlocked.push(new URLSearchParams(options.body).get("user_id"));
      return { ok: true, status: 200, json: async () => ({ id_str: "2" }) };
    },
  });
  queueVerifiedBlock(tabC, { restId: "2", screenName: "Alice", country: "Italy", updatedAt: Date.now() });
  exclusionStorage.set("localefence.excludedUserIds", "2");
  releaseLock();
  await waitFor(() => tabC.hooks.getLookupRecord("Alice") == null);
  assert.deepEqual(exclusionBlocked, [], "an excluded account in storage must never be blocked by a waiting tab");

  // Two tabs blocking distinct accounts must not lose totalBlocked increments.
  const countStorage = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.blockOwnerRestId", "1"],
    ["localefence.locations", "Italy"],
    ["localefence.notificationsEnabled", "false"],
  ]);
  const countLocks = makeLockManager();
  const countFetch = async (_url, options) => ({
    ok: true, status: 200, json: async () => ({ id_str: new URLSearchParams(options.body).get("user_id") }),
  });
  const t1 = boot({ currentOwner: "1", storedOwner: "1", storageValues: countStorage, navigatorImpl: { locks: countLocks }, fetchImpl: countFetch });
  const t2 = boot({ currentOwner: "1", storedOwner: "1", storageValues: countStorage, navigatorImpl: { locks: countLocks }, fetchImpl: countFetch });
  queueVerifiedBlock(t1, { restId: "10", screenName: "UserOne", country: "Italy", updatedAt: Date.now() });
  queueVerifiedBlock(t2, { restId: "11", screenName: "UserTwo", country: "Italy", updatedAt: Date.now() });
  await waitFor(() => t1.hooks.getLookupRecord("UserOne") == null && t2.hooks.getLookupRecord("UserTwo") == null);
  assert.equal(countStorage.get("localefence.totalBlocked"), "2");
};

const testRejectedWebLockFallsBackWithoutDeadlock = async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const app = boot({
      currentOwner: "1",
      storedBlockEnabled: "false",
      navigatorImpl: {
        locks: {
          request: () => Promise.reject(new Error("SecurityError: Web Locks denied")),
        },
      },
      fetchImpl: async () => ({
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: { result: {
          rest_id: "2", core: { screen_name: "Alice" }, about_profile: { account_based_in: "France" },
        } } } }),
      }),
    });
    const target = makeMutableFeedTarget("Alice");
    app.hooks.enqueue("Alice", target.container, target.tweet);
    await waitFor(() => target.getBadge()?.dataset.accountBasedIn === "France");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(unhandled, 0, "a rejected Web Lock must not leak an unhandled rejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
};

const testAboutQueryIdOriginAndPostResetGuard = async () => {
  const storageValues = new Map();
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false", storageValues });
  assert.equal(
    app.hooks.extractAboutQueryId("https://x.com/i/api/graphql/ValidQueryId1234/AboutAccountQuery?variables=%7B%7D"),
    "ValidQueryId1234",
  );
  assert.equal(
    app.hooks.extractAboutQueryId("https://api.x.com/graphql/ApiSubdomainId12/AboutAccountQuery?variables=%7B%7D"),
    "ApiSubdomainId12",
  );
  assert.equal(
    app.hooks.extractAboutQueryId("https://evil.example/i/api/graphql/EvilQueryId1234/AboutAccountQuery"),
    "",
    "cross-origin URLs must never supply an AboutAccountQuery ID",
  );
  assert.equal(
    app.hooks.extractAboutQueryId("https://x.com/other/graphql/WrongPath12345/AboutAccountQuery"),
    "",
    "non-API paths must not be accepted as AboutAccountQuery URLs",
  );
  await app.hooks.resetLocaleFenceData();
  assert.equal(
    app.hooks.rememberAboutQueryId("https://x.com/i/api/graphql/LateObserved1234/AboutAccountQuery", { fromObserver: true }),
    false,
    "late observer entries right after reset must not repopulate storage",
  );
  assert.equal(storageValues.get("localefence.aboutQueryId"), undefined);
};

const testPrototypeKeysAndMalformedAccountFields = async () => {
  const app = boot({
    currentOwner: "1", storedBlockEnabled: "false",
    fetchImpl: async () => ({
      headers: { get: () => null }, ok: true, status: 200,
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2",
        core: { screen_name: "Alice", name: { unexpected: true } },
        about_profile: { account_based_in: "constructor" },
      } } } }),
    }),
  });
  assert.equal(app.hooks.resolveCountryAlias("constructor"), "constructor");
  assert.equal(app.hooks.resolveCountryAlias("toString"), "toString");
  assert.equal(app.hooks.resolveCountryAlias(42), "");
  const result = await app.hooks.fetchCountry("Alice");
  assert.equal(result.found, true);
  assert.equal(result.user.country, "constructor");
  assert.equal(result.user.name, undefined);
};

const testInFlightBlockDedupAndOrphanCleanup = async () => {
  let finishAlice;
  let aboutRequests = 0;
  const blocked = [];
  const app = boot({
    currentOwner: "1", storedOwner: "1",
    fetchImpl: async (url, options) => {
      if (url.includes("AboutAccountQuery")) {
        aboutRequests += 1;
        return {
          headers: { get: () => null }, ok: true, status: 200,
          json: async () => ({ data: { user_result_by_screen_name: { result: {
            rest_id: "2", core: { screen_name: "Alice" }, about_profile: { account_based_in: "Italy" },
          } } } }),
        };
      }
      const restId = new URLSearchParams(options.body).get("user_id");
      blocked.push(restId);
      return new Promise((resolve) => {
        finishAlice = () => resolve({ ok: true, status: 200, json: async () => ({ id_str: restId }) });
      });
    },
  });
  const target1 = makeMutableFeedTarget("Alice");
  const target2 = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target1.container, target1.tweet);
  await waitFor(() => Boolean(finishAlice));
  // Encountering another post by Alice while her block is in flight must not re-queue or re-fetch.
  app.hooks.enqueue("Alice", target2.container, target2.tweet);
  assert.equal(app.hooks.getBlockQueue().length, 0);
  // Queue Bob behind Alice, then mark Bob as known-blocked in storage before his turn.
  queueVerifiedBlock(app, { restId: "3", screenName: "Bob", country: "Italy", updatedAt: Date.now() });
  app.storage("localefence.blockedAccounts", "1:3");
  finishAlice();
  await waitFor(() => app.hooks.getLookupRecord("Alice") == null && app.hooks.getLookupRecord("Bob") == null);
  assert.equal(aboutRequests, 1, "an in-flight block must not trigger a duplicate lookup");
  assert.deepEqual(blocked, ["2"], "known-blocked Bob must be skipped and cleaned up from lookupRecords");
};

const testCrossTabCacheClearAndQueueClearSync = async () => {
  const storageValues = new Map([["localefence.locations", "Italy"]]);
  const storageBus = [];
  const target = makeMutableFeedTarget("Alice");
  const tabA = boot({ currentOwner: "1", storedBlockEnabled: "false", storageValues, storageBus });
  const tabB = boot({
    currentOwner: "1", storedBlockEnabled: "false", storageValues, storageBus,
    feedTweets: [target.tweet], visibilityState: "hidden",
  });
  tabB.hooks.seedCachedUser({ restId: "2", screenName: "Alice", country: "Italy", updatedAt: Date.now() });
  tabB.hooks.enqueue("Alice", target.container, target.tweet);
  assert.equal(target.cell.dataset.localefenceHidden, "true");
  tabB.dispatchStorage({ key: "localefence.sharedLookupCache", newValue: null });
  assert.equal(target.cell.dataset.localefenceHidden, undefined, "cross-tab cache clear must un-hide previously hidden posts");

  // Clearing queue in Tab A must also clear Tab B's in-memory lookup queue.
  tabB.hooks.rememberLookupRecord("Bob", { tweetText: "hi", tweetUrl: "" });
  assert.ok(tabB.hooks.getLookupRecord("Bob"));
  await tabA.hooks.clearLookupRecords(true);
  assert.equal(tabB.hooks.getLookupRecord("Bob"), undefined, "cross-tab queue clear must clear queued records in other tabs");
};

const testEmptyRateLimitHeadersDoNotTriggerBackoff = async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 600;
  const app = boot({
    currentOwner: "1", storedBlockEnabled: "false",
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: {
        get: (name) => name === "x-rate-limit-remaining" ? "" : name === "x-rate-limit-limit" ? "  " : name === "x-rate-limit-reset" ? String(resetAt) : null,
      },
      json: async () => ({ data: { user_result_by_screen_name: { result: {
        rest_id: "2", core: { screen_name: "Alice" }, about_profile: { account_based_in: "France" },
      } } } }),
    }),
  });
  const target = makeMutableFeedTarget("Alice");
  app.hooks.enqueue("Alice", target.container, target.tweet);
  await waitFor(() => target.getBadge() != null);
  assert.equal(app.hooks.getLookupBackoffUntil(), 0, "empty remaining header must not be parsed as 0");
  assert.equal(app.hooks.getLookupQuota().remaining, null);
  assert.equal(app.hooks.getLookupQuota().limit, null);
};

const testDrawerCjkLabelsExternalLinkRejectionAndStateBadgePreservation = async () => {
  const app = boot({ currentOwner: "1", storedBlockEnabled: "false" });
  for (const shortLabel of ["設定", "设置", "설정"]) {
    const makeCjkRow = () => ({
      attributes: { href: "/settings" }, dataset: {},
      children: [{ attributes: {}, setAttribute() {}, innerHTML: "" }, { children: [], textContent: shortLabel }],
      querySelector(s) { return s === "svg" ? this.children[0] : null; },
      querySelectorAll(s) { return s === "span, div" ? [this.children[1]] : []; },
      removeAttribute() {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener() {},
      cloneNode() { return makeCjkRow(); },
    });
    const entry = app.hooks.buildLocaleFenceDrawerEntry(makeCjkRow());
    assert.equal(entry.children[1].textContent, "LocaleFence", `2-char CJK label ${shortLabel} must be relabeled`);
    assert.equal(entry.attributes.role, "button");
  }
  const externalSettingLink = makeDrawerLink("https://example.com/my-settings-guide", "Settings guide");
  const tweetSettingLink = {
    ...makeDrawerLink("/settings", "Tweet link"),
    closest: (selector) => selector === '[data-testid="tweet"]' ? { dataset: { testid: "tweet" } } : null,
  };
  assert.equal(
    app.hooks.findLocaleFenceDrawerAnchor({ querySelector: () => null, querySelectorAll: () => [externalSettingLink, tweetSettingLink] }),
    null,
    "external links and links inside tweets must never be selected as drawer anchors",
  );
  assert.ok(source.includes("[data-localefence-drawer-entry]"), "stale runtime cleanup must handle drawer entries");

  // Re-rendering a badge must preserve [data-account-state] pills and update aria-label.
  const target = makeMutableFeedTarget("Alice");
  const badgeApp = boot({ currentOwner: "1", storedBlockEnabled: "false", feedTweets: [target.tweet], visibilityState: "hidden" });
  badgeApp.hooks.applyCountry(target.container, target.tweet, { country: "Italy", locationWarning: false }, "Alice");
  badgeApp.hooks.markFeedAccount("Alice", "Blocked");
  assert.ok(target.getBadge().querySelector("[data-account-state]"));
  assert.match(target.getBadge().getAttribute("aria-label"), /Blocked/);
  badgeApp.hooks.applyCountry(target.container, target.tweet, { country: "Italy", locationWarning: true }, "Alice");
  assert.equal(target.getBadge().querySelector("[data-account-state]")?.textContent, "Blocked");
  assert.match(target.getBadge().getAttribute("aria-label"), /Blocked/);
};

const testEmpty200ProfileCachedAsUnavailable = async () => {
  let requests = 0;
  const app = boot({
    currentOwner: "1", storedBlockEnabled: "false",
    fetchImpl: async () => {
      requests += 1;
      return {
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({ data: { user_result_by_screen_name: {} } }),
      };
    },
  });
  const target = makeMutableFeedTarget("GhostUser");
  app.hooks.enqueue("GhostUser", target.container, target.tweet);
  await waitFor(() => app.hooks.isUnavailableAccount("GhostUser"));
  app.hooks.enqueue("GhostUser", target.container, target.tweet);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests, 1, "an empty 200 profile result must be cached as unavailable to avoid repeated requests");
};

const makeMiniDomElement = (tagName, attrs = {}, text = "") => {
  const el = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    attributes: { ...attrs },
    dataset: {},
    children: [],
    parentElement: null,
    parentNode: null,
    isConnected: true,
    _text: text,
    get textContent() {
      return this._text || this.children.map((c) => c.textContent || "").join("");
    },
    set textContent(value) {
      this.children = [];
      this._text = String(value);
    },
    appendChild(child) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    matches(selector) {
      return selector.split(",").map((part) => part.trim()).some((part) => {
        if (part === "article") return this.tagName === "ARTICLE";
        if (part === "ul") return this.tagName === "UL";
        if (part === "li") return this.tagName === "LI";
        if (part === "a") return this.tagName === "A";
        if (part === "button") return this.tagName === "BUTTON";
        if (part === "img") return this.tagName === "IMG";
        if (part === "video") return this.tagName === "VIDEO";
        if (part === "time") return this.tagName === "TIME";
        if (part === '[role="link"]') return this.attributes.role === "link";
        if (part === '[role="group"]') return this.attributes.role === "group";
        if (part === '[data-testid="tweet"]') return this.attributes["data-testid"] === "tweet";
        if (part === '[data-testid="User-Name"]') return this.attributes["data-testid"] === "User-Name";
        if (part === '[data-testid="cellInnerDiv"]') return this.attributes["data-testid"] === "cellInnerDiv";
        if (part === '[data-testid="tweetText"]') return this.attributes["data-testid"] === "tweetText";
        if (part === '[data-testid="tweetPhoto"]') return this.attributes["data-testid"] === "tweetPhoto";
        if (part === "[data-account-based-in]") return "accountBasedIn" in this.dataset;
        if (part === "[data-account-state]") return "accountState" in this.dataset;
        if (part === 'a[href^="/"]') return this.tagName === "A" && (this.attributes.href || "").startsWith("/");
        if (part === 'a[href*="/status/"]') return this.tagName === "A" && (this.attributes.href || "").includes("/status/");
        if (part === 'div[dir="auto"][lang]') return this.tagName === "DIV" && this.attributes.dir === "auto" && Boolean(this.attributes.lang);
        return false;
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.matches?.(selector)) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    },
  };
  return el;
};

const testModernDesktopDomWithoutTestIds = async () => {
  const lookups = [];
  const app = boot({
    currentOwner: "1",
    storedBlockEnabled: "false",
    storageValues: new Map([["localefence.locations", "Italy"]]),
    fetchImpl: async (url) => {
      const { screenName } = JSON.parse(new URL(url).searchParams.get("variables"));
      lookups.push(screenName);
      return {
        headers: { get: () => null }, ok: true, status: 200,
        json: async () => ({
          data: {
            user_result_by_screen_name: {
              result: {
                rest_id: screenName === "Alice" ? "2" : "3",
                core: { name: screenName, screen_name: screenName },
                about_profile: { account_based_in: screenName === "Alice" ? "Italy" : "France" },
              },
            },
          },
        }),
      };
    },
  });

  // Build X's data-testid-less desktop structure: ul > li > div[role=link] > article (with nested quoted article).
  const ul = makeMiniDomElement("ul");
  const li = makeMiniDomElement("li");
  const card = makeMiniDomElement("div", { role: "link" });
  const overlayStatus = makeMiniDomElement("a", { href: "/Alice/status/12345" });
  const article = makeMiniDomElement("article");
  const outer = makeMiniDomElement("div");
  const avatarCol = makeMiniDomElement("div");
  const avatarLink = makeMiniDomElement("a", { href: "/Alice" });
  avatarLink.appendChild(makeMiniDomElement("img"));
  avatarCol.appendChild(avatarLink);

  const mainCol = makeMiniDomElement("div");
  const headerBar = makeMiniDomElement("div");
  const headerRow = makeMiniDomElement("div");
  const nameAndHandle = makeMiniDomElement("div");
  const nameDiv = makeMiniDomElement("div");
  const nameSpan = makeMiniDomElement("span");
  nameSpan.appendChild(makeMiniDomElement("a", { href: "/Alice" }, "Alice Display"));
  nameDiv.appendChild(nameSpan);
  const handleDiv = makeMiniDomElement("div");
  const handleSpan = makeMiniDomElement("span");
  const handleLink = makeMiniDomElement("a", { href: "/Alice" }, "@Alice");
  handleSpan.appendChild(handleLink);
  handleDiv.appendChild(handleSpan);
  nameAndHandle.appendChild(nameDiv);
  nameAndHandle.appendChild(handleDiv);
  const tsSpan = makeMiniDomElement("span");
  const tsLink = makeMiniDomElement("a", { href: "/Alice/status/12345" }, "2h");
  tsSpan.appendChild(tsLink);
  headerRow.appendChild(nameAndHandle);
  headerRow.appendChild(tsSpan);
  const rightButtons = makeMiniDomElement("div");
  rightButtons.appendChild(makeMiniDomElement("button"));
  headerBar.appendChild(headerRow);
  headerBar.appendChild(rightButtons);

  const bodyText = makeMiniDomElement("div", { dir: "auto", lang: "en" });
  bodyText.appendChild(makeMiniDomElement("span", {}, "Hello from modern X DOM"));
  bodyText.appendChild(makeMiniDomElement("a", { href: "/Mentioned" }, "@Mentioned"));

  // Nested quoted tweet <article> must not be treated as a separate feed post or hijack outer author.
  const quoteWrap = makeMiniDomElement("div", { role: "link" });
  const quotedArticle = makeMiniDomElement("article");
  const quotedHeader = makeMiniDomElement("div");
  quotedHeader.appendChild(makeMiniDomElement("a", { href: "/QuotedUser" }, "@QuotedUser"));
  quotedArticle.appendChild(quotedHeader);
  quoteWrap.appendChild(quotedArticle);

  const actions = makeMiniDomElement("div", { role: "group" });
  actions.appendChild(makeMiniDomElement("a", { href: "/Alice/status/12345/analytics" }, "10"));

  mainCol.appendChild(headerBar);
  mainCol.appendChild(bodyText);
  mainCol.appendChild(quoteWrap);
  mainCol.appendChild(actions);
  outer.appendChild(avatarCol);
  outer.appendChild(mainCol);
  article.appendChild(outer);
  card.appendChild(overlayStatus);
  card.appendChild(article);
  li.appendChild(card);
  ul.appendChild(li);

  app.hooks.findTweets(ul);
  await waitFor(() => headerRow.querySelector("[data-account-based-in]") != null);
  assert.deepEqual(lookups, ["Alice"], "only the outer <article> author must be queried, not mentions or quoted articles");
  assert.equal(headerRow.querySelector("[data-account-based-in]").dataset.accountBasedIn, "Italy");
  assert.equal(li.dataset.localefenceHidden, "true", "matching posts in modern DOM must hide their ul > li timeline cell");
  assert.equal(quotedArticle.querySelector("[data-account-based-in]"), null);

  // Recycling the article to Bob via href mutation must clear the stale flag and un-hide the li cell.
  handleLink.setAttribute("href", "/Bob");
  handleLink.textContent = "@Bob";
  tsLink.setAttribute("href", "/Bob/status/67890");
  app.mutate([{ type: "attributes", attributeName: "href", target: handleLink, addedNodes: [], removedNodes: [] }]);
  assert.equal(li.dataset.localefenceHidden, undefined);
  await waitFor(() => headerRow.querySelector("[data-account-based-in]")?.dataset.accountUsername === "Bob");
  assert.equal(headerRow.querySelector("[data-account-based-in]").dataset.accountBasedIn, "France");
  assert.equal(li.dataset.localefenceHidden, undefined);
};

const run = async () => {
  testAndroidMountRecovery();
  testDrawerEntry();
  testDrawerRowResolution();
  testDrawerAnchorTiers();
  testFindTweetsSkipsNonElements();
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
  await testQueuedLookupDoesNotCrossOwners();
  await testAccountSwitchDuringLookupDisablesBlocking();
  await testChangedTweetDoesNotReceiveOldCountry();
  await testAuthorLinkMutationClearsStaleBadge();
  await testUnavailableAuthorMutationClearsStaleBadge();
  await testAuthorChildMutationClearsStaleBadge();
  await testReplacedAuthorHeaderClearsStaleVisibility();
  await testResponseBodiesRemainBoundedByTimeout();
  await testResetReleasesStalledResponseBody();
  await testDelayedStorageDoesNotResumePause();
  await testImmediateNormalBlocks();
  await testQueuedBlockCancellation();
  await testFirefoxForeignLockPromise();
  await testConcurrentTabDeduplication();
  await testPausedStateAndOwnedVisibility();
  await testCompleteReset();
  await testResetCancelsInFlightLookup();
  await testResetDoesNotRestoreInFlightBlockData();
  await testResetCancelsAnotherTabsInFlightLookup();
  testSourceCountryExtraction();
  testStoreRegionMatchingIsOptIn();
  await testStoreRegionDoesNotMatchWithoutOptIn();
  await testStoreRegionBlockNeedsFreshProof();
  await testLocationWarningIsDisplayOnly();
  await testStoreRegionHidesAfterFreshLookup();
  await testSharedCacheCarriesStoreRegion();
  testStoreRegionStats();
  await testLegacyMetadataRefresh();
  await testNoWarningMetadataIsReusable();
  await testMetadataOnlyBadges();
  await testInvalidCachedStoreProof();
  await testStoreBlockReasonSnapshot();
  await testStoreBlockCancelledWhileWaitingForLock();
  await testChangedStoreRegionCancelsBlock();
  testInactiveBlockingRejectsStoreQueue();
  await testCrossTabPauseExclusionAndCounterInsideLock();
  await testRejectedWebLockFallsBackWithoutDeadlock();
  await testAboutQueryIdOriginAndPostResetGuard();
  await testPrototypeKeysAndMalformedAccountFields();
  await testInFlightBlockDedupAndOrphanCleanup();
  await testCrossTabCacheClearAndQueueClearSync();
  await testEmptyRateLimitHeadersDoNotTriggerBackoff();
  await testDrawerCjkLabelsExternalLinkRejectionAndStateBadgePreservation();
  await testEmpty200ProfileCachedAsUnavailable();
  await testModernDesktopDomWithoutTestIds();
};

module.exports = { boot, makeMutableFeedTarget, waitFor };
if (require.main === module) {
  run()
    .then(() => console.log("LocaleFence safety and lifecycle checks passed"))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
