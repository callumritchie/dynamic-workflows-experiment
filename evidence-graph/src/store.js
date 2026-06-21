// Tiny content-addressed artifact store (JSON files on disk under .eg/).
// Stands in for Postgres + object store in this reference slice; the access
// pattern (namespaced get/put/has keyed by content_hash x version) is the real one.
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class Store {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  _p(ns, key) {
    return join(this.root, ns, `${key}.json`);
  }
  has(ns, key) {
    return existsSync(this._p(ns, key));
  }
  get(ns, key) {
    const p = this._p(ns, key);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }
  put(ns, key, val) {
    const p = this._p(ns, key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(val, null, 2));
    return val;
  }
  list(ns) {
    const d = join(this.root, ns);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
  }
}
