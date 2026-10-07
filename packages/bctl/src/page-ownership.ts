import type {BrowserContext, Page} from 'playwright';

// Which open page is a record's page. A record names its page (page.name) and owns its Context
// (Symbol.for('apanel.browser-session.context-owner.v1') on the Context, with the record's pageName).
//
// Rules from 1426 千窗's Arena nodes, kept general here:
// - several pages with the name: a takeover that named its new page before closing the old one, then
//   threw, blocked a node for hours. Once the copies are settled (seen for settleMs) in one Context,
//   resolveDuplicates picks the one to keep and the others are closed; nothing of the caller can be
//   driving them, since the lookup failed while they all existed. Not settled or ambiguous: none;
// - the named page taken elsewhere on the same site (a person opened the site's leaderboard on it) is
//   still the record's page: callers that need the target path bring it back themselves;
// - the page dropped out of the named list while its owned Context stayed open: re-attached when that
//   Context holds exactly one target page. Several owned Contexts or pages are ambiguous: none.
//
// Self-contained (no module scope), so `${findOwnedPage}` can be installed into a running Browser host.

export type FindOwnedPageOptions = {
  /** The record's page proper (e.g. a URL prefix). */
  isTarget: (url: string) => boolean;
  /** Still the record's page when elsewhere here (same site). Defaults to isTarget. */
  isSameSite?: (url: string) => boolean;
  /** Among settled same-named copies in one Context: the page to keep, or null when it cannot be told. */
  resolveDuplicates?: (pages: Page[]) => Page | null;
  /** How long copies must have been seen before they are resolved (default 60 s). */
  settleMs?: number;
  /** Context owner marker key (default the BCTL browser-session key). */
  ownerKey?: symbol;
};

export function findOwnedPage(pages: Page[], contexts: readonly BrowserContext[] | undefined, name: string, options: FindOwnedPageOptions): Page | null {
  const named = (page: Page) => !page.isClosed() && (page as Page & {name?: string}).name === name;
  const matches = pages.filter((page) => named(page) && options.isTarget(page.url()));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const seenKey = Symbol.for('bctl.find-owned-page.seen-at');
    const now = Date.now();
    for (const page of matches) (page as unknown as Record<symbol, number>)[seenKey] ??= now;
    const settle = options.settleMs ?? 60_000;
    if (matches.some((page) => now - (page as unknown as Record<symbol, number>)[seenKey]! < settle)) return null;
    if (matches.some((page) => page.context() !== matches[0]!.context())) return null;
    const keep = options.resolveDuplicates
      ? options.resolveDuplicates(matches)
      : matches.every((page) => page.url() === matches[0]!.url()) ? matches[matches.length - 1]! : null;
    if (!keep) return null;
    for (const page of matches) if (page !== keep) page.close().catch(() => {});
    return keep;
  }
  const sameSite = options.isSameSite || options.isTarget;
  const away = pages.filter((page) => named(page) && sameSite(page.url()));
  if (away.length === 1) return away[0]!;
  const ownerKey = options.ownerKey || Symbol.for('apanel.browser-session.context-owner.v1');
  const owned = (contexts || []).filter((context) => (context as unknown as Record<symbol, {pageName?: string} | undefined>)[ownerKey]?.pageName === name);
  const candidates = owned.flatMap((context) => context.pages().filter((page) => !page.isClosed() && options.isTarget(page.url())));
  if (owned.length !== 1 || candidates.length !== 1) return null;
  const page = candidates[0]! as Page & {name?: string};
  page.name = name;
  if (!pages.includes(page)) {
    pages.push(page);
    page.once('close', () => {
      const index = pages.indexOf(page);
      if (index !== -1) pages.splice(index, 1);
    });
  }
  return page;
}
