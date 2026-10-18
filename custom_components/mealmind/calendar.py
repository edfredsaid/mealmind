"""Calendar platform for MealMind."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import MealMindCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the MealMind calendar entity."""
    coordinator: MealMindCoordinator = hass.data[DOMAIN]["coordinator"]
    async_add_entities([MealMindCalendarEntity(coordinator, entry)])


class MealMindCalendarEntity(CoordinatorEntity[MealMindCoordinator], CalendarEntity):
    """Calendar entity representing the MealMind meal schedule."""

    _attr_has_entity_name = False
    _attr_name = "Meal Plan"
    _attr_unique_id = "mealmind_meal_plan_calendar"
    _attr_icon = "mdi:calendar-restaurant"

    def __init__(self, coordinator: MealMindCoordinator, entry: ConfigEntry) -> None:
        """Initialize the calendar entity."""
        super().__init__(coordinator)
        self._entry = entry
        self.entity_id = "calendar.meal_plan"

    def _build_event(self, d_str: str, day_entry: dict[str, Any], meals_db: dict[str, Any]) -> CalendarEvent | None:
        """Convert a scheduled day dict into a CalendarEvent."""
        try:
            dt = date.fromisoformat(d_str)
        except ValueError:
            return None

        if day_entry.get("skipped"):
            reason = day_entry.get("skip_reason") or "Skipped"
            return CalendarEvent(
                start=dt,
                end=dt + timedelta(days=1),
                summary=f"[Skipped] {reason}",
                description="Day marked as skipped in MealMind",
                uid=f"mealmind_{d_str}",
            )

        meal_id = day_entry.get("meal_id")
        db_meal = meals_db.get(meal_id, {}) if meal_id else {}
        meal_name = day_entry.get("meal_name") or db_meal.get("name")
        if not meal_name:
            return None

        fav_prefix = "★ " if db_meal.get("favourite") else ""
        exp = day_entry.get("shortest_expiry")
        exp_suffix = f" (Exp: {exp[8:10]}/{exp[5:7]})" if exp and len(exp) == 10 else ""
        summary = f"{fav_prefix}{meal_name}{exp_suffix}"

        desc_parts: list[str] = []
        ingredients = db_meal.get("ingredients", [])
        if ingredients:
            desc_parts.append("Ingredients: " + ", ".join(ingredients))
        if exp:
            desc_parts.append(f"Shortest Ingredient Expiry: {exp}")
        notes = day_entry.get("notes") or db_meal.get("notes")
        if notes:
            desc_parts.append(f"Notes: {notes}")

        return CalendarEvent(
            start=dt,
            end=dt + timedelta(days=1),
            summary=summary,
            description="\n".join(desc_parts),
            uid=f"mealmind_{d_str}",
        )

    @property
    def event(self) -> CalendarEvent | None:
        """Return the current or next upcoming event."""
        data = self.coordinator.data or {}
        schedule = data.get("schedule", {})
        meals_db = data.get("meals", {})
        today_str = date.today().isoformat()

        for d_str in sorted(schedule.keys()):
            if d_str >= today_str:
                ev = self._build_event(d_str, schedule[d_str], meals_db)
                if ev is not None:
                    return ev
        return None

    async def async_get_events(
        self,
        hass: HomeAssistant,
        start_date: datetime,
        end_date: datetime,
    ) -> list[CalendarEvent]:
        """Return calendar events within a datetime range."""
        data = self.coordinator.data or {}
        schedule = data.get("schedule", {})
        meals_db = data.get("meals", {})

        start_d = start_date.date().isoformat()
        end_d = end_date.date().isoformat()

        events: list[CalendarEvent] = []
        for d_str, day_entry in sorted(schedule.items()):
            if start_d <= d_str <= end_d:
                ev = self._build_event(d_str, day_entry, meals_db)
                if ev is not None:
                    events.append(ev)
        return events
