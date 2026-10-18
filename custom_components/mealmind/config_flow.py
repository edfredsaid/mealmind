"""Config flow for MealMind integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import (
    DEFAULT_PRINTER_ENTITY,
    DEFAULT_TODO_ENTITY,
    DOMAIN,
)


class MealMindConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for MealMind."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            dislikes_raw = user_input.get("dislikes", "feta, beetroot")
            dislikes = [d.strip() for d in dislikes_raw.split(",") if d.strip()]
            return self.async_create_entry(
                title="MealMind",
                data={
                    "todo_entity": user_input.get("todo_entity", DEFAULT_TODO_ENTITY),
                    "printer_entity": user_input.get("printer_entity", DEFAULT_PRINTER_ENTITY),
                    "dietary_profile": user_input.get("dietary_profile", "Vegetarian"),
                    "dislikes": dislikes,
                },
            )

        schema = vol.Schema(
            {
                vol.Optional("todo_entity", default=DEFAULT_TODO_ENTITY): str,
                vol.Optional("printer_entity", default=DEFAULT_PRINTER_ENTITY): str,
                vol.Optional("dietary_profile", default="Vegetarian"): str,
                vol.Optional("dislikes", default="feta, beetroot"): str,
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema)
