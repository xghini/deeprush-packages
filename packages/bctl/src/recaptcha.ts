import type {Page} from 'playwright';

// Read-only state of a reCAPTCHA widget on a page, for telling a person when there is something to click.
// Nothing here clicks, solves or changes the page.
//
// From 1426 千窗's Arena nodes (2026-10-06/07):
// - the checkbox is an anchor iframe of about 302x76 (size=normal). Sites may also keep an invisible
//   anchor (size=invisible, 0x0) on every page: never a check to click, excluded by size;
// - a shown anchor whose checkbox (#recaptcha-anchor, role=checkbox) has not drawn yet cannot be clicked;
//   one that stays undrawn is a stuck widget;
// - the image challenge is a bframe iframe of at least 200x200 that is visible. Expired challenges stay
//   in the DOM with visibility:hidden (19 of them on one page), so visibility is checked, not presence.
//
// Self-contained (no module scope), so `${readRecaptchaState}` can be installed into a running Browser host.

export type RecaptchaState = {
  /** A visible checkbox anchor iframe (not the invisible one). */
  anchorShown: boolean;
  /** Its checkbox is drawn and can be clicked. */
  checkboxDrawn: boolean;
  /** The image challenge is open. */
  challengeOpen: boolean;
  /** A person can act now: a drawn checkbox or an open challenge. */
  actionable: boolean;
};

export async function readRecaptchaState(page: Page): Promise<RecaptchaState> {
  const shown = await page.evaluate(() => {
    const visible = (frame: HTMLIFrameElement, width: number, height: number) => {
      const rect = frame.getBoundingClientRect();
      const ok = frame.checkVisibility ? frame.checkVisibility({visibilityProperty: true, opacityProperty: true}) : rect.width > 0;
      return ok && rect.width >= width && rect.height >= height;
    };
    const anchors = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src*="recaptcha"][src*="anchor"]'))
      .filter((frame) => visible(frame, 200, 50))
      .map((frame) => frame.name);
    const challengeOpen = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src*="recaptcha"][src*="bframe"]'))
      .some((frame) => visible(frame, 200, 200));
    return {anchors, challengeOpen};
  });
  let checkboxDrawn = false;
  for (const frame of page.frames()) {
    if (checkboxDrawn) break;
    if (frame.isDetached() || !shown.anchors.includes(frame.name())) continue;
    checkboxDrawn = await frame.evaluate(() => {
      const box = document.querySelector('#recaptcha-anchor');
      if (!box || box.getAttribute('role') !== 'checkbox') return false;
      const rect = box.getBoundingClientRect();
      return rect.width >= 10 && rect.height >= 10;
    }).catch(() => false);
  }
  return {
    anchorShown: shown.anchors.length > 0,
    checkboxDrawn,
    challengeOpen: shown.challengeOpen,
    actionable: checkboxDrawn || shown.challengeOpen,
  };
}
