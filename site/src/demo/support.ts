// SPDX-License-Identifier: Apache-2.0
// Whether this browser can run the demo. ClientVM v1 is Chromium only: instance
// pages rely on Document-Isolation-Policy for cross-origin isolation. This is a
// cheap first check; the controller still verifies isolation when an instance
// boots and the demo reports that failure if it happens.

interface UADataBrand {
  brand: string;
  version: string;
}

/** Chromium 137 shipped Document-Isolation-Policy on desktop. */
const MIN_CHROMIUM = 137;

export type Support = { ok: true } | { ok: false; reason: string };

export function checkSupport(): Support {
  const brands = (navigator as Navigator & { userAgentData?: { brands: UADataBrand[] } })
    .userAgentData?.brands;
  const chromium = brands?.find((b) => b.brand === 'Chromium');
  if (!chromium) {
    return {
      ok: false,
      reason:
        'The live demo needs a Chromium-based browser (Chrome, Edge, Brave, Arc). ' +
        'ClientVM v1 relies on Document-Isolation-Policy, which other engines do not ship yet.',
    };
  }
  if (Number(chromium.version) < MIN_CHROMIUM) {
    return {
      ok: false,
      reason: `The live demo needs Chromium ${MIN_CHROMIUM} or later; this is ${chromium.version}.`,
    };
  }
  if (!('serviceWorker' in navigator)) {
    return { ok: false, reason: 'The live demo needs service workers, which are off here.' };
  }
  return { ok: true };
}
