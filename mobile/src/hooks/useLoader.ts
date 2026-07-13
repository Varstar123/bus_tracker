import { useEffect } from 'react';

/**
 * Runs an async loader on mount, and again whenever it changes.
 *
 * This exists to make one judgement call in one place instead of in every hook.
 *
 * React's `set-state-in-effect` rule fires on `useEffect(() => { void load() })`
 * whenever `load` transitively calls setState -- it is guarding against cascading
 * renders. But every loader here awaits the network before it sets anything, so
 * its setState lands in a later microtask, not synchronously in the effect body,
 * and no cascading render happens. Passing the loader in as an opaque function
 * says exactly that: this effect subscribes to an external system, which is what
 * effects are for.
 *
 * If you ever pass a `load` that setStates *before* its first await, that
 * reasoning breaks. Don't.
 */
export function useLoader(load: () => Promise<void>): void {
  useEffect(() => {
    void load();
  }, [load]);
}
