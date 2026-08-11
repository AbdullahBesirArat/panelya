"use client";

import { useCallback, useEffect, useState } from "react";

const popstateSubscribers = new Set<() => void>();
let popstateListening = false;

function notifyPopstateSubscribers() {
  popstateSubscribers.forEach((subscriber) => subscriber());
}

function subscribeToPopstate(subscriber: () => void) {
  popstateSubscribers.add(subscriber);
  if (!popstateListening) {
    window.addEventListener("popstate", notifyPopstateSubscribers);
    popstateListening = true;
  }
  return () => {
    popstateSubscribers.delete(subscriber);
    if (popstateListening && popstateSubscribers.size === 0) {
      window.removeEventListener("popstate", notifyPopstateSubscribers);
      popstateListening = false;
    }
  };
}

/**
 * Keeps one admin filter in the query string without triggering a route transition.
 * Each user change creates a history entry; popstate then restores the matching control.
 * Reading the initial URL in an effect avoids a server/client hydration mismatch.
 */
export function useUrlFilterState<T extends string>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    const readFromUrl = () => {
      const next = new URLSearchParams(window.location.search).get(key);
      setValue((next === null ? fallback : next) as T);
    };
    readFromUrl();
    return subscribeToPopstate(readFromUrl);
  }, [fallback, key]);

  const update = useCallback((next: T) => {
    setValue(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set(key, next);
    else url.searchParams.delete(key);
    const target = `${url.pathname}${url.search}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (target !== current) window.history.pushState({}, "", target);
  }, [key]);

  return [value, update] as const;
}
