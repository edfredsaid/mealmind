"""Persistent storage manager for MealMind."""

from __future__ import annotations

import copy
from datetime import date, datetime, timedelta
import logging
import re
import uuid
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DEFAULT_SETTINGS, SEED_MEALS, STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


def _slugify(text: str) -> str:
    """Create a clean slug from meal name."""
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return f"meal_{slug[:40]}" if slug else f"meal_{uuid.uuid4().hex[:8]}"


class MealMindStore:
    """Manage MealMind persistent data in .storage/mealmind."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = {
            "settings": copy.deepcopy(DEFAULT_SETTINGS),
            "meals": {},
            "schedule": {},
            "queue": [],
        }

    async def async_load(self) -> None:
        """Load data from disk or initialize defaults."""
        stored = await self._store.async_load()
        if stored and isinstance(stored, dict):
            settings = copy.deepcopy(DEFAULT_SETTINGS)
            settings.update(stored.get("settings", {}))
            self._data = {
                "settings": settings,
                "meals": stored.get("meals", {}),
                "schedule": stored.get("schedule", {}),
                "queue": stored.get("queue", []),
            }
        else:
            # Seed initial meals from the user's existing meal plan
            meals = {}
            for item in SEED_MEALS:
                meals[item["id"]] = copy.deepcopy(item)
            self._data["meals"] = meals
            await self.async_save()

    async def async_save(self) -> None:
        """Persist current data to disk."""
        await self._store.async_save(self._data)

    # ------------------------------------------------------------------
    # Getters
    # ------------------------------------------------------------------

    def get_settings(self) -> dict[str, Any]:
        """Return current settings."""
        return copy.deepcopy(self._data["settings"])

    def get_meals(self) -> dict[str, dict[str, Any]]:
        """Return all meals in the database."""
        return copy.deepcopy(self._data["meals"])

    def get_schedule(self) -> dict[str, dict[str, Any]]:
        """Return the full schedule dict keyed by YYYY-MM-DD."""
        return copy.deepcopy(self._data["schedule"])

    def get_queue(self) -> list[dict[str, Any]]:
        """Return the unscheduled meal queue."""
        return copy.deepcopy(self._data["queue"])

    def get_all_ingredients(self) -> list[str]:
        """Return sorted unique list of all ingredients across all saved meals."""
        ingredients: set[str] = set()
        for meal in self._data["meals"].values():
            for ing in meal.get("ingredients", []):
                if ing and ing.strip():
                    ingredients.add(ing.strip())
        return sorted(ingredients, key=str.lower)

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------

    async def async_update_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Update settings and persist."""
        for key, val in updates.items():
            if key in DEFAULT_SETTINGS:
                self._data["settings"][key] = val
        await self.async_save()
        return self.get_settings()

    # ------------------------------------------------------------------
    # Meal Database CRUD
    # ------------------------------------------------------------------

    async def async_save_meal(self, meal_data: dict[str, Any]) -> dict[str, Any]:
        """Create or update a meal in the database."""
        name = (meal_data.get("name") or "").strip()
        if not name:
            raise ValueError("Meal name is required")

        meal_id = meal_data.get("id")
        if not meal_id:
            # Check if a meal with the exact same name (case-insensitive) exists
            for existing_id, existing in self._data["meals"].items():
                if existing.get("name", "").strip().lower() == name.lower():
                    meal_id = existing_id
                    break
        if not meal_id:
            base_id = _slugify(name)
            meal_id = base_id
            counter = 2
            while meal_id in self._data["meals"]:
                meal_id = f"{base_id}_{counter}"
                counter += 1

        existing_meal = self._data["meals"].get(meal_id, {})

        ingredients = meal_data.get("ingredients", existing_meal.get("ingredients", []))
        if isinstance(ingredients, str):
            ingredients = [i.strip() for i in ingredients.split(",") if i.strip()]
        else:
            ingredients = [str(i).strip() for i in ingredients if str(i).strip()]

        tags = meal_data.get("tags", existing_meal.get("tags", []))
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        else:
            tags = [str(t).strip() for t in tags if str(t).strip()]

        meal_record = {
            "id": meal_id,
            "name": name,
            "ingredients": ingredients,
            "tags": tags,
            "notes": meal_data.get("notes", existing_meal.get("notes", "")),
            "favourite": bool(meal_data.get("favourite", existing_meal.get("favourite", False))),
            "times_cooked": int(meal_data.get("times_cooked", existing_meal.get("times_cooked", 0))),
            "last_cooked": meal_data.get("last_cooked", existing_meal.get("last_cooked")),
        }

        self._data["meals"][meal_id] = meal_record

        # Also keep scheduled entries' meal_name in sync if they reference this meal_id
        for day_entry in self._data["schedule"].values():
            if day_entry.get("meal_id") == meal_id:
                day_entry["meal_name"] = name

        await self.async_save()
        return copy.deepcopy(meal_record)

    async def async_delete_meal(self, meal_id: str) -> bool:
        """Delete a meal from the database."""
        if meal_id not in self._data["meals"]:
            return False
        del self._data["meals"][meal_id]
        await self.async_save()
        return True

    # ------------------------------------------------------------------
    # Schedule & Queue Management
    # ------------------------------------------------------------------

    async def async_set_day(
        self,
        date_str: str,
        meal_id: str | None = None,
        meal_name: str | None = None,
        ingredients: list[str] | None = None,
        shortest_expiry: str | None = None,
        pinned: bool | None = None,
        skipped: bool | None = None,
        skip_reason: str | None = None,
        notes: str | None = None,
        save_to_db: bool = True,
    ) -> dict[str, Any]:
        """Set or update a meal on a specific YYYY-MM-DD date."""
        existing = self._data["schedule"].get(date_str, {})

        # If a new meal name is provided without a meal_id, ensure it exists in DB
        if meal_name and not meal_id and save_to_db:
            saved_meal = await self.async_save_meal(
                {
                    "name": meal_name,
                    "ingredients": ingredients if ingredients is not None else [],
                    "notes": notes if notes is not None else "",
                }
            )
            meal_id = saved_meal["id"]
            meal_name = saved_meal["name"]
        elif meal_id and meal_id in self._data["meals"]:
            db_meal = self._data["meals"][meal_id]
            meal_name = db_meal["name"]
            if ingredients is not None:
                await self.async_save_meal({"id": meal_id, "name": meal_name, "ingredients": ingredients})

        is_skipped = skipped if skipped is not None else existing.get("skipped", False)
        if meal_id or meal_name:
            is_skipped = False

        entry = {
            "date": date_str,
            "meal_id": meal_id if meal_id is not None else existing.get("meal_id"),
            "meal_name": meal_name if meal_name is not None else existing.get("meal_name", ""),
            "shortest_expiry": (
                shortest_expiry if shortest_expiry is not None else existing.get("shortest_expiry")
            ),
            "pinned": bool(pinned if pinned is not None else existing.get("pinned", False)),
            "skipped": bool(is_skipped),
            "skip_reason": (
                skip_reason if skip_reason is not None else existing.get("skip_reason", "")
            ),
            "notes": notes if notes is not None else existing.get("notes", ""),
        }

        self._data["schedule"][date_str] = entry
        await self.async_save()
        return copy.deepcopy(entry)

    async def async_clear_day(self, date_str: str) -> None:
        """Clear a scheduled day."""
        self._data["schedule"].pop(date_str, None)
        await self.async_save()

    async def async_add_to_queue(
        self,
        meal_id: str | None = None,
        meal_name: str | None = None,
        ingredients: list[str] | None = None,
        shortest_expiry: str | None = None,
        notes: str | None = None,
    ) -> dict[str, Any]:
        """Add a meal to the unscheduled queue (and save to DB if new)."""
        if meal_name and not meal_id:
            saved = await self.async_save_meal(
                {
                    "name": meal_name,
                    "ingredients": ingredients or [],
                    "notes": notes or "",
                }
            )
            meal_id = saved["id"]
            meal_name = saved["name"]
        elif meal_id and meal_id in self._data["meals"]:
            meal_name = self._data["meals"][meal_id]["name"]

        item = {
            "queue_id": f"q_{uuid.uuid4().hex[:8]}",
            "meal_id": meal_id,
            "meal_name": meal_name or "Unnamed Meal",
            "shortest_expiry": shortest_expiry,
            "notes": notes or "",
        }
        self._data["queue"].append(item)
        await self.async_save()
        return copy.deepcopy(item)

    async def async_remove_from_queue(self, queue_id: str) -> None:
        """Remove an item from the unscheduled queue."""
        self._data["queue"] = [q for q in self._data["queue"] if q.get("queue_id") != queue_id]
        await self.async_save()

    async def async_swap_days(self, date_a: str, date_b: str) -> None:
        """Swap meals between two dates."""
        if date_a == date_b:
            return
        entry_a = copy.deepcopy(self._data["schedule"].get(date_a))
        entry_b = copy.deepcopy(self._data["schedule"].get(date_b))

        if entry_a:
            entry_a["date"] = date_b
            self._data["schedule"][date_b] = entry_a
        else:
            self._data["schedule"].pop(date_b, None)

        if entry_b:
            entry_b["date"] = date_a
            self._data["schedule"][date_a] = entry_b
        else:
            self._data["schedule"].pop(date_a, None)

        await self.async_save()

    def _is_slot_locked(self, date_str: str) -> bool:
        """Return True if a date is pinned or marked skipped."""
        entry = self._data["schedule"].get(date_str)
        if not entry:
            return False
        return bool(entry.get("pinned") or entry.get("skipped"))

    def _next_unlocked_date(self, from_date: date) -> date:
        """Find the next date after from_date that is neither pinned nor skipped."""
        candidate = from_date + timedelta(days=1)
        for _ in range(90):
            if not self._is_slot_locked(candidate.isoformat()):
                return candidate
            candidate += timedelta(days=1)
        return candidate

    async def async_push_day(self, date_str: str, days: int = 1) -> dict[str, Any]:
        """Push the meal on date_str forward, cascading subsequent unpinned meals."""
        entry = self._data["schedule"].get(date_str)
        if not entry or (not entry.get("meal_id") and not entry.get("meal_name")):
            return {"pushed": False, "warnings": []}

        # Unpin the pushed day if it was pinned so it can move
        entry["pinned"] = False

        start_dt = date.fromisoformat(date_str)
        # Collect all unpinned, non-skipped meals from start_dt onwards (up to 60 days ahead)
        movable_dates: list[date] = []
        movable_meals: list[dict[str, Any]] = []

        for offset in range(60):
            d = start_dt + timedelta(days=offset)
            d_str = d.isoformat()
            slot = self._data["schedule"].get(d_str)
            if slot and (slot.get("pinned") or slot.get("skipped")):
                continue
            if slot and (slot.get("meal_id") or slot.get("meal_name")):
                movable_dates.append(d)
                movable_meals.append(copy.deepcopy(slot))
                self._data["schedule"].pop(d_str, None)

        # Find target dates starting `days` unlocked slots after start_dt
        curr_dt = start_dt
        for _ in range(max(1, days)):
            curr_dt = self._next_unlocked_date(curr_dt)

        warnings: list[str] = []
        for idx, meal_item in enumerate(movable_meals):
            if idx > 0:
                curr_dt = self._next_unlocked_date(curr_dt)
            target_str = curr_dt.isoformat()
            meal_item["date"] = target_str
            self._data["schedule"][target_str] = meal_item

            exp = meal_item.get("shortest_expiry")
            if exp and target_str > exp:
                warnings.append(
                    f"'{meal_item.get('meal_name')}' is now scheduled on {target_str}, which is after its shortest ingredient expiry ({exp})!"
                )

        await self.async_save()
        return {"pushed": True, "warnings": warnings}

    async def async_skip_day(
        self,
        date_str: str,
        skip_reason: str = "Skipped",
        push_existing: bool = True,
    ) -> dict[str, Any]:
        """Mark a day as skipped, optionally pushing its planned meal forward."""
        existing = self._data["schedule"].get(date_str)
        if existing and existing.get("skipped"):
            # Toggle off skip if already skipped
            self._data["schedule"].pop(date_str, None)
            await self.async_save()
            return {"skipped": False, "warnings": []}

        warnings: list[str] = []
        if push_existing and existing and (existing.get("meal_id") or existing.get("meal_name")):
            res = await self.async_push_day(date_str, days=1)
            warnings = res.get("warnings", [])

        self._data["schedule"][date_str] = {
            "date": date_str,
            "meal_id": None,
            "meal_name": "",
            "shortest_expiry": None,
            "pinned": False,
            "skipped": True,
            "skip_reason": skip_reason or "Skipped",
            "notes": "",
        }
        await self.async_save()
        return {"skipped": True, "warnings": warnings}

    async def async_auto_schedule(
        self,
        start_date_str: str | None = None,
        num_days: int = 14,
    ) -> dict[str, Any]:
        """Auto-schedule unpinned meals & queue items ordered by shortest ingredient expiry."""
        start_dt = date.fromisoformat(start_date_str) if start_date_str else date.today()
        window_dates = [start_dt + timedelta(days=i) for i in range(num_days)]

        # 1. Gather all unlocked slots in the window and pull their meals into a pool
        open_dates: list[str] = []
        meal_pool: list[dict[str, Any]] = []

        for d in window_dates:
            d_str = d.isoformat()
            slot = self._data["schedule"].get(d_str)
            if slot and (slot.get("pinned") or slot.get("skipped")):
                continue
            open_dates.append(d_str)
            if slot and (slot.get("meal_id") or slot.get("meal_name")):
                meal_pool.append(
                    {
                        "meal_id": slot.get("meal_id"),
                        "meal_name": slot.get("meal_name"),
                        "shortest_expiry": slot.get("shortest_expiry"),
                        "notes": slot.get("notes", ""),
                    }
                )
                self._data["schedule"].pop(d_str, None)

        # 2. Add any items from the unscheduled queue into the pool
        for q_item in self._data["queue"]:
            meal_pool.append(
                {
                    "meal_id": q_item.get("meal_id"),
                    "meal_name": q_item.get("meal_name"),
                    "shortest_expiry": q_item.get("shortest_expiry"),
                    "notes": q_item.get("notes", ""),
                }
            )
        self._data["queue"] = []

        # 3. Sort meal_pool so meals with the earliest shortest_expiry come first
        # Meals without shortest_expiry keep their relative order after dated meals
        def _sort_key(item: tuple[int, dict[str, Any]]) -> tuple[int, str, int]:
            idx, m = item
            exp = m.get("shortest_expiry")
            if exp:
                return (0, str(exp), idx)
            return (1, "9999-12-31", idx)

        sorted_pool = [m for _, m in sorted(enumerate(meal_pool), key=_sort_key)]

        warnings: list[str] = []
        scheduled_count = 0

        for idx, meal_item in enumerate(sorted_pool):
            if idx < len(open_dates):
                target_date = open_dates[idx]
                exp = meal_item.get("shortest_expiry")
                if exp and target_date > exp:
                    warnings.append(
                        f"'{meal_item.get('meal_name')}' scheduled on {target_date} expires on {exp}!"
                    )
                self._data["schedule"][target_date] = {
                    "date": target_date,
                    "meal_id": meal_item.get("meal_id"),
                    "meal_name": meal_item.get("meal_name", ""),
                    "shortest_expiry": exp,
                    "pinned": False,
                    "skipped": False,
                    "skip_reason": "",
                    "notes": meal_item.get("notes", ""),
                }
                scheduled_count += 1
            else:
                # Overflow back to queue
                self._data["queue"].append(
                    {
                        "queue_id": f"q_{uuid.uuid4().hex[:8]}",
                        "meal_id": meal_item.get("meal_id"),
                        "meal_name": meal_item.get("meal_name", ""),
                        "shortest_expiry": meal_item.get("shortest_expiry"),
                        "notes": meal_item.get("notes", ""),
                    }
                )

        await self.async_save()
        return {
            "scheduled_count": scheduled_count,
            "warnings": warnings,
        }
