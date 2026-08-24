// STUB. Written ahead of the fixtures so the suite reports six specific
// assertion failures instead of one import crash. Replaced in the next commit.

export const DICTIONARY_FILENAME = 'entities.json';

export function dictionaryPath() {
  return '';
}

export function loadDictionary() {
  return Object.freeze({ path: '', exists: false, entities: Object.freeze([]), sessions: Object.freeze({}) });
}

export function mergeEntities(stored, incoming) {
  return { entities: incoming, added: 0, merged: 0 };
}

export function proseHash() {
  return '';
}

export function saveDictionary() {
  return '';
}

export function uncoveredSessions() {
  return Object.freeze([]);
}
