# LocaleFence privacy policy

Last updated: November 27, 2026

LocaleFence is a local-first browser tool for `x.com`. It does not operate a developer-controlled server, include analytics or advertising, or sell or share user data.

## Data the tool handles

To provide its visible features, LocaleFence reads X usernames and visible post content in pages you open. It requests X's **About this account** metadata for encountered accounts using your existing signed-in X session. If you explicitly enable automatic blocking, or choose to undo one of its blocks, it sends that action directly to X.

LocaleFence stores the following only in browser storage associated with `x.com`:

- selected locations, preferences, exclusions, counters, remembered block identifiers, and X's last reported lookup-quota headers;
- resolved X account IDs, display names, usernames, countries, the **Connected via** store label and its country, X's location-accuracy flag, and cache timestamps;
- a bounded copy of the 64 most recent lookup results for coordination across open X tabs, plus one-hour unavailable-profile markers that prevent repeated failed requests;
- pending lookup items and up to 250 automatic-block history entries, including a short snapshot and URL of the post that triggered each action and whether the match came from the reported country or the store region.

This information is used only to show account-location context, apply the filters you select, avoid duplicate actions, and let you review or undo automatic blocks. LocaleFence does not read direct messages.

## Network activity

LocaleFence sends requests only to `x.com` as part of the features above. No account, post, browsing, authentication, or location data is transmitted to the LocaleFence developer or to a third-party service.

Firefox describes any information sent outside the browser as data transmission, even when it goes directly back to the website providing the feature. The Firefox package therefore declares authentication information, personally identifying information, and website content as required transmission categories. Those declarations cover the X session token and account identifiers sent directly to X for location lookups and requested account actions; they do not mean that the LocaleFence developer receives them.

## Control and deletion

The cache, lookup queue, and block history can be cleared separately. **Settings → Reset LocaleFence** deletes all LocaleFence data stored in the current browser. Deleting local data or uninstalling the tool does not undo blocks already recorded by X. Because the data is stored with the X website rather than in Chrome extension storage, uninstalling the extension alone may not delete it; use the reset control or clear `x.com` site data.

## Security and limitations

LocaleFence never asks for an X password. It relies on the active X browser session and on X's private web interfaces, which can change without notice. Account-location metadata may be missing or inaccurate and should not be treated as a person's verified nationality or physical location. The same applies to the **Connected via** store region, which can lag behind or differ from where an account currently connects, and to X's location warning, which reports possible inaccuracy without establishing VPN or proxy use.

Questions or privacy requests can be filed through the [LocaleFence issue tracker](https://github.com/ssupt/LocaleFence/issues).
