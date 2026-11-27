// supabase-js מזויף לבדיקת הדפדפן: רושם כל קריאה ב-window.__sb, בלי רשת.
(function () {
  const log = (window.__sb = { calls: [], session: window.__FAKE_SESSION || null, watchCount: window.__watchCount || 0 });
  function table(name) {
    const q = { _name: name, _op: "select" };
    const done = () => {
      log.calls.push({ table: name, op: q._op, payload: q._payload, opts: q._opts });
      if (name === "travel_watchlist" && q._op === "select") return { count: log.watchCount, data: [], error: null };
      return { data: null, error: null };
    };
    Object.assign(q, {
      select(cols, opts) { q._opts = opts; return q; },
      insert(p) { q._op = "insert"; q._payload = p; return Promise.resolve(done()); },
      upsert(p, o) { q._op = "upsert"; q._payload = p; q._opts = o; return Promise.resolve(done()); },
      maybeSingle() { return Promise.resolve(done()); },
      then(res, rej) { return Promise.resolve(done()).then(res, rej); },
    });
    return q;
  }
  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: async () => ({ data: { session: log.session } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signInWithPassword: async ({ email }) => { log.calls.push({ op: "login", email }); log.session = { user: { id: "u1", email } }; return { data: { user: log.session.user }, error: null }; },
          signOut: async () => { log.session = null; },
        },
        from: (name) => table(name),
        functions: { invoke: async (fn, { body }) => { log.calls.push({ fn, body }); return { data: { ok: true }, error: null }; } },
      };
    },
  };
})();
