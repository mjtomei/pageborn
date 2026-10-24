// Receipts live in this phone's native storage (browser previews use their
// own origin). Exclude viewport, app URL/version and glasses identity: opening
// a keyboard, rotating the phone or updating Pageborne must not rerun checks.
// WebViews do not expose a phone serial number; OS/runtime/hardware hints also
// invalidate receipts restored to a different class of device.
export function speechDeviceIdentity({ navigator = globalThis.navigator, screen = globalThis.screen,
  pixelRatio = globalThis.devicePixelRatio } = {}) {
  return JSON.stringify([navigator?.userAgent, navigator?.platform, navigator?.hardwareConcurrency,
    navigator?.deviceMemory, navigator?.maxTouchPoints, [screen?.width, screen?.height].sort((a, b) => a - b), pixelRatio]);
}
