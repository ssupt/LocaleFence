"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("localefence.user.js", "utf8");

const boot = ({ currentOwner, storedOwner }) => {
  const values = new Map([
    ["localefence.blockEnabled", "true"],
    ["localefence.notificationsEnabled", "false"],
    ...(storedOwner ? [["localefence.blockOwnerRestId", storedOwner]] : []),
  ]);
  const listeners = new Map();
  const makeNode = () => ({
    appendChild() {},
    closest() { return null; },
    dataset: {},
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    style: {},
  });
  const documentElement = makeNode();
  documentElement.lang = "en";
  const document = {
    body: null,
    cookie: `twid=${encodeURIComponent(`u=${currentOwner}`)}`,
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
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
  };
  context.globalThis = context;
  context.addEventListener = (type, listener) => listeners.set(type, listener);
  vm.runInNewContext(source, context);
  return {
    blockEnabled: () => values.get("localefence.blockEnabled"),
    storage: (key, newValue) => listeners.get("storage")({ key, newValue }),
  };
};

assert.equal(boot({ currentOwner: "2", storedOwner: "1" }).blockEnabled(), "false");
assert.equal(boot({ currentOwner: "1" }).blockEnabled(), "false");

const matchingOwner = boot({ currentOwner: "1", storedOwner: "1" });
assert.equal(matchingOwner.blockEnabled(), "true");
matchingOwner.storage("localefence.blockEnabled", "false");
assert.equal(matchingOwner.blockEnabled(), "false");

const changedOwner = boot({ currentOwner: "1", storedOwner: "1" });
changedOwner.storage("localefence.blockOwnerRestId", "2");
assert.equal(changedOwner.blockEnabled(), "false");

console.log("LocaleFence account-safety checks passed");
