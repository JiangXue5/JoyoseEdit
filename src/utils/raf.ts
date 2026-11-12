// Coalesce expensive work (serialise + reactive write + path re-detection)
// into a single call per animation frame. Typing in a number input fires
// `input` on every keystroke; without this each keystroke rebuilt the payload
// and re-rendered the sidebar counters, which is what made the WebUI feel
// sticky on device.

export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let queued = false;
  let lastArgs: A | null = null;

  return (...args: A) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const a = lastArgs as A;
      lastArgs = null;
      fn(...a);
    });
  };
}
