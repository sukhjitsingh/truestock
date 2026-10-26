/**
 * The store that lets the entry and enroll screens hide the bottom tab bar
 * (lib/tab-bar-visibility.ts). The tab bar's links bypass the leg's discard
 * guard, so it must be gone while a draft is on screen — and must come back,
 * exactly once, when the screen is left or unmounted. Rendering is covered by
 * the browser harness; pinned here is the bookkeeping that decides visibility.
 */
import { describe, test, expect } from "bun:test";
import {
  hideTabBar,
  isTabBarHidden,
  subscribeTabBarHidden,
} from "@/lib/tab-bar-visibility";

describe("tab bar visibility store", () => {
  test("visible until something asks to hide it", () => {
    expect(isTabBarHidden()).toBe(false);
  });

  test("hidden while a request is held, visible again once it is released", () => {
    const release = hideTabBar();
    expect(isTabBarHidden()).toBe(true);
    release();
    expect(isTabBarHidden()).toBe(false);
  });

  test("a second request taken before the first is released keeps the bar hidden", () => {
    // A screen remounting registers its new request before the old cleanup runs.
    // A boolean would flip back to visible here, mid-entry.
    const first = hideTabBar();
    const second = hideTabBar();
    first();
    expect(isTabBarHidden()).toBe(true);
    second();
    expect(isTabBarHidden()).toBe(false);
  });

  test("releasing twice does not underflow and leave the bar suppressed forever", () => {
    const release = hideTabBar();
    release();
    release();
    // If the count had gone to -1, this request would net to 0 and the bar
    // would stay visible while hidden was asked for.
    const next = hideTabBar();
    expect(isTabBarHidden()).toBe(true);
    next();
    expect(isTabBarHidden()).toBe(false);
  });

  test("subscribers are told on hide and on release, and not after unsubscribing", () => {
    let calls = 0;
    const unsubscribe = subscribeTabBarHidden(() => {
      calls += 1;
    });
    const release = hideTabBar();
    expect(calls).toBe(1);
    release();
    expect(calls).toBe(2);
    release(); // already released: no notification
    expect(calls).toBe(2);
    unsubscribe();
    hideTabBar()();
    expect(calls).toBe(2);
  });
});
