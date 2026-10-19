import { describe, expect, it } from 'vitest';
import { currentDelegation, runWithDelegation, withDelegation } from './delegation';

describe('withDelegation', () => {
  it('leaves details untouched outside any delegated scope', () => {
    // The common case by far — somebody clicking in the UI. A marker here would claim a
    // credential acted when a person did.
    expect(withDelegation({ reportId: 'r-1' })).toEqual({ reportId: 'r-1' });
    expect(withDelegation(null)).toBeNull();
    expect(currentDelegation()).toBeUndefined();
  });

  it('stamps the key a request arrived with', async () => {
    await runWithDelegation({ viaApiKey: { id: 'k-1', name: 'Desktop' } }, async () => {
      expect(withDelegation(null)).toEqual({ viaApiKey: { id: 'k-1', name: 'Desktop' } });
    });
  });

  it('does not leak out of its scope', async () => {
    // AsyncLocalStorage rather than a module variable, precisely so two concurrent requests
    // cannot stamp each other's audit rows.
    await runWithDelegation({ viaApiKey: { id: 'k-1' } }, async () => {
      expect(currentDelegation()).toBeDefined();
    });
    expect(currentDelegation()).toBeUndefined();
    expect(withDelegation({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('more than one kind of delegation', () => {
  it('records an assistant-drafted action distinctly from a key-driven one', async () => {
    // The person pressed confirm, so their authority is what was used and they remain the
    // actor. What this adds is that a model wrote the proposal — which is what a reviewer
    // six months later has no other way to find out.
    await runWithDelegation({ viaAssistant: { conversationId: 'c-1' } }, async () => {
      expect(withDelegation({ reportId: 'r-1' })).toEqual({
        reportId: 'r-1',
        viaAssistant: { conversationId: 'c-1' },
      });
    });
  });

  it('carries both when both are true', async () => {
    await runWithDelegation(
      { viaApiKey: { id: 'k-1' }, viaAssistant: { conversationId: 'c-1' } },
      async () => {
        expect(withDelegation(null)).toEqual({
          viaApiKey: { id: 'k-1' },
          viaAssistant: { conversationId: 'c-1' },
        });
      },
    );
  });

  it('lets an explicit marker win over the ambient one, per marker', async () => {
    await runWithDelegation(
      { viaApiKey: { id: 'ambient' }, viaAssistant: { conversationId: 'c-1' } },
      async () => {
        expect(withDelegation({ viaApiKey: { id: 'explicit' } })).toEqual({
          viaApiKey: { id: 'explicit' },
          viaAssistant: { conversationId: 'c-1' },
        });
      },
    );
  });
});
