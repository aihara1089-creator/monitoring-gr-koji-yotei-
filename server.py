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
from datetime import datetime, date
import calendar
try:
    import jpholiday
    HAS_JPHOLIDAY = True
except ImportError:
    HAS_JPHOLIDAY = False

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
        is_holiday = HAS_JPHOLIDAY and jpholiday.is_holiday(date(year, month, d))
        holiday_name = (jpholiday.is_holiday_name(date(year, month, d)) if HAS_JPHOLIDAY else None) or ""
        cal_days.append({
            "day": d,
            "weekday": weekday_names[dt.weekday()],
            "is_weekend": dt.weekday() >= 5,
            "is_holiday": bool(is_holiday),
            "holiday_name": holiday_name
        })
    
    return {
        "year": year,
        "month": month,
        "days": cal_days,
        "schedules": entries,
        "staff": data["staff"]
    }

@app.post("/api/schedule")
def create_schedule(item: ScheduleCreate):
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
def update_schedule(schedule_id: str, item: ScheduleUpdate):
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
def delete_schedule(schedule_id: str):
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
def add_staff(item: StaffCreate):
    data = load_data()
    if item.name in data["staff"]:
        raise HTTPException(status_code=400, detail="既に存在します")
    data["staff"].append(item.name)
    save_data(data)
    return {"staff": data["staff"]}

@app.delete("/api/staff/{name}")
def delete_staff(name: str):
    data = load_data()
    if name not in data["staff"]:
        raise HTTPException(status_code=404, detail="Not found")
    data["staff"] = [s for s in data["staff"] if s != name]
    save_data(data)
    return {"staff": data["staff"]}

@app.put("/api/staff/order")
def reorder_staff(item: StaffOrder):
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
def create_reminder(item: ReminderCreate):
    data = load_data()
    # スケジュール存在確認
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
def update_reminder(reminder_id: str, item: ReminderUpdate):
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
def delete_reminder(reminder_id: str):
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
