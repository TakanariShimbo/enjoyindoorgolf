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
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": `public, max-age=${CACHE_TTL}`,
};

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
    if (request.method !== "GET" || url.pathname !== "/schedule") {
      return new Response("not found", { status: 404, headers: CORS });
    }

    const cacheKey = new Request(`${url.origin}/schedule`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

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
