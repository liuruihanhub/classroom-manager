function safeMessage(error, fallback = "云同步请求失败") {
  const code = String(error?.code ?? "");
  if (code === "40001" || /revision_conflict/i.test(String(error?.message ?? ""))) return "revision_conflict";
  if (/invalid login credentials/i.test(String(error?.message ?? ""))) return "邮箱或密码错误";
  if (/jwt.*expired|token.*expired|invalid jwt|not authenticated|session.*expired/i.test(String(error?.message ?? ""))) return "登录状态已过期";
  if (/project.*paused|service unavailable|gateway timeout|timed out/i.test(String(error?.message ?? ""))) return "云服务暂不可用或正在恢复";
  if (/network|fetch|offline/i.test(String(error?.message ?? ""))) return "网络不可用，请稍后重试";
  return fallback;
}

export function readSupabaseConfig(env = import.meta.env) {
  const url = String(env.VITE_SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const publishableKey = String(env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  let safeUrl = false;
  try {
    const parsed = new URL(url);
    safeUrl = parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname));
  } catch { safeUrl = false; }
  return { configured: Boolean(url && publishableKey && safeUrl), url, publishableKey, invalid: Boolean((url || publishableKey) && !(url && publishableKey && safeUrl)) };
}

function requestError(error, fallback) {
  const next = new Error(safeMessage(error, fallback));
  if (/network|fetch|offline/i.test(String(error?.message ?? ""))) next.code = "OFFLINE";
  return next;
}

export function createSupabaseAdapter(config, { clientFactory } = {}) {
  if (!config?.url || !config?.publishableKey) throw new Error("Supabase 云同步配置不完整");
  if (typeof clientFactory !== "function") throw new Error("Supabase 客户端工厂未加载");
  const client = clientFactory(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  return {
    async getSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throw requestError(error, "无法读取登录状态");
      return data.session;
    },
    onAuthStateChange(callback) {
      const { data } = client.auth.onAuthStateChange((_event, session) => callback(session));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw requestError(error, "登录失败");
      return data.session;
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw requestError(error, "退出失败");
    },
    forUser(userId) {
      if (!userId) throw new Error("缺少当前账号标识");
      return {
        async read() {
          const { data, error } = await client.from("teacher_databases")
            .select("owner_id,payload,revision,created_at,updated_at")
            .eq("owner_id", userId)
            .maybeSingle();
          if (error) throw requestError(error, "读取云端数据失败");
          return data;
        },
        async compareAndSwap({ expectedRevision, payload }) {
          const { data, error } = await client.rpc("save_teacher_database", {
            p_expected_revision: expectedRevision,
            p_payload: payload,
          });
          if (error && safeMessage(error) === "revision_conflict") {
            return { ok: false, conflict: true, record: await this.read() };
          }
          if (error) throw requestError(error, "写入云端数据失败");
          return { ok: true, record: Array.isArray(data) ? data[0] : data };
        },
        async history(limit = 20) {
          const safeLimit = Number.isSafeInteger(limit) ? Math.min(20, Math.max(1, limit)) : 20;
          const { data, error } = await client.from("teacher_database_history")
            .select("owner_id,payload,revision,archived_at")
            .eq("owner_id", userId)
            .order("revision", { ascending: false })
            .limit(safeLimit);
          if (error) throw requestError(error, "读取云端历史失败");
          return data;
        },
        subscribe(onRecord, onStatus) {
          const channel = client.channel(`teacher-database-${userId}`)
            .on("postgres_changes", {
              event: "*", schema: "public", table: "teacher_databases", filter: `owner_id=eq.${userId}`,
            }, (event) => onRecord(event.new))
            .subscribe((status) => onStatus?.(status === "SUBSCRIBED"));
          return () => client.removeChannel(channel);
        },
      };
    },
  };
}

export async function loadSupabaseAdapter(config) {
  const { createClient } = await import("@supabase/supabase-js");
  return createSupabaseAdapter(config, { clientFactory: createClient });
}

export { safeMessage };
