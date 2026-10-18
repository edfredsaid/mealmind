"""MealMind – Smart Meal Planner, Expiry Auto-Scheduler & ESC/POS Printer Integration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components.frontend import (
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, PLATFORMS, VERSION
from .coordinator import MealMindCoordinator
from .printer_helper import (
    async_print_next_7_days,
    async_print_shopping_list,
    async_print_today_card,
)
from .store import MealMindStore
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the MealMind integration."""
    hass.data.setdefault(DOMAIN, {})
    async_register_websocket_commands(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up MealMind from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    store: MealMindStore | None = hass.data[DOMAIN].get("store")
    if not store:
        store = MealMindStore(hass)
        await store.async_load()
        hass.data[DOMAIN]["store"] = store

    # Sync any initial options from config entry into store settings
    if entry.data:
        updates = {k: v for k, v in entry.data.items() if v is not None}
        if updates:
            await store.async_update_settings(updates)

    coordinator = MealMindCoordinator(hass, entry, store)
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator
    hass.data[DOMAIN]["coordinator"] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    _async_register_services(hass, store, coordinator)
    await _async_register_panel(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a MealMind config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop("coordinator", None)
        if not any(isinstance(v, MealMindCoordinator) for v in hass.data[DOMAIN].values()):
            async_remove_panel(hass, DOMAIN)
            hass.data[DOMAIN].pop("panel_registered", None)
    return unload_ok


def _async_register_services(
    hass: HomeAssistant,
    store: MealMindStore,
    coordinator: MealMindCoordinator,
) -> None:
    """Register MealMind domain services for automations and buttons."""
    if hass.services.has_service(DOMAIN, "print_today_card"):
        return

    async def handle_print_today_card(call: ServiceCall) -> None:
        await async_print_today_card(hass, store, call.data.get("date"))

    async def handle_print_next_7_days(call: ServiceCall) -> None:
        await async_print_next_7_days(hass, store, call.data.get("start_date"))

    async def handle_print_shopping_list(call: ServiceCall) -> None:
        await async_print_shopping_list(hass, store)

    async def handle_auto_schedule(call: ServiceCall) -> None:
        await store.async_auto_schedule(
            start_date_str=call.data.get("start_date"),
            num_days=call.data.get("num_days", 14),
        )
        await coordinator.async_request_refresh()

    async def handle_push_day(call: ServiceCall) -> None:
        target_date = call.data.get("date")
        await store.async_push_day(target_date, call.data.get("days", 1))
        await coordinator.async_request_refresh()

    async def handle_skip_day(call: ServiceCall) -> None:
        target_date = call.data.get("date")
        await store.async_skip_day(
            target_date,
            skip_reason=call.data.get("skip_reason", "Skipped"),
            push_existing=call.data.get("push_existing", True),
        )
        await coordinator.async_request_refresh()

    hass.services.async_register(
        DOMAIN,
        "print_today_card",
        handle_print_today_card,
        schema=vol.Schema({vol.Optional("date"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN,
        "print_next_7_days",
        handle_print_next_7_days,
        schema=vol.Schema({vol.Optional("start_date"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN,
        "print_shopping_list",
        handle_print_shopping_list,
        schema=vol.Schema({}),
    )
    hass.services.async_register(
        DOMAIN,
        "auto_schedule",
        handle_auto_schedule,
        schema=vol.Schema(
            {
                vol.Optional("start_date"): cv.string,
                vol.Optional("num_days", default=14): cv.positive_int,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "push_day",
        handle_push_day,
        schema=vol.Schema(
            {
                vol.Required("date"): cv.string,
                vol.Optional("days", default=1): cv.positive_int,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "skip_day",
        handle_skip_day,
        schema=vol.Schema(
            {
                vol.Required("date"): cv.string,
                vol.Optional("skip_reason", default="Skipped"): cv.string,
                vol.Optional("push_existing", default=True): cv.boolean,
            }
        ),
    )


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Register the MealMind custom panel in the Home Assistant sidebar."""
    if hass.data[DOMAIN].get("panel_registered"):
        return

    panel_js = Path(__file__).parent / "frontend" / "mealmind-panel.js"
    if not panel_js.exists():
        _LOGGER.warning("MealMind panel JS not found at %s", panel_js)
        return

    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig("/mealmind/mealmind-panel.js", str(panel_js), False)]
        )
    except RuntimeError:
        _LOGGER.debug("MealMind static path already registered")

    try:
        async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title="MealMind",
            sidebar_icon="mdi:silverware-fork-knife",
            frontend_url_path="mealmind",
            config={
                "_panel_custom": {
                    "name": "mealmind-panel",
                    "embed_iframe": False,
                    "trust_external": False,
                    "js_url": f"/mealmind/mealmind-panel.js?v={VERSION}",
                }
            },
        )
    except ValueError:
        _LOGGER.debug("MealMind panel already registered")

    hass.data[DOMAIN]["panel_registered"] = True
    _LOGGER.info("MealMind panel registered in sidebar")
