# Changelog

## 1.3.0 — 2026-11-27

- Support X's updated desktop and mobile timeline DOM (`ul > li > div[role=link] > article` without `data-testid` attributes) while keeping full compatibility with legacy markup and skipping nested quoted `<article>` cards.
- Prevent the desktop sidebar trigger from ever injecting into mobile or experimental bottom bars by requiring positive vertical-sidebar geometry, hiding `[data-localefence-root]` on narrow viewports, ejecting it on horizontal resize, and placing the mobile drawer entry above **Settings and privacy**.
- Fall back from `POST` to `GET` on HTTP `422` (in addition to `405`) for `AboutAccountQuery`, and remember `GET` for the remainder of the session so rejected `POST` probes don't waste quota.
- Read the **Connected via** app-store label, the store-region country derived from it, and X's location-accuracy flag from About Account responses.
- Add an off-by-default **Match Connected via store region** setting that extends hiding and automatic blocking to the app-store country; each automatic block still requires a fresh lookup.
- Show the Connected-via label and X's "location may not be accurate" warning in the flag tooltip, and mark store-region matches in block notifications, the lookup queue, and block history.
- Require recognized country-and-store labels for store matching, and discard stale derived countries when reading caches.
- Refresh legacy cached records on encounter, show warnings without a reported country, and label store-only flags.
- Include store matches in country counts without counting an account twice within a continent or the overall total.
- Save the block match reason at request dispatch so later settings or cache changes cannot rewrite history.
- Enforce cross-tab safety pauses, exclusions, filter state, and atomic block-counter updates inside the block request lock, deduplicate in-flight blocks, and clean up cancelled lookup records.
- Fall back cleanly when Web Locks rejects, validate `AboutAccountQuery` origin/paths (including `api.x.com`), guard against empty rate-limit headers and prototype-key lookups, cache empty 200 profile responses as unavailable, and sync cross-tab cache/queue/history clears.
- Fix 2-character CJK mobile drawer relabeling, drawer anchor scoping, stale drawer-entry cleanup, `[data-account-state]` preservation on badge re-renders, detached overlay cleanup, and startup IndexedDB write amplification.

## 1.2.6 — 2026-10-07

- Preserve automatic-block error pauses when delayed settings events arrive from another tab.
- Keep request timeouts active while reading response bodies, including block and unblock responses.
- Preserve concurrent queue and cache writes while another tab loads and prunes IndexedDB data.
- Clear stale country flags and hidden states when X reuses a post for an unavailable author or replaces its author links or header.
- Associate queued lookups with the signed-in account that encountered them, preventing automatic blocks from crossing accounts.
- Cancel outstanding location requests on reset, synchronize resets across tabs, and prevent late responses from restoring deleted data.
- Add regression checks for delayed storage events, stalled response bodies, feed reuse, concurrent IndexedDB writes, and reset during startup.
