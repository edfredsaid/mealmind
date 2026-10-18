"""Constants for the MealMind integration."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "mealmind"
VERSION = "1.0.3"

PLATFORMS: list[Platform] = [
    Platform.CALENDAR,
    Platform.SENSOR,
]

STORAGE_KEY = "mealmind"
STORAGE_VERSION = 1

DEFAULT_TODO_ENTITY = "todo.shopping_list"
DEFAULT_NON_FOOD_TODO_ENTITY = "todo.non_food_shopping"
DEFAULT_PRINTER_ENTITY = "notify.hall_stairs_hallway_receipt_printer"
DEFAULT_AI_CONVERSATION_ENTITY = "conversation.google_generative_ai"
DEFAULT_AI_TASK_ENTITY = "ai_task.google_ai_task"

DEFAULT_SETTINGS: dict = {
    "todo_entity": DEFAULT_TODO_ENTITY,
    "non_food_todo_entity": DEFAULT_NON_FOOD_TODO_ENTITY,
    "printer_entity": DEFAULT_PRINTER_ENTITY,
    "ai_conversation_entity": DEFAULT_AI_CONVERSATION_ENTITY,
    "ai_task_entity": DEFAULT_AI_TASK_ENTITY,
    "dietary_profile": "Vegetarian",
    "dislikes": ["feta", "beetroot"],
    "custom_preferences": "Prefer tasty vegetarian main meals suitable for evening dinners.",
    "guest_mode_active": False,
    "guest_mode_notes": "",
}

SEED_MEALS: list[dict] = [
    {
        "id": "meal_pie_mash",
        "name": "Pie & Mash with Green Veg",
        "ingredients": ["Veggie Pies", "Potatoes", "Butter", "Green Veg", "Gravy"],
        "tags": ["Comfort", "Winter"],
        "notes": "Serve with steamed greens and onion gravy.",
        "favourite": True,
        "times_cooked": 3,
        "last_cooked": None,
    },
    {
        "id": "meal_cheddar_onion_tartlet",
        "name": "Cheddar & Onion Tartlet with Salad and Savoury Rice",
        "ingredients": ["Cheddar & Onion Tartlets", "Bags of Lettuce", "Cucumber", "Tomatoes", "Spring Onions", "Savoury Rice"],
        "tags": ["Quick", "Easy"],
        "notes": "Oven bake tartlets for 20-25 mins.",
        "favourite": True,
        "times_cooked": 2,
        "last_cooked": None,
    },
    {
        "id": "meal_aubergine_parm",
        "name": "Aubergine Parm with Salad & Garlic Bread",
        "ingredients": ["Aubergine", "Passata", "Mozzarella", "Parmesan Style Cheese", "Garlic Bread", "Bags of Lettuce"],
        "tags": ["Italian", "Guest-Friendly"],
        "notes": "Bake layered aubergine with passata and mozzarella until bubbling.",
        "favourite": True,
        "times_cooked": 2,
        "last_cooked": None,
    },
    {
        "id": "meal_pizza_mozzarella",
        "name": "Pizza and Mozzarella Sticks",
        "ingredients": ["Vegetarian Pizza", "Mozzarella Sticks", "Garlic Potato Salad", "Cheese Coleslaw"],
        "tags": ["Quick", "Friday"],
        "notes": "Quick oven night.",
        "favourite": False,
        "times_cooked": 4,
        "last_cooked": None,
    },
]
