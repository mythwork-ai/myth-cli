import type { Plugin } from "vite";

const ORBITCODE_MODULE_ID = "orbitcode";
const RESOLVED_ORBITCODE_ID = "\0orbitcode";

// Virtual `orbitcode` module — the reactive state hooks every OrbitCode app
// imports (`import { useVar, useMap } from 'orbitcode'`). Backed by
// localStorage for local `orbit run`; the hosted runtime swaps in the
// collab-backed implementation. Storage `storage` events keep tabs in sync.
const ORBITCODE_SHIM = `
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

function getStorageKey(name) {
  return 'orbitcode:' + name;
}

function getStoredValue(name, defaultValue) {
  try {
    const stored = localStorage.getItem(getStorageKey(name));
    if (stored !== null) {
      return JSON.parse(stored);
    }
  } catch {}
  return defaultValue;
}

function setStoredValue(name, value) {
  try {
    localStorage.setItem(getStorageKey(name), JSON.stringify(value));
  } catch {}
}

// useVar returns [value, setter, loading] like useState, but persists to localStorage
export function useVar(name, defaultValue) {
  const [value, setValue] = useState(() => getStoredValue(name, defaultValue));

  useEffect(() => {
    const handler = (e) => {
      if (e.key === getStorageKey(name)) {
        setValue(e.newValue ? JSON.parse(e.newValue) : defaultValue);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [name, defaultValue]);

  const setter = useCallback((newValue) => {
    setValue(prev => {
      const resolved = typeof newValue === 'function' ? newValue(prev) : newValue;
      setStoredValue(name, resolved);
      return resolved;
    });
  }, [name]);

  return [value, setter, false];
}

// useList returns [items, actions, loading] for ordered array CRUD
export function useList(name) {
  const arrRef = useRef(getStoredValue(name, []));
  const [items, setItems] = useState(() => {
    return arrRef.current.map((item, i) => item);
  });

  useEffect(() => {
    const handler = (e) => {
      if (e.key === getStorageKey(name)) {
        const newArr = e.newValue ? JSON.parse(e.newValue) : [];
        arrRef.current = newArr;
        setItems(newArr.map((item, i) => item));
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [name]);

  function persist(arr) {
    arrRef.current = arr;
    setStoredValue(name, arr);
    setItems(arr.map((item, i) => item));
  }

  const actions = {
    // Legacy API (backward compat)
    add: async (item) => {
      const arr = [...arrRef.current, item];
      persist(arr);
      return String(arr.length - 1);
    },
    update: (id, item) => {
      return actions.updateAt(parseInt(id, 10), item);
    },
    remove: (id) => {
      return actions.removeAt(parseInt(id, 10));
    },
    // New array API
    push: async (item) => {
      return actions.add(item);
    },
    pop: async () => {
      const arr = [...arrRef.current];
      if (arr.length === 0) return;
      arr.pop();
      persist(arr);
    },
    insertAt: async (index, item) => {
      const arr = [...arrRef.current];
      arr.splice(index, 0, item);
      persist(arr);
      return String(index);
    },
    removeAt: async (index) => {
      const arr = [...arrRef.current];
      if (index < 0 || index >= arr.length) return;
      arr.splice(index, 1);
      persist(arr);
    },
    updateAt: async (index, item) => {
      const arr = [...arrRef.current];
      if (index < 0 || index >= arr.length) return;
      arr[index] = item;
      persist(arr);
    },
    move: async (fromIndex, toIndex) => {
      const arr = [...arrRef.current];
      if (fromIndex < 0 || fromIndex >= arr.length) return;
      if (toIndex < 0 || toIndex >= arr.length) return;
      const [moved] = arr.splice(fromIndex, 1);
      arr.splice(toIndex, 0, moved);
      persist(arr);
    },
    set: async (newItems) => {
      persist([...newItems]);
    },
  };

  return [items, actions, false];
}

export const useSet = useList;

// useMap returns [entries, { set, remove }, loading] for key-value dictionaries
export function useMap(name) {
  const cacheRef = useRef(getStoredValue(name, {}));
  const [entries, setEntries] = useState(() => ({ ...cacheRef.current }));

  useEffect(() => {
    const handler = (e) => {
      if (e.key === getStorageKey(name)) {
        const newObj = e.newValue ? JSON.parse(e.newValue) : {};
        cacheRef.current = newObj;
        setEntries({ ...newObj });
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [name]);

  const actions = {
    set: async (key, value) => {
      cacheRef.current = { ...cacheRef.current, [key]: value };
      setStoredValue(name, cacheRef.current);
      setEntries({ ...cacheRef.current });
    },
    remove: async (key) => {
      const next = { ...cacheRef.current };
      delete next[key];
      cacheRef.current = next;
      setStoredValue(name, next);
      setEntries({ ...next });
    },
  };

  return [entries, actions, false];
}
`;

/**
 * Vite plugin wiring OrbitCode's runtime for local `orbit run`:
 *   - serves the virtual `orbitcode` module (useVar/useMap/useList),
 *   - resolves the preact family (and react→preact/compat) from the CLI's
 *     own node_modules so there's exactly one preact instance, and
 *   - redirects other bare imports to esm.sh so apps can `import 'three'`
 *     without installing it locally (react externalized → shared runtime).
 */
export function mythPlugin(): Plugin {
  return {
    name: "myth",
    enforce: "pre",

    async resolveId(id, importer, options) {
      if (id === ORBITCODE_MODULE_ID) {
        return RESOLVED_ORBITCODE_ID;
      }

      // NOTE: the preact/react family is pinned to one ESM instance by the
      // resolve.alias table in run.ts (and the preact preset in publish),
      // not here — resolving it twice from different paths re-splits preact.

      // @orbitcode/* are workspace packages that pnpm symlinks into the
      // user project's node_modules. Defer to vite's default resolver
      // (return null = "not mine"). NEVER fall back to esm.sh — those
      // packages aren't published, esm.sh always 404s.
      if (id.startsWith('@orbitcode/')) {
        return null;
      }

      // Other bare imports: try local resolve, fall back to esm.sh for
      // unbundled third-party libs (three, reveal.js, etc.). The
      // `?external=react,...` makes esm.sh emit bare specifiers that
      // resolve back through the preact aliases above.
      if (isBareImport(id)) {
        const local = await this.resolve(id, importer, { ...options, skipSelf: true });
        if (local) return local;
        return {
          id: `https://esm.sh/${id}?external=react,react-dom,react/jsx-runtime&target=es2022`,
          external: true,
        };
      }

      return null;
    },

    load(id) {
      if (id === RESOLVED_ORBITCODE_ID) {
        return ORBITCODE_SHIM;
      }
      return null;
    },
  };
}

function isBareImport(id: string): boolean {
  // Bare imports don't start with . or / and aren't URLs
  if (id.startsWith(".") || id.startsWith("/")) return false;
  if (id.startsWith("http://") || id.startsWith("https://")) return false;
  if (id.startsWith("\0")) return false; // virtual module
  return true;
}
