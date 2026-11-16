/**
 * Electron draws native views (the browser preview's WebContentsView) above the
 * whole renderer, so DOM content overlapping one is hidden behind it. Hosts mark
 * themselves with `data-native-view` while their native view is shown.
 */
type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

export function rectsIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const NATIVE_VIEW_HOST = '[data-native-view]';

export function hasNativeViews(): boolean {
  return document.querySelector(NATIVE_VIEW_HOST) !== null;
}

export function nativeViewRects(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>(NATIVE_VIEW_HOST)].map((host) =>
    host.getBoundingClientRect()
  );
}
