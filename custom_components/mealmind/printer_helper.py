"""ESC/POS thermal receipt printer helper for MealMind."""

from __future__ import annotations

from datetime import date, datetime, timedelta
import logging
from typing import Any

from homeassistant.core import HomeAssistant

from .store import MealMindStore

_LOGGER = logging.getLogger(__name__)


def _format_short_date(date_str: str | None) -> str:
    """Format YYYY-MM-DD as DD/MM/YYYY or DD/MM."""
    if not date_str:
        return ""
    try:
        dt = date.fromisoformat(date_str)
        return dt.strftime("%d/%m/%Y")
    except ValueError:
        return str(date_str)


def _format_day_heading(dt: date) -> str:
    """Format date as 'Mon 19 Oct'."""
    return dt.strftime("%a %d %b")


async def async_print_today_card(
    hass: HomeAssistant,
    store: MealMindStore,
    target_date_str: str | None = None,
) -> None:
    """Print Today's Meal Card on the ESC/POS receipt printer."""
    settings = store.get_settings()
    printer_entity = settings.get("printer_entity", "notify.hall_stairs_hallway_receipt_printer")
    schedule = store.get_schedule()
    meals_db = store.get_meals()

    dt = date.fromisoformat(target_date_str) if target_date_str else date.today()
    d_str = dt.isoformat()
    day_entry = schedule.get(d_str, {})

    meal_id = day_entry.get("meal_id")
    db_meal = meals_db.get(meal_id, {}) if meal_id else {}
    meal_name = day_entry.get("meal_name") or db_meal.get("name") or "No Meal Planned"
    is_skipped = day_entry.get("skipped", False)
    skip_reason = day_entry.get("skip_reason") or "Skipped"
    is_fav = db_meal.get("favourite", False)
    ingredients = db_meal.get("ingredients", [])
    shortest_exp = day_entry.get("shortest_expiry")
    notes = day_entry.get("notes") or db_meal.get("notes") or ""

    lines: list[str] = [
        f"Date: {dt.strftime('%a %d/%m/%Y')}",
        "================================",
    ]

    if is_skipped:
        lines.append(f"STATUS: SKIPPED ({skip_reason})")
    else:
        fav_tag = " [*FAV*]" if is_fav else ""
        lines.append(f"{meal_name}{fav_tag}")
        if shortest_exp:
            lines.append(f"Shortest Date: {_format_short_date(shortest_exp)}")
        lines.append("--------------------------------")
        if ingredients:
            lines.append("INGREDIENTS:")
            for ing in ingredients:
                lines.append(f"  [ ] {ing}")
        else:
            lines.append("Ingredients: (none tagged)")

        if notes:
            lines.append("--------------------------------")
            lines.append("NOTES:")
            lines.append(notes)

    lines.append("================================")

    box_title = (
        "TODAY'S MEAL CARD"
        if dt == date.today()
        else f"MEAL CARD: {dt.strftime('%a %d %b').upper()}"
    )

    await hass.services.async_call(
        "escpos_printer",
        "print_box",
        {
            "align": "center",
            "padding": 1,
            "style": "ascii",
            "text": box_title,
            "cut": "none",
        },
        target={"entity_id": [printer_entity]},
        blocking=True,
    )

    await hass.services.async_call(
        "escpos_printer",
        "print_text_utf8",
        {
            "align": "left",
            "cut": "full",
            "feed": 2,
            "text": "\n".join(lines),
        },
        target={"entity_id": [printer_entity]},
        blocking=True,
    )


async def async_print_next_7_days_cards(
    hass: HomeAssistant,
    store: MealMindStore,
    start_date_str: str | None = None,
) -> int:
    """Print an individual full Meal Card for every day with a meal planned in the next 7 days."""
    schedule = store.get_schedule()
    start_dt = date.fromisoformat(start_date_str) if start_date_str else date.today()

    printed_count = 0
    for i in range(7):
        d = start_dt + timedelta(days=i)
        d_str = d.isoformat()
        day_entry = schedule.get(d_str, {})
        if day_entry.get("skipped"):
            continue
        if day_entry.get("meal_id") or day_entry.get("meal_name"):
            await async_print_today_card(hass, store, d_str)
            printed_count += 1

    if printed_count == 0:
        settings = store.get_settings()
        printer_entity = settings.get("printer_entity", "notify.hall_stairs_hallway_receipt_printer")
        await hass.services.async_call(
            "escpos_printer",
            "print_text_utf8",
            {
                "align": "center",
                "cut": "full",
                "feed": 2,
                "text": "MEALMIND\nNo meals planned in the next 7 days.",
            },
            target={"entity_id": [printer_entity]},
            blocking=True,
        )

    return printed_count


async def async_print_next_7_days(
    hass: HomeAssistant,
    store: MealMindStore,
    start_date_str: str | None = None,
) -> None:
    """Print the next 7 days meal schedule on the ESC/POS receipt printer."""
    settings = store.get_settings()
    printer_entity = settings.get("printer_entity", "notify.hall_stairs_hallway_receipt_printer")
    schedule = store.get_schedule()
    meals_db = store.get_meals()

    start_dt = date.fromisoformat(start_date_str) if start_date_str else date.today()
    end_dt = start_dt + timedelta(days=6)

    lines: list[str] = [
        f"{start_dt.strftime('%d/%m/%Y')} - {end_dt.strftime('%d/%m/%Y')}",
        "================================",
    ]

    planned_count = 0
    for i in range(7):
        d = start_dt + timedelta(days=i)
        d_str = d.isoformat()
        day_entry = schedule.get(d_str, {})
        heading = _format_day_heading(d)

        if day_entry.get("skipped"):
            reason = day_entry.get("skip_reason") or "Skipped"
            lines.append(f"{heading}:")
            lines.append(f"  -- {reason} --")
        elif day_entry.get("meal_id") or day_entry.get("meal_name"):
            planned_count += 1
            meal_id = day_entry.get("meal_id")
            db_meal = meals_db.get(meal_id, {}) if meal_id else {}
            m_name = day_entry.get("meal_name") or db_meal.get("name") or "Planned Meal"
            exp = day_entry.get("shortest_expiry")
            pin = " [PIN]" if day_entry.get("pinned") else ""
            lines.append(f"{heading}:{pin}")
            lines.append(f"  * {m_name}")
            if exp:
                try:
                    exp_short = date.fromisoformat(exp).strftime("%d/%m")
                except ValueError:
                    exp_short = exp
                lines.append(f"    (Use by: {exp_short})")
        else:
            lines.append(f"{heading}:")
            lines.append("  (Unplanned)")

        if i < 6:
            lines.append("--------------------------------")

    lines.append("================================")
    lines.append(f"Planned meals: {planned_count}/7")

    await hass.services.async_call(
        "escpos_printer",
        "print_box",
        {
            "align": "center",
            "padding": 1,
            "style": "ascii",
            "text": "NEXT 7 DAYS MEAL PLAN",
            "cut": "none",
        },
        target={"entity_id": [printer_entity]},
        blocking=True,
    )

    await hass.services.async_call(
        "escpos_printer",
        "print_text_utf8",
        {
            "align": "left",
            "cut": "full",
            "feed": 2,
            "text": "\n".join(lines),
        },
        target={"entity_id": [printer_entity]},
        blocking=True,
    )


async def async_print_shopping_list(
    hass: HomeAssistant,
    store: MealMindStore,
) -> None:
    """Print the active Food and Non-Food shopping lists formatted for pen check-off and photo scanning."""
    settings = store.get_settings()
    printer_entity = settings.get("printer_entity", "notify.hall_stairs_hallway_receipt_printer")
    todo_entity = settings.get("todo_entity", "todo.shopping_list")
    non_food_entity = settings.get("non_food_todo_entity", "todo.non_food_shopping")

    food_items: list[dict[str, Any]] = []
    if hass.states.get(todo_entity):
        res_food = await hass.services.async_call(
            "todo",
            "get_items",
            {"status": ["needs_action"]},
            target={"entity_id": [todo_entity]},
            blocking=True,
            return_response=True,
        )
        food_items = res_food.get(todo_entity, {}).get("items", [])

    non_food_items: list[dict[str, Any]] = []
    if non_food_entity and hass.states.get(non_food_entity):
        res_nf = await hass.services.async_call(
            "todo",
            "get_items",
            {"status": ["needs_action"]},
            target={"entity_id": [non_food_entity]},
            blocking=True,
            return_response=True,
        )
        non_food_items = res_nf.get(non_food_entity, {}).get("items", [])

    now_str = datetime.now().strftime("%d/%m/%Y %H:%M")
    lines: list[str] = [
        f"Printed: {now_str}",
        "Cross out or tick bought items",
        "================================",
    ]

    if not food_items and not non_food_items:
        lines.append("  (Shopping lists are empty!)")
    else:
        lines.append(f"--- FOOD & GROCERIES ({len(food_items)}) ---")
        if not food_items:
            lines.append("  (None)")
        else:
            for item in food_items:
                summary = item.get("summary", "")
                desc = item.get("description", "")
                lines.append(f"[ ] {summary}")
                if desc:
                    lines.append(f"    ({desc})")

        lines.append("--------------------------------")
        lines.append(f"--- NON-FOOD / HOUSEHOLD ({len(non_food_items)}) ---")
        if not non_food_items:
            lines.append("  (None)")
        else:
            for item in non_food_items:
                summary = item.get("summary", "")
                desc = item.get("description", "")
                lines.append(f"[ ] {summary}")
                if desc:
                    lines.append(f"    ({desc})")

    total_count = len(food_items) + len(non_food_items)
    lines.append("================================")
    lines.append(f"Total items: {total_count} ({len(food_items)} food, {len(non_food_items)} non-food)")

    await hass.services.async_call(
        "escpos_printer",
        "print_box",
        {
            "align": "center",
            "padding": 1,
            "style": "ascii",
            "text": "SHOPPING LIST",
            "cut": "none",
        },
        target={"entity_id": [printer_entity]},
        blocking=True,
    )

    await hass.services.async_call(
        "escpos_printer",
        "print_text_utf8",
        {
            "align": "left",
            "cut": "full",
            "feed": 2,
            "text": "\n".join(lines),
        },
        target={"entity_id": [printer_entity]},
        blocking=True,
    )
