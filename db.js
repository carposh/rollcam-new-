const DB = (() => {
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('rollcam', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('rolls', { keyPath: 'id' });
        db.createObjectStore('photos', { keyPath: 'id' }).createIndex('rollId', 'rollId');
        db.createObjectStore('prints', { keyPath: 'id' }).createIndex('rollId', 'rollId');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(name, mode = 'readonly') {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  async function get(name, key) {
    return wrap((await store(name)).get(key));
  }

  async function put(name, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      tx.objectStore(name).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function putMany(entries) {
    const db = await open();
    const names = [...new Set(entries.map((e) => e[0]))];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readwrite');
      for (const [name, value] of entries) tx.objectStore(name).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function all(name) {
    return wrap((await store(name)).getAll());
  }

  async function byRoll(name, rollId) {
    const list = await wrap((await store(name)).index('rollId').getAll(rollId));
    return list.sort((a, b) => a.index - b.index);
  }

  async function deleteRoll(rollId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['rolls', 'photos', 'prints'], 'readwrite');
      tx.objectStore('rolls').delete(rollId);
      for (const name of ['photos', 'prints']) {
        const idx = tx.objectStore(name).index('rollId');
        idx.openKeyCursor(IDBKeyRange.only(rollId)).onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          tx.objectStore(name).delete(cur.primaryKey);
          cur.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function count(name) {
    return wrap((await store(name)).count());
  }

  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['rolls', 'photos', 'prints'], 'readwrite');
      ['rolls', 'photos', 'prints'].forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getMeta(key, fallback) {
    const row = await get('meta', key);
    return row ? row.value : fallback;
  }

  function setMeta(key, value) {
    return put('meta', { key, value });
  }

  return { open, get, put, putMany, all, byRoll, deleteRoll, count, clearAll, getMeta, setMeta };
})();
