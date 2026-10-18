"""DataUpdateCoordinator for MealMind."""

from __future__ import annotations

from datetime import date, timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import DOMAIN
from .store import MealMindStore

_LOGGER = logging.getLogger(__name__)


class MealMindCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator for MealMind state and entity updates."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        store: MealMindStore,
    ) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=5),
        )
        self.entry = entry
        self.store = store

    async def _async_update_data(self) -> dict[str, Any]:
        """Return latest state snapshot from the store."""
        meals = self.store.get_meals()
        schedule = self.store.get_schedule()
        queue = self.store.get_queue()
        settings = self.store.get_settings()

        today_str = date.today().isoformat()
        tomorrow_str = (date.today() + timedelta(days=1)).isoformat()

        expiring_soon: list[dict[str, Any]] = []
        for d_str, entry in sorted(schedule.items()):
            if d_str < today_str or entry.get("skipped"):
                continue
            exp = entry.get("shortest_expiry")
            if exp and exp <= tomorrow_str and (entry.get("meal_id") or entry.get("meal_name")):
                expiring_soon.append(
                    {
                        "date": d_str,
                        "meal_name": entry.get("meal_name"),
                        "shortest_expiry": exp,
                        "overdue": exp < today_str or d_str > exp,
                    }
                )

        return {
            "meals": meals,
            "schedule": schedule,
            "queue": queue,
            "settings": settings,
            "today": schedule.get(today_str, {}),
            "expiring_soon": expiring_soon,
        }
