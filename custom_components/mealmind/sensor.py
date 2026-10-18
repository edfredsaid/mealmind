"""Sensor platform for MealMind."""

from __future__ import annotations

from datetime import date
from typing import Any

from homeassistant.components.sensor import SensorEntity
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
    """Set up MealMind sensor entities."""
    coordinator: MealMindCoordinator = hass.data[DOMAIN]["coordinator"]
    async_add_entities(
        [
            MealMindTodayMealSensor(coordinator, entry),
            MealMindExpiringSoonSensor(coordinator, entry),
        ]
    )


class MealMindTodayMealSensor(CoordinatorEntity[MealMindCoordinator], SensorEntity):
    """Sensor showing today's planned meal."""

    _attr_has_entity_name = False
    _attr_name = "MealMind Today's Meal"
    _attr_unique_id = "mealmind_today_meal"
    _attr_icon = "mdi:silverware-fork-knife"

    def __init__(self, coordinator: MealMindCoordinator, entry: ConfigEntry) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._entry = entry
        self.entity_id = "sensor.mealmind_today_meal"

    @property
    def native_value(self) -> str:
        """Return today's meal name."""
        data = self.coordinator.data or {}
        today_str = date.today().isoformat()
        day_entry = data.get("schedule", {}).get(today_str, {})
        if day_entry.get("skipped"):
            return f"Skipped ({day_entry.get('skip_reason') or 'Skipped'})"
        meal_id = day_entry.get("meal_id")
        db_meal = data.get("meals", {}).get(meal_id, {}) if meal_id else {}
        return day_entry.get("meal_name") or db_meal.get("name") or "Unplanned"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra attributes for today's meal."""
        data = self.coordinator.data or {}
        today_str = date.today().isoformat()
        day_entry = data.get("schedule", {}).get(today_str, {})
        meal_id = day_entry.get("meal_id")
        db_meal = data.get("meals", {}).get(meal_id, {}) if meal_id else {}
        return {
            "date": today_str,
            "meal_id": meal_id,
            "ingredients": db_meal.get("ingredients", []),
            "favourite": db_meal.get("favourite", False),
            "tags": db_meal.get("tags", []),
            "shortest_expiry": day_entry.get("shortest_expiry"),
            "pinned": day_entry.get("pinned", False),
            "skipped": day_entry.get("skipped", False),
            "notes": day_entry.get("notes") or db_meal.get("notes", ""),
        }


class MealMindExpiringSoonSensor(CoordinatorEntity[MealMindCoordinator], SensorEntity):
    """Sensor showing count of planned meals with ingredients expiring today or tomorrow."""

    _attr_has_entity_name = False
    _attr_name = "MealMind Expiring Soon"
    _attr_unique_id = "mealmind_expiring_soon"
    _attr_icon = "mdi:clock-alert-outline"
    _attr_native_unit_of_measurement = "meals"

    def __init__(self, coordinator: MealMindCoordinator, entry: ConfigEntry) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._entry = entry
        self.entity_id = "sensor.mealmind_expiring_soon"

    @property
    def native_value(self) -> int:
        """Return count of meals expiring soon."""
        data = self.coordinator.data or {}
        return len(data.get("expiring_soon", []))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return list of expiring meals."""
        data = self.coordinator.data or {}
        return {
            "meals": data.get("expiring_soon", []),
        }
