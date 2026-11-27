export const host = {
  state: { focusedSessionId: { get: () => globalThis.__focused ?? null }, activeSessionId: { get: () => null } },
  composer: {
    insertText: async (sessionId, text, opts) => { (globalThis.__calls ||= []).push(['insertText', sessionId, text, opts]); return globalThis.__composerOk !== false },
    submit: (sessionId, text) => { (globalThis.__calls ||= []).push(['submit', sessionId, text]); return true },
    getDraft: async () => globalThis.__draft ?? '',
    setDraft: async () => true,
    focus: () => {}
  },
  navigate: p => (globalThis.__calls ||= []).push(['navigate', p]),
  notify: n => (globalThis.__calls ||= []).push(['notify', n.message]),
  newChat: () => (globalThis.__calls ||= []).push(['newChat']),
  request: async (m, p) => { (globalThis.__calls ||= []).push(['request', m, p.session_id]); return {} }
}
