#!/usr/bin/env python3
"""hacomono の公開スケジュールAPIから E.I.G の予約状況を取得し、
GitHub Pages で配信する docs/schedule.json を生成する。

未ログインで取得できる公開情報のみを使用する。

データ源:
  - /api/master/studio-lessons/schedule (room 1)      : 各1時間枠 (3打席まとめ)
  - /api/reservation/reservations/{lesson_id}/no      : その枠で予約済みの打席番号 [1,2,3]
  - 同 schedule (room 4/5/6 = 1/2/3番打席の打席指定枠) : 打席別の予約とリンク先
"""
import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE = "https://enjoyindoorgolf.hacomono.jp/api"
STUDIO_ID = 1
LEGACY_ROOM = 1                  # 従来の「打席予約」(定員3、座席選択あり)
SEAT_ROOMS = {4: 1, 5: 2, 6: 3}  # studio_room_id -> 打席番号 (打席指定予約)
CAPACITY = 3

JST = timezone(timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (EIG-schedule-viewer)"}


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as res:
        body = json.load(res)
    if body.get("errors"):
        raise RuntimeError(f"API errors: {url}: {body['errors']}")
    return body["data"]


def fetch_items(room_id):
    query = urllib.parse.quote(json.dumps({
        "page": 1, "is_all": True,
        "studio_id": STUDIO_ID, "studio_room_id": room_id,
    }))
    return get_json(f"{BASE}/master/studio-lessons/schedule?query={query}")["studio_lessons"]["items"]


def fetch_reserved_nos(lesson_id):
    return get_json(f"{BASE}/reservation/reservations/{lesson_id}/no")["nos"]


def build():
    slots = {}  # start_at -> slot

    legacy = fetch_items(LEGACY_ROOM)
    for it in legacy:
        slots[it["start_at"]] = {
            "date": it["date"],
            "hour": int(it["start_at"][11:13]),
            "start_at": it["start_at"],
            "reservable": bool(it["is_reservable"]),
            "legacy_hash": it["id_hash"],
            "_legacy_id": it["id"],
            "_legacy_count": it["reservation_count"],
            "booked": [],   # 予約済み打席番号
            "seat_hash": {},  # 打席番号 -> 打席指定予約のid_hash (空きの場合)
        }

    # 予約のある枠だけ、予約済み打席番号を並列取得
    targets = [s for s in slots.values() if s["_legacy_count"] > 0]
    with ThreadPoolExecutor(max_workers=8) as ex:
        for s, nos in zip(targets, ex.map(lambda s: fetch_reserved_nos(s["_legacy_id"]), targets)):
            s["booked"] = sorted(nos)

    # 打席指定予約 (room 4/5/6) をマージ
    for room_id, seat_no in SEAT_ROOMS.items():
        for it in fetch_items(room_id):
            s = slots.get(it["start_at"])
            if s is None:
                continue
            if it["reservation_count"] > 0 and seat_no not in s["booked"]:
                s["booked"].append(seat_no)
                s["booked"].sort()
            elif it["is_reservable"]:
                s["seat_hash"][str(seat_no)] = it["id_hash"]

    days = {}
    for s in sorted(slots.values(), key=lambda x: x["start_at"]):
        del s["_legacy_id"], s["_legacy_count"]
        days.setdefault(s["date"], []).append(s)

    return {
        "generated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "capacity": CAPACITY,
        "reserve_url_base": "https://enjoyindoorgolf.hacomono.jp/reserve/space/",
        "days": [{"date": d, "slots": sl} for d, sl in sorted(days.items())],
    }


def main():
    out = Path(__file__).resolve().parent.parent.parent / "frontend" / "schedule.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    data = build()
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    total = sum(len(d["slots"]) for d in data["days"])
    print(f"wrote {out} ({len(data['days'])} days, {total} slots)")


if __name__ == "__main__":
    main()
