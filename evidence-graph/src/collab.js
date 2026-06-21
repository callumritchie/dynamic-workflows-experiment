// Phase 3 - collaboration layer over the Evidence Graph.
//
// Three memory scopes (design/product-spec.md §2):
//   - project memory (shared): canonical model, rankings, PROMOTED answers + threads
//   - personal workspace (private by default): a user's threads / scratch questions
//   - promotion: a one-click action that moves a personal finding into project scope
//
// Team-wide dedup falls out for free: once an answer is promoted (visibility=project),
// any teammate's matching question is a semantic-cache hit regardless of who asked first.
import { randomUUID } from 'node:crypto';
import { route } from './router.js';

const id = (p) => `${p}-${randomUUID().slice(0, 8)}`;

export class Workspace {
  constructor(pipeline) {
    this.p = pipeline;
    this.store = pipeline.store;
  }

  newThread({ userId, title, visibility = 'personal' }) {
    const tid = id('t');
    this.store.put('threads', tid, { id: tid, owner: userId, title, visibility, created_at: Date.now() });
    return tid;
  }

  // Ask within a thread, as a user. Routes through the (now user-aware) router and
  // records the message so it can later be promoted.
  async ask({ threadId, userId, question, scope = {}, onStep }) {
    const d = await route(this.p, { question, scope, userId, onStep });
    const mid = id('m');
    this.store.put('messages', mid, {
      id: mid,
      thread_id: threadId,
      owner: userId,
      visibility: 'personal',
      question,
      path: d.path,
      answer_ref: d.answer_ref ?? null,
      cache_hit: d.cache_hit,
      created_at: Date.now(),
    });
    return { ...d, message_id: mid };
  }

  // Low-friction promotion: personal -> project. Cascades to the cached answer so the
  // whole team benefits, and emits an activity event (the feed shows promoted items,
  // not raw personal chat).
  promote({ userId, kind, refId, note = '' }) {
    if (kind === 'query_answer') {
      this.#promoteAnswer(refId);
    } else if (kind === 'message') {
      const m = this.store.get('messages', refId);
      if (!m) throw new Error(`no message ${refId}`);
      m.visibility = 'project';
      this.store.put('messages', refId, m);
      if (m.answer_ref) this.#promoteAnswer(m.answer_ref);
    } else if (kind === 'thread') {
      const t = this.store.get('threads', refId);
      if (!t) throw new Error(`no thread ${refId}`);
      t.visibility = 'project';
      this.store.put('threads', refId, t);
    } else {
      throw new Error(`unknown promotion kind: ${kind}`);
    }
    const ev = { id: id('e'), kind, ref_id: refId, actor: userId, note, at: Date.now() };
    this.store.put('activity', ev.id, ev);
    return ev;
  }

  #promoteAnswer(key) {
    const e = this.store.get('qcache', key);
    if (e) {
      e.visibility = 'project';
      this.store.put('qcache', key, e);
    }
  }

  // Project activity feed (promoted items only), oldest first.
  activity() {
    return this.store.list('activity').sort((a, b) => a.at - b.at);
  }

  // Threads visible to a user: project-shared + their own.
  threads(userId) {
    return this.store.list('threads').filter((t) => t.visibility === 'project' || t.owner === userId);
  }
}
