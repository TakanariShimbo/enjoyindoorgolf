var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var UPSTREAM = "https://enjoyindoorgolf.hacomono.jp/api";
var STUDIO_ID = 1;
var LEGACY_ROOM = 1;
var SEAT_ROOMS = { 4: 1, 5: 2, 6: 3 };
var CAPACITY = 3;
var CACHE_TTL = 60;
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": `public, max-age=${CACHE_TTL}`
};
async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (EIG-schedule-viewer worker)" }
  });
  if (!res.ok) throw new Error(`upstream ${res.status}: ${url}`);
  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(`upstream errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}
__name(getJson, "getJson");
function fetchItems(roomId) {
  const query = encodeURIComponent(JSON.stringify({
    page: 1,
    is_all: true,
    studio_id: STUDIO_ID,
    studio_room_id: roomId
  }));
  return getJson(`${UPSTREAM}/master/studio-lessons/schedule?query=${query}`).then((d) => d.studio_lessons.items);
}
__name(fetchItems, "fetchItems");
async function buildSchedule() {
  const [legacy, ...seatRoomItems] = await Promise.all([
    fetchItems(LEGACY_ROOM),
    ...Object.keys(SEAT_ROOMS).map((r) => fetchItems(Number(r)))
  ]);
  const slots = /* @__PURE__ */ new Map();
  for (const it of legacy) {
    slots.set(it.start_at, {
      date: it.date,
      hour: Number(it.start_at.slice(11, 13)),
      start_at: it.start_at,
      reservable: !!it.is_reservable,
      legacy_hash: it.id_hash,
      booked: [],
      _id: it.id,
      _count: it.reservation_count
    });
  }
  const partial = [...slots.values()].filter((s) => s._count > 0 && s._count < CAPACITY);
  const nosList = await Promise.all(
    partial.map(
      (s) => getJson(`${UPSTREAM}/reservation/reservations/${s._id}/no`).then((d) => d.nos).catch(() => null)
      // 1枠の失敗で全体を壊さない
    )
  );
  partial.forEach((s, i) => {
    s.booked = nosList[i] ? [...nosList[i]].sort() : [];
    if (nosList[i] === null) s.nos_error = true;
  });
  for (const s of slots.values()) {
    if (s._count >= CAPACITY) s.booked = [1, 2, 3];
  }
  const roomIds = Object.keys(SEAT_ROOMS).map(Number);
  seatRoomItems.forEach((items, idx) => {
    const seatNo = SEAT_ROOMS[roomIds[idx]];
    for (const it of items) {
      const s = slots.get(it.start_at);
      if (s && it.reservation_count > 0 && !s.booked.includes(seatNo)) {
        s.booked.push(seatNo);
        s.booked.sort();
      }
    }
  });
  const days = /* @__PURE__ */ new Map();
  for (const s of [...slots.values()].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    delete s._id;
    delete s._count;
    if (!days.has(s.date)) days.set(s.date, []);
    days.get(s.date).push(s);
  }
  return {
    generated_at: new Date(Date.now() + 9 * 36e5).toISOString().replace("Z", "+09:00"),
    capacity: CAPACITY,
    reserve_url_base: "https://enjoyindoorgolf.hacomono.jp/reserve/space/",
    days: [...days.entries()].map(([date, sl]) => ({ date, slots: sl }))
  };
}
__name(buildSchedule, "buildSchedule");
var worker_default = {
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
        headers: { "Content-Type": "application/json", ...CORS }
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }
  }
};

// ../../../.npm/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.npm/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-EcBXSt/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../.npm/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-EcBXSt/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
