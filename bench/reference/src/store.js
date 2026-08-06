// Minimal in-memory store shared by every resource. No persistence, no DB —
// this project is throwaway, and swapping in real storage isn't the point of it.
export function createStore() {
  let nextId = 1;
  const items = new Map();

  return {
    list() {
      return [...items.values()];
    },
    get(id) {
      return items.get(Number(id)) || null;
    },
    create(data) {
      const item = { id: nextId++, ...data, createdAt: new Date().toISOString() };
      items.set(item.id, item);
      return item;
    },
    update(id, data) {
      const existing = items.get(Number(id));
      if (!existing) return null;
      const updated = { ...existing, ...data, id: existing.id };
      items.set(existing.id, updated);
      return updated;
    },
    remove(id) {
      return items.delete(Number(id));
    },
  };
}
