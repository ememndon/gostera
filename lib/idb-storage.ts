/**
 * IndexedDB-backed Zustand storage adapter.
 *
 * Replaces localStorage for the project store, removing the 5-10 MB browser limit.
 * IndexedDB can hold gigabytes — practical limit is disk space.
 *
 * Uses idb-keyval for a minimal, zero-config IndexedDB wrapper.
 */

import { get, set, del } from "idb-keyval";
import type { StateStorage } from "zustand/middleware";

export const idbStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    return (await get<string>(name)) ?? null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};
