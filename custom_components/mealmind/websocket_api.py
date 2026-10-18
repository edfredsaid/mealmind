"""WebSocket API for the MealMind integration."""

from __future__ import annotations

from datetime import date
import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .ai_helper import async_scan_receipt_photo, async_suggest_meals
from .const import DOMAIN
from .coordinator import MealMindCoordinator
from .printer_helper import (
    async_print_next_7_days,
    async_print_next_7_days_cards,
    async_print_shopping_list,
    async_print_today_card,
)
from .store import MealMindStore

_LOGGER = logging.getLogger(__name__)


def _get_store_and_coord(hass: HomeAssistant) -> tuple[MealMindStore, MealMindCoordinator | None]:
    """Return store and coordinator from hass.data."""
    data = hass.data.get(DOMAIN, {})
    return data["store"], data.get("coordinator")


async def _fetch_shopping_list(hass: HomeAssistant, store: MealMindStore) -> list[dict[str, Any]]:
    """Fetch active items from the configured todo shopping list and annotate with planned meals."""
    settings = store.get_settings()
    todo_entity = settings.get("todo_entity", "todo.shopping_list")
    if not hass.states.get(todo_entity):
        return []

    try:
        res = await hass.services.async_call(
            "todo",
            "get_items",
            {"status": ["needs_action"]},
            target={"entity_id": [todo_entity]},
            blocking=True,
            return_response=True,
        )
        items: list[dict[str, Any]] = res.get(todo_entity, {}).get("items", [])
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Failed to fetch shopping list from %s: %s", todo_entity, err)
        return []

    # Map ingredients from upcoming planned meals & queue to shopping items
    meals_db = store.get_meals()
    schedule = store.get_schedule()
    queue = store.get_queue()
    today_str = date.today().isoformat()

    upcoming_meals: list[tuple[str, list[str]]] = []
    for d_str, entry in sorted(schedule.items()):
        if d_str >= today_str and not entry.get("skipped"):
            meal_id = entry.get("meal_id")
            db_meal = meals_db.get(meal_id, {}) if meal_id else {}
            m_name = entry.get("meal_name") or db_meal.get("name")
            ings = db_meal.get("ingredients", [])
            if m_name and ings:
                upcoming_meals.append((m_name, ings))

    for q_item in queue:
        meal_id = q_item.get("meal_id")
        db_meal = meals_db.get(meal_id, {}) if meal_id else {}
        m_name = q_item.get("meal_name") or db_meal.get("name")
        ings = db_meal.get("ingredients", [])
        if m_name and ings:
            upcoming_meals.append((m_name, ings))

    annotated: list[dict[str, Any]] = []
    for item in items:
        summary = (item.get("summary") or "").strip()
        s_lower = summary.lower()
        for_meals: list[str] = []
        for m_name, ings in upcoming_meals:
            for ing in ings:
                ing_l = ing.lower()
                if s_lower == ing_l or s_lower in ing_l or ing_l in s_lower:
                    if m_name not in for_meals:
                        for_meals.append(m_name)
        annotated.append(
            {
                "uid": item.get("uid"),
                "summary": summary,
                "description": item.get("description", ""),
                "status": item.get("status", "needs_action"),
                "for_meals": for_meals,
                "list_type": "food",
            }
        )
    return annotated


async def _fetch_non_food_shopping_list(hass: HomeAssistant, store: MealMindStore) -> list[dict[str, Any]]:
    """Fetch active items from the configured non-food todo shopping list."""
    settings = store.get_settings()
    non_food_entity = settings.get("non_food_todo_entity", "todo.non_food_shopping")
    if not non_food_entity or not hass.states.get(non_food_entity):
        return []

    try:
        res = await hass.services.async_call(
            "todo",
            "get_items",
            {"status": ["needs_action"]},
            target={"entity_id": [non_food_entity]},
            blocking=True,
            return_response=True,
        )
        items: list[dict[str, Any]] = res.get(non_food_entity, {}).get("items", [])
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Failed to fetch non-food shopping list from %s: %s", non_food_entity, err)
        return []

    return [
        {
            "uid": item.get("uid"),
            "summary": (item.get("summary") or "").strip(),
            "description": item.get("description", ""),
            "status": item.get("status", "needs_action"),
            "for_meals": [],
            "list_type": "non_food",
        }
        for item in items
    ]


async def _build_full_state(hass: HomeAssistant, store: MealMindStore) -> dict[str, Any]:
    """Build full state payload for the frontend."""
    shopping_list = await _fetch_shopping_list(hass, store)
    non_food_shopping_list = await _fetch_non_food_shopping_list(hass, store)
    return {
        "settings": store.get_settings(),
        "meals": store.get_meals(),
        "schedule": store.get_schedule(),
        "queue": store.get_queue(),
        "all_ingredients": store.get_all_ingredients(),
        "shopping_list": shopping_list,
        "non_food_shopping_list": non_food_shopping_list,
    }


async def _refresh_coord(coord: MealMindCoordinator | None) -> None:
    """Trigger coordinator refresh if available."""
    if coord:
        await coord.async_request_refresh()


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register all MealMind WebSocket commands."""
    websocket_api.async_register_command(hass, ws_get_state)
    websocket_api.async_register_command(hass, ws_update_settings)
    websocket_api.async_register_command(hass, ws_save_meal)
    websocket_api.async_register_command(hass, ws_delete_meal)
    websocket_api.async_register_command(hass, ws_set_day)
    websocket_api.async_register_command(hass, ws_clear_day)
    websocket_api.async_register_command(hass, ws_push_day)
    websocket_api.async_register_command(hass, ws_skip_day)
    websocket_api.async_register_command(hass, ws_swap_days)
    websocket_api.async_register_command(hass, ws_auto_schedule)
    websocket_api.async_register_command(hass, ws_queue_add)
    websocket_api.async_register_command(hass, ws_queue_remove)
    websocket_api.async_register_command(hass, ws_shopping_add_items)
    websocket_api.async_register_command(hass, ws_shopping_complete_items)
    websocket_api.async_register_command(hass, ws_ai_suggest)
    websocket_api.async_register_command(hass, ws_receipt_scan)
    websocket_api.async_register_command(hass, ws_printer_print)


@websocket_api.websocket_command({vol.Required("type"): "mealmind/get_state"})
@websocket_api.async_response
async def ws_get_state(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return full state for the MealMind frontend."""
    store, _ = _get_store_and_coord(hass)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/settings/update",
        vol.Required("settings"): dict,
    }
)
@websocket_api.async_response
async def ws_update_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Update MealMind settings."""
    store, coord = _get_store_and_coord(hass)
    await store.async_update_settings(msg["settings"])
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/meals/save",
        vol.Required("meal"): dict,
    }
)
@websocket_api.async_response
async def ws_save_meal(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Create or update a meal in the Meal Database."""
    store, coord = _get_store_and_coord(hass)
    saved = await store.async_save_meal(msg["meal"])
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    state["saved_meal"] = saved
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/meals/delete",
        vol.Required("meal_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_meal(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Delete a meal from the Meal Database."""
    store, coord = _get_store_and_coord(hass)
    await store.async_delete_meal(msg["meal_id"])
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/schedule/set_day",
        vol.Required("date"): str,
        vol.Optional("meal_id"): vol.Any(str, None),
        vol.Optional("meal_name"): vol.Any(str, None),
        vol.Optional("ingredients"): vol.Any(list, None),
        vol.Optional("shortest_expiry"): vol.Any(str, None),
        vol.Optional("pinned"): vol.Any(bool, None),
        vol.Optional("skipped"): vol.Any(bool, None),
        vol.Optional("skip_reason"): vol.Any(str, None),
        vol.Optional("notes"): vol.Any(str, None),
        vol.Optional("mark_cooked"): vol.Any(bool, None),
    }
)
@websocket_api.async_response
async def ws_set_day(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set or update a scheduled day."""
    store, coord = _get_store_and_coord(hass)
    entry = await store.async_set_day(
        date_str=msg["date"],
        meal_id=msg.get("meal_id"),
        meal_name=msg.get("meal_name"),
        ingredients=msg.get("ingredients"),
        shortest_expiry=msg.get("shortest_expiry"),
        pinned=msg.get("pinned"),
        skipped=msg.get("skipped"),
        skip_reason=msg.get("skip_reason"),
        notes=msg.get("notes"),
    )

    # If newly scheduled meal has a meal_id, optionally increment times_cooked when requested
    if msg.get("mark_cooked") and entry.get("meal_id"):
        meals = store.get_meals()
        db_meal = meals.get(entry["meal_id"])
        if db_meal:
            db_meal["times_cooked"] = db_meal.get("times_cooked", 0) + 1
            db_meal["last_cooked"] = msg["date"]
            await store.async_save_meal(db_meal)

    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    state["updated_day"] = entry
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/schedule/clear_day",
        vol.Required("date"): str,
    }
)
@websocket_api.async_response
async def ws_clear_day(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Clear a scheduled day."""
    store, coord = _get_store_and_coord(hass)
    await store.async_clear_day(msg["date"])
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/schedule/push_day",
        vol.Required("date"): str,
        vol.Optional("days", default=1): int,
    }
)
@websocket_api.async_response
async def ws_push_day(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Push a day's meal forward and cascade subsequent unpinned meals."""
    store, coord = _get_store_and_coord(hass)
    res = await store.async_push_day(msg["date"], msg.get("days", 1))
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    state["action_result"] = res
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/schedule/skip_day",
        vol.Required("date"): str,
        vol.Optional("skip_reason", default="Skipped"): str,
        vol.Optional("push_existing", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_skip_day(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Mark a day as skipped (or unskip) and push existing meal forward."""
    store, coord = _get_store_and_coord(hass)
    res = await store.async_skip_day(
        msg["date"],
        skip_reason=msg.get("skip_reason", "Skipped"),
        push_existing=msg.get("push_existing", True),
    )
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    state["action_result"] = res
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/schedule/swap_days",
        vol.Required("date_a"): str,
        vol.Required("date_b"): str,
    }
)
@websocket_api.async_response
async def ws_swap_days(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Swap two days on the schedule."""
    store, coord = _get_store_and_coord(hass)
    await store.async_swap_days(msg["date_a"], msg["date_b"])
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/schedule/auto_schedule",
        vol.Optional("start_date"): vol.Any(str, None),
        vol.Optional("num_days", default=14): int,
    }
)
@websocket_api.async_response
async def ws_auto_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Auto-schedule unpinned meals ordered by shortest ingredient expiry date."""
    store, coord = _get_store_and_coord(hass)
    res = await store.async_auto_schedule(
        start_date_str=msg.get("start_date"),
        num_days=msg.get("num_days", 14),
    )
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    state["action_result"] = res
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/queue/add",
        vol.Optional("meal_id"): vol.Any(str, None),
        vol.Optional("meal_name"): vol.Any(str, None),
        vol.Optional("ingredients"): vol.Any(list, None),
        vol.Optional("shortest_expiry"): vol.Any(str, None),
        vol.Optional("notes"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_queue_add(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Add a meal to the unscheduled queue."""
    store, coord = _get_store_and_coord(hass)
    await store.async_add_to_queue(
        meal_id=msg.get("meal_id"),
        meal_name=msg.get("meal_name"),
        ingredients=msg.get("ingredients"),
        shortest_expiry=msg.get("shortest_expiry"),
        notes=msg.get("notes"),
    )
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/queue/remove",
        vol.Required("queue_id"): str,
    }
)
@websocket_api.async_response
async def ws_queue_remove(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Remove an item from the unscheduled queue."""
    store, coord = _get_store_and_coord(hass)
    await store.async_remove_from_queue(msg["queue_id"])
    await _refresh_coord(coord)
    state = await _build_full_state(hass, store)
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/shopping/add_items",
        vol.Required("items"): [str],
        vol.Optional("list_type", default="food"): vol.In(["food", "non_food"]),
    }
)
@websocket_api.async_response
async def ws_shopping_add_items(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Add selected items to either the Food or Non-Food Todo shopping list."""
    store, _ = _get_store_and_coord(hass)
    settings = store.get_settings()
    list_type = msg.get("list_type", "food")

    if list_type == "non_food":
        target_entity = settings.get("non_food_todo_entity", "todo.non_food_shopping")
        existing = await _fetch_non_food_shopping_list(hass, store)
    else:
        target_entity = settings.get("todo_entity", "todo.shopping_list")
        existing = await _fetch_shopping_list(hass, store)

    existing_lower = {item["summary"].strip().lower() for item in existing}

    added: list[str] = []
    for raw_item in msg["items"]:
        clean = str(raw_item).strip()
        if not clean or clean.lower() in existing_lower:
            continue
        await hass.services.async_call(
            "todo",
            "add_item",
            {"item": clean},
            target={"entity_id": [target_entity]},
            blocking=True,
        )
        existing_lower.add(clean.lower())
        added.append(clean)

    state = await _build_full_state(hass, store)
    state["added_items"] = added
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/shopping/complete_items",
        vol.Required("items"): [str],
        vol.Optional("list_type", default="food"): vol.In(["food", "non_food"]),
    }
)
@websocket_api.async_response
async def ws_shopping_complete_items(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Mark one or more items (by uid or summary) as completed on the Food or Non-Food Todo list."""
    store, _ = _get_store_and_coord(hass)
    settings = store.get_settings()
    list_type = msg.get("list_type", "food")

    if list_type == "non_food":
        target_entity = settings.get("non_food_todo_entity", "todo.non_food_shopping")
    else:
        target_entity = settings.get("todo_entity", "todo.shopping_list")

    completed: list[str] = []
    for item_ref in msg["items"]:
        if not item_ref:
            continue
        try:
            await hass.services.async_call(
                "todo",
                "update_item",
                {"item": item_ref, "status": "completed"},
                target={"entity_id": [target_entity]},
                blocking=True,
            )
            completed.append(item_ref)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Failed to complete shopping list item '%s' on %s: %s", item_ref, target_entity, err)

    state = await _build_full_state(hass, store)
    state["completed_items"] = completed
    connection.send_result(msg["id"], state)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/ai/suggest",
        vol.Optional("guest_mode", default=False): bool,
        vol.Optional("guest_notes", default=""): str,
        vol.Optional("extra_prompt", default=""): str,
    }
)
@websocket_api.async_response
async def ws_ai_suggest(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Use Gemini AI to suggest meals from the database/favourites and new recipe ideas."""
    store, _ = _get_store_and_coord(hass)
    shopping = await _fetch_shopping_list(hass, store)
    shopping_names = [item["summary"] for item in shopping]
    meals_db = list(store.get_meals().values())
    settings = store.get_settings()

    try:
        suggestions = await async_suggest_meals(
            hass=hass,
            shopping_items=shopping_names,
            meals_db=meals_db,
            settings=settings,
            guest_mode=msg.get("guest_mode", False),
            guest_notes=msg.get("guest_notes", ""),
            extra_prompt=msg.get("extra_prompt", ""),
        )
        connection.send_result(msg["id"], {"suggestions": suggestions})
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("MealMind AI suggestion failed")
        connection.send_error(msg["id"], "ai_error", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/receipt/scan",
        vol.Required("image_base64"): str,
        vol.Optional("mime_type", default="image/jpeg"): str,
        vol.Optional("auto_complete", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_receipt_scan(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Scan a photo of a printed shopping list and mark crossed-out/ticked items completed across Food and Non-Food lists."""
    store, _ = _get_store_and_coord(hass)
    settings = store.get_settings()
    todo_entity = settings.get("todo_entity", "todo.shopping_list")
    non_food_entity = settings.get("non_food_todo_entity", "todo.non_food_shopping")

    food_shopping = await _fetch_shopping_list(hass, store)
    non_food_shopping = await _fetch_non_food_shopping_list(hass, store)
    combined_shopping = food_shopping + non_food_shopping

    non_food_uids = {item.get("uid") for item in non_food_shopping if item.get("uid")}
    non_food_summaries_lower = {
        (item.get("summary") or "").strip().lower() for item in non_food_shopping
    }

    try:
        scan_result = await async_scan_receipt_photo(
            hass=hass,
            image_base64=msg["image_base64"],
            mime_type=msg.get("mime_type", "image/jpeg"),
            shopping_items=combined_shopping,
            settings=settings,
        )

        completed_summaries: list[str] = []
        if msg.get("auto_complete", True):
            for bought in scan_result.get("bought_items", []):
                target_item = bought.get("uid") or bought.get("summary")
                summary_str = (bought.get("summary") or "").strip()
                if target_item:
                    is_nf = (
                        bought.get("list_type") == "non_food"
                        or bought.get("uid") in non_food_uids
                        or summary_str.lower() in non_food_summaries_lower
                    )
                    entity_to_update = non_food_entity if is_nf else todo_entity
                    try:
                        await hass.services.async_call(
                            "todo",
                            "update_item",
                            {"item": target_item, "status": "completed"},
                            target={"entity_id": [entity_to_update]},
                            blocking=True,
                        )
                        completed_summaries.append(summary_str or str(target_item))
                    except Exception as err:  # noqa: BLE001
                        _LOGGER.debug("Could not mark '%s' completed on %s: %s", target_item, entity_to_update, err)

        state = await _build_full_state(hass, store)
        state["scan_result"] = scan_result
        state["completed_summaries"] = completed_summaries
        connection.send_result(msg["id"], state)
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("MealMind receipt scan failed")
        connection.send_error(msg["id"], "scan_error", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "mealmind/printer/print",
        vol.Required("mission"): vol.In(
            ["today_card", "next_7_days", "next_7_days_cards", "shopping_list"]
        ),
        vol.Optional("date"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_printer_print(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Execute one of the ESC/POS thermal printer missions."""
    store, _ = _get_store_and_coord(hass)
    mission = msg["mission"]
    target_date = msg.get("date")
    try:
        printed_count: int | None = None
        if mission == "today_card":
            await async_print_today_card(hass, store, target_date)
        elif mission == "next_7_days":
            await async_print_next_7_days(hass, store, target_date)
        elif mission == "next_7_days_cards":
            printed_count = await async_print_next_7_days_cards(hass, store, target_date)
        elif mission == "shopping_list":
            await async_print_shopping_list(hass, store)
        connection.send_result(
            msg["id"],
            {"printed": True, "mission": mission, "printed_count": printed_count},
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("MealMind printer mission '%s' failed", mission)
        connection.send_error(msg["id"], "print_error", str(err))
