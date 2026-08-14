/**
 * Cookie names for UI preferences that a server component must read.
 *
 * These live here — a plain module with no `"use client"` — rather than beside
 * the component that writes them, and that is not a tidiness preference. A
 * `const` exported from a `"use client"` module is NOT the value when a server
 * component imports it: Next replaces the module with a client-reference proxy,
 * so every export arrives as an opaque object. `cookies().get(RAIL_COOKIE)`
 * then looks up a proxy instead of `"ts-rail-expanded"` and returns `undefined`
 * on every request.
 *
 * That failure is silent and looks exactly like "the cookie isn't being set":
 * the write succeeds, the browser sends it, `cookies().getAll()` lists it by
 * name, and only `.get()` comes back empty. The rail shipped this way and read
 * as broken persistence for a full debugging pass.
 *
 * So: any constant shared across the server/client boundary belongs in a module
 * neither side marks as client-only.
 */

/** Whether the back-office rail is expanded. `"1"` or `"0"`. */
export const RAIL_COOKIE = "ts-rail-expanded";
