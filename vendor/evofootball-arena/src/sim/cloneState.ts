/**
 * Prototype-preserving, cycle-safe clone for the closed deterministic sim graph.
 * Intended for OFFLINE counterfactual probes only; never call from live AI.
 */
export function cloneSimulationState<T>(root: T): T {
  const seen = new Map<object, unknown>();

  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const object = value as object;
    if (seen.has(object)) return seen.get(object);

    if (value instanceof WeakMap || value instanceof WeakSet
      || value instanceof Date || value instanceof RegExp
      || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      throw new TypeError(`Unsupported simulation-state object: ${value.constructor.name}`);
    }

    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(object, output);
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        Object.defineProperty(output, key, 'value' in descriptor
          ? { ...descriptor, value: clone(descriptor.value) }
          : descriptor);
      }
      return output;
    }

    if (value instanceof Set) {
      const output = new Set<unknown>();
      seen.set(object, output);
      for (const entry of value) output.add(clone(entry));
      return output;
    }

    if (value instanceof Map) {
      const output = new Map<unknown, unknown>();
      seen.set(object, output);
      for (const [key, entry] of value) output.set(clone(key), clone(entry));
      return output;
    }

    const output = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
    seen.set(object, output);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      Object.defineProperty(output, key, 'value' in descriptor
        ? { ...descriptor, value: clone(descriptor.value) }
        : descriptor);
    }
    return output;
  };

  return clone(root) as T;
}
