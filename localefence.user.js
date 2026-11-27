// ==UserScript==
// @name         LocaleFence for X
// @namespace    https://github.com/ssupt/LocaleFence
// @version      1.3.0
// @description  See X account countries, hide matching posts, and optionally block matching accounts
// @author       ssupt
// @license      GPL-3.0-only
// @homepageURL  https://greasyfork.org/en/scripts/585483-localefence-for-x
// @source       https://github.com/ssupt/LocaleFence
// @supportURL   https://github.com/ssupt/LocaleFence/issues
// @updateURL    https://raw.githubusercontent.com/ssupt/LocaleFence/main/localefence.user.js
// @downloadURL  https://raw.githubusercontent.com/ssupt/LocaleFence/main/localefence.user.js
// @match        https://x.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 ssupt

(() => {
  // A DOM marker prevents the userscript and browser-extension builds from both
  // running when someone has installed both distributions. A synchronous
  // ping distinguishes a live runtime from a stale marker restored by a
  // discarded mobile tab.
  const runtimeVersion = "1.3.0";
  const runtimePingEvent = "localefence:runtime-ping";
  const runtimeRoot = document.documentElement;
  const pingExistingRuntime = () => {
    if (!runtimeRoot?.dataset?.localefenceRuntime || !document.dispatchEvent) return false;
    const token = `${Date.now()}:${Math.random()}`;
    runtimeRoot.dataset.localefenceRuntimePing = token;
    try {
      document.dispatchEvent(new Event(runtimePingEvent));
    } catch { /* A stale marker is handled below. */ }
    const acknowledged = runtimeRoot.dataset.localefenceRuntimePong === token;
    delete runtimeRoot.dataset.localefenceRuntimePing;
    delete runtimeRoot.dataset.localefenceRuntimePong;
    return acknowledged;
  };
  if (runtimeRoot?.dataset?.localefenceRuntime) {
    if (pingExistingRuntime()) return;
    const claimedAt = Number(runtimeRoot.dataset.localefenceRuntimeClaimedAt);
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 2000) return;
    document.querySelectorAll?.(
      "[data-localefence-root], [data-localefence-overlay], [data-localefence-toasts], [data-localefence-styles], [data-localefence-drawer-entry]",
    ).forEach((node) => node.remove());
  }
  if (runtimeRoot?.dataset) {
    runtimeRoot.dataset.localefenceRuntime = runtimeVersion;
    runtimeRoot.dataset.localefenceRuntimeClaimedAt = String(Date.now());
  }
  document.addEventListener?.(runtimePingEvent, () => {
    const token = runtimeRoot?.dataset?.localefenceRuntimePing;
    if (token) runtimeRoot.dataset.localefenceRuntimePong = token;
  });

  // X uses this public bearer token in its own web client. It is not a personal credential.
  const authToken =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const fallbackAboutQueryId = "zs_jFPFT78rBpXv9Z3U2YQ";
  const blockUrl = "https://x.com/i/api/1.1/blocks/create.json";
  const unblockUrl = "https://x.com/i/api/1.1/blocks/destroy.json";
  const getCookie = (name) => document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1] || "";
  const decodeCookie = (name) => {
    const value = getCookie(name);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const getCsrfToken = () => decodeCookie("ct0");
  const getOwnRestId = () => {
    const value = decodeCookie("twid").replace(/^"|"$/g, "");
    return value.match(/^u=(\d+)$/)?.[1];
  };

  const readStorage = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const writeStorage = (key, value) => {
    try {
      localStorage.setItem(key, String(value));
    } catch { /* Storage can be unavailable in restricted browser contexts. */ }
  };
  const removeStorage = (key) => {
    try {
      localStorage.removeItem(key);
    } catch { /* Storage can be unavailable in restricted browser contexts. */ }
  };
  const removeStorageByPrefix = (prefix) => {
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
    } catch { /* Storage can be unavailable in restricted browser contexts. */ }
    keys.forEach(removeStorage);
  };
  // Reset invalidates work started before the local stores were cleared.
  let dataGeneration = 0;
  let resetInProgress = false;
  let lastResetAt = 0;
  let cacheClearGeneration = 0;
  let queueClearGeneration = 0;
  let historyClearGeneration = 0;
  // Firefox content scripts can expose Web Locks promises through a page
  // compartment. Awaiting that foreign promise throws a permission error, so
  // resolve a promise owned by LocaleFence from inside the lock callback.
  const withExclusiveWebLock = (name, callback) => {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) return callback();
    return new Promise((resolve, reject) => {
      let started = false;
      const runCallback = async () => {
        started = true;
        try {
          resolve(await callback());
        } catch (error) {
          reject(error);
        }
      };
      try {
        const request = locks.request(name, runCallback);
        try {
          request?.then?.(undefined, () => {
            if (!started) void runCallback();
          });
        } catch { /* Firefox foreign lock promises reject .then access; runCallback settles it. */ }
      } catch {
        if (!started) void runCallback();
      }
    });
  };
  const aboutQueryIdStorageKey = "localefence.aboutQueryId";
  const rejectedAboutQueryIds = new Set();
  const isAboutQueryId = (value) => /^[A-Za-z0-9_-]{10,64}$/.test(value || "");
  const extractAboutQueryId = (value) => {
    try {
      const origin = globalThis.location?.origin || "https://x.com";
      const url = new URL(String(value || ""), origin);
      const isSameOrigin = !globalThis.location?.origin || url.origin === globalThis.location.origin;
      const isApiSubdomain = url.origin === "https://api.x.com";
      if (!isSameOrigin && !isApiSubdomain) return "";
      const pattern = isApiSubdomain
        ? /^\/graphql\/([^/?]+)\/AboutAccountQuery\/?$/
        : /^\/i\/api\/graphql\/([^/?]+)\/AboutAccountQuery\/?$/;
      const match = url.pathname.match(pattern);
      return isAboutQueryId(match?.[1]) ? match[1] : "";
    } catch {
      return "";
    }
  };
  const storedAboutQueryId = readStorage(aboutQueryIdStorageKey);
  let aboutQueryId = isAboutQueryId(storedAboutQueryId) ? storedAboutQueryId : fallbackAboutQueryId;
  const rememberAboutQueryId = (value, { fromObserver = false } = {}) => {
    if (fromObserver && (resetInProgress || (lastResetAt && Date.now() - lastResetAt < 5000))) return false;
    const candidate = isAboutQueryId(value) ? value : extractAboutQueryId(value);
    if (!candidate || rejectedAboutQueryIds.has(candidate)) return false;
    if (fromObserver && aboutQueryId === candidate) return false;
    if (aboutQueryId === candidate && readStorage(aboutQueryIdStorageKey) === candidate) return false;
    aboutQueryId = candidate;
    writeStorage(aboutQueryIdStorageKey, candidate);
    return true;
  };
  const discoverObservedAboutQueryId = (options = {}) => {
    let entries = [];
    try {
      entries = globalThis.performance?.getEntriesByType?.("resource") || [];
    } catch { /* Resource timing may be unavailable in restricted contexts. */ }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = extractAboutQueryId(entries[index]?.name);
      if (candidate && !rejectedAboutQueryIds.has(candidate)) return rememberAboutQueryId(candidate, options);
    }
    return false;
  };
  discoverObservedAboutQueryId({ fromObserver: true });
  try {
    if (globalThis.PerformanceObserver) {
      const observer = new globalThis.PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => rememberAboutQueryId(entry?.name, { fromObserver: true }));
      });
      try {
        observer.observe({ type: "resource", buffered: true });
      } catch {
        observer.observe({ entryTypes: ["resource"] });
      }
    }
  } catch { /* Query-ID observation is a best-effort resilience feature. */ }
  const recoverAboutQueryId = (rejectedQueryId) => {
    rejectedAboutQueryIds.add(rejectedQueryId);
    if (aboutQueryId !== rejectedQueryId && !rejectedAboutQueryIds.has(aboutQueryId)) return true;
    if (discoverObservedAboutQueryId()) return true;
    if (!rejectedAboutQueryIds.has(fallbackAboutQueryId)) return rememberAboutQueryId(fallbackAboutQueryId);
    return false;
  };
  const getAboutQueryUrl = () =>
    `https://x.com/i/api/graphql/${aboutQueryId}/AboutAccountQuery`;

  // Runtime state
  const screenNames = new Map();
  const aboutUsers = new Map();
  const pending = new Map();
  const queue = [];
  const lookupAttempts = new Map();
  const lookupRetryTimers = new Map();
  const lookupRecords = new Map();
  const unavailableAccounts = new Map();
  const blockQueue = [];
  const queuedBlockIds = new Set();
  const inFlightBlockIds = new Set();
  const blockHistory = [];
  const activeLookupRequests = new Set();
  const excludedUserIdsStorageKey = "localefence.excludedUserIds";
  const excludedUserIds = new Set(
    (readStorage(excludedUserIdsStorageKey) || "").split("\n").filter(Boolean),
  );
  const refreshExcludedUserIds = () => {
    excludedUserIds.clear();
    (readStorage(excludedUserIdsStorageKey) || "").split("\n").filter(Boolean).forEach((restId) => {
      excludedUserIds.add(restId);
    });
  };
  let processing = false;
  let blockProcessing = false;
  const blockEnabledStorageKey = "localefence.blockEnabled";
  const blockPausedStorageKey = "localefence.blockPaused";
  const blockOwnerStorageKey = "localefence.blockOwnerRestId";
  const blockedAccountStorageKey = "localefence.blockedAccounts";
  const resetSignalStorageKey = "localefence.resetSignal";
  const queueClearSignalStorageKey = "localefence.queueClearSignal";
  const historyClearSignalStorageKey = "localefence.historyClearSignal";
  const maxBlockedAccountEntries = 10000;
  const isRestId = (value) => /^\d+$/.test(value || "");
  const blockAccountKey = (ownerRestId, restId) =>
    isRestId(ownerRestId) && isRestId(restId) ? `${ownerRestId}:${restId}` : "";
  const parseBlockedAccountKeys = (value) =>
    (value || "").split("\n").filter((key) => /^\d+:\d+$/.test(key));
  const blockedAccountKeys = new Set(parseBlockedAccountKeys(readStorage(blockedAccountStorageKey)));
  const refreshBlockedAccountKeys = () => {
    blockedAccountKeys.clear();
    parseBlockedAccountKeys(readStorage(blockedAccountStorageKey)).forEach((key) => blockedAccountKeys.add(key));
    trimBlockedAccountKeys();
  };
  const saveBlockedAccountKeys = () =>
    writeStorage(blockedAccountStorageKey, [...blockedAccountKeys].join("\n"));
  const trimBlockedAccountKeys = () => {
    while (blockedAccountKeys.size > maxBlockedAccountEntries) {
      blockedAccountKeys.delete(blockedAccountKeys.values().next().value);
    }
  };
  if (blockedAccountKeys.size > maxBlockedAccountEntries) {
    trimBlockedAccountKeys();
    saveBlockedAccountKeys();
  }
  const isKnownBlocked = (ownerRestId, restId) =>
    blockedAccountKeys.has(blockAccountKey(ownerRestId, restId));
  const rememberBlockedAccount = (ownerRestId, restId) => {
    const key = blockAccountKey(ownerRestId, restId);
    if (!key || blockedAccountKeys.has(key)) return;
    blockedAccountKeys.add(key);
    trimBlockedAccountKeys();
    saveBlockedAccountKeys();
  };
  const forgetBlockedAccount = (ownerRestId, restId) => {
    const key = blockAccountKey(ownerRestId, restId);
    if (!key || !blockedAccountKeys.delete(key)) return;
    saveBlockedAccountKeys();
  };
  let blockEnabled = readStorage(blockEnabledStorageKey) === "true";
  let blockOwnerRestId = readStorage(blockOwnerStorageKey) || "";
  const invalidStoredBlockOwner = blockEnabled && (!blockOwnerRestId || blockOwnerRestId !== getOwnRestId());
  if (invalidStoredBlockOwner) {
    blockEnabled = false;
    writeStorage(blockEnabledStorageKey, false);
    writeStorage(blockPausedStorageKey, false);
  }
  let blockPaused = blockEnabled && readStorage(blockPausedStorageKey) === "true";
  let blockSuccessCount = 0;
  const storedTotalBlocked = readStorage("localefence.totalBlocked");
  const parsedTotalBlocked = Number(storedTotalBlocked);
  let totalBlockedCount = Number.isFinite(parsedTotalBlocked) && parsedTotalBlocked >= 0
    ? parsedTotalBlocked
    : 0;
  let blockErrorMessage = invalidStoredBlockOwner
    ? "Automatic blocking was turned off. Enable it again for this X account."
    : blockPaused
      ? "Paused after a block request error. Turn blocking off and on to retry."
      : "";
  let lookupStatusMessage = "";
  let lookupStatusError = false;
  let queueTimer = null;
  let hydrationReady = Promise.resolve();
  const countryAliases = new Map([
    ["Cabo Verde", "Cape Verde"],
    ["Eswatini", "Swaziland"],
    ["North Macedonia", "Macedonia"],
    ["Türkiye", "Turkey"],
    ["South Korea", "Korea"],
    ["Czechia", "Czech Republic"],
  ]);
  const dayMs = 24 * 60 * 60 * 1000;
  const cacheTtlMs = 28 * dayMs;
  const defaultRateLimitDelayMs = 15 * 1000;
  const maximumRateLimitDelayMs = 7 * dayMs;
  const lookupBackoffStorageKey = "localefence.lookupBackoffUntil";
  const lookupFallbackAttemptsStorageKey = "localefence.lookupFallbackAttempts";
  const sharedLookupCacheStorageKey = "localefence.sharedLookupCache";
  const unavailableAccountsStorageKey = "localefence.unavailableAccounts";
  const lookupQuotaStorageKey = "localefence.lookupQuota";
  const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
  const parseNonNegativeInt = (value) => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const readFutureTimestamp = (key) => {
    const timestamp = Number(readStorage(key));
    const now = Date.now();
    return Number.isFinite(timestamp) && timestamp > now && timestamp <= now + maximumRateLimitDelayMs
      ? timestamp
      : 0;
  };
  const readLookupFallbackAttempts = () =>
    Math.floor(clamp(Number(readStorage(lookupFallbackAttemptsStorageKey)) || 0, 0, 9));
  let lookupBackoffUntil = readFutureTimestamp(lookupBackoffStorageKey);
  let lookupBackoffReason = lookupBackoffUntil ? "rate_limit" : "";
  let lookupFallbackAttempts = readLookupFallbackAttempts();
  // Versions 1.2.0-1.2.1 persisted adaptive pacing. Normal requests are now
  // immediate again; only an explicit quota exhaustion or retry cooldown waits.
  removeStorage("localefence.lookupRequestDelayMs");
  removeStorage("localefence.lastLookupRequestAt");
  removeStorageByPrefix("localefence.lastBlockRequestAt.");
  const setLookupBackoffUntil = (timestamp, reason = "rate_limit") => {
    const now = Date.now();
    lookupBackoffUntil = Number.isFinite(timestamp) && timestamp > now
      ? Math.min(timestamp, now + maximumRateLimitDelayMs)
      : 0;
    lookupBackoffReason = lookupBackoffUntil ? reason : "";
    if (lookupBackoffUntil) writeStorage(lookupBackoffStorageKey, lookupBackoffUntil);
    else removeStorage(lookupBackoffStorageKey);
  };
  const syncLookupBackoffUntil = () => {
    lookupBackoffUntil = readFutureTimestamp(lookupBackoffStorageKey);
    if (!lookupBackoffUntil) lookupBackoffReason = "";
    else if (!lookupBackoffReason) lookupBackoffReason = "rate_limit";
    return lookupBackoffUntil;
  };
  const resetLookupFallbackAttempts = () => {
    lookupFallbackAttempts = 0;
    removeStorage(lookupFallbackAttemptsStorageKey);
  };
  const formatRetryTime = (timestamp) => {
    const date = new Date(timestamp);
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    return sameDay
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  };
  const describeLookupBackoff = () =>
    `Location lookups are rate-limited. LocaleFence will retry at ${formatRetryTime(lookupBackoffUntil)}. ` +
    "Accounts remain queued locally and will resume while X is open.";
  if (lookupBackoffUntil) lookupStatusMessage = describeLookupBackoff();
  const maxLookupRetries = 6;
  const maxLookupQueueEntries = 500;
  const maxCachedAccounts = 5000;
  const maxSharedLookupCacheEntries = 64;
  const maxUnavailableAccountEntries = 256;
  const unavailableAccountTtlMs = 60 * 60 * 1000;
  const maxBlockHistoryEntries = 250;
  const maxPendingTargetsPerAccount = 25;
  const countryRequestTimeoutMs = 20000;
  const blockRequestTimeoutMs = 20000;
  const resolveCountryAlias = (country) =>
    typeof country === "string" ? (countryAliases.get(country) || country) : "";
  const parseSelectedLocations = (value) =>
    (value || "").split("\n").map(resolveCountryAlias).filter(Boolean);
  const storedValues = readStorage("localefence.locations");
  const selectedLocations = new Set(parseSelectedLocations(storedValues));
  const refreshSelectedLocations = () => {
    selectedLocations.clear();
    parseSelectedLocations(readStorage("localefence.locations")).forEach((location) => {
      selectedLocations.add(location);
    });
  };
  const saveSelectedLocations = () => writeStorage("localefence.locations", [...selectedLocations].join("\n"));
  if (storedValues && storedValues !== [...selectedLocations].join("\n")) saveSelectedLocations();
  const storedHideEnabled = readStorage("localefence.hideEnabled");
  let hideEnabled = storedHideEnabled == null || storedHideEnabled === "true";
  const matchStoreRegionStorageKey = "localefence.matchStoreRegion";
  let matchStoreRegion = readStorage(matchStoreRegionStorageKey) === "true";
  let notificationsEnabled = readStorage("localefence.notificationsEnabled") !== "false";
  const notificationSizes = new Set(["compact", "standard", "large"]);
  const storedNotificationSize = readStorage("localefence.notificationSize");
  let notificationSize = notificationSizes.has(storedNotificationSize) ? storedNotificationSize : "compact";
  const notificationPositions = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
  const storedNotificationPosition = readStorage("localefence.notificationPosition");
  let notificationPosition = notificationPositions.has(storedNotificationPosition)
    ? storedNotificationPosition
    : "top-right";
  const storedCountrySort = readStorage("localefence.countrySort");
  let countrySort = [
    "default",
    "selected:asc",
    "selected:desc",
    "name:asc",
    "name:desc",
    "seen:asc",
    "seen:desc",
  ].includes(storedCountrySort)
    ? storedCountrySort
    : "default";
  let renderLocationStats = () => {};
  let renderActionControls = () => {};
  let renderBlockHistory = () => {};
  let renderLookupQueue = () => {};
  let renderLookupStatus = () => {};
  let renderLookupQuota = () => {};
  const saveExcludedUserIds = () =>
    writeStorage(excludedUserIdsStorageKey, [...excludedUserIds].join("\n"));

  // Location data
  const countryFlags = new Map([
    ["Afghanistan", "🇦🇫"],
    ["Africa", "🌐"],
    ["Åland Islands", "🇦🇽"],
    ["Albania", "🇦🇱"],
    ["Algeria", "🇩🇿"],
    ["American Samoa", "🇦🇸"],
    ["Andorra", "🇦🇩"],
    ["Angola", "🇦🇴"],
    ["Anguilla", "🇦🇮"],
    ["Antarctica", "🇦🇶"],
    ["Antigua and Barbuda", "🇦🇬"],
    ["Argentina", "🇦🇷"],
    ["Armenia", "🇦🇲"],
    ["Aruba", "🇦🇼"],
    ["Asia", "🌐"],
    ["Australasia", "🌐"],
    ["Australia", "🇦🇺"],
    ["Austria", "🇦🇹"],
    ["Azerbaijan", "🇦🇿"],
    ["Bahamas", "🇧🇸"],
    ["Bahrain", "🇧🇭"],
    ["Bangladesh", "🇧🇩"],
    ["Barbados", "🇧🇧"],
    ["Belarus", "🇧🇾"],
    ["Belgium", "🇧🇪"],
    ["Belize", "🇧🇿"],
    ["Benin", "🇧🇯"],
    ["Bermuda", "🇧🇲"],
    ["Bhutan", "🇧🇹"],
    ["Bolivia", "🇧🇴"],
    ["Bonaire", "🇧🇶"],
    ["Bosnia and Herzegovina", "🇧🇦"],
    ["Botswana", "🇧🇼"],
    ["Bouvet Island", "🇧🇻"],
    ["Brazil", "🇧🇷"],
    ["British Indian Ocean Territory", "🇮🇴"],
    ["British Virgin Islands", "🇻🇬"],
    ["Brunei Darussalam", "🇧🇳"],
    ["Bulgaria", "🇧🇬"],
    ["Burkina Faso", "🇧🇫"],
    ["Burundi", "🇧🇮"],
    ["Cambodia", "🇰🇭"],
    ["Cameroon", "🇨🇲"],
    ["Canada", "🇨🇦"],
    ["Cape Verde", "🇨🇻"],
    ["Caribbean", "🌐"],
    ["Cayman Islands", "🇰🇾"],
    ["Central African Republic", "🇨🇫"],
    ["Central Asia", "🌐"],
    ["Chad", "🇹🇩"],
    ["Chile", "🇨🇱"],
    ["China", "🇨🇳"],
    ["Christmas Island", "🇨🇽"],
    ["Cocos (Keeling) Islands", "🇨🇨"],
    ["Colombia", "🇨🇴"],
    ["Comoros", "🇰🇲"],
    ["Congo", "🇨🇬"],
    ["Congo, the Democratic Republic of the", "🇨🇩"],
    ["Cook Islands", "🇨🇰"],
    ["Costa Rica", "🇨🇷"],
    ["Côte d'Ivoire", "🇨🇮"],
    ["Croatia", "🇭🇷"],
    ["Cuba", "🇨🇺"],
    ["Curaçao", "🇨🇼"],
    ["Cyprus", "🇨🇾"],
    ["Czech Republic", "🇨🇿"],
    ["Denmark", "🇩🇰"],
    ["Djibouti", "🇩🇯"],
    ["Dominica", "🇩🇲"],
    ["Dominican Republic", "🇩🇴"],
    ["East Asia", "🌐"],
    ["East Asia & Pacific", "🌐"],
    ["Eastern Europe (Non-EU)", "🌐"],
    ["Ecuador", "🇪🇨"],
    ["Egypt", "🇪🇬"],
    ["El Salvador", "🇸🇻"],
    ["Equatorial Guinea", "🇬🇶"],
    ["Eritrea", "🇪🇷"],
    ["Estonia", "🇪🇪"],
    ["Ethiopia", "🇪🇹"],
    ["Europe", "🌐"],
    ["Falkland Islands (Malvinas)", "🇫🇰"],
    ["Faroe Islands", "🇫🇴"],
    ["Fiji", "🇫🇯"],
    ["Finland", "🇫🇮"],
    ["France", "🇫🇷"],
    ["French Guiana", "🇬🇫"],
    ["French Polynesia", "🇵🇫"],
    ["French Southern Territories", "🇹🇫"],
    ["Gabon", "🇬🇦"],
    ["Gambia", "🇬🇲"],
    ["Georgia", "🇬🇪"],
    ["Germany", "🇩🇪"],
    ["Ghana", "🇬🇭"],
    ["Gibraltar", "🇬🇮"],
    ["Greece", "🇬🇷"],
    ["Greenland", "🇬🇱"],
    ["Grenada", "🇬🇩"],
    ["Guadeloupe", "🇬🇵"],
    ["Guam", "🇬🇺"],
    ["Guatemala", "🇬🇹"],
    ["Guernsey", "🇬🇬"],
    ["Guinea", "🇬🇳"],
    ["Guinea-Bissau", "🇬🇼"],
    ["Guyana", "🇬🇾"],
    ["Haiti", "🇭🇹"],
    ["Heard Island and McDonald Islands", "🇭🇲"],
    ["Holy See (Vatican City State)", "🇻🇦"],
    ["Honduras", "🇭🇳"],
    ["Hong Kong", "🇭🇰"],
    ["Hungary", "🇭🇺"],
    ["Iceland", "🇮🇸"],
    ["India", "🇮🇳"],
    ["Indonesia", "🇮🇩"],
    ["Iran", "🇮🇷"],
    ["Iraq", "🇮🇶"],
    ["Ireland", "🇮🇪"],
    ["Isle of Man", "🇮🇲"],
    ["Israel", "🇮🇱"],
    ["Italy", "🇮🇹"],
    ["Jamaica", "🇯🇲"],
    ["Japan", "🇯🇵"],
    ["Jersey", "🇯🇪"],
    ["Jordan", "🇯🇴"],
    ["Kazakhstan", "🇰🇿"],
    ["Kenya", "🇰🇪"],
    ["Kiribati", "🇰🇮"],
    ["Korea", "🇰🇷"],
    ["Korea, Democratic People's Republic of", "🇰🇵"],
    ["Kuwait", "🇰🇼"],
    ["Kyrgyzstan", "🇰🇬"],
    ["Lao People's Democratic Republic", "🇱🇦"],
    ["Latvia", "🇱🇻"],
    ["Lebanon", "🇱🇧"],
    ["Lesotho", "🇱🇸"],
    ["Liberia", "🇱🇷"],
    ["Libya", "🇱🇾"],
    ["Liechtenstein", "🇱🇮"],
    ["Lithuania", "🇱🇹"],
    ["Luxembourg", "🇱🇺"],
    ["Macao", "🇲🇴"],
    ["Macedonia", "🇲🇰"],
    ["Madagascar", "🇲🇬"],
    ["Malawi", "🇲🇼"],
    ["Malaysia", "🇲🇾"],
    ["Maldives", "🇲🇻"],
    ["Mali", "🇲🇱"],
    ["Malta", "🇲🇹"],
    ["Marshall Islands", "🇲🇭"],
    ["Martinique", "🇲🇶"],
    ["Mauritania", "🇲🇷"],
    ["Mauritius", "🇲🇺"],
    ["Mayotte", "🇾🇹"],
    ["Mexico", "🇲🇽"],
    ["Micronesia", "🇫🇲"],
    ["Moldova", "🇲🇩"],
    ["Monaco", "🇲🇨"],
    ["Mongolia", "🇲🇳"],
    ["Montenegro", "🇲🇪"],
    ["Montserrat", "🇲🇸"],
    ["Morocco", "🇲🇦"],
    ["Mozambique", "🇲🇿"],
    ["Myanmar", "🇲🇲"],
    ["Namibia", "🇳🇦"],
    ["Nauru", "🇳🇷"],
    ["Nepal", "🇳🇵"],
    ["Netherlands", "🇳🇱"],
    ["New Caledonia", "🇳🇨"],
    ["New Zealand", "🇳🇿"],
    ["Nicaragua", "🇳🇮"],
    ["Niger", "🇳🇪"],
    ["Nigeria", "🇳🇬"],
    ["Niue", "🇳🇺"],
    ["Norfolk Island", "🇳🇫"],
    ["North Africa", "🌐"],
    ["North America", "🌐"],
    ["Northern Mariana Islands", "🇲🇵"],
    ["Norway", "🇳🇴"],
    ["Oceania", "🌐"],
    ["Oman", "🇴🇲"],
    ["Pakistan", "🇵🇰"],
    ["Palau", "🇵🇼"],
    ["Palestine", "🇵🇸"],
    ["Panama", "🇵🇦"],
    ["Papua New Guinea", "🇵🇬"],
    ["Paraguay", "🇵🇾"],
    ["Peru", "🇵🇪"],
    ["Philippines", "🇵🇭"],
    ["Pitcairn", "🇵🇳"],
    ["Poland", "🇵🇱"],
    ["Portugal", "🇵🇹"],
    ["Puerto Rico", "🇵🇷"],
    ["Qatar", "🇶🇦"],
    ["Réunion", "🇷🇪"],
    ["Romania", "🇷🇴"],
    ["Russian Federation", "🇷🇺"],
    ["Rwanda", "🇷🇼"],
    ["Saint Barthélemy", "🇧🇱"],
    ["Saint Helena, Ascension and Tristan da Cunha", "🇸🇭"],
    ["Saint Kitts and Nevis", "🇰🇳"],
    ["Saint Lucia", "🇱🇨"],
    ["Saint Martin (French part)", "🇲🇫"],
    ["Saint Pierre and Miquelon", "🇵🇲"],
    ["Saint Vincent and the Grenadines", "🇻🇨"],
    ["Samoa", "🇼🇸"],
    ["San Marino", "🇸🇲"],
    ["Sao Tome and Principe", "🇸🇹"],
    ["Saudi Arabia", "🇸🇦"],
    ["Senegal", "🇸🇳"],
    ["Serbia", "🇷🇸"],
    ["Seychelles", "🇸🇨"],
    ["Sierra Leone", "🇸🇱"],
    ["Singapore", "🇸🇬"],
    ["Sint Maarten (Dutch part)", "🇸🇽"],
    ["Slovakia", "🇸🇰"],
    ["Slovenia", "🇸🇮"],
    ["Solomon Islands", "🇸🇧"],
    ["Somalia", "🇸🇴"],
    ["South Africa", "🇿🇦"],
    ["South America", "🌐"],
    ["South Asia", "🌐"],
    ["South Georgia and the South Sandwich Islands", "🇬🇸"],
    ["South Sudan", "🇸🇸"],
    ["Southeast Asia", "🌐"],
    ["Spain", "🇪🇸"],
    ["Sri Lanka", "🇱🇰"],
    ["Sudan", "🇸🇩"],
    ["Suriname", "🇸🇷"],
    ["Svalbard and Jan Mayen", "🇸🇯"],
    ["Swaziland", "🇸🇿"],
    ["Sweden", "🇸🇪"],
    ["Switzerland", "🇨🇭"],
    ["Syrian Arab Republic", "🇸🇾"],
    ["Taiwan", "🇹🇼"],
    ["Tajikistan", "🇹🇯"],
    ["Tanzania", "🇹🇿"],
    ["Thailand", "🇹🇭"],
    ["Timor-Leste", "🇹🇱"],
    ["Togo", "🇹🇬"],
    ["Tokelau", "🇹🇰"],
    ["Tonga", "🇹🇴"],
    ["Trinidad and Tobago", "🇹🇹"],
    ["Tunisia", "🇹🇳"],
    ["Turkey", "🇹🇷"],
    ["Turkmenistan", "🇹🇲"],
    ["Turks and Caicos Islands", "🇹🇨"],
    ["Tuvalu", "🇹🇻"],
    ["Uganda", "🇺🇬"],
    ["Ukraine", "🇺🇦"],
    ["United Arab Emirates", "🇦🇪"],
    ["United Kingdom", "🇬🇧"],
    ["United States", "🇺🇸"],
    ["United States Minor Outlying Islands", "🇺🇲"],
    ["Uruguay", "🇺🇾"],
    ["US Virgin Islands", "🇻🇮"],
    ["Uzbekistan", "🇺🇿"],
    ["Vanuatu", "🇻🇺"],
    ["Venezuela", "🇻🇪"],
    ["Viet Nam", "🇻🇳"],
    ["Wallis and Futuna", "🇼🇫"],
    ["West Asia", "🌐"],
    ["Western Sahara", "🇪🇭"],
    ["Yemen", "🇾🇪"],
    ["Zambia", "🇿🇲"],
    ["Zimbabwe", "🇿🇼"],
  ]);
  const makeContinentGroup = (codes, regionNames) => ({
    codes: new Set(codes.split(" ")),
    regionNames: new Set(regionNames),
  });
  const continentGroups = new Map([
    [
      "Africa",
      makeContinentGroup(
        "DZ EG LY MA SD TN EH IO BI KM DJ ER ET TF KE MG MW MU YT MZ RE RW SC SO SS UG TZ ZM ZW AO CM CF TD CG CD GQ GA ST BW SZ LS NA ZA BJ BF CV CI GM GH GN GW LR ML MR NE NG SH SN SL TG",
        ["Africa", "North Africa"],
      ),
    ],
    [
      "Asia",
      makeContinentGroup(
        "KZ KG TJ TM UZ CN HK MO TW KP JP MN KR BN KH ID LA MY MM PH SG TH TL VN AF BD BT IN IR MV NP PK LK AM AZ BH CY GE IQ IL JO KW LB OM QA SA PS SY TR AE YE",
        ["Asia", "Central Asia", "East Asia & Pacific", "East Asia", "South Asia", "Southeast Asia", "West Asia"],
      ),
    ],
    [
      "Europe",
      makeContinentGroup(
        "BY BG CZ HU PL MD RO RU SK UA AX DK EE FO FI GG IS IE IM JE LV LT NO SJ SE GB AL AD BA HR GI GR VA IT MT ME MK PT SM RS SI ES AT BE FR DE LI LU MC NL CH",
        ["Europe", "Eastern Europe (Non-EU)"],
      ),
    ],
    [
      "North America",
      makeContinentGroup(
        "AI AG AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI BZ CR SV GT HN MX NI PA BM CA GL PM US",
        ["North America", "Caribbean"],
      ),
    ],
    [
      "South America",
      makeContinentGroup("AR BO BV BR CL CO EC FK GF GY PY PE GS SR UY VE", ["South America"]),
    ],
    [
      "Oceania",
      makeContinentGroup(
        "AU CX CC HM NZ NF FJ NC PG SB VU GU KI MH FM NR MP PW UM AS CK PF NU PN WS TK TO TV WF",
        ["Oceania", "Australasia", "East Asia & Pacific"],
      ),
    ],
    ["Antarctica", makeContinentGroup("AQ", ["Antarctica"])],
  ]);
  const flagToCountryCode = (flag) => {
    const codepoints = Array.from(flag || "", (character) => character.codePointAt(0));
    if (codepoints.length !== 2 || codepoints.some((codepoint) => codepoint < 0x1f1e6 || codepoint > 0x1f1ff)) {
      return "";
    }
    return String.fromCharCode(...codepoints.map((codepoint) => codepoint - 0x1f1e6 + 65));
  };
  const countryCodes = new Map(
    [...countryFlags].map(([country, flag]) => [country, flagToCountryCode(flag)]).filter(([, code]) => code),
  );
  const continentIncludesLocation = (continent, location) => {
    const group = continentGroups.get(continent);
    if (!group) return false;
    return group.regionNames.has(location) || group.codes.has(countryCodes.get(location));
  };
  // X formats the About Account "Connected via" label as "<Country> <Platform> App"
  // (for example "Russian Federation Android App" or "United States App Store").
  // Only recognized country + store labels authorize a store-region match.
  // Web, legacy device labels, and unknown formats carry no usable store proof.
  const sourceCountryNames = new Map();
  countryFlags.forEach((flag, country) => {
    if (flag !== "🌐") sourceCountryNames.set(country.toLowerCase(), country);
  });
  countryAliases.forEach((country, alias) => {
    if (sourceCountryNames.has(country.toLowerCase())) sourceCountryNames.set(alias.toLowerCase(), country);
  });
  const extractSourceCountry = (source) => {
    if (typeof source !== "string") return "";
    const label = source.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
    const match = label.match(/^(.+) (?:app store|android app|google play)$/);
    return match ? sourceCountryNames.get(match[1]) || "" : "";
  };
  const createFlagNode = (emoji) => {
    const flag = document.createElement("span");
    flag.setAttribute("aria-hidden", "true");
    flag.textContent = emoji;
    return flag;
  };
  const getPageTheme = () => {
    const color = getComputedStyle(document.body || document.documentElement).color;
    const channels = color.match(/\d+/g)?.slice(0, 3).map(Number);
    return channels && channels.reduce((sum, channel) => sum + channel, 0) < 384 ? "light" : "dark";
  };
  const normalizeTweetUrl = (value) => {
    try {
      const url = new URL(value || "", globalThis.location.origin);
      const isStatusPath =
        /^\/[^/]+\/status\/\d+$/.test(url.pathname) || /^\/i\/web\/status\/\d+$/.test(url.pathname);
      return url.origin === globalThis.location.origin && isStatusPath ? `${url.origin}${url.pathname}` : "";
    } catch {
      return "";
    }
  };
  const safeDate = (value) => {
    const timestamp = Number(value);
    const date = new Date(Number.isFinite(timestamp) ? timestamp : 0);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
  };
  const showToast = (
    message,
    { actionLabel = "", country = "", error = false, onAction = null, postText = "", targetUrl = "" } = {},
  ) => {
    if (!notificationsEnabled) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    targetUrl = normalizeTweetUrl(targetUrl);
    // Small screens get a minimal pill (flag + short text, ~1s, no stacking)
    // tucked under the app header instead of feed-covering cards.
    const miniToast = Boolean(globalThis.matchMedia?.("(max-width: 700px)")?.matches);
    let host = document.querySelector("[data-localefence-toasts]");
    if (!host) {
      host = document.createElement("div");
      host.dataset.localefenceToasts = "true";
      root.appendChild(host);
    }
    host.dataset.theme = getPageTheme();
    host.dataset.size = notificationSize;
    host.dataset.position = miniToast ? "top-right" : notificationPosition;
    if (miniToast) host.replaceChildren();
    const toast = document.createElement("div");
    toast.dataset.localefenceToast = "true";
    if (miniToast) toast.dataset.localefenceMini = "true";
    toast.dataset.error = error.toString();
    toast.dataset.interactive = Boolean((actionLabel && onAction) || targetUrl).toString();
    toast.dataset.clickable = Boolean(targetUrl).toString();
    toast.setAttribute("role", error ? "alert" : "status");
    const icon = document.createElement("span");
    icon.dataset.toastIcon = "true";
    icon.textContent = error ? "!" : "✓";
    const body = document.createElement("span");
    body.dataset.toastBody = "true";
    const copy = document.createElement(targetUrl && !miniToast ? "a" : "span");
    copy.dataset.toastCopy = "true";
    if (targetUrl && !miniToast) {
      copy.href = targetUrl;
      copy.target = "_blank";
      copy.rel = "noopener noreferrer";
      copy.setAttribute("aria-label", `${message}. Open triggering post`);
    }
    body.appendChild(copy);
    const titleRow = document.createElement("span");
    titleRow.dataset.toastTitle = "true";
    if (country) {
      const flag = document.createElement("span");
      flag.dataset.toastFlag = "true";
      flag.setAttribute("role", "img");
      flag.setAttribute("aria-label", country);
      flag.textContent = countryFlags.get(country) || "🌐";
      titleRow.appendChild(flag);
    }
    const title = document.createElement("span");
    title.textContent = message;
    titleRow.appendChild(title);
    copy.appendChild(titleRow);
    if (postText && !miniToast) {
      const post = document.createElement("span");
      post.dataset.toastPost = "true";
      post.textContent = postText;
      copy.appendChild(post);
    }
    if (targetUrl && !miniToast) {
      const hint = document.createElement("span");
      hint.dataset.toastHint = "true";
      hint.textContent = "Click to view post";
      copy.appendChild(hint);
    }
    if (actionLabel && onAction && !miniToast) {
      const action = document.createElement("button");
      action.dataset.toastAction = "true";
      action.type = "button";
      action.textContent = actionLabel;
      action.addEventListener("click", async (event) => {
        event.stopPropagation();
        clearTimeout(removalTimer);
        action.disabled = true;
        action.textContent = "Working…";
        try {
          await onAction();
        } finally {
          toast.remove();
        }
      });
      body.appendChild(action);
    }
    if (miniToast) toast.append(body);
    else toast.append(icon, body);
    host.appendChild(toast);
    requestAnimationFrame(() => {
      toast.dataset.visible = "true";
    });
    const removalTimer = setTimeout(() => {
      toast.dataset.visible = "false";
      setTimeout(() => toast.remove(), 200);
    }, miniToast ? 1200 : actionLabel ? 12000 : postText ? 5200 : 3200);
  };
  const compact = (object) =>
    Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ""));
  const usernameKey = (username) =>
    typeof username === "string" && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username.toLowerCase() : "";
  const parseStoredArray = (key) => {
    try {
      const value = JSON.parse(readStorage(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  // Older cached records have no Connected-via fields. Re-derive the store
  // country from the raw label when present so parser changes apply on read.
  const normalizeAccountSource = (user) => {
    const label = typeof user?.source === "string" ? user.source.trim() : "";
    // Mark truncation so a longer unknown label cannot become valid store proof.
    const source = label.length > 80 ? `${label.slice(0, 79)}…` : label;
    return {
      source,
      // A previously derived country must never override an unrecognized label.
      sourceCountry: extractSourceCountry(source),
      locationWarning: typeof user?.locationWarning === "boolean" ? user.locationWarning : undefined,
    };
  };
  const normalizeAccountName = (name) => (typeof name === "string" ? name : "");
  const normalizeSharedUser = (user) => {
    const updatedAt = Number(user?.updatedAt);
    if (
      !isRestId(user?.restId) ||
      !usernameKey(user?.screenName) ||
      !Number.isFinite(updatedAt) ||
      updatedAt <= 0 ||
      updatedAt > Date.now() + 5 * 60 * 1000 ||
      Date.now() - updatedAt > cacheTtlMs
    ) return null;
    return compact({
      restId: user.restId,
      screenName: user.screenName,
      name: normalizeAccountName(user.name),
      country: resolveCountryAlias(user.country),
      ...normalizeAccountSource(user),
      updatedAt,
    });
  };
  const cacheAboutUserInMemory = (user) => {
    const key = usernameKey(user?.screenName);
    if (!key || !user?.restId) return false;
    const existing = aboutUsers.get(user.restId);
    if (existing && Number(existing.updatedAt) > Number(user.updatedAt)) return false;
    screenNames.forEach((mappedRestId, mappedKey) => {
      if (mappedRestId === user.restId && mappedKey !== key) screenNames.delete(mappedKey);
    });
    aboutUsers.set(user.restId, user);
    const mappedUser = aboutUsers.get(screenNames.get(key));
    if (!mappedUser || Number(mappedUser.updatedAt) <= Number(user.updatedAt)) {
      screenNames.set(key, user.restId);
    }
    return true;
  };
  const readSharedLookupCache = () =>
    parseStoredArray(sharedLookupCacheStorageKey)
      .map(normalizeSharedUser)
      .filter(Boolean)
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, maxSharedLookupCacheEntries);
  const syncSharedLookupCache = (username = "") => {
    const requestedKey = usernameKey(username);
    let requestedUser = null;
    readSharedLookupCache().forEach((user) => {
      cacheAboutUserInMemory(user);
      if (usernameKey(user.screenName) === requestedKey) requestedUser = user;
    });
    return requestedUser;
  };
  const rememberSharedAboutUser = (user) => {
    const key = usernameKey(user?.screenName);
    if (!key || !user?.restId) return;
    const entries = readSharedLookupCache().filter((entry) =>
      entry.restId !== user.restId && usernameKey(entry.screenName) !== key);
    entries.unshift(user);
    writeStorage(sharedLookupCacheStorageKey, JSON.stringify(entries.slice(0, maxSharedLookupCacheEntries)));
  };
  const readUnavailableAccounts = () => {
    const now = Date.now();
    return parseStoredArray(unavailableAccountsStorageKey)
      .map((entry) => ({
        key: usernameKey(entry?.key),
        reason: String(entry?.reason || "Account data unavailable").slice(0, 160),
        until: Number(entry?.until),
      }))
      .filter((entry) => entry.key && entry.until > now && entry.until <= now + unavailableAccountTtlMs)
      .sort((a, b) => Number(b.until) - Number(a.until))
      .slice(0, maxUnavailableAccountEntries);
  };
  const syncUnavailableAccounts = () => {
    unavailableAccounts.clear();
    readUnavailableAccounts().forEach((entry) => unavailableAccounts.set(entry.key, entry));
  };
  const rememberUnavailableAccount = (username, reason = "Account data unavailable") => {
    const key = usernameKey(username);
    if (!key) return;
    const entry = {
      key,
      reason: String(reason || "Account data unavailable").slice(0, 160),
      until: Date.now() + unavailableAccountTtlMs,
    };
    const entries = readUnavailableAccounts().filter((item) => item.key !== key);
    entries.unshift(entry);
    writeStorage(unavailableAccountsStorageKey, JSON.stringify(entries.slice(0, maxUnavailableAccountEntries)));
    unavailableAccounts.set(key, entry);
  };
  const forgetUnavailableAccount = (username) => {
    const key = usernameKey(username);
    if (!key) return;
    unavailableAccounts.delete(key);
    const entries = readUnavailableAccounts().filter((entry) => entry.key !== key);
    if (entries.length) writeStorage(unavailableAccountsStorageKey, JSON.stringify(entries));
    else removeStorage(unavailableAccountsStorageKey);
  };
  const isUnavailableAccount = (username) => {
    const key = usernameKey(username);
    const entry = unavailableAccounts.get(key);
    if (!entry) return false;
    if (Number(entry.until) > Date.now()) return true;
    forgetUnavailableAccount(key);
    return false;
  };
  const parseLookupQuota = (value) => {
    try {
      const quota = JSON.parse(value || "null");
      const observedAt = Number(quota?.observedAt);
      if (!Number.isFinite(observedAt) || observedAt <= 0 || Date.now() - observedAt > maximumRateLimitDelayMs) {
        return null;
      }
      return {
        limit: parseNonNegativeInt(quota.limit),
        observedAt,
        remaining: parseNonNegativeInt(quota.remaining),
        resetAt: parseNonNegativeInt(quota.resetAt) || 0,
      };
    } catch {
      return null;
    }
  };
  let lookupQuota = parseLookupQuota(readStorage(lookupQuotaStorageKey));
  syncSharedLookupCache();
  syncUnavailableAccounts();
  // Persistent cache, lookup queue, and block history
  const dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = globalThis.indexedDB?.open("localefence", 1);
    } catch {
      resolve(null);
      return;
    }
    if (!request) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (db) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("aboutUsers")) db.createObjectStore("aboutUsers");
      if (!db.objectStoreNames.contains("blockHistory")) {
        db.createObjectStore("blockHistory", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("lookupQueue")) {
        db.createObjectStore("lookupQueue", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      finish(db);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });

  const fetchWithTimeout = async (url, options, timeoutMs, readResponse, cancelOnReset = false) => {
    const Controller = globalThis.AbortController;
    const controller = Controller ? new Controller() : null;
    let cancel;
    const cancellation = new Promise((resolve, reject) => {
      cancel = () => {
        controller?.abort();
        const error = new Error("X request timed out or was cancelled");
        error.name = "AbortError";
        reject(error);
      };
    });
    const timeout = setTimeout(cancel, timeoutMs);
    if (cancelOnReset) activeLookupRequests.add(cancel);
    try {
      const request = async () => {
        const response = await globalThis.fetch(url, controller ? { ...options, signal: controller.signal } : options);
        return readResponse(response);
      };
      return await Promise.race([request(), cancellation]);
    } finally {
      clearTimeout(timeout);
      activeLookupRequests.delete(cancel);
    }
  };
  const requestResult = (request, fallback) =>
    new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result ?? fallback);
      request.onerror = () => resolve(fallback);
    });
  const getValues = (db, storeName) => {
    try {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      return requestResult(request, []);
    } catch {
      return Promise.resolve([]);
    }
  };
  const transactionDone = (tx) =>
    new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  const isShallowEqualRecord = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
  };
  // Read and prune in one transaction so another tab's later writes survive.
  const readAndPruneStore = (db, storeName, retainEntries) =>
    new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        let keys;
        let values;
        let retained = [];
        const prune = () => {
          if (!keys || !values) return;
          try {
            const originalByKey = new Map(keys.map((key, index) => [key, values[index]]));
            retained = retainEntries(keys.map((key, index) => [key, values[index]]));
            const retainedKeys = new Set(retained.map(([key]) => key));
            keys.forEach((key) => {
              if (!retainedKeys.has(key)) store.delete(key);
            });
            retained.forEach(([key, value]) => {
              if (originalByKey.has(key) && isShallowEqualRecord(originalByKey.get(key), value)) return;
              if (store.keyPath == null) store.put(value, key);
              else store.put(value);
            });
          } catch {
            tx.abort();
          }
        };
        keysRequest.onsuccess = () => { keys = keysRequest.result; prune(); };
        valuesRequest.onsuccess = () => { values = valuesRequest.result; prune(); };
        tx.oncomplete = () => resolve(retained);
        tx.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  const processAboutUser = (user) => {
    if (!isRestId(user?.rest_id) || !usernameKey(user?.core?.screen_name)) return null;
    return compact({
      restId: user.rest_id,
      screenName: user.core.screen_name,
      name: normalizeAccountName(user.core.name),
      country: resolveCountryAlias(user.about_profile?.account_based_in),
      ...normalizeAccountSource({
        source: user.about_profile?.source,
        // False means no warning was reported, not that the location is verified.
        locationWarning: user.about_profile?.location_accurate === false,
      }),
      updatedAt: Date.now(),
    });
  };
  const normalizeStoredUser = (restId, user) =>
    compact({
      restId: isRestId(user?.restId) ? user.restId : isRestId(restId) ? restId : "",
      screenName: user?.screenName,
      name: normalizeAccountName(user?.name),
      country: resolveCountryAlias(user?.country),
      ...normalizeAccountSource(user),
      updatedAt: Number(user?.updatedAt) || 0,
    });
  const removeScreenNameMappings = (restId, exceptKey = "") => {
    screenNames.forEach((mappedRestId, key) => {
      if (mappedRestId === restId && key !== exceptKey) screenNames.delete(key);
    });
  };
  const pruneAboutUsers = () => {
    if (aboutUsers.size <= maxCachedAccounts) return [];
    const removed = [...aboutUsers.values()]
      .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt))
      .slice(0, aboutUsers.size - maxCachedAccounts);
    removed.forEach((user) => {
      aboutUsers.delete(user.restId);
      removeScreenNameMappings(user.restId);
    });
    return removed.map((user) => user.restId);
  };
  const saveAboutUser = async (user, removedRestIds = [], generation = dataGeneration) => {
    if (!user.restId) return false;
    const key = usernameKey(user.screenName);
    removeScreenNameMappings(user.restId, key);
    if (key) screenNames.set(key, user.restId);
    try {
      const db = await dbPromise;
      if (!db || generation !== dataGeneration || resetInProgress) return false;
      const tx = db.transaction("aboutUsers", "readwrite");
      const store = tx.objectStore("aboutUsers");
      store.put(user, user.restId);
      removedRestIds.forEach((restId) => store.delete(restId));
      return transactionDone(tx);
    } catch {
      return false;
    }
  };
  const saveAboutResponse = async (json, generation = dataGeneration) => {
    const aboutUser = processAboutUser(json?.data?.user_result_by_screen_name?.result);
    if (!aboutUser || generation !== dataGeneration || resetInProgress) return null;
    cacheAboutUserInMemory(aboutUser);
    forgetUnavailableAccount(aboutUser.screenName);
    rememberSharedAboutUser(aboutUser);
    const removedRestIds = pruneAboutUsers();
    await saveAboutUser(aboutUser, removedRestIds, generation);
    return aboutUser;
  };
  const clearCacheStores = async () => {
    cacheClearGeneration += 1;
    unavailableAccounts.clear();
    removeStorage(sharedLookupCacheStorageKey);
    removeStorage(unavailableAccountsStorageKey);
    await hydrationReady;
    try {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction("aboutUsers", "readwrite");
      tx.objectStore("aboutUsers").clear();
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const trimBlockHistory = async () => {
    if (blockHistory.length <= maxBlockHistoryEntries) return;
    const removed = blockHistory.splice(maxBlockHistoryEntries);
    try {
      const db = await dbPromise;
      if (!db || !removed.length) return;
      const tx = db.transaction("blockHistory", "readwrite");
      const store = tx.objectStore("blockHistory");
      removed.forEach(({ id }) => {
        if (id != null) store.delete(id);
      });
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const loadBlockHistory = async (db, startHistoryClear = historyClearGeneration, startGeneration = dataGeneration) => {
    const entries = await getValues(db, "blockHistory");
    if (startHistoryClear !== historyClearGeneration || startGeneration !== dataGeneration || resetInProgress) return;
    blockHistory.splice(
      0,
      blockHistory.length,
      ...entries
        .filter((entry) => entry?.id != null && entry?.restId && entry?.username)
        .sort((a, b) => Number(b.blockedAt) - Number(a.blockedAt)),
    );
    let migratedBlockedAccounts = false;
    blockHistory.forEach((entry) => {
      if (!["blocked", "unblock_failed"].includes(entry.status || "blocked")) return;
      const key = blockAccountKey(entry.ownerRestId, entry.restId);
      if (key && !blockedAccountKeys.has(key)) {
        blockedAccountKeys.add(key);
        migratedBlockedAccounts = true;
      }
    });
    if (migratedBlockedAccounts) {
      trimBlockedAccountKeys();
      saveBlockedAccountKeys();
    }
    if (storedTotalBlocked == null && blockHistory.length) {
      totalBlockedCount = blockHistory.length;
      writeStorage("localefence.totalBlocked", totalBlockedCount);
      renderActionControls();
    }
    await trimBlockHistory();
    renderBlockHistory();
  };
  const addBlockHistoryEntry = async (entry) => {
    const generation = dataGeneration;
    if (resetInProgress) return null;
    let id = `memory:${Date.now()}:${entry.restId}`;
    try {
      const db = await dbPromise;
      if (db && generation === dataGeneration && !resetInProgress) {
        const tx = db.transaction("blockHistory", "readwrite");
        const done = transactionDone(tx);
        const request = tx.objectStore("blockHistory").add(entry);
        const persistedId = await new Promise((resolve) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        });
        if (await done && persistedId != null) id = persistedId;
      }
    } catch { /* Keep the entry in memory when IndexedDB is unavailable. */ }
    if (generation !== dataGeneration || resetInProgress) return null;
    const savedEntry = { ...entry, id };
    blockHistory.unshift(savedEntry);
    await trimBlockHistory();
    renderBlockHistory();
    return savedEntry;
  };
  const updateBlockHistoryStatus = async (id, status) => {
    if (id == null) return;
    const entry = blockHistory.find((item) => item.id === id);
    if (!entry) return;
    const generation = dataGeneration;
    entry.status = status;
    renderBlockHistory();
    try {
      const db = await dbPromise;
      if (!db || generation !== dataGeneration || resetInProgress || !blockHistory.includes(entry)) return;
      const tx = db.transaction("blockHistory", "readwrite");
      tx.objectStore("blockHistory").put(entry);
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const clearBlockHistory = async (broadcast = false) => {
    historyClearGeneration += 1;
    blockHistory.length = 0;
    renderBlockHistory();
    if (broadcast) writeStorage(historyClearSignalStorageKey, `${Date.now()}:${Math.random()}`);
    await hydrationReady;
    try {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction("blockHistory", "readwrite");
      tx.objectStore("blockHistory").clear();
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const persistLookupRecord = async (record) => {
    if (resetInProgress) return;
    const generation = dataGeneration;
    lookupRecords.set(record.key, record);
    renderLookupQueue();
    try {
      const db = await dbPromise;
      if (!db || generation !== dataGeneration || resetInProgress || lookupRecords.get(record.key) !== record) return;
      const tx = db.transaction("lookupQueue", "readwrite");
      tx.objectStore("lookupQueue").put(record);
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const removeLookupRecord = async (username) => {
    const generation = dataGeneration;
    const key = usernameKey(username);
    const record = lookupRecords.get(key);
    const timer = lookupRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    lookupRetryTimers.delete(key);
    lookupAttempts.delete(key);
    pending.delete(key);
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (usernameKey(queue[index]) === key) queue.splice(index, 1);
    }
    for (let index = blockQueue.length - 1; index >= 0; index -= 1) {
      if (usernameKey(blockQueue[index].username) !== key) continue;
      queuedBlockIds.delete(blockQueue[index].restId);
      blockQueue.splice(index, 1);
    }
    lookupRecords.delete(key);
    renderLookupQueue();
    renderActionControls();
    try {
      const db = await dbPromise;
      if (!db || generation !== dataGeneration || resetInProgress || lookupRecords.has(key)) return;
      const tx = db.transaction("lookupQueue", "readwrite");
      tx.objectStore("lookupQueue").delete(key);
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
    return record;
  };
  const updateLookupRecord = (username, changes) => {
    const key = usernameKey(username);
    const record = lookupRecords.get(key);
    if (!record) return Promise.resolve(null);
    Object.assign(record, changes, { updatedAt: Date.now() });
    return persistLookupRecord(record).then(() => record);
  };
  const rememberLookupRecord = (username, snapshot) => {
    const key = usernameKey(username);
    if (!key) return null;
    const existing = lookupRecords.get(key);
    if (existing) return existing;
    if (lookupRecords.size >= maxLookupQueueEntries) {
      const oldest = [...lookupRecords.values()].sort((a, b) => Number(a.enqueuedAt) - Number(b.enqueuedAt))[0];
      if (oldest) removeLookupRecord(oldest.username);
    }
    const record = {
      key,
      username,
      ownerRestId: getOwnRestId() || "",
      tweetText: snapshot.tweetText,
      tweetUrl: snapshot.tweetUrl,
      enqueuedAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      status: "lookup",
      lastError: "",
    };
    persistLookupRecord(record);
    return record;
  };
  const clearLookupRecords = async (broadcast = false) => {
    queueClearGeneration += 1;
    clearTimeout(queueTimer);
    clearBlockQueue();
    if (broadcast) writeStorage(queueClearSignalStorageKey, `${Date.now()}:${Math.random()}`);
    setLookupBackoffUntil(0);
    resetLookupFallbackAttempts();
    lookupRecords.forEach((record) => {
      const timer = lookupRetryTimers.get(record.key);
      if (timer) clearTimeout(timer);
      lookupRetryTimers.delete(record.key);
      lookupAttempts.delete(record.key);
      pending.delete(record.key);
    });
    const keys = new Set(lookupRecords.keys());
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (keys.has(usernameKey(queue[index]))) queue.splice(index, 1);
    }
    lookupRecords.clear();
    renderLookupQueue();
    setLookupStatus();
    await hydrationReady;
    try {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction("lookupQueue", "readwrite");
      tx.objectStore("lookupQueue").clear();
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const retryLookupRecord = (key) => {
    const record = lookupRecords.get(key);
    if (!record) return;
    clearLookupRetry(record.username);
    record.status = "lookup";
    record.attempts = 0;
    record.lastError = "";
    persistLookupRecord(record);
    if (!pending.has(key)) pending.set(key, []);
    if (!queue.some((username) => usernameKey(username) === key)) queue.push(record.username);
    setLookupStatus("Retrying queued location lookup…");
    scheduleQueue();
  };

  // Matching, blocking, and exclusions
  const isCountrySelected = (country) => selectedLocations.has(country);
  const isLocationMatched = (location) => {
    if (!location) return false;
    if (selectedLocations.has(location)) return true;
    return [...selectedLocations].some((selected) => continentIncludesLocation(selected, location));
  };
  // The reported location decides first; the opt-in Connected-via store region
  // is only a fallback, so an account whose reported country matches is never
  // attributed to its store region.
  const matchAccountLocation = (account) => {
    if (!account) return { country: "", viaStore: false };
    if (account.country && isLocationMatched(account.country)) {
      return { country: account.country, viaStore: false };
    }
    if (matchStoreRegion && account.sourceCountry && isLocationMatched(account.sourceCountry)) {
      return { country: account.sourceCountry, viaStore: true };
    }
    return { country: "", viaStore: false };
  };
  const isAccountHidden = (account) => hideEnabled && Boolean(matchAccountLocation(account).country);
  const isAccountBlocked = (account) =>
    blockEnabled && !blockPaused && Boolean(matchAccountLocation(account).country);
  const clearBlockQueue = () => {
    blockQueue.length = 0;
    queuedBlockIds.clear();
  };
  const disableBlocking = (message = "", persist = true) => {
    blockEnabled = false;
    blockPaused = false;
    blockErrorMessage = message;
    if (persist) {
      writeStorage(blockEnabledStorageKey, false);
      writeStorage(blockPausedStorageKey, false);
    }
    clearBlockQueue();
    lookupRecords.forEach((record) => {
      if (record.status === "awaiting_block") removeLookupRecord(record.username);
    });
    renderActionControls();
  };
  const resetLocaleFenceData = async (broadcast = true) => {
    if (resetInProgress) return;
    resetInProgress = true;
    lastResetAt = Date.now();
    dataGeneration += 1;
    clearTimeout(queueTimer);
    activeLookupRequests.forEach((cancel) => cancel());
    if (broadcast) writeStorage(resetSignalStorageKey, `${Date.now()}:${Math.random()}`);
    try {
      disableBlocking("", false);
      await hydrationReady;
      dataGeneration += 1;
      await Promise.all([clearLookupRecords(), clearBlockHistory(), clearCacheStores()]);
      aboutUsers.clear();
      screenNames.clear();
      selectedLocations.clear();
      excludedUserIds.clear();
      blockedAccountKeys.clear();
      rejectedAboutQueryIds.clear();
      aboutQueryId = fallbackAboutQueryId;
      blockOwnerRestId = "";
      hideEnabled = true;
      matchStoreRegion = false;
      notificationsEnabled = true;
      notificationSize = "compact";
      notificationPosition = "top-right";
      lookupQuota = null;
      countrySort = "default";
      blockSuccessCount = 0;
      totalBlockedCount = 0;
      blockErrorMessage = "";
      setLookupStatus();
      removeStorageByPrefix("localefence.");
      document.querySelectorAll("[data-account-based-in]").forEach((node) => node.remove());
      document.querySelectorAll("[data-localefence-hidden]").forEach((node) => {
        delete node.dataset.localefenceHidden;
      });
      document.querySelector("[data-localefence-toasts]")?.remove();
      renderLocationStats();
      renderLookupQueue();
      renderBlockHistory();
      renderActionControls();
      renderLookupQuota();
    } finally {
      resetInProgress = false;
    }
  };
  const ensureBlockOwner = () => {
    if (!blockEnabled) return false;
    if (blockOwnerRestId && blockOwnerRestId === getOwnRestId()) return true;
    const message = "Automatic blocking was turned off because the signed-in X account changed.";
    disableBlocking(message);
    showToast(message, { error: true });
    return false;
  };
  const syncBlockingPreferences = () => {
    // Storage events can arrive after a newer failure or user setting. Only
    // the current persisted values may resume work; observers never clear a pause.
    const nextOwner = readStorage(blockOwnerStorageKey) || "";
    const enabled = readStorage(blockEnabledStorageKey) === "true";
    const ownerChanged = blockOwnerRestId !== nextOwner;
    blockOwnerRestId = nextOwner;
    if (!enabled || nextOwner !== getOwnRestId() || !selectedLocations.size) {
      disableBlocking(enabled
        ? "Automatic blocking was not enabled because the active X account or filters differ."
        : "", false);
      return;
    }
    if (ownerChanged) clearBlockQueue();
    blockEnabled = true;
    blockPaused = readStorage(blockPausedStorageKey) === "true";
    blockErrorMessage = blockPaused
      ? "Paused after a block request error. Turn blocking off and on to retry."
      : "";
    if (blockPaused) clearBlockQueue();
    else {
      refreshProcessedAccounts();
      resumeAwaitingBlocks();
    }
    renderActionControls();
  };
  globalThis.addEventListener("storage", (event) => {
    if (event.key === resetSignalStorageKey) {
      if (event.newValue) void resetLocaleFenceData(false);
    } else if (event.key === queueClearSignalStorageKey) {
      if (event.newValue) {
        queueClearGeneration += 1;
        clearTimeout(queueTimer);
        clearBlockQueue();
        lookupBackoffUntil = 0;
        lookupBackoffReason = "";
        lookupFallbackAttempts = 0;
        lookupRecords.forEach((record) => {
          const timer = lookupRetryTimers.get(record.key);
          if (timer) clearTimeout(timer);
          lookupRetryTimers.delete(record.key);
          lookupAttempts.delete(record.key);
          pending.delete(record.key);
        });
        const keys = new Set(lookupRecords.keys());
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          if (keys.has(usernameKey(queue[index]))) queue.splice(index, 1);
        }
        lookupRecords.clear();
        renderLookupQueue();
        renderActionControls();
        setLookupStatus();
      }
    } else if (event.key === historyClearSignalStorageKey) {
      if (event.newValue) {
        historyClearGeneration += 1;
        blockHistory.length = 0;
        renderBlockHistory();
      }
    } else if (event.key === null) {
      blockOwnerRestId = "";
      lookupBackoffUntil = 0;
      lookupBackoffReason = "";
      selectedLocations.clear();
      excludedUserIds.clear();
      blockedAccountKeys.clear();
      hideEnabled = true;
      matchStoreRegion = false;
      notificationsEnabled = true;
      notificationSize = "compact";
      notificationPosition = "top-right";
      lookupQuota = null;
      unavailableAccounts.clear();
      totalBlockedCount = 0;
      if (blockEnabled) disableBlocking("", false);
      blockPaused = false;
      setLookupStatus();
      refreshProcessedAccounts();
      renderLocationStats();
      renderActionControls();
      renderLookupQuota();
    } else if ([blockOwnerStorageKey, blockEnabledStorageKey, blockPausedStorageKey].includes(event.key)) {
      syncBlockingPreferences();
    } else if (event.key === lookupBackoffStorageKey) {
      syncLookupBackoffUntil();
      if (lookupBackoffUntil) {
        setLookupStatus(describeLookupBackoff());
        if (document.visibilityState !== "hidden") {
          scheduleQueue(Math.max(lookupBackoffUntil - Date.now(), 1000));
        }
      } else {
        setLookupStatus();
        if (document.visibilityState !== "hidden" && queue.length) scheduleQueue();
      }
    } else if (event.key === lookupFallbackAttemptsStorageKey) {
      lookupFallbackAttempts = Math.floor(clamp(Number(event.newValue) || 0, 0, 9));
    } else if (event.key === "localefence.locations") {
      selectedLocations.clear();
      parseSelectedLocations(event.newValue).forEach((location) => {
        selectedLocations.add(location);
      });
      refreshProcessedAccounts();
      resumeAwaitingBlocks();
      renderLocationStats();
    } else if (event.key === "localefence.hideEnabled") {
      hideEnabled = event.newValue == null || event.newValue === "true";
      refreshProcessedAccounts();
      renderActionControls();
    } else if (event.key === matchStoreRegionStorageKey) {
      matchStoreRegion = event.newValue === "true";
      refreshProcessedAccounts();
      resumeAwaitingBlocks();
      renderLocationStats();
      renderActionControls();
    } else if (event.key === "localefence.notificationsEnabled") {
      notificationsEnabled = event.newValue !== "false";
      if (!notificationsEnabled) document.querySelector("[data-localefence-toasts]")?.remove();
      renderActionControls();
    } else if (event.key === "localefence.notificationSize") {
      notificationSize = notificationSizes.has(event.newValue) ? event.newValue : "compact";
      const toastHost = document.querySelector("[data-localefence-toasts]");
      if (toastHost) toastHost.dataset.size = notificationSize;
      renderActionControls();
    } else if (event.key === "localefence.notificationPosition") {
      notificationPosition = notificationPositions.has(event.newValue) ? event.newValue : "top-right";
      const toastHost = document.querySelector("[data-localefence-toasts]");
      if (toastHost) toastHost.dataset.position = notificationPosition;
      renderActionControls();
    } else if (event.key === sharedLookupCacheStorageKey) {
      if (event.newValue == null) {
        aboutUsers.clear();
        screenNames.clear();
        document.querySelectorAll("[data-account-based-in]").forEach((node) => node.remove());
        document.querySelectorAll("[data-localefence-hidden]").forEach((node) => {
          delete node.dataset.localefenceHidden;
        });
        // A reset in another tab clears the shared cache too. Leave the
        // already-visible feed empty until new posts or a later page scan.
        if (!resetInProgress && (!lastResetAt || Date.now() - lastResetAt > 5000)) findTweets(document);
        renderLocationStats();
      } else {
        syncSharedLookupCache();
      }
    } else if (event.key === unavailableAccountsStorageKey) {
      syncUnavailableAccounts();
    } else if (event.key === lookupQuotaStorageKey) {
      lookupQuota = parseLookupQuota(event.newValue);
      renderLookupQuota();
    } else if (event.key === excludedUserIdsStorageKey) {
      excludedUserIds.clear();
      (event.newValue || "").split("\n").filter(Boolean).forEach((restId) => excludedUserIds.add(restId));
      pruneAwaitingBlocks();
      refreshProcessedAccounts();
      renderActionControls();
    } else if (event.key === blockedAccountStorageKey) {
      refreshBlockedAccountKeys();
      pruneAwaitingBlocks();
    } else if (event.key === "localefence.totalBlocked") {
      const nextTotal = Number(event.newValue);
      totalBlockedCount = Number.isFinite(nextTotal) && nextTotal >= 0 ? nextTotal : 0;
      renderActionControls();
    }
  });
  const pauseBlocking = (message) => {
    blockPaused = true;
    blockErrorMessage = message;
    writeStorage(blockPausedStorageKey, true);
    clearBlockQueue();
    renderActionControls();
    showToast(message, { error: true });
  };
  const markFeedAccount = (username, status) => {
    const key = usernameKey(username);
    document.querySelectorAll("[data-account-username]").forEach((node) => {
      if (usernameKey(node.dataset.accountUsername) !== key) return;
      let badge = node.querySelector("[data-account-state]");
      if (!badge) {
        badge = document.createElement("span");
        badge.dataset.accountState = "true";
        node.appendChild(badge);
      }
      badge.dataset.state = status.toLowerCase();
      badge.textContent = status;
      const baseLabel = node.dataset.accountAriaBase || node.getAttribute?.("aria-label") || "";
      if (baseLabel) {
        node.dataset.accountAriaBase = baseLabel;
        node.setAttribute?.("aria-label", `${baseLabel}. ${status}`);
      }
    });
  };
  const sendBlockRequest = async (restId, url) => {
    if (!isRestId(restId)) throw new Error("The X account ID is invalid");
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new Error("X session CSRF token is unavailable");
    let response;
    let responseJson;
    try {
      ({ response, json: responseJson } = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          authorization: authToken,
          "content-type": "application/x-www-form-urlencoded",
          "x-csrf-token": csrfToken,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-client-language": document.documentElement?.lang?.split("-")[0] || "en",
        },
        credentials: "include",
        body: new URLSearchParams({ user_id: restId }).toString(),
      }, blockRequestTimeoutMs, async (response) => {
        let json = null;
        try {
          json = await response.json();
        } catch (error) {
          if (error?.name === "AbortError") throw error;
        }
        return { response, json };
      }));
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("X request timed out; its result is unknown");
      }
      throw error;
    }
    const details = responseJson?.errors?.map((error) => error.message).filter(Boolean).join("; ") || "";
    if (response.ok && !details) return responseJson;
    throw new Error(`X returned ${response.status}${details ? `: ${details}` : ""}`);
  };
  const blockAccount = (restId) => sendBlockRequest(restId, blockUrl);
  const unblockAccount = (restId) => sendBlockRequest(restId, unblockUrl);
  const getAccountLabel = (restId, username) => {
    const rawName = aboutUsers.get(restId)?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    return name ? `${name} (@${username})` : `@${username}`;
  };
  const withBlockRequestLock = (ownerRestId, callback) => {
    return withExclusiveWebLock(`localefence:block-request:${ownerRestId}`, callback);
  };
  const excludeAndUnblock = async ({ country, historyId, ownerRestId, restId, username }) => {
    if (!ownerRestId || ownerRestId !== getOwnRestId()) {
      showToast("Switch back to the X account that created this block before changing it.", { error: true });
      return false;
    }
    const label = getAccountLabel(restId, username);
    excludedUserIds.add(restId);
    saveExcludedUserIds();
    pruneAwaitingBlocks();
    try {
      await unblockAccount(restId);
    } catch (error) {
      markFeedAccount(username, "Blocked");
      try {
        await updateBlockHistoryStatus(historyId, "unblock_failed");
      } catch { /* The unblock result is more important than local history rendering. */ }
      showToast(
        `${label} is excluded from future blocking, but X could not undo the current block: ${error?.message || "unblock request failed"}`,
        { error: true },
      );
      renderActionControls();
      return true;
    }
    forgetBlockedAccount(ownerRestId, restId);
    markFeedAccount(username, "Excluded");
    try {
      await updateBlockHistoryStatus(historyId, "excluded");
    } catch { /* The successful unblock remains authoritative. */ }
    showToast(`${label} was unblocked and excluded`, { country });
    renderActionControls();
    return true;
  };
  const refreshBlockingStateFromStorage = (requestOwnerRestId) => {
    refreshBlockedAccountKeys();
    refreshExcludedUserIds();
    refreshSelectedLocations();
    matchStoreRegion = readStorage(matchStoreRegionStorageKey) === "true";
    const storedOwner = readStorage(blockOwnerStorageKey) || "";
    const storedEnabled = readStorage(blockEnabledStorageKey) === "true";
    const storedPaused = readStorage(blockPausedStorageKey) === "true";
    if (!storedEnabled || storedOwner !== requestOwnerRestId || storedOwner !== getOwnRestId() || !selectedLocations.size) {
      if (!storedEnabled || storedOwner !== getOwnRestId()) {
        blockOwnerRestId = storedOwner;
        disableBlocking(storedEnabled
          ? "Automatic blocking was not enabled because the active X account or filters differ."
          : "", false);
      }
      return "cancelled";
    }
    if (storedPaused) {
      blockPaused = true;
      blockErrorMessage = "Paused after a block request error. Turn blocking off and on to retry.";
      clearBlockQueue();
      renderActionControls();
      return "paused";
    }
    return "ready";
  };
  const processBlockQueue = async () => {
    if (blockProcessing) return;
    blockProcessing = true;
    try {
      while (blockEnabled && !blockPaused && blockQueue.length) {
        const generation = dataGeneration;
        const { restId, tweetText, tweetUrl, username } = blockQueue.shift();
        queuedBlockIds.delete(restId);
        inFlightBlockIds.add(restId);
        try {
          const key = usernameKey(username);
          const cached = getCachedAccount(username);
          if (!lookupRecords.has(key)) continue;
          if (isKnownBlocked(blockOwnerRestId, restId)) {
            markFeedAccount(username, "Blocked");
            await removeLookupRecord(username);
            continue;
          }
          if (excludedUserIds.has(restId)) {
            markFeedAccount(username, "Excluded");
            await removeLookupRecord(username);
            continue;
          }
          if (
            !cached ||
            !isAccountBlocked(cached) ||
            screenNames.get(key) !== restId ||
            restId === getOwnRestId()
          ) {
            if (!blockPaused) await removeLookupRecord(username);
            continue;
          }
          if (!ensureBlockOwner()) break;
          const requestOwnerRestId = blockOwnerRestId;
          let outcome = "cancelled";
          let requestMatch;
          try {
            outcome = await withBlockRequestLock(requestOwnerRestId, async () => {
              if (generation !== dataGeneration || resetInProgress) return "cancelled";
              const syncState = refreshBlockingStateFromStorage(requestOwnerRestId);
              if (syncState !== "ready") return syncState;
              if (isKnownBlocked(requestOwnerRestId, restId)) return "known";
              if (excludedUserIds.has(restId)) return "excluded";
              if (!lookupRecords.has(key) || !ensureBlockOwner() || blockOwnerRestId !== requestOwnerRestId) {
                return "cancelled";
              }
              const latestCached = getCachedAccount(username);
              if (
                !latestCached ||
                !isAccountBlocked(latestCached) ||
                screenNames.get(key) !== restId ||
                restId === getOwnRestId()
              ) return "cancelled";
              // Record the reason at dispatch. Settings or cached metadata can
              // change while X is processing the request.
              requestMatch = matchAccountLocation(latestCached);
              try {
                await blockAccount(restId);
              } catch (error) {
                // Persist the safety pause before releasing the cross-tab lock so
                // waiting tabs observe it before issuing another block request.
                if (generation === dataGeneration && !resetInProgress) {
                  pauseBlocking(
                    `Paused after an error: ${error?.message || "block request failed"}. Turn blocking off and on to retry.`,
                  );
                }
                return "failed";
              }
              if (generation !== dataGeneration || resetInProgress) return "cancelled";
              rememberBlockedAccount(requestOwnerRestId, restId);
              const persistedTotal = Number(readStorage("localefence.totalBlocked"));
              const baseTotal = Number.isFinite(persistedTotal) && persistedTotal >= 0
                ? Math.max(persistedTotal, totalBlockedCount)
                : totalBlockedCount;
              totalBlockedCount = baseTotal + 1;
              writeStorage("localefence.totalBlocked", totalBlockedCount);
              return "blocked";
            });
          } catch (error) {
            if (generation !== dataGeneration || resetInProgress) continue;
            pauseBlocking(
              `Paused after an error: ${error?.message || "block request failed"}. Turn blocking off and on to retry.`,
            );
            break;
          }
          if (generation !== dataGeneration || resetInProgress) continue;
          if (outcome === "known") {
            markFeedAccount(username, "Blocked");
            await removeLookupRecord(username);
            continue;
          }
          if (outcome === "excluded") {
            markFeedAccount(username, "Excluded");
            await removeLookupRecord(username);
            continue;
          }
          if (outcome === "paused" || outcome === "failed") break;
          if (outcome !== "blocked") {
            if (!blockPaused && lookupRecords.has(key)) await removeLookupRecord(username);
            continue;
          }
          const { country: blockedCountry, viaStore: blockedViaStore } = requestMatch;
          blockSuccessCount += 1;
          const label = getAccountLabel(restId, username);
          markFeedAccount(username, "Blocked");
          const removal = removeLookupRecord(username);
          try {
            const rawName = aboutUsers.get(restId)?.name;
            const historyEntry = await addBlockHistoryEntry({
              restId,
              ownerRestId: requestOwnerRestId,
              username,
              name: typeof rawName === "string" ? rawName.trim() : "",
              country: blockedCountry,
              matchSource: blockedViaStore ? "store" : "location",
              tweetText,
              tweetUrl,
              blockedAt: Date.now(),
              status: "blocked",
            });
            await removal;
            if (generation !== dataGeneration || resetInProgress) continue;
            showToast(`${label} was blocked${blockedViaStore ? " · store region match" : ""}`, {
              actionLabel: "Exclude",
              country: blockedCountry,
              onAction: () => excludeAndUnblock({
                country: blockedCountry,
                historyId: historyEntry?.id,
                ownerRestId: historyEntry?.ownerRestId,
                restId,
                username,
              }),
              postText: tweetText,
              targetUrl: tweetUrl,
            });
          } catch (error) {
            await removal;
            if (generation !== dataGeneration || resetInProgress) continue;
            console.warn("LocaleFence blocked an account but could not finish local bookkeeping", error);
            showToast(`${label} was blocked, but LocaleFence could not save its local history.`, {
              country: blockedCountry,
              error: true,
              postText: tweetText,
              targetUrl: tweetUrl,
            });
          }
          renderActionControls();
        } finally {
          inFlightBlockIds.delete(restId);
        }
      }
    } finally {
      blockProcessing = false;
      renderActionControls();
    }
  };
  const getTweetSnapshot = (tweet) => {
    const textNode =
      [...(tweet?.querySelectorAll?.('[data-testid="tweetText"]') || [])].find((node) => belongsToTweet(node, tweet)) ||
      tweet?.querySelector?.('[data-testid="tweetText"]') ||
      [...(tweet?.querySelectorAll?.('div[dir="auto"][lang]') || [])].find((node) => belongsToTweet(node, tweet));
    const text = textNode?.textContent?.replace(/\s+/g, " ").trim();
    const hasMedia = Boolean(
      tweet?.querySelector?.('[data-testid="tweetPhoto"], video') ||
      [...(tweet?.querySelectorAll?.("img") || [])].some(
        (img) => belongsToTweet(img, tweet) && !img.closest?.('a[href^="/"]'),
      ),
    );
    const tweetText = text
      ? text.length > 320
        ? `${text.slice(0, 319)}…`
        : text
      : hasMedia
        ? "Media post"
        : "Post text unavailable";
    const timeLink = tweet?.querySelector?.("time")?.closest?.('a[href*="/status/"]');
    const directStatusLink = [...(tweet?.querySelectorAll?.('a[href*="/status/"]') || [])].find(
      (link) => belongsToTweet(link, tweet) && normalizeTweetUrl(link.getAttribute("href")),
    );
    const wrapperStatusLink = tweet?.parentElement?.matches?.('[role="link"]')
      ? [...(tweet.parentElement.children || [])].find(
          (child) => child.matches?.('a[href*="/status/"]') && normalizeTweetUrl(child.getAttribute("href")),
        )
      : null;
    const link = timeLink || directStatusLink || wrapperStatusLink || tweet?.querySelector?.('a[href*="/status/"]');
    const tweetUrl = normalizeTweetUrl(link?.getAttribute("href"));
    return { tweetText, tweetUrl };
  };
  const enqueueBlock = (username, matched, tweet, savedSnapshot = null) => {
    const { country } = matched;
    if (!blockEnabled || blockPaused || !isLocationMatched(country) || !ensureBlockOwner()) return false;
    const verifiedUser = savedSnapshot?.verifiedUser;
    const key = usernameKey(username);
    if (
      !verifiedUser?.restId ||
      usernameKey(verifiedUser.screenName) !== key ||
      matchAccountLocation(verifiedUser).country !== country
    ) {
      return false;
    }
    const restId = verifiedUser.restId;
    if (!restId || restId === getOwnRestId()) return false;
    if (excludedUserIds.has(restId)) {
      markFeedAccount(username, "Excluded");
      return false;
    }
    if (isKnownBlocked(blockOwnerRestId, restId)) {
      markFeedAccount(username, "Blocked");
      return false;
    }
    if (queuedBlockIds.has(restId) || inFlightBlockIds.has(restId)) return true;
    queuedBlockIds.add(restId);
    const snapshot = savedSnapshot || getTweetSnapshot(tweet);
    blockQueue.push({
      restId,
      username,
      tweetText: snapshot.tweetText,
      tweetUrl: snapshot.tweetUrl,
    });
    processBlockQueue();
    renderActionControls();
    return true;
  };
  const pruneAwaitingBlocks = () => {
    lookupRecords.forEach((record) => {
      if (record.status !== "awaiting_block" || !record.country) return;
      if (
        !blockEnabled ||
        record.ownerRestId !== blockOwnerRestId ||
        (record.matchSource === "store" && !matchStoreRegion) ||
        !isLocationMatched(record.country) ||
        (record.restId && excludedUserIds.has(record.restId)) ||
        (record.restId && isKnownBlocked(blockOwnerRestId, record.restId))
      ) {
        removeLookupRecord(record.username);
      }
    });
  };
  const resumeAwaitingBlocks = () => {
    pruneAwaitingBlocks();
    lookupRecords.forEach((record) => {
      if (record.status !== "awaiting_block" || !record.country) return;
      if (blockPaused) return;
      if (record.restId && (queuedBlockIds.has(record.restId) || inFlightBlockIds.has(record.restId))) return;
      record.status = "lookup";
      record.attempts = 0;
      record.lastError = "";
      persistLookupRecord(record);
      if (!pending.has(record.key)) pending.set(record.key, []);
      if (!queue.some((username) => usernameKey(username) === record.key)) queue.push(record.username);
    });
    if (queue.length) scheduleQueue();
  };
  const resolveLookupRecord = (username, account, targets = []) => {
    const key = usernameKey(username);
    const lookupRecord = lookupRecords.get(key);
    if (!lookupRecord) return;
    if (blockEnabled) ensureBlockOwner();
    const identityVerified = account?.restId && usernameKey(account.screenName) === key;
    const restId = identityVerified ? account.restId : "";
    const excluded = restId && excludedUserIds.has(restId);
    const matched = matchAccountLocation(account);
    // Records from older versions have no owner and cannot authorize a block.
    const recordBelongsToOwner = lookupRecord.ownerRestId && lookupRecord.ownerRestId === blockOwnerRestId;
    if (
      blockEnabled &&
      recordBelongsToOwner &&
      matched.country &&
      identityVerified &&
      !excluded
    ) {
      const snapshot = { tweetText: lookupRecord.tweetText, tweetUrl: lookupRecord.tweetUrl };
      updateLookupRecord(username, {
        status: "awaiting_block",
        attempts: 0,
        lastError: "",
        country: matched.country,
        matchSource: matched.viaStore ? "store" : "location",
        ownerRestId: blockOwnerRestId,
        restId,
        name: typeof account.name === "string" ? account.name.trim() : "",
      });
      if (!blockPaused && !enqueueBlock(username, matched, targets[0]?.tweet, {
        ...snapshot,
        verifiedUser: account,
      })) {
        removeLookupRecord(username);
      }
    } else {
      removeLookupRecord(username);
    }
  };
  const isCacheExpired = (updatedAt) => {
    const timestamp = Number(updatedAt);
    const now = Date.now();
    return !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 5 * 60 * 1000 || now - timestamp > cacheTtlMs;
  };
  const getLocationStats = () => {
    const counts = new Map();
    const locationCounts = new Map();
    aboutUsers.forEach((user) => {
      const locations = [...new Set([user.country, matchStoreRegion ? user.sourceCountry : ""].filter(Boolean))];
      const groups = new Set(locations);
      locations.forEach((country) => counts.set(country, (counts.get(country) || 0) + 1));
      continentGroups.forEach((_, continent) => {
        if (locations.some((location) => continentIncludesLocation(continent, location))) groups.add(continent);
      });
      // An account can have two countries in the same continent. Count it once
      // per selectable location, and once in the overall account total.
      groups.forEach((location) => locationCounts.set(location, (locationCounts.get(location) || 0) + 1));
    });

    const rows = [...counts.entries()].sort(([countryA, countA], [countryB, countB]) => {
      return countB - countA || countryA.localeCompare(countryB);
    });
    return { rows, total: aboutUsers.size, counts: locationCounts };
  };
  // Count each cached account once, using the same rule as hiding and blocking
  // so accounts matching both their reported and store countries count once.
  const getSelectedAccountCount = () => {
    let matched = 0;
    aboutUsers.forEach((user) => {
      if (matchAccountLocation(user).country) matched += 1;
    });
    return matched;
  };
  const getLocationCount = (location, counts) => counts.get(location) || 0;
  const getCachedAccount = (username) => {
    const key = usernameKey(username);
    if (!key) return null;
    const restId = screenNames.get(key);
    if (restId && aboutUsers.has(restId)) {
      const user = aboutUsers.get(restId);
      // Legacy records predate Connected-via and accuracy metadata. Keep their
      // country visible, but refresh them on encounter instead of waiting 28 days.
      return { ...user, expired: isCacheExpired(user.updatedAt) || typeof user.locationWarning !== "boolean" };
    }
    return null;
  };
  const getReusableLookupResult = (username, queuedAt = 0) => {
    const cached = getCachedAccount(username);
    if (!cached || cached.expired) return null;
    const user = aboutUsers.get(cached.restId);
    if (!user) return null;
    const needsFreshBlockProof =
      blockEnabled &&
      !blockPaused &&
      Boolean(matchAccountLocation(user).country) &&
      !isKnownBlocked(blockOwnerRestId, cached.restId);
    if (needsFreshBlockProof && Number(user.updatedAt) <= Number(queuedAt)) return null;
    return { country: user.country, found: true, shared: true, user };
  };

  // Cache hydration and location lookup processing
  const hydrateCache = async () => {
    const startGeneration = dataGeneration;
    const startCacheClear = cacheClearGeneration;
    const startQueueClear = queueClearGeneration;
    const startHistoryClear = historyClearGeneration;
    const db = await dbPromise;
    if (!db || startGeneration !== dataGeneration || resetInProgress) return;
    const [aboutEntries, , retainedLookupRecords] = await Promise.all([
      readAndPruneStore(db, "aboutUsers", (entries) => entries
        .map(([restId, user]) => normalizeStoredUser(restId, user))
        .filter((user) => user.restId && usernameKey(user.screenName) && !isCacheExpired(user.updatedAt))
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
        .slice(0, maxCachedAccounts)
        .map((user) => [user.restId, user])),
      loadBlockHistory(db, startHistoryClear, startGeneration),
      readAndPruneStore(db, "lookupQueue", (entries) => entries
        .map(([, record]) => record)
        .filter((record) => record?.key && usernameKey(record.username) === record.key)
        .sort((a, b) => Number(a.enqueuedAt) - Number(b.enqueuedAt))
        .slice(-maxLookupQueueEntries)
        // No request survives a page reload. Make interrupted checks eligible again.
        .map((record) => [record.key, record.status === "checking"
          ? { ...record, status: "lookup", lastError: "" }
          : record])),
    ]);
    if (startGeneration !== dataGeneration || resetInProgress) return;
    if (startCacheClear === cacheClearGeneration) {
      aboutEntries.forEach(([, nextUser]) => cacheAboutUserInMemory(nextUser));
    }
    if (startQueueClear === queueClearGeneration) {
      retainedLookupRecords.forEach(([, record]) => {
        if (!lookupRecords.has(record.key)) lookupRecords.set(record.key, record);
      });
      lookupRecords.forEach((record) => {
        if (record.status === "awaiting_block") return;
        if (record.status === "failed") return;
        if (!pending.has(record.key)) pending.set(record.key, []);
        lookupAttempts.set(record.key, Math.max(0, Number(record.attempts) || 0));
        if (!queue.some((username) => usernameKey(username) === record.key)) queue.push(record.username);
      });
      renderLookupQueue();
      resumeAwaitingBlocks();
      if (queue.length) scheduleQueue();
    }
    renderLocationStats();
  };

  const setLookupStatus = (message = "", isError = false) => {
    lookupStatusMessage = message;
    lookupStatusError = isError;
    renderLookupStatus();
  };
  const clearLookupRetry = (username) => {
    const key = usernameKey(username);
    const timer = lookupRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    lookupRetryTimers.delete(key);
    lookupAttempts.delete(key);
  };
  const parseRetryAfterMs = (headers) => {
    const value = headers?.get?.("retry-after");
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp - Date.now() : 0;
  };
  const readRateLimit = (headers) => {
    const now = Date.now();
    const remaining = parseNonNegativeInt(headers?.get?.("x-rate-limit-remaining"));
    const limit = parseNonNegativeInt(headers?.get?.("x-rate-limit-limit"));
    const resetSeconds = parseNonNegativeInt(headers?.get?.("x-rate-limit-reset"));
    const resetAt = resetSeconds && resetSeconds > 0 ? resetSeconds * 1000 : 0;
    const resetDelayMs = resetAt > now ? resetAt - now + 1000 : 0;
    return {
      rateLimitLimit: limit,
      rateLimitRemaining: remaining,
      rateLimitResetAt: resetAt,
      rateLimitResetAfterMs: resetDelayMs,
      retryAfterMs: parseRetryAfterMs(headers),
    };
  };
  const describeLookupQuota = () => {
    if (!lookupQuota) {
      return "X has not reported location-lookup quota details yet.";
    }
    if (lookupQuota.resetAt > 0 && lookupQuota.resetAt <= Date.now()) {
      return "X's last reported quota window has reset. The next location lookup will refresh the count.";
    }
    if (lookupQuota.remaining == null) {
      return lookupQuota.resetAt > Date.now()
        ? `X did not report a remaining count. The current window resets around ${formatRetryTime(lookupQuota.resetAt)}.`
        : "X did not report a remaining lookup count.";
    }
    const total = lookupQuota.limit != null ? ` of ${lookupQuota.limit.toLocaleString()}` : "";
    const reset = lookupQuota.resetAt > Date.now()
      ? ` The current window resets around ${formatRetryTime(lookupQuota.resetAt)}.`
      : "";
    return `X reports ${lookupQuota.remaining.toLocaleString()}${total} location lookups remaining.${reset}`;
  };
  const rememberLookupQuota = (rateLimit) => {
    if (
      rateLimit.rateLimitLimit == null &&
      rateLimit.rateLimitRemaining == null &&
      !rateLimit.rateLimitResetAt
    ) return;
    lookupQuota = {
      limit: rateLimit.rateLimitLimit,
      observedAt: Date.now(),
      remaining: rateLimit.rateLimitRemaining,
      resetAt: rateLimit.rateLimitResetAt || 0,
    };
    writeStorage(lookupQuotaStorageKey, JSON.stringify(lookupQuota));
    renderLookupQuota();
  };
  const scheduleLookupRetry = (username, result) => {
    const key = usernameKey(username);
    if (!lookupRecords.has(key)) {
      pending.delete(key);
      return false;
    }
    const rateLimited = result.status === 429;
    if (rateLimited) {
      clearLookupRetry(username);
      const serverProvidedDelay = Number(result.retryAfterMs) > 0;
      if (serverProvidedDelay) {
        resetLookupFallbackAttempts();
      } else {
        lookupFallbackAttempts = Math.min(
          Math.max(lookupFallbackAttempts, readLookupFallbackAttempts()) + 1,
          9,
        );
        writeStorage(lookupFallbackAttemptsStorageKey, lookupFallbackAttempts);
      }
      const fallbackDelay = Math.min(
        defaultRateLimitDelayMs * 2 ** Math.max(lookupFallbackAttempts - 1, 0),
        60 * 60 * 1000,
      );
      const delay = clamp(
        result.retryAfterMs || fallbackDelay,
        1000,
        maximumRateLimitDelayMs,
      );
      setLookupBackoffUntil(Date.now() + delay);
      if (!queue.some((queuedUsername) => usernameKey(queuedUsername) === key)) queue.push(username);
      updateLookupRecord(username, {
        attempts: 0,
        status: "rate_limited",
        lastError: "HTTP 429",
      });
      setLookupStatus(describeLookupBackoff());
      return true;
    }
    const attempt = (lookupAttempts.get(key) || 0) + 1;
    if (attempt > maxLookupRetries) {
      clearLookupRetry(username);
      pending.delete(key);
      updateLookupRecord(username, {
        attempts: maxLookupRetries,
        status: "failed",
        lastError: result.status ? `HTTP ${result.status}` : result.reason || "Temporary lookup failure",
      });
      setLookupStatus(`Some locations could not be loaded after ${maxLookupRetries} retries. Use Retry in Lookup queue.`, true);
      return false;
    }
    lookupAttempts.set(key, attempt);
    const baseDelay = result.retryAfterMs || 2000;
    const maximumDelay = 60000;
    const delay = Math.min(baseDelay * 2 ** (attempt - 1), maximumDelay) + Math.floor(Math.random() * 750);
    const isSessionError = result.status === 401 || result.status === 403 || result.reason === "session";
    if (isSessionError) {
      setLookupBackoffUntil(Math.max(lookupBackoffUntil, Date.now() + delay), "session");
    }
    const existingTimer = lookupRetryTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    lookupRetryTimers.set(
      key,
      setTimeout(() => {
        lookupRetryTimers.delete(key);
        if (!pending.has(key)) return;
        if (!queue.some((queuedUsername) => usernameKey(queuedUsername) === key)) queue.push(username);
        scheduleQueue();
      }, delay),
    );
    updateLookupRecord(username, {
      attempts: attempt,
      status: "retrying",
      lastError: result.status ? `HTTP ${result.status}` : result.reason || "Temporary lookup failure",
    });
    setLookupStatus(
      isSessionError
        ? `Sign in to X to load account locations; retrying automatically (${attempt}/${maxLookupRetries}).`
        : `Location lookup failed temporarily; retrying automatically (${attempt}/${maxLookupRetries}).`,
    );
    return false;
  };
  let preferredAboutMethod = "POST";
  const fetchCountry = async (username, options = {}) => {
    const { method = preferredAboutMethod, recoveredQueryId = false, generation = dataGeneration } = options;
    if (generation !== dataGeneration || resetInProgress) return { cancelled: true };
    const requestedQueryId = aboutQueryId;
    const url = `${getAboutQueryUrl()}?${new URLSearchParams({ variables: JSON.stringify({ screenName: username }) })}`;
    const csrfToken = getCsrfToken();
    if (!csrfToken) return { found: false, retryable: true, reason: "session", retryAfterMs: 1500 };
    try {
      // The request uses the signed-in X session and only asks for account location metadata.
      const { response: res, json } = await fetchWithTimeout(url, {
        method,
        headers: {
          authorization: authToken,
          "x-csrf-token": csrfToken,
        },
        credentials: "include",
      }, countryRequestTimeoutMs, async (response) => ({
        response,
        json: response.ok ? await response.json() : null,
      }), true);
      if (generation !== dataGeneration || resetInProgress) return { cancelled: true };
      const rateLimit = readRateLimit(res.headers);
      rememberLookupQuota(rateLimit);
      if (res.status === 429) {
        rateLimit.retryAfterMs = Math.max(rateLimit.retryAfterMs, rateLimit.rateLimitResetAfterMs);
      } else {
        resetLookupFallbackAttempts();
      }
      if (!res.ok) {
        if ([405, 422].includes(res.status) && method === "POST") {
          preferredAboutMethod = "GET";
          return fetchCountry(username, { method: "GET", recoveredQueryId, generation });
        }
        if (!recoveredQueryId && [400, 404, 422].includes(res.status) && recoverAboutQueryId(requestedQueryId)) {
          return fetchCountry(username, { method, recoveredQueryId: true, generation });
        }
        const retryable = [401, 403, 429].includes(res.status) || res.status >= 500;
        return { found: false, retryable, status: res.status, ...rateLimit };
      }
      if (generation !== dataGeneration || resetInProgress) return { cancelled: true };
      const aboutUser = await saveAboutResponse(json, generation);
      if (generation !== dataGeneration || resetInProgress) return { cancelled: true };
      if (aboutUser) return { country: aboutUser.country, found: true, user: aboutUser, ...rateLimit };
      const graphQlErrors = json?.errors?.map((error) => error?.message).filter(Boolean);
      const rawProfileResult = json?.data?.user_result_by_screen_name?.result;
      const unavailableDetails = [
        rawProfileResult?.__typename,
        rawProfileResult?.reason,
        ...(graphQlErrors || []),
      ].filter(Boolean).join("; ");
      const emptyProfileResponse =
        !graphQlErrors?.length &&
        Boolean(json?.data) &&
        Object.prototype.hasOwnProperty.call(json.data, "user_result_by_screen_name") &&
        !rawProfileResult?.rest_id;
      const unavailable =
        emptyProfileResponse ||
        /not[ _-]?found|does not exist|no user|suspend|deactivat|unavailable/i.test(unavailableDetails);
      if (
        !recoveredQueryId &&
        graphQlErrors?.some((message) => /operation|persisted|query/i.test(message)) &&
        recoverAboutQueryId(requestedQueryId)
      ) return fetchCountry(username, { method, recoveredQueryId: true, generation });
      return graphQlErrors?.length
        ? { found: false, retryable: false, reason: graphQlErrors.join("; "), unavailable, ...rateLimit }
        : { found: false, unavailable, ...rateLimit };
    } catch (error) {
      if (generation !== dataGeneration || resetInProgress) return { cancelled: true };
      return {
        found: false,
        retryable: true,
        reason: error?.name === "AbortError" ? "timeout" : "network",
      };
    }
  };
  const scheduleQueue = (delay = 0) => {
    clearTimeout(queueTimer);
    queueTimer = setTimeout(processQueue, delay);
  };
  const withLookupRequestLock = (callback) => {
    return withExclusiveWebLock("localefence:location-request", callback);
  };
  const reservedProfilePaths = new Set([
    "home", "explore", "search", "notifications", "messages", "compose", "settings",
    "i", "intent", "hashtag", "login", "logout", "tos", "privacy", "jobs", "lists",
    "bookmarks", "communities", "premium", "grok", "articles",
  ]);
  const extractProfileHandle = (href) => {
    const match = String(href || "").match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (!match) return "";
    return reservedProfilePaths.has(match[1].toLowerCase()) ? "" : match[1];
  };
  const isTweetNode = (node) =>
    Boolean(node?.matches?.('[data-testid="tweet"]')) ||
    (Boolean(node?.matches?.("article")) && !node.parentElement?.closest?.("article"));
  const closestTweet = (node) => {
    if (!node?.closest) return null;
    const legacy = node.closest('[data-testid="tweet"]');
    if (legacy) return legacy;
    let current = node.closest("article");
    while (current?.parentElement?.closest?.("article")) {
      current = current.parentElement.closest("article");
    }
    return current;
  };
  const belongsToTweet = (node, tweet) => {
    if (!node || !tweet) return false;
    if (tweet.matches?.('[data-testid="tweet"]')) return true;
    const ownerArticle = node.closest?.("article");
    return !ownerArticle || ownerArticle === tweet;
  };
  const isAuthorStatusLink = (link, handle) => {
    const match = String(link?.getAttribute?.("href") || "").match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+\/?$/);
    return Boolean(match) && (!handle || match[1].toLowerCase() === handle.toLowerCase());
  };
  const resolveModernAuthorContainer = (tweet, profileLink, username) => {
    let best = profileLink.parentElement || null;
    let node = profileLink.parentElement;
    for (let depth = 0; depth < 5 && node && node !== tweet; depth += 1) {
      if (node.querySelector?.('div[dir="auto"][lang], [role="group"], article, button')) break;
      const hasStatusSibling = [...(node.querySelectorAll?.('a[href*="/status/"]') || [])].some(
        (link) => isAuthorStatusLink(link, username),
      );
      if (hasStatusSibling) return node;
      best = node;
      node = node.parentElement;
    }
    return best;
  };
  const getTweetAccount = (tweet) => {
    const legacyContainer = tweet?.querySelector?.('[data-testid="User-Name"]');
    if (legacyContainer && belongsToTweet(legacyContainer, tweet)) {
      const profileLink = [...(legacyContainer.querySelectorAll?.('a[href^="/"]') || [])].find((link) =>
        /^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.getAttribute("href") || ""),
      );
      const username = profileLink?.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})/)?.[1];
      return { container: legacyContainer, username };
    }
    const links = [...(tweet?.querySelectorAll?.('a[href^="/"]') || [])].filter(
      (link) => belongsToTweet(link, tweet) && !link.closest?.('div[dir="auto"][lang], [role="group"]'),
    );
    const handleLink = links.find((link) => {
      const handle = extractProfileHandle(link.getAttribute("href"));
      return handle && link.textContent?.trim().toLowerCase() === `@${handle.toLowerCase()}`;
    });
    const profileLink = handleLink || links.find((link) => {
      const handle = extractProfileHandle(link.getAttribute("href"));
      return handle && !link.querySelector?.("img");
    });
    if (!profileLink) return { container: null, username: undefined };
    const username = extractProfileHandle(profileLink.getAttribute("href"));
    const container = resolveModernAuthorContainer(tweet, profileLink, username);
    return { container, username };
  };
  const applyCountryToTargets = (targets, account, username) => {
    const key = usernameKey(username);
    targets.forEach(({ container, tweet }) => {
      if (tweet?.isConnected === false) return;
      const current = getTweetAccount(tweet);
      if (current.container === container && usernameKey(current.username) === key) {
        applyCountry(container, tweet, account, username);
      } else {
        container?.querySelector?.("[data-account-based-in]")?.remove();
        applyPostVisibility(tweet, null);
        handleTweet(tweet);
      }
    });
  };

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    let nextQueueDelay = 0;
    try {
      await hydrationReady;
      while (queue.length) {
        if (resetInProgress) break;
        if (document.visibilityState === "hidden") break;
        const username = queue.shift();
        const key = usernameKey(username);
        const targets = pending.get(key);
        if (!targets) continue;
        const hasLookupRecord = lookupRecords.has(usernameKey(username));
        const cached = getCachedAccount(username);
        if (cached) {
          applyCountryToTargets(targets, cached, username);
          if (!cached.expired && !hasLookupRecord) {
            pending.delete(key);
            continue;
          }
        }
        const reusableResult = getReusableLookupResult(username, lookupRecords.get(key)?.enqueuedAt);
        if (reusableResult) {
          clearLookupRetry(username);
          applyCountryToTargets(targets, reusableResult.user, username);
          resolveLookupRecord(username, reusableResult.user, targets);
          pending.delete(key);
          continue;
        }
        const generation = dataGeneration;
        const result = await withLookupRequestLock(async () => {
          if (generation !== dataGeneration || resetInProgress) return { cancelled: true };
          syncLookupBackoffUntil();
          const backoffDelay = lookupBackoffUntil - Date.now();
          const waitTime = Math.max(backoffDelay, 0);
          if (waitTime > 0 || document.visibilityState === "hidden") {
            return { deferred: true, retryAfterMs: Math.max(waitTime, 0) };
          }
          if (!lookupRecords.has(key) || !pending.has(key)) return { cancelled: true };
          syncSharedLookupCache(username);
          syncUnavailableAccounts();
          const sharedResult = getReusableLookupResult(username, lookupRecords.get(key)?.enqueuedAt);
          if (sharedResult) return sharedResult;
          if (isUnavailableAccount(username)) return { found: false, unavailable: true };
          updateLookupRecord(username, { status: "checking" });
          return fetchCountry(username, { generation });
        }).catch(() => ({ found: false, retryable: true, reason: "network" }));
        if (generation !== dataGeneration || resetInProgress || result.cancelled) continue;
        if (result.deferred) {
          queue.unshift(username);
          nextQueueDelay = Math.max(result.retryAfterMs, 250);
          break;
        }
        if (result.status !== 429 && result.rateLimitRemaining === 0 && result.rateLimitResetAfterMs > 0) {
          setLookupBackoffUntil(Date.now() + result.rateLimitResetAfterMs);
          setLookupStatus(describeLookupBackoff());
        }
        if (result.found) {
          clearLookupRetry(username);
          if (!lookupRetryTimers.size && !lookupBackoffUntil) setLookupStatus();
          renderLocationStats();
          applyCountryToTargets(targets, result.user, username);
          resolveLookupRecord(username, result.user, targets);
          pending.delete(key);
        } else if (result.retryable) {
          if (scheduleLookupRetry(username, result)) {
            nextQueueDelay = Math.max(lookupBackoffUntil - Date.now(), 1000);
            break;
          }
        } else {
          clearLookupRetry(username);
          if (result.status) {
            updateLookupRecord(username, {
              status: "failed",
              lastError: `HTTP ${result.status}`,
            });
            setLookupStatus(`X rejected location lookups with HTTP ${result.status}. Reload X if this continues.`, true);
          } else {
            if (result.unavailable) rememberUnavailableAccount(username, result.reason);
            removeLookupRecord(username);
          }
          pending.delete(key);
        }
      }
    } finally {
      processing = false;
      if (!resetInProgress && queue.length && document.visibilityState !== "hidden") scheduleQueue(nextQueueDelay);
    }
  };

  const enqueue = (username, container, tweet) => {
    if (resetInProgress) return;
    const key = usernameKey(username);
    if (!key) return;
    const unavailable = isUnavailableAccount(username);
    const cached = getCachedAccount(username);
    const existingBadge = container?.querySelector?.("[data-account-based-in]");
    if (
      existingBadge &&
      (unavailable || !cached || usernameKey(existingBadge.dataset.accountUsername) !== key)
    ) {
      existingBadge.remove();
      applyPostVisibility(tweet, null);
    }
    if (unavailable) {
      applyPostVisibility(tweet, null);
      return;
    }
    if (cached) {
      applyCountry(container, tweet, cached, username);
    } else {
      applyPostVisibility(tweet, null);
    }
    const knownBlocked = cached?.restId && isKnownBlocked(blockOwnerRestId, cached.restId);
    const needsFreshBlockProof =
      blockEnabled && !blockPaused && Boolean(matchAccountLocation(cached).country) && !knownBlocked;
    const needsFreshLookup = !cached || cached.expired || needsFreshBlockProof;
    if (!needsFreshLookup) return;
    const lookupRecord = lookupRecords.get(key);
    if (lookupRecord?.status === "failed") return;
    if (
      lookupRecord?.status === "awaiting_block" &&
      lookupRecord.restId &&
      (queuedBlockIds.has(lookupRecord.restId) || inFlightBlockIds.has(lookupRecord.restId))
    ) return;
    if (!lookupRecord) {
      rememberLookupRecord(username, getTweetSnapshot(tweet));
    }
    const targets = pending.get(key);
    if (targets) {
      const connectedTargets = targets.filter((target) => target.tweet?.isConnected !== false);
      targets.splice(0, targets.length, ...connectedTargets.slice(-maxPendingTargetsPerAccount));
      if (!targets.some((target) => target.tweet === tweet)) {
        if (targets.length >= maxPendingTargetsPerAccount) targets.shift();
        targets.push({ container, tweet });
      }
      return;
    }
    pending.set(key, [{ container, tweet }]);
    queue.push(username);
    scheduleQueue();
  };

  // Feed integration
  const getFeedCell = (tweet) => {
    const legacyCell = tweet?.closest?.('[data-testid="cellInnerDiv"]');
    if (legacyCell) return legacyCell;
    const listItem = tweet?.closest?.("li");
    if (listItem?.parentElement?.matches?.("ul")) return listItem;
    return tweet;
  };
  const applyPostVisibility = (tweet, account) => {
    const target = getFeedCell(tweet);
    if (!target?.dataset) return;
    if (isAccountHidden(account)) target.dataset.localefenceHidden = "true";
    else delete target.dataset.localefenceHidden;
  };
  const refreshProcessedAccounts = () => {
    document.querySelectorAll("[data-account-based-in]").forEach((node) => {
      const tweet = closestTweet(node);
      const current = getTweetAccount(tweet);
      if (current.container !== node.parentElement ||
          usernameKey(current.username) !== usernameKey(node.dataset.accountUsername)) {
        node.remove();
        applyPostVisibility(tweet, null);
        if (current.username) enqueue(current.username, current.container, tweet);
        return;
      }
      // Recompute from the cache: the displayed country is not necessarily the
      // one that matched, once store-region matching is enabled.
      applyPostVisibility(tweet, getCachedAccount(node.dataset.accountUsername));
      enqueue(node.dataset.accountUsername, node.parentElement, tweet);
    });
  };
  const applyCountry = (container, tweet, account, username) => {
    const country = account?.country || account?.sourceCountry || "";
    if (!country && !account?.source && !account?.locationWarning) {
      container.querySelector("[data-account-based-in]")?.remove();
      applyPostVisibility(tweet, null);
      return;
    }
    const locationSource = account.country ? "location" : account.sourceCountry ? "store" : "unknown";
    const emoji = countryFlags.get(country) || (!country ? "🌐" : "");
    const existing = container.querySelector("[data-account-based-in]");
    const node = existing || document.createElement("span");
    const signature = [
      country,
      account.sourceCountry || "",
      account.locationWarning ? "warning" : "",
      locationSource,
    ].join("|");
    const shouldRenderCountry = node.dataset.accountSignature !== signature;
    node.dataset.accountBasedIn = country;
    node.dataset.accountUsername = username;
    node.dataset.accountSignature = signature;
    node.dataset.accountLocationSource = locationSource;
    node.setAttribute("role", "img");
    if (account.locationWarning) node.dataset.locationWarning = "true";
    else delete node.dataset.locationWarning;
    const details = [];
    if (account.country) details.push(`Account based in ${account.country}`);
    else details.push("Account location unavailable");
    if (account.source) details.push(`Connected via ${account.source}`);
    if (locationSource === "store") details.push(`Store region: ${account.sourceCountry}`);
    if (account.locationWarning) details.push("Location may not be accurate (reported by X)");
    node.title = details.join("\n");
    const baseAriaLabel = details.join(". ");
    const existingState = node.querySelector?.("[data-account-state]");
    node.dataset.accountAriaBase = baseAriaLabel;
    node.setAttribute("aria-label", existingState?.textContent ? `${baseAriaLabel}. ${existingState.textContent}` : baseAriaLabel);
    if (shouldRenderCountry) {
      node.textContent = "";
      if (emoji) node.appendChild(createFlagNode(emoji));
      else node.textContent = ` ${country}`;
      if (locationSource === "store") {
        const store = document.createElement("span");
        store.dataset.accountStoreMarker = "true";
        store.textContent = "store";
        store.setAttribute("aria-hidden", "true");
        node.appendChild(store);
      }
      if (account.locationWarning) {
        const warning = document.createElement("span");
        warning.dataset.locationWarningMarker = "true";
        warning.textContent = "⚠";
        warning.title = "X may not be able to verify this location";
        warning.setAttribute("aria-hidden", "true");
        node.appendChild(warning);
      }
      if (existingState) node.appendChild(existingState);
    }
    if (!existing) container.appendChild(node);
    applyPostVisibility(tweet, account);
  };

  const handleTweet = (tweet) => {
    const { container, username } = getTweetAccount(tweet);
    if (!username || !container) {
      tweet?.querySelector?.("[data-account-based-in]")?.remove();
      applyPostVisibility(tweet, null);
      return;
    }
    enqueue(username, container, tweet);
  };

  const findTweets = (root) => {
    // Text nodes have no query API: accessing .forEach on the short-circuited
    // lookup would throw and abort the whole observer batch.
    if (root && root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const seen = new Set();
    const visit = (tweet) => {
      if (!tweet || seen.has(tweet)) return;
      seen.add(tweet);
      handleTweet(tweet);
    };
    if (isTweetNode(root)) visit(root);
    root?.querySelectorAll?.('[data-testid="tweet"]')?.forEach?.(visit);
    root?.querySelectorAll?.("article")?.forEach?.((article) => {
      if (isTweetNode(article)) visit(article);
    });
  };

  // Navigation and settings UI
  const ensureLocaleFenceStyles = () => {
    if (document.querySelector("[data-localefence-styles]")) return;
    const styleRoot = document.head || document.documentElement;
    if (!styleRoot) {
      globalThis.addEventListener("DOMContentLoaded", ensureLocaleFenceStyles, { once: true });
      return;
    }
    const style = document.createElement("style");
    style.dataset.localefenceStyles = "true";
    style.textContent = `
      [data-localefence-root],
      [data-localefence-overlay],
      [data-localefence-toasts] {
        --lf-background: #000;
        --lf-surface: #16181c;
        --lf-subtle: #080808;
        --lf-border: #2f3336;
        --lf-border-strong: #536471;
        --lf-muted: #71767b;
        --lf-secondary: #aab8c2;
        --lf-text: #e7e9ea;
        --lf-hover: rgba(231, 233, 234, 0.1);
        --lf-soft-hover: rgba(255, 255, 255, 0.03);
        --lf-shadow: rgba(255, 255, 255, 0.06);
      }
      [data-localefence-root][data-theme="light"],
      [data-localefence-overlay][data-theme="light"],
      [data-localefence-toasts][data-theme="light"] {
        --lf-background: #fff;
        --lf-surface: #f7f9f9;
        --lf-subtle: #f7f9f9;
        --lf-border: #eff3f4;
        --lf-border-strong: #cfd9de;
        --lf-muted: #536471;
        --lf-secondary: #536471;
        --lf-text: #0f1419;
        --lf-hover: rgba(15, 20, 25, 0.1);
        --lf-soft-hover: rgba(15, 20, 25, 0.03);
        --lf-shadow: rgba(0, 0, 0, 0.08);
      }
      [data-localefence-root] {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        width: 100%;
        flex-shrink: 0;
        position: relative;
        z-index: 0;
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      [data-localefence-trigger] {
        display: flex;
        align-items: center;
        gap: 20px;
        padding: 12px;
        position: relative;
        isolation: isolate;
        overflow: hidden;
        color: inherit;
        font-family: inherit;
        font-size: 20px;
        font-weight: 400;
        line-height: 24px;
        border: none;
        background: transparent;
        border-radius: 9999px;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
      }
      [data-localefence-trigger]::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 0;
        border-radius: inherit;
        background: currentColor;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      [data-localefence-trigger]:hover::before,
      [data-localefence-trigger]:focus-visible::before {
        opacity: 0.1;
      }
      [data-localefence-trigger] > * {
        position: relative;
        z-index: 1;
      }
      [data-localefence-trigger] > svg {
        width: 1.75rem;
        height: 1.75rem;
        flex-shrink: 0;
        transform: scale(1.25);
        transform-origin: center;
      }
      [data-localefence-close]:hover {
        background: var(--lf-hover);
      }
      [data-localefence-label] {
        margin-right: 16px;
        white-space: nowrap;
      }
      [data-localefence-root][data-localefence-compact="true"] {
        align-items: center;
      }
      [data-localefence-root][data-localefence-compact="true"] [data-localefence-trigger] {
        gap: 0;
      }
      [data-localefence-root][data-localefence-compact="true"] [data-localefence-label] {
        display: none;
      }
      @media (max-width: 1276px) {
        [data-localefence-root] {
          align-items: center;
        }
        [data-localefence-label] {
          display: none;
        }
      }
      [data-account-based-in] {
        padding: 0 10px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      [data-account-based-in] [data-location-warning-marker] {
        color: #f7b928;
        font-size: 10px;
        line-height: 1;
      }
      [data-account-based-in] [data-account-store-marker] {
        font-size: 10px;
      }
      [data-localefence-hidden="true"] {
        display: none !important;
      }
      [data-account-state] {
        padding: 1px 6px;
        border-radius: 9999px;
        background: rgba(244, 33, 46, 0.12);
        color: #f4212e;
        font-size: 11px;
        font-weight: 700;
        line-height: 16px;
      }
      [data-account-state][data-state="excluded"] {
        background: rgba(29, 155, 240, 0.12);
        color: #1d9bf0;
      }
      [data-localefence-backdrop] {
        position: fixed;
        inset: 0;
        background: rgba(91, 112, 131, 0.4);
        z-index: 10000;
        display: none;
        touch-action: none;
      }
      [data-localefence-menu] {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(600px, calc(100vw - 32px));
        height: 90vh;
        height: 90dvh;
        max-height: 90vh;
        max-height: 90dvh;
        display: none;
        flex-direction: column;
        background: var(--lf-background);
        color: var(--lf-text);
        border: 1px solid var(--lf-border);
        border-radius: 16px;
        box-shadow: 0 0 18px 4px var(--lf-shadow);
        z-index: 10001;
        overflow: hidden;
        font-size: 15px;
      }
      [data-localefence-overlay] {
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      [data-localefence-overlay][data-localefence-open="true"] [data-localefence-backdrop] {
        display: block;
      }
      [data-localefence-overlay][data-localefence-open="true"] [data-localefence-menu] {
        display: flex;
      }
      [data-localefence-menu] *,
      [data-localefence-menu] *::before,
      [data-localefence-menu] *::after {
        box-sizing: border-box;
      }
      [data-localefence-header] {
        display: flex;
        align-items: center;
        gap: 20px;
        padding: 14px 16px;
        flex-shrink: 0;
      }
      [data-localefence-title] {
        font-size: 20px;
        font-weight: 800;
      }
      [data-localefence-close] {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        margin: -6px;
        border: none;
        border-radius: 9999px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        transition: background-color 0.18s ease;
      }
      [data-localefence-close] svg {
        width: 20px;
        height: 20px;
      }
      [data-localefence-controls] {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 0 16px 12px;
        flex-shrink: 0;
      }
      [data-localefence-actions] {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--lf-border);
        border-radius: 12px;
      }
      [data-localefence-action] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 11px 12px;
        cursor: pointer;
      }
      [data-localefence-action] + [data-localefence-action] {
        border-top: 1px solid var(--lf-border);
      }
      [data-localefence-action]:hover {
        background: var(--lf-soft-hover);
      }
      [data-action-copy] {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      [data-action-title] {
        font-weight: 700;
      }
      [data-action-help],
      [data-block-status] {
        color: var(--lf-muted);
        font-size: 12px;
        line-height: 16px;
      }
      [data-block-status][data-error="true"] {
        color: #f4212e;
      }
      [data-localefence-action] input[type="checkbox"] {
        appearance: none;
        width: 40px;
        height: 22px;
        margin: 0;
        padding: 2px;
        border: none;
        border-radius: 9999px;
        background: var(--lf-border-strong);
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      [data-localefence-action] input[type="checkbox"]::after {
        content: "";
        display: block;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #fff;
        transition: transform 0.15s;
      }
      [data-localefence-action] input[type="checkbox"]:checked {
        background: #1d9bf0;
      }
      [data-localefence-action][data-block-action] input[type="checkbox"]:checked {
        background: #f4212e;
      }
      [data-localefence-action] input[type="checkbox"]:checked::after {
        transform: translateX(18px);
      }
      [data-notification-size],
      [data-notification-position] {
        min-width: 104px;
        padding: 7px 28px 7px 10px;
        border: 1px solid var(--lf-border-strong);
        border-radius: 9999px;
        background: var(--lf-surface);
        color: var(--lf-text);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      [data-exclusion-summary] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: var(--lf-muted);
        font-size: 12px;
      }
      [data-exclusion-summary][hidden] {
        display: none;
      }
      [data-clear-exclusions] {
        padding: 3px 10px;
        border: 1px solid var(--lf-border-strong);
        border-radius: 9999px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      [data-localefence-tabs] {
        display: flex;
        gap: 4px;
        padding: 4px;
        border-radius: 9999px;
        background: var(--lf-surface);
      }
      [data-localefence-tabs] button {
        flex: 1;
        padding: 7px 12px;
        border: none;
        border-radius: 9999px;
        background: transparent;
        color: var(--lf-muted);
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: background-color 0.18s ease, color 0.18s ease;
      }
      [data-localefence-tabs] button:hover,
      [data-localefence-tabs] button:focus-visible {
        background: var(--lf-hover);
        color: var(--lf-text);
      }
      [data-localefence-tabs] button[data-active="true"] {
        background: var(--lf-border);
        color: var(--lf-text);
      }
      [data-country-view][hidden],
      [data-queue-view][hidden],
      [data-history-view][hidden],
      [data-settings-view][hidden] {
        display: none;
      }
      [data-settings-panel] {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 16px;
      }
      [data-reset-panel] {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        margin-top: 16px;
        padding: 14px;
        border: 1px solid rgba(244, 33, 46, 0.35);
        border-radius: 12px;
      }
      [data-reset-panel] p {
        margin: 0;
        color: var(--lf-muted);
        font-size: 12px;
        line-height: 17px;
      }
      [data-lookup-quota-panel] {
        display: flex;
        flex-direction: column;
        gap: 5px;
        margin-top: 16px;
        padding: 12px 14px;
        border: 1px solid var(--lf-border);
        border-radius: 12px;
        background: var(--lf-subtle);
      }
      [data-lookup-quota-panel] p {
        margin: 0;
        color: var(--lf-muted);
        font-size: 12px;
        line-height: 17px;
      }
      [data-reset-all] {
        padding: 6px 14px;
        border: 1px solid rgba(244, 33, 46, 0.5);
        border-radius: 9999px;
        background: transparent;
        color: #f4212e;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }
      [data-location-help] {
        color: var(--lf-muted);
        font-size: 12px;
        line-height: 16px;
      }
      [data-lookup-status] {
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(255, 212, 0, 0.08);
        color: #ffd400;
        font-size: 12px;
        line-height: 16px;
      }
      [data-lookup-status][data-error="true"] {
        background: rgba(244, 33, 46, 0.08);
        color: #f4212e;
      }
      [data-lookup-status][hidden] {
        display: none;
      }
      [data-search-wrap] {
        position: relative;
        display: flex;
        align-items: center;
      }
      [data-search-wrap] svg {
        position: absolute;
        left: 14px;
        width: 18px;
        height: 18px;
        color: var(--lf-muted);
        pointer-events: none;
      }
      [data-country-search] {
        width: 100%;
        padding: 10px 14px 10px 40px;
        border: 1px solid var(--lf-border);
        border-radius: 9999px;
        background: var(--lf-background);
        color: inherit;
        font-family: inherit;
        font-size: 15px;
        outline: none;
      }
      [data-country-search]:focus {
        border-color: #1d9bf0;
      }
      [data-country-list] {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      [data-history-list],
      [data-queue-list] {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      [data-history-empty] {
        padding: 40px 20px;
        color: var(--lf-muted);
        text-align: center;
      }
      [data-history-entry] {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--lf-surface);
      }
      [data-history-header] {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      [data-history-flag] {
        font-size: 20px;
        line-height: 1;
      }
      [data-history-account] {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-history-meta] {
        margin-left: auto;
        color: var(--lf-muted);
        font-size: 12px;
        white-space: nowrap;
      }
      [data-history-status] {
        padding: 1px 6px;
        border-radius: 9999px;
        background: rgba(244, 33, 46, 0.12);
        color: #f4212e;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }
      [data-history-status][data-status="excluded"] {
        background: rgba(29, 155, 240, 0.12);
        color: #1d9bf0;
      }
      [data-history-status][data-status="unblock_failed"] {
        background: rgba(255, 212, 0, 0.12);
        color: #ffd400;
      }
      [data-history-post] {
        padding: 10px 12px;
        border-left: 3px solid var(--lf-border);
        border-radius: 4px;
        background: var(--lf-subtle);
        color: var(--lf-secondary);
        font-size: 13px;
        line-height: 18px;
        overflow-wrap: anywhere;
        text-decoration: none;
        white-space: pre-wrap;
      }
      [data-history-post][href]:hover {
        border-left-color: #1d9bf0;
        color: var(--lf-text);
      }
      [data-queue-empty] {
        padding: 40px 20px;
        color: var(--lf-muted);
        text-align: center;
      }
      [data-queue-entry] {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--lf-surface);
      }
      [data-queue-header] {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      [data-queue-account] {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-queue-status] {
        color: #ffd400;
        font-size: 12px;
        white-space: nowrap;
      }
      [data-queue-post] {
        padding: 10px 12px;
        border-left: 3px solid var(--lf-border);
        border-radius: 4px;
        background: var(--lf-subtle);
        color: var(--lf-secondary);
        font-size: 13px;
        line-height: 18px;
        overflow-wrap: anywhere;
        text-decoration: none;
      }
      [data-queue-actions] {
        display: flex;
        gap: 8px;
      }
      [data-history-action],
      [data-queue-actions] button {
        padding: 4px 10px;
        border: 1px solid var(--lf-border-strong);
        border-radius: 9999px;
        background: transparent;
        color: var(--lf-secondary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      [data-history-action]:disabled {
        cursor: default;
        opacity: 0.6;
      }
      [data-localefence-menu] table {
        width: 100%;
        border-collapse: collapse;
      }
      [data-localefence-menu] thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--lf-background);
        padding: 0;
        text-align: left;
        font-weight: 400;
        border-bottom: 1px solid var(--lf-border);
      }
      [data-localefence-menu] thead th:first-child {
        width: 1%;
      }
      [data-sort-column] {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 8px 12px;
        border: none;
        background: transparent;
        color: var(--lf-muted);
        font-family: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }
      [data-sort-column]:hover {
        color: var(--lf-text);
      }
      th[data-active-sort="true"] [data-sort-column] {
        color: var(--lf-text);
      }
      [data-localefence-menu] tbody tr {
        cursor: pointer;
        border-bottom: 1px solid var(--lf-surface);
      }
      [data-localefence-menu] tbody tr:hover {
        background: var(--lf-soft-hover);
      }
      [data-localefence-menu] tbody tr[data-selected="true"] {
        background: rgba(29, 155, 240, 0.1);
      }
      [data-localefence-menu] tbody tr[data-continent="true"] {
        background: rgba(29, 155, 240, 0.04);
      }
      [data-localefence-menu] tbody td {
        padding: 10px 12px;
        vertical-align: middle;
      }
      [data-localefence-menu] tbody input[type="checkbox"] {
        display: block;
        width: 18px;
        height: 18px;
        accent-color: #1d9bf0;
        cursor: pointer;
      }
      [data-region-cell] {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
      [data-continent-label] {
        padding: 1px 6px;
        border-radius: 9999px;
        background: var(--lf-border);
        color: var(--lf-secondary);
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
      }
      [data-seen-cell] {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      [data-seen-count] {
        min-width: 44px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--lf-muted);
        font-size: 13px;
      }
      [data-seen-bar] {
        flex: 1;
        height: 6px;
        min-width: 40px;
        background: var(--lf-border);
        border-radius: 3px;
        overflow: hidden;
      }
      [data-seen-fill] {
        height: 100%;
        width: 0;
        background: #1d9bf0;
        border-radius: 3px;
        transition: width 0.2s;
      }
      [data-localefence-footer] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-top: 1px solid var(--lf-border);
        flex-shrink: 0;
      }
      [data-localefence-stats] {
        color: var(--lf-muted);
        font-size: 13px;
      }
      [data-clear-cache],
      [data-clear-history],
      [data-clear-queue] {
        padding: 6px 16px;
        border: 1px solid rgba(244, 33, 46, 0.4);
        border-radius: 9999px;
        background: transparent;
        color: #f4212e;
        font-family: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }
      [data-clear-cache]:hover,
      [data-clear-history]:hover,
      [data-clear-queue]:hover {
        background: rgba(244, 33, 46, 0.1);
      }
      [data-localefence-toasts] {
        --lf-toast-inline-offset: 24px;
        --lf-toast-top-offset: 24px;
        --lf-toast-top-right-offset: 72px;
        --lf-toast-bottom-offset: 24px;
        position: fixed;
        left: var(--lf-toast-inline-offset);
        top: var(--lf-toast-top-offset);
        z-index: 10002;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        pointer-events: none;
      }
      [data-localefence-toasts][data-position="top-right"] {
        right: var(--lf-toast-inline-offset);
        left: auto;
        top: var(--lf-toast-top-right-offset);
        align-items: flex-end;
      }
      [data-localefence-toasts][data-position="bottom-left"] {
        top: auto;
        bottom: var(--lf-toast-bottom-offset);
      }
      [data-localefence-toasts][data-position="bottom-right"] {
        right: var(--lf-toast-inline-offset);
        bottom: var(--lf-toast-bottom-offset);
        left: auto;
        top: auto;
        align-items: flex-end;
      }
      [data-localefence-toast] {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        max-width: min(420px, calc(100vw - 32px));
        padding: 12px 16px;
        border: 1px solid var(--lf-border);
        border-radius: 12px;
        background: var(--lf-surface);
        color: var(--lf-text);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 14px;
        opacity: 0;
        transform: translateY(-8px);
        transition: opacity 0.2s, transform 0.2s;
      }
      [data-localefence-toasts][data-position^="bottom"] [data-localefence-toast] {
        transform: translateY(8px);
      }
      [data-localefence-toasts][data-position^="bottom"] [data-localefence-toast][data-visible="true"] {
        transform: translateY(0);
      }
      [data-localefence-toasts][data-size="compact"] [data-localefence-toast] {
        gap: 8px;
        max-width: min(340px, calc(100vw - 32px));
        padding: 9px 12px;
        font-size: 13px;
      }
      [data-localefence-toasts][data-size="compact"] [data-toast-post] {
        font-size: 12px;
        line-height: 16px;
        -webkit-line-clamp: 2;
      }
      [data-localefence-toasts][data-size="large"] [data-localefence-toast] {
        gap: 12px;
        max-width: min(480px, calc(100vw - 32px));
        padding: 16px 18px;
        font-size: 16px;
      }
      [data-localefence-toasts][data-size="large"] [data-toast-post] {
        font-size: 14px;
        line-height: 20px;
        -webkit-line-clamp: 5;
      }
      [data-toast-body],
      [data-toast-copy] {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      [data-toast-copy] {
        color: inherit;
        text-decoration: none;
      }
      [data-toast-title] {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      [data-toast-flag] {
        font-size: 18px;
        line-height: 1;
        flex-shrink: 0;
      }
      [data-toast-post] {
        display: -webkit-box;
        overflow: hidden;
        color: var(--lf-secondary);
        font-size: 13px;
        line-height: 18px;
        overflow-wrap: anywhere;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 4;
      }
      [data-toast-hint] {
        color: #1d9bf0;
        font-size: 12px;
        font-weight: 700;
      }
      [data-toast-action] {
        align-self: flex-start;
        padding: 5px 12px;
        border: 1px solid var(--lf-border-strong);
        border-radius: 9999px;
        background: transparent;
        color: var(--lf-text);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      [data-toast-action]:hover {
        background: var(--lf-hover);
      }
      [data-toast-action]:disabled {
        cursor: default;
        opacity: 0.6;
      }
      [data-localefence-toast][data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }
      [data-localefence-toast][data-interactive="true"] {
        pointer-events: auto;
      }
      [data-localefence-toast][data-clickable="true"]:hover {
        border-color: var(--lf-border-strong);
      }
      [data-toast-copy][href]:focus-visible {
        outline: 2px solid #1d9bf0;
        outline-offset: 2px;
      }
      [data-toast-icon] {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #00ba7c;
        color: #fff;
        font-weight: 800;
        flex-shrink: 0;
      }
      [data-localefence-toast][data-error="true"] [data-toast-icon] {
        background: #f4212e;
      }
      @media (max-width: 700px) {
        [data-localefence-root] {
          display: none !important;
        }
        [data-localefence-trigger] {
          min-width: 44px;
          min-height: 44px;
          padding: 10px;
        }
        [data-localefence-menu] {
          inset: 0;
          top: 0;
          left: 0;
          transform: none;
          width: 100vw;
          max-width: 100vw;
          height: 100vh;
          height: 100dvh;
          max-height: 100vh;
          max-height: 100dvh;
          margin: 0;
          border-width: 0;
          border-radius: 0;
          overscroll-behavior: contain;
        }
        [data-localefence-header] {
          padding-top: calc(14px + env(safe-area-inset-top));
        }
        [data-localefence-controls] {
          padding-inline: 12px;
        }
        [data-localefence-tabs] {
          justify-content: flex-start;
          overflow-x: auto;
          border-radius: 12px;
          scrollbar-width: none;
        }
        [data-localefence-tabs]::-webkit-scrollbar {
          display: none;
        }
        [data-localefence-tabs] button {
          flex: 0 0 auto;
        }
        [data-localefence-footer] {
          flex-wrap: wrap;
          padding-bottom: calc(12px + env(safe-area-inset-bottom));
        }
        [data-localefence-toasts] {
          --lf-toast-inline-offset: 16px;
          --lf-toast-top-offset: calc(16px + env(safe-area-inset-top));
          --lf-toast-top-right-offset: calc(60px + env(safe-area-inset-top));
          --lf-toast-bottom-offset: calc(16px + env(safe-area-inset-bottom));
        }
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] {
          align-items: center;
          gap: 6px;
          max-width: calc(100vw - 32px);
          padding: 6px 12px;
          overflow: hidden;
          border-radius: 9999px;
          font-size: 12px;
          line-height: 16px;
        }
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-post],
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-hint] {
          display: none;
        }
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-body],
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-copy] {
          overflow: hidden;
        }
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-title] {
          gap: 5px;
          white-space: nowrap;
        }
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-title] > span:last-child {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        [data-localefence-toasts] [data-localefence-toast][data-localefence-mini="true"] [data-toast-flag] {
          font-size: 14px;
        }
      }
    `;
    styleRoot.appendChild(style);
  };

  const isMobileLocaleFenceViewport = () =>
    Boolean(globalThis.matchMedia?.("(max-width: 700px)")?.matches);
  const measureLocaleFenceNavRect = (node) => {
    try {
      const rect = node?.getBoundingClientRect?.();
      const width = Number(rect?.width ?? node?.clientWidth);
      const height = Number(rect?.height ?? node?.clientHeight);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      return {
        width,
        height,
        top: Number(rect?.top),
        bottom: Number(rect?.bottom),
      };
    } catch {
      return null;
    }
  };
  const hasHorizontalLocaleFenceNavLinks = (nav) => {
    try {
      const rects = [...(nav?.querySelectorAll?.("a[href]") || [])]
        .map((link) => link?.getBoundingClientRect?.())
        .filter((rect) => rect && Number(rect.width) > 0 && Number(rect.height) > 0);
      if (rects.length < 2) return false;
      const dx = Math.abs(rects[1].left - rects[0].left);
      const dy = Math.abs(rects[1].top - rects[0].top);
      return dx > dy && dy < Math.max(rects[0].height, rects[1].height, 24);
    } catch {
      return false;
    }
  };
  const isHorizontalLocaleFenceNav = (nav) => {
    if (!nav) return false;
    if (hasHorizontalLocaleFenceNavLinks(nav)) return true;
    const rect = measureLocaleFenceNavRect(nav);
    if (rect) {
      // X's mobile web app uses a short, full-width bottom tab bar, while the
      // desktop sidebar is tall and narrow. A horizontal or bottom-pinned nav
      // can never host a desktop-style sidebar entry without breaking the bar.
      if (rect.width > rect.height * 1.5) return true;
      const viewportHeight = Number(globalThis.innerHeight);
      if (
        Number.isFinite(viewportHeight) &&
        viewportHeight > 0 &&
        Number.isFinite(rect.top) &&
        rect.height <= 120 &&
        rect.top >= viewportHeight * 0.55
      ) return true;
    }
    try {
      const style = globalThis.getComputedStyle?.(nav);
      if (
        (!rect || rect.height <= rect.width) &&
        (nav.children?.length ?? 0) >= 2 &&
        style?.display?.includes?.("flex") &&
        /^row/i.test(style.flexDirection || "")
      ) return true;
    } catch { /* ignore */ }
    return false;
  };
  // Any mobile-width viewport or horizontal/bottom tab bar is served through
  // the side drawer instead of injecting a button into <nav>.
  const shouldUseDrawerLocaleFence = (nav) => {
    if (isMobileLocaleFenceViewport()) return true;
    if (!nav) return false;
    const container = findLocaleFenceTabContainer(nav);
    return isHorizontalLocaleFenceNav(nav) || (container !== nav && isHorizontalLocaleFenceNav(container));
  };
  // Require positive layout proof that <nav> is a tall vertical sidebar before
  // injecting a sidebar button, so unmeasured (0x0), display:contents, or
  // experimental bottom-bar containers can never receive the button.
  const isVerticalSidebarLocaleFenceNav = (nav) => {
    if (!nav || shouldUseDrawerLocaleFence(nav)) return false;
    const container = findLocaleFenceTabContainer(nav);
    const rect = measureLocaleFenceNavRect(container) || measureLocaleFenceNavRect(nav);
    if (!rect) return false;
    return rect.height >= rect.width;
  };
  const resolveLocaleFenceMount = ({ allowStandalone, androidBrowser, body, compactViewport, nav }) => {
    // The sidebar trigger lives in X's navigation on desktop layouts, while
    // mobile layouts (horizontal bottom tab bar) use a side-drawer entry. The
    // body mount only hosts the invisible dialog overlay, never a button.
    const mountNav = nav || null;
    const mount = mountNav || ((androidBrowser || compactViewport || allowStandalone || nav) ? body : null);
    return { mount, mountNav };
  };
  const isCompactLocaleFenceNav = (nav) => {
    // A bottom tab bar reports the full viewport width (e.g. ~360px), so a
    // width-only heuristic would wrongly show the text label inside the bar.
    // Treat every mobile/horizontal nav as compact to keep the icon-only button.
    if (isMobileLocaleFenceViewport() || isHorizontalLocaleFenceNav(nav)) return true;
    const measuredWidth = Number(nav?.getBoundingClientRect?.()?.width ?? nav?.clientWidth);
    if (Number.isFinite(measuredWidth) && measuredWidth > 0) return measuredWidth < 200;
    return Boolean(globalThis.matchMedia?.("(max-width: 1276px)")?.matches);
  };
  const syncLocaleFenceNavLayout = (wrapper, nav) => {
    if (!wrapper || !nav) return;
    // Only touch the DOM when the value actually changes: every attribute
    // write invalidates style and can retrigger X's own observers, which
    // turns a window resize into a feedback loop.
    const compact = isCompactLocaleFenceNav(nav).toString();
    if (wrapper.dataset.localefenceCompact !== compact) wrapper.dataset.localefenceCompact = compact;
  };
  let localeFenceNavObserver = null;
  let observedLocaleFenceNav = null;
  let observedLocaleFenceRoot = null;
  let localeFenceLayoutQueued = false;
  const observeLocaleFenceNavLayout = (wrapper, nav) => {
    syncLocaleFenceNavLayout(wrapper, nav);
    if (!globalThis.ResizeObserver || (wrapper === observedLocaleFenceRoot && nav === observedLocaleFenceNav)) return;
    localeFenceNavObserver?.disconnect();
    observedLocaleFenceRoot = wrapper;
    observedLocaleFenceNav = nav;
    // Coalesce bursts (e.g. continuous window resizing) to one sync per
    // frame instead of measuring and writing on every notification.
    localeFenceNavObserver = new globalThis.ResizeObserver(() => {
      if (localeFenceLayoutQueued) return;
      localeFenceLayoutQueued = true;
      const run = () => {
        localeFenceLayoutQueued = false;
        if (shouldUseDrawerLocaleFence(nav) || !isVerticalSidebarLocaleFenceNav(nav)) {
          disconnectLocaleFenceNavObserver();
          wrapper.remove?.();
          localeFenceDrawerArmed = true;
          ensureLocaleFenceDrawerEntry();
          return;
        }
        syncLocaleFenceNavLayout(wrapper, nav);
      };
      if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(run);
      else setTimeout(run, 100);
    });
    localeFenceNavObserver.observe(nav);
  };
  const findLocaleFenceTabContainer = (nav) => {
    // X's mobile bottom bar may nest its tabs in an inner flex row instead of
    // exposing them as direct <nav> children. Prefer the row that actually
    // holds the tabs so the trigger becomes a real tab cell.
    try {
      const homeLink = nav?.querySelector?.('a[href="/home"]');
      const container = homeLink?.parentElement;
      if (
        container &&
        container !== nav &&
        (container.querySelectorAll?.('a[href]')?.length ?? 0) >= 2
      ) return container;
    } catch { /* Fall through to the nav element itself. */ }
    return nav;
  };
  const placeLocaleFenceInNav = (wrapper, nav) => {
    if (!wrapper || !nav) return;
    const container = findLocaleFenceTabContainer(nav);
    observeLocaleFenceNavLayout(wrapper, container);
    if (wrapper.parentNode === container) return;
    const insertionPoint = container.lastElementChild;
    if (insertionPoint && insertionPoint !== wrapper) container.insertBefore(wrapper, insertionPoint);
    else container.appendChild(wrapper);
  };
  const disconnectLocaleFenceNavObserver = () => {
    localeFenceNavObserver?.disconnect();
    observedLocaleFenceRoot = null;
    observedLocaleFenceNav = null;
  };
  let openLocaleFenceMenu = null;
  let wiredOpenMenu = null;
  let unlockOverlayScroll = () => {};
  let removeOverlayKeydown = () => {};
  let triggerButtonNode = null;
  let triggerWrapperNode = null;
  // The dialog overlay is built, wired, and attached only when first opened:
  // a body-level node during X's boot wedges page load (proven by A/B
  // bisect), while sidebar/drawer triggers are safe from the start.
  openLocaleFenceMenu = () => {
    if (!wiredOpenMenu && !buildLocaleFenceOverlay()) return;
    try {
      wiredOpenMenu();
    } catch (error) {
      console.warn("LocaleFence could not open its settings.", error);
    }
  };
  const bindLocaleFenceTrigger = (wrapperNode) => {
    if (!wrapperNode) return;
    const button = wrapperNode.querySelector?.("[data-localefence-trigger]");
    if (!button || button.dataset.localefenceBound) return;
    button.dataset.localefenceBound = "true";
    triggerButtonNode = button;
    triggerWrapperNode = wrapperNode;
    button.addEventListener("click", () => {
      try {
        openLocaleFenceMenu?.();
      } catch { /* Opening the dialog is best effort here. */ }
    });
  };
  const findLocaleFenceDrawerAnchor = (scope = document) => {
    // The side drawer holds locale-independent links such as /settings, so
    // prefer href matching over visible labels. Several tiers cover X markup
    // variations (nested settings paths, query strings, reordered rows).
    try {
      const isDrawerLink = (link) => {
        if (!link) return false;
        const tweet = link.closest?.('[data-testid="tweet"]');
        if (tweet && (tweet.dataset?.testid === "tweet" || tweet.getAttribute?.("data-testid") === "tweet")) {
          return false;
        }
        const article = link.closest?.("article");
        if (article && article.tagName?.toUpperCase?.() === "ARTICLE") return false;
        const own = link.closest?.("[data-localefence-drawer-entry]");
        if (own && own.dataset?.localefenceDrawerEntry) return false;
        return true;
      };
      const isInternalPath = (rawHref, pathFragment) => {
        if (!rawHref) return false;
        try {
          const origin = globalThis.location?.origin || "https://x.com";
          const url = new URL(rawHref, origin);
          if (globalThis.location?.origin && url.origin !== globalThis.location.origin) return false;
          return new RegExp(`(?:^|/)${pathFragment}(?:[/?#]|$)`, "i").test(url.pathname);
        } catch {
          return false;
        }
      };
      const exact = scope.querySelector?.('a[href="/settings"], a[href$="/settings"]');
      if (isDrawerLink(exact)) return exact;
      const links = [...(scope.querySelectorAll?.("a[href]") || [])].filter(isDrawerLink);
      const nestedSettings = links.find((link) =>
        isInternalPath(String(link?.getAttribute?.("href") || link?.href || ""), "settings?"),
      );
      if (nestedSettings) return nestedSettings;
      const logout = links.find((link) =>
        isInternalPath(String(link?.getAttribute?.("href") || link?.href || ""), "logout"),
      );
      const drawer = logout?.closest?.("div") || scope;
      const rows = [...(drawer.querySelectorAll?.("a") || [])]
        .filter((link) => isDrawerLink(link) && link.querySelector?.("svg"));
      const englishSettings = rows.find((link) => link.textContent?.trim() === "Settings and privacy");
      if (englishSettings) return englishSettings;
      // Last resort: the drawer row immediately above "Log out" is the
      // settings row in every known X drawer ordering.
      const logoutIndex = rows.indexOf(logout);
      if (logout && logoutIndex > 0) return rows[logoutIndex - 1];
      return null;
    } catch {
      return null;
    }
  };
  const rowForLocaleFenceDrawerAnchor = (anchor) => {
    // The matched link can be nested inside its row (icon and label in
    // separate elements). Climb until the node is one icon-bearing row among
    // sibling rows, so the entry is inserted as a full sibling row instead of
    // inline content clipped inside the anchor's row.
    try {
      let node = anchor;
      for (let depth = 0; depth < 6 && node?.parentElement; depth += 1) {
        const parent = node.parentElement;
        const rowLike = [...(parent.children || [])].filter((child) => child.querySelector?.("svg"));
        if (rowLike.length >= 3) return node;
        if (rowLike.length === 0) break;
        node = parent;
      }
    } catch { /* Fall through to the anchor itself. */ }
    return anchor;
  };
  const buildLocaleFenceDrawerEntry = (anchor) => {
    // Clone the drawer row so the entry inherits X's exact row layout, icon
    // metrics, and padding instead of approximating them with custom CSS.
    const row = rowForLocaleFenceDrawerAnchor(anchor);
    const entry = row.cloneNode(true);
    entry.dataset.localefenceDrawerEntry = "true";
    entry.removeAttribute("href");
    entry.querySelectorAll?.("[href]").forEach?.((node) => node.removeAttribute("href"));
    entry.setAttribute("role", "button");
    entry.setAttribute("aria-label", "LocaleFence");
    entry.setAttribute("tabindex", "0");
    const icon = entry.querySelector?.("svg");
    if (icon) {
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML =
        '<path fill-rule="evenodd" clip-rule="evenodd" d="M3.75 5.5C3.75 4.67 4.42 4 5.25 4h13.5c.83 0 1.5.67 1.5 1.5 0 .37-.14.72-.39.99l-5.11 5.63V17c0 .57-.32 1.09-.82 1.34l-3 1.5c-.47.24-1.03.21-1.47-.06-.44-.27-.71-.76-.71-1.28v-6.38L4.14 6.49c-.25-.27-.39-.62-.39-.99zM5.85 6l4.49 5.49c.27.32.41.72.41 1.13v5.07l2-1v-4.07c0-.41.14-.81.41-1.13L17.65 6H5.85z" fill="currentColor"></path>';
    }
    const label = [...(entry.querySelectorAll?.("span, div") || [])].find((node) => {
      const text = node.textContent?.trim() || "";
      return node.children.length === 0 && text.length >= 2 && !/^\d+$/.test(text);
    });
    if (label) label.textContent = "LocaleFence";
    else entry.setAttribute("aria-label", "LocaleFence");
    entry.addEventListener("click", (event) => {
      event.preventDefault();
      // Let X's own drawer handlers run (the drawer closes) while opening the
      // body-level settings dialog.
      try {
        openLocaleFenceMenu?.();
      } catch { /* Opening the dialog is best effort here. */ }
    });
    entry.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      try {
        openLocaleFenceMenu?.();
      } catch { /* Opening the dialog is best effort here. */ }
    });
    return entry;
  };
  let lastLocaleFenceDrawerScanAt = 0;
  const maybeEnsureLocaleFenceDrawerEntry = () => {
    // Drawer scans walk the document, so cap them during DOM storms
    // (timeline renders, window resizing) instead of scanning per mutation —
    // and never scan at all unless a mobile layout armed the drawer.
    if (!localeFenceDrawerArmed) return;
    const now = Date.now();
    if (now - lastLocaleFenceDrawerScanAt < 1500) return;
    lastLocaleFenceDrawerScanAt = now;
    ensureLocaleFenceDrawerEntry();
  };
  const ensureLocaleFenceDrawerEntry = () => {
    if (!openLocaleFenceMenu) return;
    try {
      if (document.querySelector("[data-localefence-drawer-entry]")?.isConnected) return;
      const dialogs = [...(document.querySelectorAll?.('[role="dialog"], [data-testid="sheetDialog"]') || [])]
        .filter((dialog) => !dialog.closest?.("[data-localefence-overlay]"));
      let anchor = null;
      for (const dialog of dialogs) {
        anchor = findLocaleFenceDrawerAnchor(dialog);
        if (anchor) break;
      }
      if (!anchor) {
        const candidate = findLocaleFenceDrawerAnchor(document);
        const mainNode = candidate?.closest?.("main");
        if (candidate && !(mainNode && mainNode.tagName?.toUpperCase?.() === "MAIN")) anchor = candidate;
      }
      if (!anchor || anchor.closest?.("[data-localefence-drawer-entry]")) return;
      const entry = buildLocaleFenceDrawerEntry(anchor);
      const row = rowForLocaleFenceDrawerAnchor(anchor);
      if (row.before) row.before(entry);
      else row.after(entry);
    } catch { /* Drawer injection is best effort. */ }
  };
  let cachedLocaleFenceNav = null;
  let localeFenceDrawerArmed = false;
  const findLocaleFenceNav = (root) => {
    // The `:has()` lookup walks the whole document, so reuse the cached nav
    // while it is still connected instead of rescanning on every mutation
    // batch, resize tick, and visibility change.
    if (cachedLocaleFenceNav?.isConnected) return cachedLocaleFenceNav;
    cachedLocaleFenceNav = null;
    let nav = null;
    try {
      nav = root?.closest?.('nav:has(a[href="/home"])') || root?.querySelector?.('nav:has(a[href="/home"])');
    } catch { nav = null; }
    if (nav) cachedLocaleFenceNav = nav;
    return nav;
  };
  const findNav = (root, allowStandalone = false) => {
    const nav = findLocaleFenceNav(root);
    const compactViewport = globalThis.matchMedia?.("(max-width: 700px)")?.matches;
    const androidBrowser = /Android/i.test(globalThis.navigator?.userAgent || "");
    const { mount, mountNav } = resolveLocaleFenceMount({
      allowStandalone,
      androidBrowser,
      body: document.body,
      compactViewport,
      nav,
    });
    const existingRoot = document.querySelector("[data-localefence-root]");
    // Mobile layouts (horizontal bottom tab bar) are served through the side
    // drawer, and there is no floating button on any layout: without a
    // sidebar there is simply no trigger node (the media viewer, which has
    // neither navigation nor drawer, stays completely clean). The dialog
    // overlay is built lazily on first open and never touched here.
    const mobileContext = androidBrowser || Boolean(compactViewport);
    const drawerLayout = Boolean(compactViewport) || (mountNav
      ? shouldUseDrawerLocaleFence(mountNav)
      : mobileContext);
    const sidebarLayout = Boolean(mountNav) && !drawerLayout && isVerticalSidebarLocaleFenceNav(mountNav);
    // The drawer only exists in mobile layouts. Arming it here (and disarming
    // if resized back to desktop) keeps full-document anchor scans — and any
    // chance of injecting into a stray desktop settings link — at zero on desktop.
    localeFenceDrawerArmed = Boolean(drawerLayout || mobileContext);
    if (existingRoot) {
      existingRoot.dataset.theme = getPageTheme();
      if (drawerLayout || !sidebarLayout) {
        // The drawer owns the entry on mobile/horizontal layouts; drop any
        // sidebar button if <nav> is missing, unmeasured, or horizontal.
        disconnectLocaleFenceNavObserver();
        existingRoot.remove();
        if (drawerLayout || mobileContext) ensureLocaleFenceDrawerEntry();
        return;
      }
      if (mountNav) {
        // Legacy floating buttons from earlier versions move into the sidebar.
        placeLocaleFenceInNav(existingRoot, mountNav);
        bindLocaleFenceTrigger(existingRoot);
        return;
      }
    }
    if (drawerLayout) ensureLocaleFenceDrawerEntry();
    if (!mount || !document.body) return;
    // The trigger only ever lives in the sidebar: mobile layouts use the
    // side drawer and there is no floating-button fallback anymore.
    let wrapper = null;
    if (sidebarLayout) {
      wrapper = document.createElement("div");
      wrapper.dataset.localefenceRoot = "true";
      wrapper.dataset.theme = getPageTheme();
    }
    if (wrapper) {
      wrapper.innerHTML = `
      <button data-localefence-trigger type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="LocaleFence">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.75 5.5C3.75 4.67 4.42 4 5.25 4h13.5c.83 0 1.5.67 1.5 1.5 0 .37-.14.72-.39.99l-5.11 5.63V17c0 .57-.32 1.09-.82 1.34l-3 1.5c-.47.24-1.03.21-1.47-.06-.44-.27-.71-.76-.71-1.28v-6.38L4.14 6.49c-.25-.27-.39-.62-.39-.99zM5.85 6l4.49 5.49c.27.32.41.72.41 1.13v5.07l2-1v-4.07c0-.41.14-.81.41-1.13L17.65 6H5.85z" fill="currentColor"></path></svg>
        <span data-localefence-label>LocaleFence</span>
      </button>
    `;
    }
    if (wrapper && mountNav) placeLocaleFenceInNav(wrapper, mountNav);
    bindLocaleFenceTrigger(wrapper);
  };

  const buildLocaleFenceOverlay = () => {
    // Built lazily on first open: a body-level node during X's boot wedges
    // page load, while building it detached on a user gesture is safe.
    if (wiredOpenMenu) return true;
    if (!document.body) return false;
    const overlay = document.createElement("div");
    overlay.dataset.localefenceOverlay = "true";
    overlay.dataset.theme = getPageTheme();
    overlay.innerHTML = `
      <div data-localefence-backdrop></div>
      <div data-localefence-menu role="dialog" aria-modal="true" aria-labelledby="localefence-title">
        <div data-localefence-header>
          <button data-localefence-close type="button" aria-label="Close LocaleFence">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10.59 12 4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z" fill="currentColor"></path></svg>
          </button>
          <span data-localefence-title id="localefence-title">Country filters</span>
        </div>
        <div data-localefence-controls>
          <div data-localefence-actions>
            <label data-localefence-action>
              <span data-action-copy>
                <span data-action-title>Hide matching posts</span>
                <span data-action-help>Remove posts from selected countries from your feed.</span>
              </span>
              <input data-hide-matching type="checkbox" role="switch">
            </label>
            <label data-localefence-action data-block-action>
              <span data-action-copy>
                <span data-action-title>Automatically block accounts</span>
                <span data-action-help>Block encountered accounts from selected countries on X. Stays on until disabled.</span>
                <span data-block-status aria-live="polite"></span>
              </span>
              <input data-block-matching type="checkbox" role="switch">
            </label>
          </div>
          <div data-exclusion-summary hidden>
            <span data-exclusion-count></span>
            <button data-clear-exclusions type="button">Clear exclusions</button>
          </div>
          <span data-lookup-status aria-live="polite" hidden></span>
          <div data-localefence-tabs>
            <button data-localefence-view="countries" data-active="true" type="button" aria-pressed="true">Countries</button>
            <button data-localefence-view="queue" type="button" aria-pressed="false">Lookup queue <span data-queue-count></span></button>
            <button data-localefence-view="history" type="button" aria-pressed="false">Block history <span data-history-count></span></button>
            <button data-localefence-view="settings" type="button" aria-pressed="false">Settings</button>
          </div>
          <span data-location-help data-country-view>Continents include all member countries. Select individual countries for narrower filters.</span>
          <div data-search-wrap data-country-view>
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10.25 3.75a6.5 6.5 0 1 0 4.02 11.6l5.69 5.69 1.06-1.06-5.69-5.69a6.5 6.5 0 0 0-5.08-10.54zm-5 6.5a5 5 0 1 1 10 0 5 5 0 0 1-10 0z" fill="currentColor"></path></svg>
            <input data-country-search type="text" placeholder="Search countries or regions" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div data-country-list data-country-view>
          <table>
            <thead>
              <tr>
                <th><button type="button" data-sort-column="selected" aria-label="Sort by selected">✓</button></th>
                <th><button type="button" data-sort-column="name">Region</button></th>
                <th><button type="button" data-sort-column="seen">Accounts</button></th>
              </tr>
            </thead>
            <tbody data-country-rows></tbody>
          </table>
        </div>
        <div data-queue-list data-queue-view hidden></div>
        <div data-history-list data-history-view hidden></div>
        <div data-settings-panel data-settings-view hidden>
          <div data-localefence-actions>
            <label data-localefence-action>
              <span data-action-copy>
                <span data-action-title>Match Connected via store region</span>
                <span data-action-help>Also match the app-store country from X's Connected via data, for hiding and automatic blocking. A store region can be stale or differ from the account's current country.</span>
              </span>
              <input data-match-store-region type="checkbox" role="switch">
            </label>
            <label data-localefence-action>
              <span data-action-copy>
                <span data-action-title>Show notifications</span>
                <span data-action-help>Show block results, errors, and triggering post snapshots.</span>
              </span>
              <input data-notifications-enabled type="checkbox" role="switch">
            </label>
            <label data-localefence-action>
              <span data-action-copy>
                <span data-action-title>Notification size</span>
                <span data-action-help>Choose how much space notifications use.</span>
              </span>
              <select data-notification-size aria-label="Notification size">
                <option value="compact">Compact</option>
                <option value="standard">Standard</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label data-localefence-action>
              <span data-action-copy>
                <span data-action-title>Notification position</span>
                <span data-action-help>Choose which corner notifications appear in.</span>
              </span>
              <select data-notification-position aria-label="Notification position">
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
              </select>
            </label>
          </div>
          <div data-lookup-quota-panel>
            <strong>Location lookup quota</strong>
            <p data-lookup-quota aria-live="polite"></p>
          </div>
          <div data-reset-panel>
            <strong>Reset local data</strong>
            <p>Delete filters, settings, cache, queue, history, exclusions, and remembered block IDs from this browser. Existing X blocks are not undone.</p>
            <button data-reset-all type="button">Reset LocaleFence</button>
          </div>
        </div>
        <div data-localefence-footer>
          <span data-localefence-stats data-country-view>
            <span data-stat-accounts></span> · <span data-stat-locations></span> · <span data-stat-hidden></span>
          </span>
          <span data-history-stats data-history-view hidden></span>
          <span data-queue-stats data-queue-view hidden></span>
          <span data-settings-view hidden>Settings are saved automatically.</span>
          <button type="button" data-clear-history data-history-view hidden>Clear history</button>
          <button type="button" data-clear-queue data-queue-view hidden>Clear queue</button>
          <button type="button" data-clear-cache data-country-view>Clear cache</button>
        </div>
      </div>
    `;
    const $$ = (selector) => overlay.querySelector(selector);
    const closeButton = $$("[data-localefence-close]");
    const searchInput = $$("[data-country-search]");
    const countryRows = $$("[data-country-rows]");
    const statAccounts = $$("[data-stat-accounts]");
    const statLocations = $$("[data-stat-locations]");
    const statHidden = $$("[data-stat-hidden]");
    const hideToggle = $$("[data-hide-matching]");
    const blockToggle = $$("[data-block-matching]");
    const notificationsToggle = $$("[data-notifications-enabled]");
    const matchStoreRegionToggle = $$("[data-match-store-region]");
    const notificationSizeSelect = $$("[data-notification-size]");
    const notificationPositionSelect = $$("[data-notification-position]");
    const blockStatus = $$("[data-block-status]");
    const exclusionSummary = $$("[data-exclusion-summary]");
    const exclusionCount = $$("[data-exclusion-count]");
    const lookupStatus = $$("[data-lookup-status]");
    const lookupQuotaLabel = $$("[data-lookup-quota]");
    const historyList = $$("[data-history-list]");
    const historyCount = $$("[data-history-count]");
    const historyStats = $$("[data-history-stats]");
    const clearHistoryButton = $$("[data-clear-history]");
    const queueList = $$("[data-queue-list]");
    const queueCount = $$("[data-queue-count]");
    const queueStats = $$("[data-queue-stats]");
    const clearQueueButton = $$("[data-clear-queue]");
    const viewButtons = [...overlay.querySelectorAll("[data-localefence-view]")];
    const countryViews = [...overlay.querySelectorAll("[data-country-view]")];
    const historyViews = [...overlay.querySelectorAll("[data-history-view]")];
    const queueViews = [...overlay.querySelectorAll("[data-queue-view]")];
    const settingsViews = [...overlay.querySelectorAll("[data-settings-view]")];
    const sortButtons = [...overlay.querySelectorAll("[data-sort-column]")];
    const countryOptions = new Map();
    const sortLabels = { selected: "✓", name: "Region", seen: "Accounts" };
    const sortDefaults = { selected: "desc", name: "asc", seen: "desc" };
    let currentView = "countries";
    let menuOpener = null;
    const updateLookupStatus = () => {
      lookupStatus.hidden = !lookupStatusMessage;
      lookupStatus.textContent = lookupStatusMessage;
      lookupStatus.dataset.error = lookupStatusError.toString();
    };
    renderLookupStatus = updateLookupStatus;
    const updateLookupQuota = () => {
      lookupQuotaLabel.textContent = describeLookupQuota();
    };
    renderLookupQuota = updateLookupQuota;
    const renderQueue = () => {
      queueCount.textContent = lookupRecords.size ? `(${lookupRecords.size.toLocaleString()})` : "";
      queueStats.textContent = `${lookupRecords.size.toLocaleString()} queued ${lookupRecords.size === 1 ? "account" : "accounts"}`;
      clearQueueButton.disabled = lookupRecords.size === 0;
      if (currentView !== "queue") return;
      queueList.replaceChildren();
      if (!lookupRecords.size) {
        const empty = document.createElement("div");
        empty.dataset.queueEmpty = "true";
        empty.textContent = "No accounts are waiting for a location check or block.";
        queueList.appendChild(empty);
        return;
      }
      const statusLabels = {
        lookup: "Waiting for location",
        checking: "Checking location",
        retrying: "Retrying location",
        rate_limited: "Waiting for X quota",
        failed: "Location check failed",
        awaiting_block: "Waiting to block",
      };
      [...lookupRecords.values()]
        .sort((a, b) => Number(a.enqueuedAt) - Number(b.enqueuedAt))
        .forEach((record) => {
          const item = document.createElement("article");
          item.dataset.queueEntry = "true";
          const header = document.createElement("div");
          header.dataset.queueHeader = "true";
          const marker = document.createElement("span");
          marker.textContent = record.country ? countryFlags.get(record.country) || "🌐" : "⏳";
          const account = document.createElement("span");
          account.dataset.queueAccount = "true";
          account.textContent = record.name ? `${record.name} (@${record.username})` : `@${record.username}`;
          const status = document.createElement("span");
          status.dataset.queueStatus = "true";
          status.textContent = Object.prototype.hasOwnProperty.call(statusLabels, record.status)
            ? statusLabels[record.status]
            : "Waiting";
          if (record.matchSource === "store") {
            status.textContent += " · store region";
            status.title = "Matched by the Connected via app-store region, not the account-based-in country.";
          }
          if (record.attempts && record.status !== "rate_limited") {
            status.textContent += ` · ${record.attempts}/${maxLookupRetries}`;
          }
          if (record.lastError) status.title = record.lastError;
          const time = document.createElement("time");
          const queuedAt = safeDate(record.enqueuedAt);
          time.dataset.historyMeta = "true";
          time.dateTime = queuedAt.toISOString();
          time.textContent = queuedAt.toLocaleString();
          const tweetUrl = normalizeTweetUrl(record.tweetUrl);
          const post = document.createElement(tweetUrl ? "a" : "div");
          post.dataset.queuePost = "true";
          post.textContent = record.tweetText || "Post text unavailable";
          if (tweetUrl) {
            post.href = tweetUrl;
            post.target = "_blank";
            post.rel = "noopener noreferrer";
          }
          const actions = document.createElement("div");
          actions.dataset.queueActions = "true";
          if (record.status === "failed") {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.textContent = "Retry";
            retry.addEventListener("click", () => retryLookupRecord(record.key));
            actions.appendChild(retry);
          }
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Remove";
          remove.addEventListener("click", () => removeLookupRecord(record.username));
          actions.appendChild(remove);
          header.append(marker, account, status, time);
          item.append(header, post, actions);
          queueList.appendChild(item);
        });
    };
    renderLookupQueue = renderQueue;
    const renderHistory = () => {
      historyCount.textContent = blockHistory.length ? `(${blockHistory.length.toLocaleString()})` : "";
      historyStats.textContent = `${blockHistory.length.toLocaleString()} block ${blockHistory.length === 1 ? "event" : "events"}`;
      clearHistoryButton.disabled = blockHistory.length === 0;
      if (currentView !== "history") return;
      historyList.replaceChildren();
      if (!blockHistory.length) {
        const empty = document.createElement("div");
        empty.dataset.historyEmpty = "true";
        empty.textContent = "No accounts have been blocked yet.";
        historyList.appendChild(empty);
        return;
      }
      const statusLabels = {
        blocked: "Blocked",
        excluded: "Excluded",
        unblock_failed: "Excluded · still blocked",
      };
      blockHistory.forEach((entry) => {
        const item = document.createElement("article");
        item.dataset.historyEntry = "true";
        const header = document.createElement("div");
        header.dataset.historyHeader = "true";
        const flag = document.createElement("span");
        flag.dataset.historyFlag = "true";
        flag.setAttribute("role", "img");
        flag.setAttribute("aria-label", entry.country || "Unknown location");
        flag.textContent = countryFlags.get(entry.country) || "🌐";
        const account = document.createElement("span");
        account.dataset.historyAccount = "true";
        account.textContent = entry.name ? `${entry.name} (@${entry.username})` : `@${entry.username}`;
        const status = document.createElement("span");
        status.dataset.historyStatus = "true";
        status.dataset.status = entry.status || "blocked";
        status.textContent = Object.prototype.hasOwnProperty.call(statusLabels, entry.status)
          ? statusLabels[entry.status]
          : "Blocked";
        if (entry.matchSource === "store") {
          status.textContent += " · store region";
          status.title = "Matched by the Connected via app-store region, not the account-based-in country.";
        }
        const time = document.createElement("time");
        const blockedAt = safeDate(entry.blockedAt);
        time.dataset.historyMeta = "true";
        time.dateTime = blockedAt.toISOString();
        time.textContent = blockedAt.toLocaleString();
        const tweetUrl = normalizeTweetUrl(entry.tweetUrl);
        const post = document.createElement(tweetUrl ? "a" : "div");
        post.dataset.historyPost = "true";
        post.textContent = entry.tweetText || "Post text unavailable";
        if (tweetUrl) {
          post.href = tweetUrl;
          post.target = "_blank";
          post.rel = "noopener noreferrer";
          post.title = "Open triggering post";
        }
        header.append(flag, account, status);
        if (entry.status !== "excluded" && entry.ownerRestId === getOwnRestId()) {
          const action = document.createElement("button");
          action.dataset.historyAction = "true";
          action.type = "button";
          action.textContent = entry.status === "unblock_failed" ? "Retry unblock" : "Exclude";
          action.addEventListener("click", async () => {
            action.disabled = true;
            action.textContent = "Working…";
            if (!(await excludeAndUnblock({
              country: entry.country,
              historyId: entry.id,
              ownerRestId: entry.ownerRestId,
              restId: entry.restId,
              username: entry.username,
            }))) renderHistory();
          });
          header.appendChild(action);
        }
        header.appendChild(time);
        item.append(header, post);
        historyList.appendChild(item);
      });
    };
    renderBlockHistory = renderHistory;
    const updateActionControls = () => {
      hideToggle.checked = hideEnabled;
      blockToggle.checked = blockEnabled;
      notificationsToggle.checked = notificationsEnabled;
      matchStoreRegionToggle.checked = matchStoreRegion;
      notificationSizeSelect.value = notificationSize;
      notificationPositionSelect.value = notificationPosition;
      const counts = [
        blockSuccessCount ? `${blockSuccessCount.toLocaleString()} blocked this page` : "",
        `${totalBlockedCount.toLocaleString()} total blocked`,
        blockQueue.length ? `${blockQueue.length.toLocaleString()} queued` : "",
      ].filter(Boolean);
      blockStatus.textContent = [blockErrorMessage || (blockEnabled ? "On" : "Off"), ...counts].join(" · ");
      blockStatus.dataset.error = Boolean(blockErrorMessage).toString();
      exclusionSummary.hidden = excludedUserIds.size === 0;
      exclusionCount.textContent = `${excludedUserIds.size.toLocaleString()} excluded ${excludedUserIds.size === 1 ? "account" : "accounts"}`;
    };
    renderActionControls = updateActionControls;
    const cycleSort = (column) => {
      const first = `${column}:${sortDefaults[column]}`;
      const second = `${column}:${sortDefaults[column] === "asc" ? "desc" : "asc"}`;
      countrySort = countrySort === first ? second : countrySort === second ? "default" : first;
      writeStorage("localefence.countrySort", countrySort);
    };
    const createCountryOption = (country) => {
      const row = document.createElement("tr");
      const emoji = countryFlags.get(country);
      const isContinent = continentGroups.has(country);
      row.dataset.continent = isContinent.toString();
      row.innerHTML = `
        <td><input type="checkbox"></td>
        <td><span data-region-cell></span></td>
        <td><div data-seen-cell><span data-seen-count></span><div data-seen-bar><div data-seen-fill></div></div></div></td>
      `;

      const cb = row.querySelector("input");
      const name = row.querySelector("[data-region-cell]");
      const count = row.querySelector("[data-seen-count]");
      const progress = row.querySelector("[data-seen-fill]");
      cb.value = country;
      cb.checked = isCountrySelected(country);
      cb.setAttribute("aria-label", country);
      cb.addEventListener("change", () => {
        if (cb.checked && blockEnabled) {
          const confirmed = globalThis.confirm(
            `Add ${country} to the active automatic-block filters? Matching accounts already visible may be blocked immediately after a fresh location check.`,
          );
          if (!confirmed) {
            cb.checked = false;
            return;
          }
        }
        if (cb.checked) selectedLocations.add(country);
        else selectedLocations.delete(country);
        saveSelectedLocations();
        renderStats();
        refreshProcessedAccounts();
        resumeAwaitingBlocks();
      });

      if (emoji) name.appendChild(createFlagNode(emoji));
      name.append(country);
      if (isContinent) {
        const label = document.createElement("span");
        label.dataset.continentLabel = "true";
        label.textContent = "Continent";
        name.appendChild(label);
      }
      row.addEventListener("click", (event) => {
        if (event.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });

      const option = { checkbox: cb, count, country, index: countryOptions.size, progress, row };
      countryOptions.set(country, option);
      countryRows.appendChild(row);
      return option;
    };
    const ensureCountryOption = (country) => countryOptions.get(country) || createCountryOption(country);
    const ensureCountryList = () => {
      if (countryOptions.size) return;
      countryFlags.forEach((_, country) => {
        ensureCountryOption(country);
      });
      selectedLocations.forEach((country) => {
        ensureCountryOption(country);
      });
    };
    const applyCountrySearch = () => {
      const term = searchInput.value.trim().toLowerCase();
      countryOptions.forEach((option) => {
        const match = !term || option.country.toLowerCase().includes(term);
        option.row.style.display = match ? "" : "none";
      });
    };
    const renderStats = () => {
      if (!overlay.dataset.localefenceOpen) return;
      ensureCountryList();
      const { rows, total, counts } = getLocationStats();
      const matched = getSelectedAccountCount();
      statAccounts.textContent = `${total.toLocaleString()} accounts`;
      statLocations.textContent = `${rows.length.toLocaleString()} locations`;
      statHidden.textContent = `${matched.toLocaleString()} matched`;
      const [sortColumn, sortDirection] = countrySort.split(":");

      rows.forEach(([country]) => {
        ensureCountryOption(country);
      });
      selectedLocations.forEach((country) => {
        ensureCountryOption(country);
      });

      countryOptions.forEach((option) => {
        option.checkbox.checked = isCountrySelected(option.country);
        const count = getLocationCount(option.country, counts);
        const percent = total ? Math.round((count / total) * 100) : 0;
        option.count.textContent = count ? count.toLocaleString() : "";
        option.count.title = count
          ? `${count.toLocaleString()} cached accounts (${percent}%)${matchStoreRegion ? "; includes store regions, counted once per location" : ""}`
          : "";
        option.progress.style.width = `${percent}%`;
        option.row.dataset.selected = option.checkbox.checked.toString();
      });
      sortButtons.forEach((sortButton) => {
        const column = sortButton.dataset.sortColumn;
        const active = column === sortColumn;
        sortButton.textContent = active
          ? `${sortLabels[column]} ${sortDirection === "asc" ? "↑" : "↓"}`
          : sortLabels[column];
        sortButton.closest("th").dataset.activeSort = active.toString();
      });

      const sortedOptions = [...countryOptions.values()].sort((a, b) => {
        let result = 0;
        if (sortColumn === "selected") {
          result = Number(a.checkbox.checked) - Number(b.checkbox.checked);
        } else if (sortColumn === "name") {
          result = a.country.localeCompare(b.country);
        } else if (sortColumn === "seen") {
          result = getLocationCount(a.country, counts) - getLocationCount(b.country, counts);
        }
        if (result) return sortDirection === "desc" ? -result : result;
        return a.index - b.index;
      });
      countryRows.append(...sortedOptions.map((option) => option.row));
      applyCountrySearch();
    };
    renderLocationStats = renderStats;
    let savedBodyOverflow = "";
    let savedDocumentOverflow = "";
    let bodyScrollLocked = false;
    const lockBodyScroll = () => {
      // Fullscreen mobile sheet: keep the X feed behind from scrolling while
      // the dialog is open. Values are restored verbatim on close.
      if (bodyScrollLocked) return;
      bodyScrollLocked = true;
      try {
        savedBodyOverflow = document.body?.style?.overflow ?? "";
        savedDocumentOverflow = document.documentElement?.style?.overflow ?? "";
        if (document.body) document.body.style.overflow = "hidden";
        if (document.documentElement) document.documentElement.style.overflow = "hidden";
      } catch { /* Scroll locking is best effort. */ }
    };
    const unlockBodyScroll = () => {
      if (!bodyScrollLocked) return;
      bodyScrollLocked = false;
      try {
        if (document.body) document.body.style.overflow = savedBodyOverflow;
        if (document.documentElement) document.documentElement.style.overflow = savedDocumentOverflow;
      } catch { /* Scroll locking is best effort. */ }
    };
    unlockOverlayScroll = unlockBodyScroll;
    const setActiveView = (view) => {
      currentView = ["countries", "queue", "history", "settings"].includes(view) ? view : "countries";
      countryViews.forEach((node) => {
        node.hidden = currentView !== "countries";
      });
      historyViews.forEach((node) => {
        node.hidden = currentView !== "history";
      });
      queueViews.forEach((node) => {
        node.hidden = currentView !== "queue";
      });
      settingsViews.forEach((node) => {
        node.hidden = currentView !== "settings";
      });
      viewButtons.forEach((button) => {
        const active = button.dataset.localefenceView === currentView;
        button.dataset.active = active.toString();
        button.setAttribute("aria-pressed", active.toString());
      });
      if (currentView === "history") renderHistory();
      else if (currentView === "queue") renderQueue();
      else if (currentView === "countries") renderStats();
    };
    const openMenu = () => {
      menuOpener = document.activeElement;
      overlay.dataset.theme = getPageTheme();
      ensureCountryList();
      overlay.dataset.localefenceOpen = "true";
      triggerButtonNode?.setAttribute("aria-expanded", "true");
      setActiveView(currentView);
      lockBodyScroll();
      requestAnimationFrame(() => {
        try {
          closeButton.focus({ preventScroll: true });
        } catch {
          closeButton.focus();
        }
      });
    };
    const closeMenu = () => {
      if (!overlay.dataset.localefenceOpen) return;
      delete overlay.dataset.localefenceOpen;
      triggerButtonNode?.setAttribute("aria-expanded", "false");
      unlockBodyScroll();
      if (menuOpener?.isConnected) menuOpener.focus();
      menuOpener = null;
    };
    wiredOpenMenu = openMenu;
    overlay.addEventListener("click", async (event) => {
      const target = event.target.closest?.("button,[data-localefence-backdrop]");
      if (!target) return;
      if (target.matches("[data-localefence-backdrop],[data-localefence-close]")) {
        closeMenu();
      } else if (target.matches("[data-localefence-view]")) {
        setActiveView(target.dataset.localefenceView);
      } else if (target.matches("[data-clear-queue]")) {
        if (!lookupRecords.size) return;
        const confirmed = globalThis.confirm("Remove all accounts waiting for a location check or automatic block?");
        if (!confirmed) return;
        await clearLookupRecords(true);
      } else if (target.matches("[data-clear-history]")) {
        if (!blockHistory.length) return;
        const confirmed = globalThis.confirm("Clear the complete automatic-block history?");
        if (!confirmed) return;
        await clearBlockHistory(true);
      } else if (target.matches("[data-clear-exclusions]")) {
        const confirmed = globalThis.confirm(
          "Clear all account exclusions? Matching accounts currently in the feed may be blocked immediately.",
        );
        if (!confirmed) return;
        excludedUserIds.clear();
        saveExcludedUserIds();
        document.querySelectorAll('[data-account-state][data-state="excluded"]').forEach((badge) => badge.remove());
        updateActionControls();
        refreshProcessedAccounts();
      } else if (target.matches("[data-reset-all]")) {
        const confirmed = globalThis.confirm(
          "Delete all LocaleFence data stored in this browser? Existing blocks on X will remain in place.",
        );
        if (!confirmed) return;
        await resetLocaleFenceData();
      } else if (target.matches("[data-sort-column]")) {
        cycleSort(target.dataset.sortColumn);
        renderStats();
      } else if (target.matches("[data-clear-cache]")) {
        aboutUsers.clear();
        screenNames.clear();
        document.querySelectorAll("[data-account-based-in]").forEach((node) => node.remove());
        document.querySelectorAll("[data-localefence-hidden]").forEach((node) => {
          delete node.dataset.localefenceHidden;
        });
        renderStats();
        await clearCacheStores();
        findTweets(document);
      }
    });
    searchInput.addEventListener("input", applyCountrySearch);
    hideToggle.addEventListener("change", () => {
      hideEnabled = hideToggle.checked;
      writeStorage("localefence.hideEnabled", hideEnabled);
      refreshProcessedAccounts();
      renderStats();
    });
    notificationsToggle.addEventListener("change", () => {
      notificationsEnabled = notificationsToggle.checked;
      writeStorage("localefence.notificationsEnabled", notificationsEnabled);
      if (!notificationsEnabled) document.querySelector("[data-localefence-toasts]")?.remove();
    });
    matchStoreRegionToggle.addEventListener("change", () => {
      const nextEnabled = matchStoreRegionToggle.checked;
      if (nextEnabled && blockEnabled && !blockPaused) {
        const confirmed = globalThis.confirm(
          "Match accounts by their Connected via app-store region while automatic blocking is active? Matching accounts already visible may be blocked immediately after a fresh location check.",
        );
        if (!confirmed) {
          matchStoreRegionToggle.checked = false;
          return;
        }
      }
      matchStoreRegion = nextEnabled;
      writeStorage(matchStoreRegionStorageKey, matchStoreRegion);
      refreshProcessedAccounts();
      resumeAwaitingBlocks();
      renderStats();
    });
    notificationSizeSelect.addEventListener("change", () => {
      notificationSize = notificationSizes.has(notificationSizeSelect.value)
        ? notificationSizeSelect.value
        : "compact";
      notificationSizeSelect.value = notificationSize;
      writeStorage("localefence.notificationSize", notificationSize);
      const toastHost = document.querySelector("[data-localefence-toasts]");
      if (toastHost) toastHost.dataset.size = notificationSize;
    });
    notificationPositionSelect.addEventListener("change", () => {
      notificationPosition = notificationPositions.has(notificationPositionSelect.value)
        ? notificationPositionSelect.value
        : "top-right";
      notificationPositionSelect.value = notificationPosition;
      writeStorage("localefence.notificationPosition", notificationPosition);
      const toastHost = document.querySelector("[data-localefence-toasts]");
      if (toastHost) toastHost.dataset.position = notificationPosition;
    });
    blockToggle.addEventListener("change", () => {
      if (blockToggle.checked) {
        if (!selectedLocations.size) {
          blockToggle.checked = false;
          disableBlocking();
          showToast("Select at least one country or region first", { error: true });
          return;
        }
        const ownerRestId = getOwnRestId();
        if (!ownerRestId) {
          blockToggle.checked = false;
          disableBlocking("Automatic blocking requires a signed-in X account.");
          showToast(blockErrorMessage, { error: true });
          return;
        }
        const confirmed = globalThis.confirm(
          `Automatically block every encountered account matching your selected ${selectedLocations.size.toLocaleString()} ${selectedLocations.size === 1 ? "location" : "locations"}${matchStoreRegion ? " by reported location or Connected via store region" : ""} until you turn this setting off? Existing X blocks will not be undone.`,
        );
        if (!confirmed) {
          blockToggle.checked = false;
          return;
        }
        blockOwnerRestId = ownerRestId;
        writeStorage(blockOwnerStorageKey, blockOwnerRestId);
        blockEnabled = true;
        blockPaused = false;
        blockErrorMessage = "";
        writeStorage(blockPausedStorageKey, false);
        writeStorage(blockEnabledStorageKey, true);
        refreshProcessedAccounts();
        resumeAwaitingBlocks();
        updateActionControls();
      } else {
        disableBlocking();
      }
    });
    const overlayKeydownHandler = (event) => {
      if (!overlay.isConnected) {
        document.removeEventListener("keydown", overlayKeydownHandler);
        return;
      }
      if (!overlay.dataset.localefenceOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...overlay.querySelectorAll(
        '[data-localefence-menu] button:not([disabled]), [data-localefence-menu] input:not([disabled]), [data-localefence-menu] select:not([disabled]), [data-localefence-menu] a[href]',
      )].filter((element) => !element.closest("[hidden]") && getComputedStyle(element).display !== "none");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!overlay.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    removeOverlayKeydown();
    document.addEventListener("keydown", overlayKeydownHandler);
    removeOverlayKeydown = () => document.removeEventListener("keydown", overlayKeydownHandler);
    // The overlay enters the document here, on first open: appending a
    // body-level node any earlier wedges X's boot (proven by A/B bisect).
    document.body.appendChild(overlay);
    renderHistory();
    renderQueue();
    setActiveView("countries");
    updateActionControls();
    updateLookupStatus();
    updateLookupQuota();
    return true;
  };

  let mountFailureReported = false;
  const tryMountLocaleFence = (root, allowStandalone = false) => {
    try {
      findNav(root, allowStandalone);
      return true;
    } catch (error) {
      if (!mountFailureReported) {
        mountFailureReported = true;
        console.warn("LocaleFence could not mount its controls; it will retry.", error);
      }
      return false;
    }
  };

  ensureLocaleFenceStyles();
  tryMountLocaleFence(document);
  findTweets(document);
  const scanDocument = () => {
    ensureLocaleFenceStyles();
    tryMountLocaleFence(document);
    findTweets(document);
  };
  let mountWatchdogAttempts = 0;
  const ensureRuntimeMount = () => {
    // Only the sidebar trigger is watchdogged: the overlay is built lazily
    // on first open, so its absence is the normal state, not a failure.
    if (document.querySelector("[data-localefence-root]")) return;
    ensureLocaleFenceStyles();
    tryMountLocaleFence(document, true);
    mountWatchdogAttempts += 1;
    if (
      !document.querySelector("[data-localefence-root]") &&
      mountWatchdogAttempts < 20 &&
      (document.readyState !== "complete" || document.body)
    ) {
      setTimeout(ensureRuntimeMount, 250);
    }
  };
  const resumeVisibleWork = () => {
    if (document.visibilityState === "hidden") return;
    ensureLocaleFenceStyles();
    tryMountLocaleFence(document, true);
    findTweets(document);
    syncLookupBackoffUntil();
    if (lookupBackoffUntil) {
      if (lookupBackoffReason !== "session") setLookupStatus(describeLookupBackoff());
    } else if (lookupStatusMessage.startsWith("Location lookups are rate-limited.")) setLookupStatus();
    if (queue.length) scheduleQueue(Math.max(lookupBackoffUntil - Date.now(), 0));
  };
  if (document.readyState === "complete") resumeVisibleWork();
  else if (document.readyState === "interactive") scanDocument();
  try {
    // Rotating a phone (or resizing across breakpoints) must re-sync the
    // trigger between sidebar and drawer layouts without waiting for the next
    // X DOM mutation.
    globalThis.matchMedia?.("(max-width: 700px)")?.addEventListener?.("change", () => {
      tryMountLocaleFence(document, true);
    });
  } catch { /* Viewport listener is best effort. */ }
  document.addEventListener?.("DOMContentLoaded", scanDocument, { once: true });
  document.addEventListener?.("visibilitychange", resumeVisibleWork);
  globalThis.addEventListener("load", resumeVisibleWork, { once: true });
  globalThis.addEventListener("pageshow", resumeVisibleWork);
  globalThis.addEventListener("online", resumeVisibleWork);
  setTimeout(ensureRuntimeMount, 500);
  hydrationReady = hydrateCache()
    .catch(() => {})
    .finally(() => {
      findTweets(document);
      if (document.readyState === "complete") resumeVisibleWork();
    });

  const isLocaleFenceOwnedNode = (node) =>
    node?.matches?.("[data-localefence-root], [data-localefence-overlay], [data-localefence-toasts]") ||
    node?.closest?.("[data-localefence-root], [data-localefence-overlay], [data-localefence-toasts]");
  new MutationObserver((mutations) => {
    let runtimeWasRemoved = false;
    let needsMountCheck = false;
    let maybeDrawer = false;
    const changedTweets = new Set();
    for (const { addedNodes, removedNodes, target, type } of mutations) {
      if (isLocaleFenceOwnedNode(target)) continue;
      if (type === "attributes") {
        if (target?.matches?.("a")) {
          const tweet = closestTweet(target);
          if (
            tweet &&
            belongsToTweet(target, tweet) &&
            (target.closest?.('[data-testid="User-Name"]') || !target.closest?.('div[dir="auto"][lang], [role="group"]'))
          ) {
            changedTweets.add(tweet);
          }
        }
        continue;
      }
      const changedNodes = [...addedNodes, ...removedNodes];
      const authorHeader = target?.closest?.('[data-testid="User-Name"]');
      const insideBadge = target?.closest?.("[data-account-based-in]");
      const inModernHeaderArea = !target?.closest?.('div[dir="auto"][lang], [role="group"]');
      const tweetForMutation = closestTweet(target);
      const authorChanged = !insideBadge && Boolean(tweetForMutation) && (
        (authorHeader && changedNodes.some((node) => node?.nodeType === 1 &&
          !node.matches?.("[data-account-based-in]"))) ||
        changedNodes.some((node) => node?.matches?.('[data-testid="User-Name"]') ||
          node?.querySelector?.('[data-testid="User-Name"]')) ||
        (inModernHeaderArea && belongsToTweet(target, tweetForMutation) && changedNodes.some((node) =>
          node?.nodeType === 1 &&
          !node.matches?.("[data-account-based-in]") &&
          (node.matches?.('a[href^="/"]') || node.querySelector?.('a[href^="/"]')),
        ))
      );
      if (authorChanged) changedTweets.add(tweetForMutation);
      for (const node of removedNodes) {
        const lostOverlay = node?.matches?.("[data-localefence-overlay]") ||
          node?.querySelector?.("[data-localefence-overlay]");
        if (
          lostOverlay ||
          node?.matches?.("[data-localefence-root]") ||
          node?.querySelector?.("[data-localefence-root]")
        ) runtimeWasRemoved = true;
        if (lostOverlay && wiredOpenMenu) {
          // The dialog rebuilds on next open: release the stale wiring,
          // listener, render closures, and any scroll lock it held.
          wiredOpenMenu = null;
          removeOverlayKeydown();
          removeOverlayKeydown = () => {};
          unlockOverlayScroll();
          unlockOverlayScroll = () => {};
          renderLocationStats = () => {};
          renderActionControls = () => {};
          renderBlockHistory = () => {};
          renderLookupQueue = () => {};
          renderLookupStatus = () => {};
          renderLookupQuota = () => {};
        }
      }
      for (const node of addedNodes) {
        // Skip text nodes and our own UI: menu renders add hundreds of nodes
        // that must not each trigger document-wide mount scans.
        if (node?.nodeType !== 1 || isLocaleFenceOwnedNode(node)) continue;
        findTweets(node);
        // Batch the expensive `:has()` navigation lookup to one check per
        // mutation batch, and only when navigation could be involved. The
        // drawer entry is likewise throttled (see
        // maybeEnsureLocaleFenceDrawerEntry).
        if (node.matches?.("nav") || node.querySelector?.("nav")) needsMountCheck = true;
        else if (node.matches?.("a[href]") || node.querySelector?.("a[href]")) maybeDrawer = true;
      }
    }
    changedTweets.forEach(handleTweet);
    if (needsMountCheck) tryMountLocaleFence(document);
    else if (runtimeWasRemoved) {
      ensureLocaleFenceStyles();
      tryMountLocaleFence(document, true);
    }
    if (maybeDrawer) maybeEnsureLocaleFenceDrawerEntry();
  }).observe(document, { attributes: true, attributeFilter: ["href"], childList: true, subtree: true });
})();
