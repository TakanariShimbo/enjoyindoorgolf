/**
 * E.I.G 予約状況集約 Worker
 *
 * GET /schedule で、hacomono 公開APIから7日分の予約状況を集約して返す。
 * - 未ログインで取得できる公開情報のみを使用
 * - hacomono 以外への中継は一切しない(オープンプロキシにしない)
 * - エッジキャッシュ60秒で hacomono への負荷を抑える
 */

const UPSTREAM = "https://enjoyindoorgolf.hacomono.jp/api";
const STUDIO_ID = 1;
// 予約はすべて room 1 (「打席予約」タブ・定員3) に入る。
// room 4/5/6 (「n番打席」タブ) は存在するが未使用 (全枠予約ゼロ)。
// もし将来そちらに運用移行したら、schedule取得+マージ処理の復活が必要 (git履歴参照)。
const LEGACY_ROOM = 1;
const CAPACITY = 3;
const CACHE_TTL = 60; // 秒

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-Eig-Auth, Content-Type",
  "Cache-Control": `public, max-age=${CACHE_TTL}`,
};

// マイ予約は絶対にキャッシュしない (個人情報)
const NO_STORE_CORS = { ...CORS, "Cache-Control": "no-store" };

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (EIG-schedule-viewer worker)" },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}: ${url}`);
  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(`upstream errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

function fetchItems(roomId) {
  const query = encodeURIComponent(JSON.stringify({
    page: 1, is_all: true, studio_id: STUDIO_ID, studio_room_id: roomId,
  }));
  return getJson(`${UPSTREAM}/master/studio-lessons/schedule?query=${query}`)
    .then((d) => d.studio_lessons.items);
}

async function buildSchedule() {
  const legacy = await fetchItems(LEGACY_ROOM);

  const slots = new Map();
  for (const it of legacy) {
    slots.set(it.start_at, {
      date: it.date,
      hour: Number(it.start_at.slice(11, 13)),
      start_at: it.start_at,
      reservable: !!it.is_reservable,
      legacy_hash: it.id_hash,
      booked: [],
      _id: it.id,
      _count: it.reservation_count,
    });
  }

  // 予約済み打席番号の解決:
  //   count===3 → 全席 [1,2,3] 確定なのでAPI不要
  //   0<count<3 → /no API で番号を取得 (無料プランのsubrequest上限対策も兼ねる)
  const partial = [...slots.values()].filter((s) => s._count > 0 && s._count < CAPACITY);
  const nosList = await Promise.all(
    partial.map((s) =>
      getJson(`${UPSTREAM}/reservation/reservations/${s._id}/no`)
        .then((d) => d.nos)
        .catch(() => null) // 1枠の失敗で全体を壊さない
    )
  );
  partial.forEach((s, i) => {
    s.booked = nosList[i] ? [...nosList[i]].sort() : [];
    if (nosList[i] === null) s.nos_error = true;
  });
  for (const s of slots.values()) {
    if (s._count >= CAPACITY) s.booked = [1, 2, 3];
  }

  const days = new Map();
  for (const s of [...slots.values()].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    delete s._id;
    delete s._count;
    if (!days.has(s.date)) days.set(s.date, []);
    days.get(s.date).push(s);
  }

  return {
    generated_at: new Date(Date.now() + 9 * 3600e3).toISOString().replace("Z", "+09:00"),
    capacity: CAPACITY,
    reserve_url_base: "https://enjoyindoorgolf.hacomono.jp/reserve/space/",
    days: [...days.entries()].map(([date, sl]) => ({ date, slots: sl })),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    // --- ログイン: id/password を hacomono の signin に中継し、発行された
    //     セッションCookieだけを呼び出し元に返す。
    //     パスワードはこの1リクエストで通過するだけ。保存・ログ・キャッシュはしない。
    if (request.method === "POST" && url.pathname === "/login") {
      let cred;
      try { cred = await request.json(); } catch { cred = {}; }
      const id = (cred.id || "").trim();
      const password = cred.password || "";
      if (!id || !password) {
        return new Response(JSON.stringify({ error: "missing" }),
          { status: 400, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      }
      // メール形式なら mail_address、そうでなければ tel としてログイン
      const isMail = id.includes("@");
      const payload = {
        mail_address: isMail ? id : null,
        tel: isMail ? null : id,
        password,
      };
      try {
        const up = await fetch(`${UPSTREAM}/system/auth/signin`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0 (EIG-schedule-viewer worker)",
          },
          body: JSON.stringify(payload),
        });
        const body = await up.json();
        if (body.errors && body.errors.length) {
          return new Response(JSON.stringify({ error: "login-failed", detail: body.errors }),
            { status: 401, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
        }
        // 発行されたCookieを集めて呼び出し元へ (以降はこれをセッションとして使う)
        const setCookies = typeof up.headers.getSetCookie === "function"
          ? up.headers.getSetCookie()
          : (up.headers.get("set-cookie") ? [up.headers.get("set-cookie")] : []);
        const auth = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
        // レスポンスbodyにトークンが入る実装もあるため拾っておく
        const bodyToken = body.data && (body.data.member_token || body.data.token || body.data.access_token);
        if (!auth && !bodyToken) {
          return new Response(JSON.stringify({ error: "no-session" }),
            { status: 502, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
        }
        return new Response(JSON.stringify({ auth: auth || `Bearer ${bodyToken}` }),
          { headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }),
          { status: 502, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      }
    }

    // --- マイ予約: 利用者のhacomonoセッションCookieを中継して自分の予約一覧を返す ---
    //   認証情報は X-Eig-Auth ヘッダで受け取り、その場で上流へ転送するだけ。
    //   保存もログもキャッシュもしない。
    if (request.method === "GET" && url.pathname === "/my") {
      const auth = request.headers.get("X-Eig-Auth");
      if (!auth) {
        return new Response(JSON.stringify({ error: "no-auth" }),
          { status: 401, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      }
      try {
        // "Bearer ..." ならAuthorizationヘッダ、それ以外はCookieとして扱う。
        const upHeaders = { "User-Agent": "Mozilla/5.0 (EIG-schedule-viewer worker)" };
        if (auth.startsWith("Bearer ")) upHeaders["Authorization"] = auth;
        else upHeaders["Cookie"] = auth;

        const norm = (r) => ({
          start_at: r.start_at || (r.studio_lesson && r.studio_lesson.start_at),
          end_at: r.end_at || (r.studio_lesson && r.studio_lesson.end_at),
          no: r.no ?? null,
          studio_name: r.studio && r.studio.name,
          status: r.status,
          id_hash: r.id_hash || (r.studio_lesson && r.studio_lesson.id_hash),
        });

        // 未来分と過去分(履歴)を両方取得してマージ (どちらか失敗しても片方は返す)
        const upcomingQ = encodeURIComponent(JSON.stringify({ page: 1, is_all: true }));
        const historyQ = encodeURIComponent(JSON.stringify({ page: 1, is_all: true, direction: "desc" }));
        const [upRes, histRes] = await Promise.allSettled([
          fetch(`${UPSTREAM}/reservation/reservations?query=${upcomingQ}`, { headers: upHeaders }).then((r) => r.json()),
          fetch(`${UPSTREAM}/reservation/reservations/list-history?query=${historyQ}`, { headers: upHeaders }).then((r) => r.json()),
        ]);

        const up = upRes.status === "fulfilled" ? upRes.value : null;
        if (up && up.is_token_invalid) {
          return new Response(JSON.stringify({ error: "auth-invalid", detail: up.errors }),
            { status: 401, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
        }
        const pick = (b) => (b && b.data && (b.data.reservations || b.data.items)) || [];
        const merged = new Map();
        for (const r of [...pick(up), ...pick(histRes.status === "fulfilled" ? histRes.value : null)]) {
          const n = norm(r);
          if (n.start_at) merged.set(n.start_at + "_" + (n.no ?? ""), n);
        }
        const list = [...merged.values()].sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
        return new Response(JSON.stringify({ reservations: list }),
          { headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }),
          { status: 502, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      }
    }

    // --- 入場QR: セッションで一時トークンを取得して返す (UI側でQR画像化) ---
    //   トークンは短命。保存・ログ・キャッシュはしない。
    if (request.method === "GET" && url.pathname === "/qr") {
      const auth = request.headers.get("X-Eig-Auth");
      if (!auth) {
        return new Response(JSON.stringify({ error: "no-auth" }),
          { status: 401, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      }
      try {
        const upHeaders = { "User-Agent": "Mozilla/5.0 (EIG-schedule-viewer worker)" };
        if (auth.startsWith("Bearer ")) upHeaders["Authorization"] = auth;
        else upHeaders["Cookie"] = auth;

        // 入場QRは予約(access)に紐づく qr_data のみを使う (本家の入場QRと同じ payload: id/exp)。
        // /system/tokens/temporary は payload が {user_id,type,exp} でゲートを通らないため使わない。
        const q = encodeURIComponent(JSON.stringify({ page: 1, is_all: true, is_auth_member: true }));
        const ar = await fetch(`${UPSTREAM}/reservation/accesses/flat?query=${q}`, { headers: upHeaders });
        const ab = await ar.json();
        if (ab.is_token_invalid || (ab.errors && ab.errors.length)) {
          return new Response(JSON.stringify({ error: "auth-invalid", detail: ab.errors }),
            { status: 401, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
        }
        const accesses = (ab.data && ab.data.accesses) || [];
        const withQr = accesses.filter((a) => a.qr_data);
        if (!withQr.length) {
          // 有効な入場QRが無い(予約が無い/時間外)
          return new Response(JSON.stringify({ error: "no-access-qr" }),
            { status: 404, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
        }
        // 現在時刻に最も近いアクセスを選ぶ
        const now = Date.now();
        withQr.sort((a, b) =>
          Math.abs(new Date(a.start_at || a.entry_at || 0) - now) -
          Math.abs(new Date(b.start_at || b.entry_at || 0) - now));
        const a = withQr[0];
        return new Response(JSON.stringify({
          token: a.qr_data, expires_at: a.expires_at || null, start_at: a.start_at || null,
        }), { headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }),
          { status: 502, headers: { "Content-Type": "application/json", ...NO_STORE_CORS } });
      }
    }

    if (request.method !== "GET" || url.pathname !== "/schedule") {
      return new Response("not found", { status: 404, headers: CORS });
    }

    const cacheKey = new Request(`${url.origin}/schedule`);
    const cache = caches.default;
    // ?refresh=1 でキャッシュを無視して取り直し (結果はキャッシュに反映)
    const force = url.searchParams.get("refresh") === "1";
    if (!force) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    try {
      const data = await buildSchedule();
      const res = new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...CORS },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
  },
};
