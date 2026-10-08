"""
工事作業予定表 - バックエンドAPI (FastAPI)
"""
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import json
import os
import uuid
import asyncio
from datetime import datetime, date
import calendar
try:
    import jpholiday
    HAS_JPHOLIDAY = True
except ImportError:
    HAS_JPHOLIDAY = False

try:
    import holidays as _holidays_lib
    HAS_HOLIDAYS = True
except ImportError:
    HAS_HOLIDAYS = False

# 中国祝日名の日本語訳テーブル（部分マッチ）
CN_NAME_JA = {
    "元旦": "中国：元旦",
    "春节": "中国：春節（旧正月）",
    "农历除夕": "中国：大晦日（旧暦）",
    "清明节": "中国：清明節",
    "劳动节": "中国：労働節",
    "端午节": "中国：端午節",
    "中秋节": "中国：中秋節",
    "国庆节": "中国：国慶節",
    "休息日": "中国：振替休日",
}

# 韓国祝日名の日本語訳テーブル
KR_NAME_JA = {
    "신정연휴": "韓国：元旦",
    "설날 전날": "韓国：ソルラル前日",
    "설날": "韓国：ソルラル（旧正月）",
    "설날 다음날": "韓国：ソルラル翌日",
    "삼일절": "韓国：三一節",
    "삼일절 대체 휴일": "韓国：三一節振替",
    "노동절": "韓国：労働節",
    "어린이날": "韓国：こどもの日",
    "부처님오신날": "韓国：仏誕節",
    "부처님오신날 대체 휴일": "韓国：仏誕節振替",
    "현충일": "韓国：顕忠日",
    "광복절": "韓国：光復節",
    "광복절 대체 휴일": "韓国：光復節振替",
    "추석 전날": "韓国：秋夕前日",
    "추석": "韓국：秋夕（チュソク）",
    "추석 다음날": "韓国：秋夕翌日",
    "개천절": "韓国：開天節",
    "개천절 대체 휴일": "韓国：開天節振替",
    "한글날": "韓国：ハングルの日",
    "기독탄신일": "韓国：クリスマス",
    "지방선거일": "韓国：地方選挙日",
    "대통령선거일": "韓国：大統領選挙日",
    "국회의원선거일": "韓国：国会議員選挙日",
}

def _cn_holiday_name_ja(raw: str) -> str:
    for key, ja in CN_NAME_JA.items():
        if key in raw:
            return ja
    return f"中国：{raw}"

def _kr_holiday_name_ja(raw: str) -> str:
    return KR_NAME_JA.get(raw, f"韓国：{raw}")

# 年ごとのキャッシュ
_cn_cache: dict = {}
_kr_cache: dict = {}

def _get_cn_holidays(year: int):
    if year not in _cn_cache:
        _cn_cache[year] = _holidays_lib.China(years=year) if HAS_HOLIDAYS else {}
    return _cn_cache[year]

def _get_kr_holidays(year: int):
    if year not in _kr_cache:
        _kr_cache[year] = _holidays_lib.SouthKorea(years=year) if HAS_HOLIDAYS else {}
    return _kr_cache[year]

app = FastAPI(title="工事作業予定表API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Renderの永続ディスク(/data)があればそちらを使う、なければローカル
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = "/data" if os.path.isdir("/data") else _BASE_DIR
DATA_FILE = os.path.join(_DATA_DIR, "data.json")
INITIAL_FILE = os.path.join(_BASE_DIR, "initial_data.json")

# 書き込み排他制御用ロック（並列リクエストによるデータ競合を防ぐ）
_DATA_LOCK = asyncio.Lock()

# -------------------------------------------------------
# データロード/セーブ
# -------------------------------------------------------
def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if "reminders" not in d:
            d["reminders"] = []
            d["reminder_next_id"] = 1
        return d
    # 初回: initial_data.json から読み込む
    if os.path.exists(INITIAL_FILE):
        with open(INITIAL_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        # IDを付与
        schedules = []
        for i, s in enumerate(raw.get("schedules", [])):
            s["id"] = str(i + 1)
            schedules.append(s)
        data = {
            "schedules": schedules,
            "staff": raw.get("staff", []),
            "next_id": len(schedules) + 1,
            "reminders": [],
            "reminder_next_id": 1
        }
        save_data(data)
        return data
    return {"schedules": [], "staff": [], "next_id": 1, "reminders": [], "reminder_next_id": 1}

def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# -------------------------------------------------------
# モデル
# -------------------------------------------------------
class ScheduleCreate(BaseModel):
    year: int
    month: int
    staff: str
    day: int
    content: str
    color: Optional[str] = "#3B82F6"

class ScheduleUpdate(BaseModel):
    content: Optional[str] = None
    color: Optional[str] = None
    staff: Optional[str] = None
    day: Optional[int] = None
    year: Optional[int] = None
    month: Optional[int] = None

class StaffCreate(BaseModel):
    name: str

class StaffOrder(BaseModel):
    staff: List[str]

class ReminderCreate(BaseModel):
    schedule_id: str          # 対象スケジュールID
    remind_days_before: int   # 何日前に通知するか
    note: Optional[str] = ""  # メモ

class ReminderUpdate(BaseModel):
    remind_days_before: Optional[int] = None
    note: Optional[str] = None

# -------------------------------------------------------
# スケジュールAPI
# -------------------------------------------------------
@app.get("/api/schedule")
def get_schedule(year: int, month: int):
    data = load_data()
    entries = [s for s in data["schedules"] if s["year"] == year and s["month"] == month]
    
    # カレンダー情報も返す
    _, days_in_month = calendar.monthrange(year, month)
    cal_days = []
    for d in range(1, days_in_month + 1):
        dt = datetime(year, month, d)
        weekday_names = ["月", "火", "水", "木", "金", "土", "日"]
        d_obj = date(year, month, d)
        # 日本祝日
        is_holiday = HAS_JPHOLIDAY and jpholiday.is_holiday(d_obj)
        holiday_name = (jpholiday.is_holiday_name(d_obj) if HAS_JPHOLIDAY else None) or ""
        # 中国祝日
        cn_hols = _get_cn_holidays(year)
        cn_raw = cn_hols.get(d_obj, "")
        is_cn_holiday = bool(cn_raw)
        cn_holiday_name = _cn_holiday_name_ja(cn_raw) if cn_raw else ""
        # 韓国祝日
        kr_hols = _get_kr_holidays(year)
        kr_raw = kr_hols.get(d_obj, "")
        is_kr_holiday = bool(kr_raw)
        kr_holiday_name = _kr_holiday_name_ja(kr_raw) if kr_raw else ""
        cal_days.append({
            "day": d,
            "weekday": weekday_names[dt.weekday()],
            "is_weekend": dt.weekday() >= 5,
            "is_holiday": bool(is_holiday),
            "holiday_name": holiday_name,
            "is_cn_holiday": is_cn_holiday,
            "cn_holiday_name": cn_holiday_name,
            "is_kr_holiday": is_kr_holiday,
            "kr_holiday_name": kr_holiday_name,
        })
    
    return {
        "year": year,
        "month": month,
        "days": cal_days,
        "schedules": entries,
        "staff": data["staff"]
    }

@app.post("/api/schedule")
async def create_schedule(item: ScheduleCreate):
    async with _DATA_LOCK:
        data = load_data()
        new_id = str(data.get("next_id", 1))
        entry = {
            "id": new_id,
            "year": item.year,
            "month": item.month,
            "staff": item.staff,
            "day": item.day,
            "content": item.content,
            "color": item.color or "#3B82F6"
        }
        data["schedules"].append(entry)
        data["next_id"] = int(new_id) + 1
        save_data(data)
    return entry

@app.put("/api/schedule/{schedule_id}")
async def update_schedule(schedule_id: str, item: ScheduleUpdate):
    async with _DATA_LOCK:
        data = load_data()
        for s in data["schedules"]:
            if s["id"] == schedule_id:
                if item.content is not None:
                    s["content"] = item.content
                if item.color is not None:
                    s["color"] = item.color
                if item.staff is not None:
                    s["staff"] = item.staff
                if item.day is not None:
                    s["day"] = item.day
                if item.year is not None:
                    s["year"] = item.year
                if item.month is not None:
                    s["month"] = item.month
                save_data(data)
                return s
    raise HTTPException(status_code=404, detail="Not found")

@app.delete("/api/schedule/{schedule_id}")
async def delete_schedule(schedule_id: str):
    async with _DATA_LOCK:
        data = load_data()
        original = len(data["schedules"])
        data["schedules"] = [s for s in data["schedules"] if s["id"] != schedule_id]
        if len(data["schedules"]) == original:
            raise HTTPException(status_code=404, detail="Not found")
        save_data(data)
    return {"ok": True}

# -------------------------------------------------------
# 担当者API
# -------------------------------------------------------
@app.get("/api/staff")
def get_staff():
    data = load_data()
    return {"staff": data["staff"]}

@app.post("/api/staff")
async def add_staff(item: StaffCreate):
    async with _DATA_LOCK:
        data = load_data()
        if item.name in data["staff"]:
            raise HTTPException(status_code=400, detail="既に存在します")
        data["staff"].append(item.name)
        save_data(data)
    return {"staff": data["staff"]}

@app.delete("/api/staff/{name}")
async def delete_staff(name: str):
    async with _DATA_LOCK:
        data = load_data()
        if name not in data["staff"]:
            raise HTTPException(status_code=404, detail="Not found")
        data["staff"] = [s for s in data["staff"] if s != name]
        save_data(data)
    return {"staff": data["staff"]}

@app.put("/api/staff/order")
async def reorder_staff(item: StaffOrder):
    async with _DATA_LOCK:
        data = load_data()
        data["staff"] = item.staff
        save_data(data)
    return {"staff": data["staff"]}

# -------------------------------------------------------
# リマインドAPI
# -------------------------------------------------------
@app.get("/api/reminders")
def get_reminders():
    data = load_data()
    reminders = data.get("reminders", [])
    # 今日基準で「あと何日」を計算して付与
    today = date.today()
    result = []
    for r in reminders:
        # 対象スケジュールの日付を探す
        sch = next((s for s in data["schedules"] if s["id"] == r["schedule_id"]), None)
        if not sch:
            continue  # スケジュール削除済みはスキップ
        sch_date = date(sch["year"], sch["month"], sch["day"])
        remind_date = sch_date - __import__('datetime').timedelta(days=r["remind_days_before"])
        days_until_remind = (remind_date - today).days
        days_until_event = (sch_date - today).days
        result.append({
            **r,
            "schedule": sch,
            "remind_date": remind_date.isoformat(),
            "days_until_remind": days_until_remind,
            "days_until_event": days_until_event,
            "is_due": days_until_remind <= 0 <= days_until_event,  # 通知タイミング内
            "is_past": days_until_event < 0,
        })
    return {"reminders": result}

@app.post("/api/reminders")
async def create_reminder(item: ReminderCreate):
    async with _DATA_LOCK:
        data = load_data()
        sch = next((s for s in data["schedules"] if s["id"] == item.schedule_id), None)
        if not sch:
            raise HTTPException(status_code=404, detail="スケジュールが見つかりません")
        new_id = str(data.get("reminder_next_id", 1))
        reminder = {
            "id": new_id,
            "schedule_id": item.schedule_id,
            "remind_days_before": item.remind_days_before,
            "note": item.note or "",
            "created_at": datetime.now().isoformat()
        }
        data.setdefault("reminders", []).append(reminder)
        data["reminder_next_id"] = int(new_id) + 1
        save_data(data)
    return reminder

@app.put("/api/reminders/{reminder_id}")
async def update_reminder(reminder_id: str, item: ReminderUpdate):
    async with _DATA_LOCK:
        data = load_data()
        for r in data.get("reminders", []):
            if r["id"] == reminder_id:
                if item.remind_days_before is not None:
                    r["remind_days_before"] = item.remind_days_before
                if item.note is not None:
                    r["note"] = item.note
                save_data(data)
                return r
    raise HTTPException(status_code=404, detail="Not found")

@app.delete("/api/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str):
    async with _DATA_LOCK:
        data = load_data()
        before = len(data.get("reminders", []))
        data["reminders"] = [r for r in data.get("reminders", []) if r["id"] != reminder_id]
        if len(data["reminders"]) == before:
            raise HTTPException(status_code=404, detail="Not found")
        save_data(data)
    return {"ok": True}

# -------------------------------------------------------
# 月一覧API (存在するデータの年月リスト)
# -------------------------------------------------------
@app.get("/api/months")
def get_months():
    data = load_data()
    months_set = set()
    for s in data["schedules"]:
        months_set.add((s["year"], s["month"]))
    months = sorted(months_set)
    return {"months": [{"year": y, "month": m} for y, m in months]}

# -------------------------------------------------------
# 静的ファイル配信
# -------------------------------------------------------
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")

@app.get("/")
def index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "index.html"))

@app.get("/{path:path}")
def catch_all(path: str):
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    file_path = os.path.join(static_dir, path)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)
    return FileResponse(os.path.join(static_dir, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
