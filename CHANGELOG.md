# Changelog

## 1.2.6 — 2026-10-07

- Preserve automatic-block error pauses when delayed settings events arrive from another tab.
- Keep request timeouts active while reading response bodies, including block and unblock responses.
- Preserve concurrent queue and cache writes while another tab loads and prunes IndexedDB data.
- Clear stale country flags and hidden states when X reuses a post for an unavailable author or replaces its author links or header.
- Associate queued lookups with the signed-in account that encountered them, preventing automatic blocks from crossing accounts.
- Cancel outstanding location requests on reset, synchronize resets across tabs, and prevent late responses from restoring deleted data.
- Add regression checks for delayed storage events, stalled response bodies, feed reuse, concurrent IndexedDB writes, and reset during startup.
