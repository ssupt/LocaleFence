// ==UserScript==
// @name         LocaleFence for X
// @namespace    https://github.com/ssupt/LocaleFence
// @version      1.1.0
// @description  Hide posts and block accounts based on their X account location
// @author       ssupt
// @license      GPL-3.0-only
// @homepageURL  https://github.com/ssupt/LocaleFence
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
  // X uses this public bearer token in its own web client. It is not a personal credential.
  const authToken =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const queryUrl = "https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery";
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

  // Runtime state
  const screenNames = new Map();
  const aboutUsers = new Map();
  const pending = new Map();
  const queue = [];
  const lookupAttempts = new Map();
  const lookupRetryTimers = new Map();
  const lookupRecords = new Map();
  const blockQueue = [];
  const queuedBlockIds = new Set();
  const blockHistory = [];
  const excludedUserIds = new Set(
    (readStorage("localefence.excludedUserIds") || "").split("\n").filter(Boolean),
  );
  let processing = false;
  let blockProcessing = false;
  const blockEnabledStorageKey = "localefence.blockEnabled";
  const blockOwnerStorageKey = "localefence.blockOwnerRestId";
  const blockedAccountStorageKey = "localefence.blockedAccounts";
  const maxBlockedAccountEntries = 10000;
  const blockAccountKey = (ownerRestId, restId) =>
    ownerRestId && restId ? `${ownerRestId}:${restId}` : "";
  const blockedAccountKeys = new Set(
    (readStorage(blockedAccountStorageKey) || "")
      .split("\n")
      .filter((key) => /^\d+:\d+$/.test(key)),
  );
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
  }
  let blockPaused = false;
  let blockSuccessCount = 0;
  const storedTotalBlocked = readStorage("localefence.totalBlocked");
  const parsedTotalBlocked = Number(storedTotalBlocked);
  let totalBlockedCount = Number.isFinite(parsedTotalBlocked) && parsedTotalBlocked >= 0
    ? parsedTotalBlocked
    : 0;
  let blockErrorMessage = invalidStoredBlockOwner
    ? "Automatic blocking was turned off. Enable it again for this X account."
    : "";
  let lookupStatusMessage = "";
  let lookupStatusError = false;
  let queueTimer = null;
  let hydrationReady = Promise.resolve();
  let lastRequestTime = 0;
  let lastBlockRequestTime = 0;
  const countryAliases = {
    "Cabo Verde": "Cape Verde",
    Eswatini: "Swaziland",
    "North Macedonia": "Macedonia",
    Türkiye: "Turkey",
    "South Korea": "Korea",
    Czechia: "Czech Republic",
  };
  const dayMs = 24 * 60 * 60 * 1000;
  const cacheTtlMs = 28 * dayMs;
  const countryRequestDelayMs = 750;
  const blockRequestDelayMs = 2000;
  const maxLookupRetries = 6;
  const maxLookupQueueEntries = 500;
  const maxCachedAccounts = 5000;
  const maxBlockHistoryEntries = 250;
  const maxPendingTargetsPerAccount = 25;
  const countryRequestTimeoutMs = 20000;
  const blockRequestTimeoutMs = 20000;
  const resolveCountryAlias = (country) => countryAliases[country] || country;
  const storedValues = readStorage("localefence.locations");
  const selectedLocations = new Set((storedValues || "").split("\n").map(resolveCountryAlias).filter(Boolean));
  const saveSelectedLocations = () => writeStorage("localefence.locations", [...selectedLocations].join("\n"));
  if (storedValues && storedValues !== [...selectedLocations].join("\n")) saveSelectedLocations();
  const storedHideEnabled = readStorage("localefence.hideEnabled");
  let hideEnabled = storedHideEnabled == null || storedHideEnabled === "true";
  let notificationsEnabled = readStorage("localefence.notificationsEnabled") !== "false";
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
  const saveExcludedUserIds = () =>
    writeStorage("localefence.excludedUserIds", [...excludedUserIds].join("\n"));

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
  const showToast = (
    message,
    { actionLabel = "", country = "", error = false, onAction = null, postText = "", targetUrl = "" } = {},
  ) => {
    if (!notificationsEnabled) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    targetUrl = normalizeTweetUrl(targetUrl);
    let host = document.querySelector("[data-localefence-toasts]");
    if (!host) {
      host = document.createElement("div");
      host.dataset.localefenceToasts = "true";
      root.appendChild(host);
    }
    host.dataset.theme = getPageTheme();
    const toast = document.createElement("div");
    toast.dataset.localefenceToast = "true";
    toast.dataset.error = error.toString();
    toast.dataset.interactive = Boolean((actionLabel && onAction) || targetUrl).toString();
    toast.dataset.clickable = Boolean(targetUrl).toString();
    toast.setAttribute("role", error ? "alert" : "status");
    const icon = document.createElement("span");
    icon.dataset.toastIcon = "true";
    icon.textContent = error ? "!" : "✓";
    const body = document.createElement("span");
    body.dataset.toastBody = "true";
    const copy = document.createElement(targetUrl ? "a" : "span");
    copy.dataset.toastCopy = "true";
    if (targetUrl) {
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
    if (postText) {
      const post = document.createElement("span");
      post.dataset.toastPost = "true";
      post.textContent = postText;
      copy.appendChild(post);
    }
    if (targetUrl) {
      const hint = document.createElement("span");
      hint.dataset.toastHint = "true";
      hint.textContent = "Click to view post";
      copy.appendChild(hint);
    }
    if (actionLabel && onAction) {
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
    toast.append(icon, body);
    host.appendChild(toast);
    requestAnimationFrame(() => {
      toast.dataset.visible = "true";
    });
    const removalTimer = setTimeout(() => {
      toast.dataset.visible = "false";
      setTimeout(() => toast.remove(), 200);
    }, actionLabel ? 12000 : postText ? 5200 : 3200);
  };
  const compact = (object) =>
    Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ""));
  const usernameKey = (username) => username?.toLowerCase?.();
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

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fetchWithTimeout = async (url, options, timeoutMs) => {
    const Controller = globalThis.AbortController;
    if (!Controller) return globalThis.fetch(url, options);
    const controller = new Controller();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await globalThis.fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
  const requestResult = (request, fallback) =>
    new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result ?? fallback);
      request.onerror = () => resolve(fallback);
    });
  const getEntries = (db, storeName) => {
    try {
      const store = db.transaction(storeName, "readonly").objectStore(storeName);
      return Promise.all([
        requestResult(store.getAllKeys(), []),
        requestResult(store.getAll(), []),
      ]).then(([keys, values]) => keys.slice(0, values.length).map((key, index) => [key, values[index]]));
    } catch {
      return Promise.resolve([]);
    }
  };
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
  const replaceStore = (db, storeName, entries) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      entries.forEach(([key, value]) => {
        store.put(value, key);
      });
      return transactionDone(tx);
    } catch {
      return Promise.resolve(false);
    }
  };
  const replaceValueStore = (db, storeName, values) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      values.forEach((value) => store.put(value));
      return transactionDone(tx);
    } catch {
      return Promise.resolve(false);
    }
  };
  const processAboutUser = (user) => {
    if (!user?.rest_id || !user.core?.screen_name) return null;
    return compact({
      restId: user.rest_id,
      screenName: user.core.screen_name,
      name: user.core.name,
      country: resolveCountryAlias(user.about_profile?.account_based_in),
      updatedAt: Date.now(),
    });
  };
  const normalizeStoredUser = (restId, user) =>
    compact({
      restId: user?.restId || restId,
      screenName: user?.screenName,
      name: user?.name,
      country: resolveCountryAlias(user?.country),
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
  const saveAboutUser = async (user, removedRestIds = []) => {
    if (!user.restId) return false;
    const key = usernameKey(user.screenName);
    removeScreenNameMappings(user.restId, key);
    if (key) screenNames.set(key, user.restId);
    try {
      const db = await dbPromise;
      if (!db) return false;
      const tx = db.transaction("aboutUsers", "readwrite");
      const store = tx.objectStore("aboutUsers");
      store.put(user, user.restId);
      removedRestIds.forEach((restId) => store.delete(restId));
      return transactionDone(tx);
    } catch {
      return false;
    }
  };
  const saveAboutResponse = async (json) => {
    const aboutUser = processAboutUser(json?.data?.user_result_by_screen_name?.result);
    if (!aboutUser) return null;
    aboutUsers.set(aboutUser.restId, aboutUser);
    const removedRestIds = pruneAboutUsers();
    await saveAboutUser(aboutUser, removedRestIds);
    return aboutUser;
  };
  const clearCacheStores = async () => {
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
  const loadBlockHistory = async (db) => {
    const entries = await getValues(db, "blockHistory");
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
    let id = `memory:${Date.now()}:${entry.restId}`;
    try {
      const db = await dbPromise;
      if (db) {
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
    entry.status = status;
    renderBlockHistory();
    try {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction("blockHistory", "readwrite");
      tx.objectStore("blockHistory").put(entry);
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const clearBlockHistory = async () => {
    blockHistory.length = 0;
    renderBlockHistory();
    try {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction("blockHistory", "readwrite");
      tx.objectStore("blockHistory").clear();
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const persistLookupRecord = async (record) => {
    lookupRecords.set(record.key, record);
    renderLookupQueue();
    try {
      const db = await dbPromise;
      if (!db) return;
      const tx = db.transaction("lookupQueue", "readwrite");
      tx.objectStore("lookupQueue").put(record);
      await transactionDone(tx);
    } catch { /* IndexedDB persistence is best effort. */ }
  };
  const removeLookupRecord = async (username) => {
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
    lookupRecords.delete(key);
    renderLookupQueue();
    try {
      const db = await dbPromise;
      if (!db) return;
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
  const clearLookupRecords = async () => {
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
  const isCountryHidden = (country) => hideEnabled && isLocationMatched(country);
  const isCountryBlocked = (country) =>
    blockEnabled && !blockPaused && isLocationMatched(country);
  const clearBlockQueue = () => {
    blockQueue.length = 0;
    queuedBlockIds.clear();
  };
  const disableBlocking = (message = "", persist = true) => {
    blockEnabled = false;
    blockPaused = false;
    blockErrorMessage = message;
    if (persist) writeStorage(blockEnabledStorageKey, false);
    clearBlockQueue();
    lookupRecords.forEach((record) => {
      if (record.status === "awaiting_block") removeLookupRecord(record.username);
    });
    renderActionControls();
  };
  const ensureBlockOwner = () => {
    if (!blockEnabled) return false;
    if (blockOwnerRestId && blockOwnerRestId === getOwnRestId()) return true;
    const message = "Automatic blocking was turned off because the signed-in X account changed.";
    disableBlocking(message);
    showToast(message, { error: true });
    return false;
  };
  globalThis.addEventListener("storage", (event) => {
    if (event.key === null) {
      blockOwnerRestId = "";
      selectedLocations.clear();
      excludedUserIds.clear();
      blockedAccountKeys.clear();
      hideEnabled = true;
      notificationsEnabled = true;
      totalBlockedCount = 0;
      if (blockEnabled) disableBlocking();
      refreshProcessedAccounts();
      renderLocationStats();
      renderActionControls();
    } else if (event.key === blockOwnerStorageKey) {
      const ownerChanged = blockOwnerRestId && blockOwnerRestId !== (event.newValue || "");
      blockOwnerRestId = event.newValue || "";
      if (blockEnabled && ownerChanged) {
        disableBlocking("Automatic blocking is waiting for the new X account settings.", false);
      } else if (blockEnabled) {
        ensureBlockOwner();
      }
    } else if (event.key === blockEnabledStorageKey) {
      if (event.newValue !== "true") {
        if (blockEnabled) disableBlocking();
      } else {
        blockOwnerRestId = readStorage(blockOwnerStorageKey) || blockOwnerRestId;
        if (blockOwnerRestId === getOwnRestId() && selectedLocations.size) {
          blockEnabled = true;
          blockPaused = false;
          blockErrorMessage = "";
          refreshProcessedAccounts();
          resumeAwaitingBlocks();
          renderActionControls();
        } else {
          disableBlocking("Automatic blocking was not enabled because the active X account or filters differ.");
        }
      }
    } else if (event.key === "localefence.locations") {
      selectedLocations.clear();
      (event.newValue || "").split("\n").map(resolveCountryAlias).filter(Boolean).forEach((location) => {
        selectedLocations.add(location);
      });
      refreshProcessedAccounts();
      resumeAwaitingBlocks();
      renderLocationStats();
    } else if (event.key === "localefence.hideEnabled") {
      hideEnabled = event.newValue == null || event.newValue === "true";
      refreshProcessedAccounts();
      renderActionControls();
    } else if (event.key === "localefence.notificationsEnabled") {
      notificationsEnabled = event.newValue !== "false";
      if (!notificationsEnabled) document.querySelector("[data-localefence-toasts]")?.remove();
      renderActionControls();
    } else if (event.key === "localefence.excludedUserIds") {
      excludedUserIds.clear();
      (event.newValue || "").split("\n").filter(Boolean).forEach((restId) => excludedUserIds.add(restId));
      refreshProcessedAccounts();
      renderActionControls();
    } else if (event.key === blockedAccountStorageKey) {
      blockedAccountKeys.clear();
      (event.newValue || "").split("\n").filter((key) => /^\d+:\d+$/.test(key)).forEach((key) => {
        blockedAccountKeys.add(key);
      });
      trimBlockedAccountKeys();
    } else if (event.key === "localefence.totalBlocked") {
      const nextTotal = Number(event.newValue);
      totalBlockedCount = Number.isFinite(nextTotal) && nextTotal >= 0 ? nextTotal : 0;
      renderActionControls();
    }
  });
  const pauseBlocking = (message) => {
    blockPaused = true;
    blockErrorMessage = message;
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
    });
  };
  const sendBlockRequest = async (restId, url) => {
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new Error("X session CSRF token is unavailable");
    let response;
    try {
      response = await fetchWithTimeout(url, {
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
      }, blockRequestTimeoutMs);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("X request timed out; its result is unknown");
      }
      throw error;
    }
    if (response.ok) return;
    let details = "";
    try {
      const json = await response.json();
      details = json?.errors?.map((error) => error.message).filter(Boolean).join("; ") || "";
    } catch { /* An error body is optional. */ }
    throw new Error(`X returned ${response.status}${details ? `: ${details}` : ""}`);
  };
  const blockAccount = (restId) => sendBlockRequest(restId, blockUrl);
  const unblockAccount = (restId) => sendBlockRequest(restId, unblockUrl);
  const getAccountLabel = (restId, username) => {
    const name = aboutUsers.get(restId)?.name?.trim();
    return name ? `${name} (@${username})` : `@${username}`;
  };
  const excludeAndUnblock = async ({ country, historyId, ownerRestId, restId, username }) => {
    if (!ownerRestId || ownerRestId !== getOwnRestId()) {
      showToast("Switch back to the X account that created this block before changing it.", { error: true });
      return false;
    }
    const label = getAccountLabel(restId, username);
    excludedUserIds.add(restId);
    saveExcludedUserIds();
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
    blockSuccessCount = Math.max(0, blockSuccessCount - 1);
    markFeedAccount(username, "Excluded");
    try {
      await updateBlockHistoryStatus(historyId, "excluded");
    } catch { /* The successful unblock remains authoritative. */ }
    showToast(`${label} was unblocked and excluded`, { country });
    renderActionControls();
    return true;
  };
  const processBlockQueue = async () => {
    if (blockProcessing) return;
    blockProcessing = true;
    try {
      while (blockEnabled && blockQueue.length) {
        const { country, restId, tweetText, tweetUrl, username } = blockQueue.shift();
        queuedBlockIds.delete(restId);
        const cached = getCachedAccount(username);
        if (
          !cached ||
          !isCountryBlocked(cached.country) ||
          screenNames.get(usernameKey(username)) !== restId ||
          isKnownBlocked(blockOwnerRestId, restId) ||
          excludedUserIds.has(restId)
        ) {
          continue;
        }
        const waitTime = blockRequestDelayMs - (Date.now() - lastBlockRequestTime);
        if (waitTime > 0) await wait(waitTime);
        if (!ensureBlockOwner()) break;
        const latestCached = getCachedAccount(username);
        if (
          !latestCached ||
          !isCountryBlocked(latestCached.country) ||
          screenNames.get(usernameKey(username)) !== restId ||
          excludedUserIds.has(restId)
        ) continue;
        if (isKnownBlocked(blockOwnerRestId, restId)) continue;
        const requestOwnerRestId = blockOwnerRestId;
        try {
          await blockAccount(restId);
        } catch (error) {
          lastBlockRequestTime = Date.now();
          pauseBlocking(
            `Paused after an error: ${error?.message || "block request failed"}. Turn blocking off and on to retry.`,
          );
          continue;
        }
        lastBlockRequestTime = Date.now();
        rememberBlockedAccount(requestOwnerRestId, restId);
        blockSuccessCount += 1;
        totalBlockedCount += 1;
        writeStorage("localefence.totalBlocked", totalBlockedCount);
        const label = getAccountLabel(restId, username);
        markFeedAccount(username, "Blocked");
        const removal = removeLookupRecord(username);
        try {
          const historyEntry = await addBlockHistoryEntry({
            restId,
            ownerRestId: requestOwnerRestId,
            username,
            name: aboutUsers.get(restId)?.name?.trim() || "",
            country,
            tweetText,
            tweetUrl,
            blockedAt: Date.now(),
            status: "blocked",
          });
          await removal;
          showToast(`${label} was blocked`, {
            actionLabel: "Exclude",
            country,
            onAction: () => excludeAndUnblock({
              country,
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
          console.warn("LocaleFence blocked an account but could not finish local bookkeeping", error);
          showToast(`${label} was blocked, but LocaleFence could not save its local history.`, {
            country,
            error: true,
            postText: tweetText,
            targetUrl: tweetUrl,
          });
        }
        renderActionControls();
      }
    } finally {
      blockProcessing = false;
      renderActionControls();
    }
  };
  const getTweetSnapshot = (tweet) => {
    const text = tweet?.querySelector?.('[data-testid="tweetText"]')?.textContent?.replace(/\s+/g, " ").trim();
    const tweetText = text
      ? text.length > 320
        ? `${text.slice(0, 319)}…`
        : text
      : tweet?.querySelector?.('[data-testid="tweetPhoto"], video')
        ? "Media post"
        : "Post text unavailable";
    const link = tweet?.querySelector?.('time')?.closest?.('a[href*="/status/"]') ||
      tweet?.querySelector?.('a[href*="/status/"]');
    const tweetUrl = normalizeTweetUrl(link?.getAttribute("href"));
    return { tweetText, tweetUrl };
  };
  const enqueueBlock = (username, country, tweet, savedSnapshot = null) => {
    if (!isCountryBlocked(country) || !ensureBlockOwner()) return false;
    const verifiedUser = savedSnapshot?.verifiedUser;
    const key = usernameKey(username);
    if (
      !verifiedUser?.restId ||
      usernameKey(verifiedUser.screenName) !== key ||
      verifiedUser.country !== country
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
    if (queuedBlockIds.has(restId)) return true;
    queuedBlockIds.add(restId);
    const snapshot = savedSnapshot || getTweetSnapshot(tweet);
    blockQueue.push({
      country,
      restId,
      username,
      tweetText: snapshot.tweetText,
      tweetUrl: snapshot.tweetUrl,
    });
    processBlockQueue();
    renderActionControls();
    return true;
  };
  const resumeAwaitingBlocks = () => {
    lookupRecords.forEach((record) => {
      if (record.status !== "awaiting_block" || !record.country) return;
      if (
        !blockEnabled ||
        record.ownerRestId !== blockOwnerRestId ||
        !isLocationMatched(record.country) ||
        (record.restId && excludedUserIds.has(record.restId))
      ) {
        removeLookupRecord(record.username);
        return;
      }
      if (blockPaused) return;
      record.status = "lookup";
      record.attempts = 0;
      record.lastError = "";
      persistLookupRecord(record);
      if (!pending.has(record.key)) pending.set(record.key, []);
      if (!queue.some((username) => usernameKey(username) === record.key)) queue.push(record.username);
    });
    if (queue.length) scheduleQueue();
  };
  const resolveLookupRecord = (username, country, targets = [], verifiedUser = null) => {
    const key = usernameKey(username);
    const lookupRecord = lookupRecords.get(key);
    if (!lookupRecord) return;
    const identityVerified = verifiedUser?.restId && usernameKey(verifiedUser.screenName) === key;
    const restId = identityVerified ? verifiedUser.restId : "";
    const excluded = restId && excludedUserIds.has(restId);
    if (blockEnabled && isLocationMatched(country) && identityVerified && !excluded) {
      const snapshot = { tweetText: lookupRecord.tweetText, tweetUrl: lookupRecord.tweetUrl };
      updateLookupRecord(username, {
        status: "awaiting_block",
        attempts: 0,
        lastError: "",
        country,
        ownerRestId: blockOwnerRestId,
        restId,
        name: verifiedUser.name?.trim() || "",
      });
      if (!blockPaused && !enqueueBlock(username, country, targets[0]?.tweet, {
        ...snapshot,
        verifiedUser,
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
    let total = 0;
    const addCountry = (country) => {
      if (!country) return;
      total += 1;
      counts.set(country, (counts.get(country) || 0) + 1);
    };
    aboutUsers.forEach((user) => {
      addCountry(user.country);
    });

    const rows = [...counts.entries()].sort(([countryA, countA], [countryB, countB]) => {
      return countB - countA || countryA.localeCompare(countryB);
    });
    return { rows, total };
  };
  const getSelectedAccountCount = (rows) =>
    rows.reduce((sum, [country, count]) => (isLocationMatched(country) ? sum + count : sum), 0);
  const getLocationCount = (location, counts) => {
    if (!continentGroups.has(location)) return counts.get(location) || 0;
    let total = 0;
    counts.forEach((count, country) => {
      if (continentIncludesLocation(location, country)) total += count;
    });
    return total;
  };
  const getCachedAccount = (username) => {
    const key = usernameKey(username);
    if (!key) return null;
    const restId = screenNames.get(key);
    if (restId && aboutUsers.has(restId)) {
      const user = aboutUsers.get(restId);
      return { country: user.country, expired: isCacheExpired(user.updatedAt), restId };
    }
    return null;
  };

  // Cache hydration and location lookup processing
  const hydrateCache = async () => {
    const db = await dbPromise;
    if (!db) return;
    const [storedAboutUsers, , storedLookupRecords] = await Promise.all([
      getEntries(db, "aboutUsers"),
      loadBlockHistory(db),
      getValues(db, "lookupQueue"),
    ]);
    const aboutEntries = storedAboutUsers
      .map(([restId, user]) => normalizeStoredUser(restId, user))
      .filter((user) => user.restId && usernameKey(user.screenName) && !isCacheExpired(user.updatedAt))
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, maxCachedAccounts)
      .map((user) => [user.restId, user]);
    aboutEntries.forEach(([, nextUser]) => {
      const key = usernameKey(nextUser.screenName);
      aboutUsers.set(nextUser.restId, nextUser);
      if (!screenNames.has(key)) screenNames.set(key, nextUser.restId);
    });
    await replaceStore(db, "aboutUsers", aboutEntries);
    const retainedLookupRecords = storedLookupRecords
      .filter((record) => record?.key && record?.username)
      .sort((a, b) => Number(a.enqueuedAt) - Number(b.enqueuedAt))
      .slice(-maxLookupQueueEntries);
    retainedLookupRecords.forEach((record) => {
      if (!lookupRecords.has(record.key)) lookupRecords.set(record.key, record);
    });
    await replaceValueStore(db, "lookupQueue", retainedLookupRecords);
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
  const scheduleLookupRetry = (username, result) => {
    const key = usernameKey(username);
    if (!lookupRecords.has(key)) {
      pending.delete(key);
      return;
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
      return;
    }
    lookupAttempts.set(key, attempt);
    const rateLimited = result.status === 429;
    const baseDelay = result.retryAfterMs || (rateLimited ? 15000 : 2000);
    const maximumDelay = rateLimited ? 300000 : 60000;
    const delay = Math.min(baseDelay * 2 ** (attempt - 1), maximumDelay) + Math.floor(Math.random() * 750);
    if (rateLimited || result.status === 401 || result.status === 403 || result.reason === "session") {
      lookupBackoffUntil = Math.max(lookupBackoffUntil, Date.now() + delay);
    }
    const existingTimer = lookupRetryTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    lookupRetryTimers.set(
      key,
      setTimeout(() => {
        lookupRetryTimers.delete(key);
        if (!pending.has(key)) return;
        queue.push(username);
        scheduleQueue();
      }, delay),
    );
    updateLookupRecord(username, {
      attempts: attempt,
      status: "retrying",
      lastError: result.status ? `HTTP ${result.status}` : result.reason || "Temporary lookup failure",
    });
    setLookupStatus(
      rateLimited
        ? `X rate-limited location lookups; retrying automatically in about ${Math.ceil(delay / 1000)} seconds.`
        : `Location lookup failed temporarily; retrying automatically (${attempt}/${maxLookupRetries}).`,
    );
  };

  let lookupBackoffUntil = 0;
  const fetchCountry = async (username) => {
    const url = `${queryUrl}?${new URLSearchParams({ variables: JSON.stringify({ screenName: username }) })}`;
    const csrfToken = getCsrfToken();
    if (!csrfToken) return { found: false, retryable: true, reason: "session", retryAfterMs: 1500 };
    try {
      // The request uses the signed-in X session and only asks for account location metadata.
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          authorization: authToken,
          "x-csrf-token": csrfToken,
        },
        credentials: "include",
      }, countryRequestTimeoutMs);
      if (!res.ok) {
        const retryAfterSeconds = Number(res.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
        const retryable = res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500;
        return { found: false, retryable, retryAfterMs, status: res.status };
      }
      const aboutUser = await saveAboutResponse(await res.json());
      return aboutUser ? { country: aboutUser.country, found: true, user: aboutUser } : { found: false };
    } catch (error) {
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

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      await hydrationReady;
      while (queue.length) {
        const username = queue.shift();
        const key = usernameKey(username);
        const targets = pending.get(key);
        if (!targets) continue;
        const hasLookupRecord = lookupRecords.has(usernameKey(username));
        const cached = getCachedAccount(username);
        if (cached) {
          targets.forEach(({ container, tweet }) => {
            applyCountry(container, tweet, cached.country, username);
          });
          if (!cached.expired && !hasLookupRecord) {
            pending.delete(key);
            continue;
          }
        }
        const requestDelay = countryRequestDelayMs - (Date.now() - lastRequestTime);
        const backoffDelay = lookupBackoffUntil - Date.now();
        const waitTime = Math.max(requestDelay, backoffDelay);
        if (waitTime > 0) await wait(waitTime);
        updateLookupRecord(username, { status: "checking" });
        const result = await fetchCountry(username);
        lastRequestTime = Date.now();
        if (result.found) {
          clearLookupRetry(username);
          if (!lookupRetryTimers.size) setLookupStatus();
          renderLocationStats();
          targets.forEach(({ container, tweet }) => {
            applyCountry(container, tweet, result.country, username);
          });
          resolveLookupRecord(username, result.country, targets, result.user);
          pending.delete(key);
        } else if (result.retryable) {
          scheduleLookupRetry(username, result);
        } else {
          clearLookupRetry(username);
          if (result.status) {
            updateLookupRecord(username, {
              status: "failed",
              lastError: `HTTP ${result.status}`,
            });
            setLookupStatus(`X rejected location lookups with HTTP ${result.status}. Reload X if this continues.`, true);
          } else {
            removeLookupRecord(username);
          }
          pending.delete(key);
        }
      }
    } finally {
      processing = false;
      if (queue.length) scheduleQueue();
    }
  };

  const enqueue = (username, container, tweet) => {
    const key = usernameKey(username);
    if (!key) return;
    const cached = getCachedAccount(username);
    if (cached) {
      applyCountry(container, tweet, cached.country, username);
    }
    const knownBlocked = cached?.restId && isKnownBlocked(blockOwnerRestId, cached.restId);
    const needsFreshBlockProof =
      blockEnabled && !blockPaused && isLocationMatched(cached?.country) && !knownBlocked;
    const needsFreshLookup = !cached || cached.expired || needsFreshBlockProof;
    if (!needsFreshLookup) return;
    const lookupRecord = lookupRecords.get(key);
    if (lookupRecord?.status === "failed") return;
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
  const getFeedCell = (tweet) => tweet?.closest?.('[data-testid="cellInnerDiv"]') || tweet;
  const applyPostVisibility = (tweet, country) => {
    const target = getFeedCell(tweet);
    if (target) target.style.display = isCountryHidden(country) ? "none" : "";
  };
  const refreshProcessedAccounts = () => {
    document.querySelectorAll("[data-account-based-in]").forEach((node) => {
      const country = node.dataset.accountBasedIn;
      const tweet = node.closest('[data-testid="tweet"]');
      applyPostVisibility(tweet, country);
      enqueue(node.dataset.accountUsername, node.parentElement, tweet);
    });
  };
  const applyCountry = (container, tweet, country, username) => {
    if (!country) {
      container.querySelector("[data-account-based-in]")?.remove();
      applyPostVisibility(tweet, null);
      return;
    }
    const emoji = countryFlags.get(country);
    const existing = container.querySelector("[data-account-based-in]");
    const node = existing || document.createElement("span");
    const shouldRenderCountry = node.dataset.accountBasedIn !== country;
    node.dataset.accountBasedIn = country;
    node.dataset.accountUsername = username;
    node.title = `Account based in ${country}`;
    node.setAttribute("aria-label", `Account based in ${country}`);
    if (shouldRenderCountry && emoji) {
      node.textContent = "";
      node.appendChild(createFlagNode(emoji));
    } else if (shouldRenderCountry) {
      node.textContent = ` ${country}`;
    }
    if (!existing) container.appendChild(node);
    applyPostVisibility(tweet, country);
  };

  const handleTweet = (tweet) => {
    const container = tweet.querySelector('[data-testid="User-Name"]');
    const profileLink = [...(container?.querySelectorAll?.('a[href^="/"]') || [])].find((link) =>
      /^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.getAttribute("href") || ""),
    );
    const username = profileLink?.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})/)?.[1];
    if (!username) return;
    enqueue(username, container, tweet);
  };

  const findTweets = (root) => {
    if (root?.matches?.('[data-testid="tweet"]')) handleTweet(root);
    root?.querySelectorAll?.('[data-testid="tweet"]').forEach(handleTweet);
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
        color: inherit;
        font-family: inherit;
        font-size: 20px;
        font-weight: 400;
        line-height: 24px;
        border: none;
        background: transparent;
        border-radius: 9999px;
        cursor: pointer;
      }
      [data-localefence-trigger] > svg {
        width: 1.75rem;
        height: 1.75rem;
        flex-shrink: 0;
      }
      [data-localefence-trigger]:hover,
      [data-localefence-close]:hover {
        background: var(--lf-hover);
      }
      [data-localefence-label] {
        white-space: nowrap;
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
      }
      [data-localefence-menu] {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(600px, calc(100vw - 32px));
        height: 90vh;
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
      [data-localefence-root][data-localefence-open="true"] [data-localefence-backdrop] {
        display: block;
      }
      [data-localefence-root][data-localefence-open="true"] [data-localefence-menu] {
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
        padding: 16px;
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
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 10002;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        pointer-events: none;
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
        transform: translateY(8px);
        transition: opacity 0.2s, transform 0.2s;
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
    `;
    styleRoot.appendChild(style);
  };

  const findNav = (root) => {
    const nav = root?.closest?.('nav:has(a[href="/home"])') || root?.querySelector?.('nav:has(a[href="/home"])');
    if (!nav || nav.querySelector("[data-localefence-root]")) return;
    const wrapper = document.createElement("div");
    wrapper.dataset.localefenceRoot = "true";
    wrapper.dataset.theme = getPageTheme();
    wrapper.innerHTML = `
      <button data-localefence-trigger type="button" aria-haspopup="dialog" aria-expanded="false">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.75 5.5C3.75 4.67 4.42 4 5.25 4h13.5c.83 0 1.5.67 1.5 1.5 0 .37-.14.72-.39.99l-5.11 5.63V17c0 .57-.32 1.09-.82 1.34l-3 1.5c-.47.24-1.03.21-1.47-.06-.44-.27-.71-.76-.71-1.28v-6.38L4.14 6.49c-.25-.27-.39-.62-.39-.99zM5.85 6l4.49 5.49c.27.32.41.72.41 1.13v5.07l2-1v-4.07c0-.41.14-.81.41-1.13L17.65 6H5.85z" fill="currentColor"></path></svg>
        <span data-localefence-label>LocaleFence</span>
      </button>
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
                <span data-action-title>Show notifications</span>
                <span data-action-help>Show block results, errors, and triggering post snapshots.</span>
              </span>
              <input data-notifications-enabled type="checkbox" role="switch">
            </label>
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
    const $ = (selector) => wrapper.querySelector(selector);
    const triggerButton = $("[data-localefence-trigger]");
    const closeButton = $("[data-localefence-close]");
    const searchInput = $("[data-country-search]");
    const countryRows = $("[data-country-rows]");
    const statAccounts = $("[data-stat-accounts]");
    const statLocations = $("[data-stat-locations]");
    const statHidden = $("[data-stat-hidden]");
    const hideToggle = $("[data-hide-matching]");
    const blockToggle = $("[data-block-matching]");
    const notificationsToggle = $("[data-notifications-enabled]");
    const blockStatus = $("[data-block-status]");
    const exclusionSummary = $("[data-exclusion-summary]");
    const exclusionCount = $("[data-exclusion-count]");
    const lookupStatus = $("[data-lookup-status]");
    const historyList = $("[data-history-list]");
    const historyCount = $("[data-history-count]");
    const historyStats = $("[data-history-stats]");
    const clearHistoryButton = $("[data-clear-history]");
    const queueList = $("[data-queue-list]");
    const queueCount = $("[data-queue-count]");
    const queueStats = $("[data-queue-stats]");
    const clearQueueButton = $("[data-clear-queue]");
    const viewButtons = [...wrapper.querySelectorAll("[data-localefence-view]")];
    const countryViews = [...wrapper.querySelectorAll("[data-country-view]")];
    const historyViews = [...wrapper.querySelectorAll("[data-history-view]")];
    const queueViews = [...wrapper.querySelectorAll("[data-queue-view]")];
    const settingsViews = [...wrapper.querySelectorAll("[data-settings-view]")];
    const sortButtons = [...wrapper.querySelectorAll("[data-sort-column]")];
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
          status.textContent = statusLabels[record.status] || "Waiting";
          if (record.attempts) status.textContent += ` · ${record.attempts}/${maxLookupRetries}`;
          if (record.lastError) status.title = record.lastError;
          const time = document.createElement("time");
          const queuedAt = new Date(Number(record.enqueuedAt) || 0);
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
        status.textContent = statusLabels[entry.status] || "Blocked";
        const time = document.createElement("time");
        const blockedAt = new Date(Number(entry.blockedAt) || 0);
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
      if (!wrapper.dataset.localefenceOpen) return;
      ensureCountryList();
      const { rows, total } = getLocationStats();
      const counts = new Map(rows);
      const matched = getSelectedAccountCount(rows);
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
        option.count.title = count ? `${count.toLocaleString()} cached accounts (${percent}%)` : "";
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
      wrapper.dataset.theme = getPageTheme();
      ensureCountryList();
      wrapper.dataset.localefenceOpen = "true";
      triggerButton.setAttribute("aria-expanded", "true");
      setActiveView(currentView);
      requestAnimationFrame(() => closeButton.focus());
    };
    const closeMenu = () => {
      if (!wrapper.dataset.localefenceOpen) return;
      delete wrapper.dataset.localefenceOpen;
      triggerButton.setAttribute("aria-expanded", "false");
      if (menuOpener?.isConnected) menuOpener.focus();
      menuOpener = null;
    };
    wrapper.addEventListener("click", async (event) => {
      const target = event.target.closest?.("button,[data-localefence-backdrop]");
      if (!target) return;
      if (target.matches("[data-localefence-trigger]")) {
        openMenu();
      } else if (target.matches("[data-localefence-backdrop],[data-localefence-close]")) {
        closeMenu();
      } else if (target.matches("[data-localefence-view]")) {
        setActiveView(target.dataset.localefenceView);
      } else if (target.matches("[data-clear-queue]")) {
        if (!lookupRecords.size) return;
        const confirmed = globalThis.confirm("Remove all accounts waiting for a location check or automatic block?");
        if (!confirmed) return;
        await clearLookupRecords();
      } else if (target.matches("[data-clear-history]")) {
        if (!blockHistory.length) return;
        const confirmed = globalThis.confirm("Clear the complete automatic-block history?");
        if (!confirmed) return;
        await clearBlockHistory();
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
      } else if (target.matches("[data-sort-column]")) {
        cycleSort(target.dataset.sortColumn);
        renderStats();
      } else if (target.matches("[data-clear-cache]")) {
        aboutUsers.clear();
        screenNames.clear();
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
          `Automatically block every encountered account matching your selected ${selectedLocations.size.toLocaleString()} ${selectedLocations.size === 1 ? "location" : "locations"} until you turn this setting off? Existing X blocks will not be undone.`,
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
        writeStorage(blockEnabledStorageKey, true);
        refreshProcessedAccounts();
        resumeAwaitingBlocks();
        updateActionControls();
      } else {
        disableBlocking();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (!wrapper.dataset.localefenceOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...wrapper.querySelectorAll(
        '[data-localefence-menu] button:not([disabled]), [data-localefence-menu] input:not([disabled]), [data-localefence-menu] a[href]',
      )].filter((element) => !element.closest("[hidden]") && getComputedStyle(element).display !== "none");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    nav.insertBefore(wrapper, nav.lastElementChild);
    renderHistory();
    renderQueue();
    setActiveView("countries");
    updateActionControls();
    updateLookupStatus();
  };

  ensureLocaleFenceStyles();
  findNav(document);
  findTweets(document);
  hydrationReady = hydrateCache()
    .catch(() => {})
    .finally(() => findTweets(document));

  new MutationObserver((mutations) => {
    for (const { addedNodes } of mutations)
      for (const node of addedNodes) {
        findTweets(node);
        findNav(node);
      }
  }).observe(document, { childList: true, subtree: true });
})();
