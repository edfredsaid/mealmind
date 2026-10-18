"""AI helper for MealMind using Google Generative AI (Gemini) and HA Conversation."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

GEMINI_PREFERRED_MODELS = [
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-pro-latest",
]


def _get_gemini_api_key(hass: HomeAssistant, settings: dict[str, Any]) -> str | None:
    """Retrieve Gemini API key from settings or HA's google_generative_ai_conversation config entry."""
    if settings.get("gemini_api_key"):
        return str(settings["gemini_api_key"]).strip()

    entries = hass.config_entries.async_entries("google_generative_ai_conversation")
    for entry in entries:
        api_key = entry.data.get("api_key")
        if api_key:
            return str(api_key).strip()
    return None


def _get_configured_ha_gemini_models(hass: HomeAssistant) -> list[str]:
    """Check if HA's google_generative_ai_conversation has a specific chat_model configured."""
    found: list[str] = []
    entries = hass.config_entries.async_entries("google_generative_ai_conversation")
    for entry in entries:
        for source in [entry.options, entry.data]:
            cm = source.get("chat_model")
            if cm and isinstance(cm, str):
                short = cm.replace("models/", "").strip()
                if short and short not in found:
                    found.append(short)
        subentries = getattr(entry, "subentries", None)
        if isinstance(subentries, dict):
            for sub in subentries.values():
                sub_data = getattr(sub, "data", {}) or {}
                cm = sub_data.get("chat_model")
                if cm and isinstance(cm, str):
                    short = cm.replace("models/", "").strip()
                    if short and short not in found:
                        found.append(short)
    return found


def _extract_json(text: str) -> dict[str, Any]:
    """Extract JSON object from LLM text response."""
    text = text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1)
    else:
        brace_start = text.find("{")
        brace_end = text.rfind("}")
        if brace_start != -1 and brace_end != -1 and brace_end > brace_start:
            text = text[brace_start : brace_end + 1]
    return json.loads(text)


async def _discover_available_gemini_models(hass: HomeAssistant, api_key: str) -> list[str]:
    """Query the Gemini ListModels endpoint to find supported generateContent flash/pro models."""
    cached = hass.data.get("mealmind_gemini_models")
    if isinstance(cached, list) and cached:
        return cached

    session = async_get_clientsession(hass)
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    try:
        async with session.get(url, timeout=15) as resp:
            if resp.status != 200:
                body = await resp.text()
                _LOGGER.warning("Gemini ListModels returned HTTP %s: %s", resp.status, body[:200])
                return []
            data = await resp.json()
            models: list[str] = []
            excluded_keywords = ("tts", "embedding", "imagen", "veo", "audio", "robotics", "computer-use", "1.5", "1.0")
            for m in data.get("models", []):
                methods = m.get("supportedGenerationMethods", [])
                name = m.get("name", "")
                if "generateContent" in methods and name.startswith("models/gemini"):
                    short_name = name.split("models/", 1)[1]
                    if not any(kw in short_name.lower() for kw in excluded_keywords):
                        models.append(short_name)

            def _model_rank(m_name: str) -> tuple[int, str]:
                if m_name in GEMINI_PREFERRED_MODELS:
                    return (GEMINI_PREFERRED_MODELS.index(m_name), m_name)
                if "flash" in m_name and "lite" not in m_name:
                    return (10, m_name)
                if "flash" in m_name:
                    return (20, m_name)
                if "pro" in m_name:
                    return (30, m_name)
                return (50, m_name)

            models.sort(key=_model_rank)
            if models:
                hass.data["mealmind_gemini_models"] = models
                _LOGGER.info("MealMind discovered available Gemini models: %s", models[:6])
            return models
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Failed to list Gemini models: %s", err)
        return []


async def _call_gemini_rest(
    hass: HomeAssistant,
    api_key: str,
    prompt: str,
    image_base64: str | None = None,
    mime_type: str = "image/jpeg",
) -> dict[str, Any]:
    """Call Google Gemini REST API directly with JSON output mode."""
    session = async_get_clientsession(hass)

    parts: list[dict[str, Any]] = [{"text": prompt}]
    if image_base64:
        # Strip data URI prefix if present
        if "," in image_base64 and image_base64.startswith("data:"):
            header, image_base64 = image_base64.split(",", 1)
            if ":" in header and ";" in header:
                mime_type = header.split(":", 1)[1].split(";", 1)[0]
        parts.insert(
            0,
            {
                "inline_data": {
                    "mime_type": mime_type or "image/jpeg",
                    "data": image_base64,
                }
            },
        )

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.2 if image_base64 else 0.7,
            "responseMimeType": "application/json",
        },
    }

    # Build ordered list of candidate models: HA configured -> discovered -> preferred static
    candidate_models: list[str] = []
    for m in _get_configured_ha_gemini_models(hass):
        if m not in candidate_models and "1.5" not in m:
            candidate_models.append(m)
    for m in await _discover_available_gemini_models(hass, api_key):
        if m not in candidate_models:
            candidate_models.append(m)
    for m in GEMINI_PREFERRED_MODELS:
        if m not in candidate_models:
            candidate_models.append(m)

    errors: list[str] = []

    for model in candidate_models[:5]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        try:
            async with session.post(url, json=payload, timeout=60) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    candidates = data.get("candidates", [])
                    if candidates:
                        content_parts = candidates[0].get("content", {}).get("parts", [])
                        # Filter out thinking parts (thought: True) returned by Gemini 2.5+ thinking models
                        non_thought_texts = [
                            p["text"]
                            for p in content_parts
                            if isinstance(p, dict) and "text" in p and not p.get("thought")
                        ]
                        all_texts = non_thought_texts or [
                            p["text"] for p in content_parts if isinstance(p, dict) and "text" in p
                        ]
                        for text_part in reversed(all_texts):
                            try:
                                return _extract_json(text_part)
                            except Exception as parse_err:  # noqa: BLE001
                                _LOGGER.warning("MealMind %s JSON parse failed: %s", model, parse_err)
                                errors.append(f"{model} JSON parse error: {parse_err}")
                    else:
                        errors.append(f"{model} returned no candidates: {str(data)[:160]}")
                else:
                    body = await resp.text()
                    _LOGGER.warning("MealMind %s returned HTTP %s: %s", model, resp.status, body[:200])
                    errors.append(f"HTTP {resp.status} from {model}: {body[:160]}")
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("MealMind %s request error: %s", model, err)
            errors.append(f"{model} error: {err}")

    raise RuntimeError("Gemini API call failed: " + " | ".join(errors[:3]))


async def _call_ha_conversation_fallback(
    hass: HomeAssistant,
    prompt: str,
    agent_id: str = "conversation.google_generative_ai",
) -> dict[str, Any]:
    """Fallback to Home Assistant conversation.process service."""
    res = await hass.services.async_call(
        "conversation",
        "process",
        {"text": prompt, "agent_id": agent_id},
        blocking=True,
        return_response=True,
    )
    speech = (
        res.get("response", {})
        .get("speech", {})
        .get("plain", {})
        .get("speech", "")
    )
    if not speech:
        raise RuntimeError("Empty response from conversation agent")
    return _extract_json(speech)


async def async_suggest_meals(
    hass: HomeAssistant,
    shopping_items: list[str],
    meals_db: list[dict[str, Any]],
    settings: dict[str, Any],
    guest_mode: bool = False,
    guest_notes: str = "",
    extra_prompt: str = "",
) -> dict[str, Any]:
    """Suggest meals from both the user's Meal Database/Favourites and new AI recipes."""
    dietary = settings.get("dietary_profile", "Vegetarian")
    dislikes = settings.get("dislikes", ["feta", "beetroot"])
    if isinstance(dislikes, list):
        dislikes_str = ", ".join(dislikes)
    else:
        dislikes_str = str(dislikes)
    custom_prefs = settings.get("custom_preferences", "")

    db_summary = [
        {
            "id": m.get("id"),
            "name": m.get("name"),
            "ingredients": m.get("ingredients", []),
            "favourite": m.get("favourite", False),
            "tags": m.get("tags", []),
        }
        for m in meals_db
    ]

    occasion_block = ""
    if guest_mode or guest_notes:
        occasion_block = f"""
SPECIAL OCCASION / GUEST MODE IS ACTIVE:
- Guest / Occasion Instructions: {guest_notes or 'We have guests / special occasion — suggest crowd-pleasing or special meals.'}
- Note: If the Guest / Occasion instructions explicitly allow an exception to the default dietary or dislike rules, honour the Guest / Occasion instructions. Otherwise keep the default dietary profile.
"""

    prompt = f"""You are MealMind, a smart meal planning assistant.
Suggest evening main meals based on the user's current shopping list, their saved Meal Database (highlighting favourites), and their dietary profile.

DIETARY PROFILE & PREFERENCES:
- Base Diet: {dietary}
- Dislikes / Excluded Ingredients (NEVER include unless overridden by Guest Mode): {dislikes_str}
- General Preferences: {custom_prefs}
{occasion_block}
{f'- Additional User Request: {extra_prompt}' if extra_prompt else ''}

CURRENT SHOPPING LIST ITEMS:
{json.dumps(shopping_items, ensure_ascii=False)}

USER'S SAVED MEAL DATABASE (with Favourites marked):
{json.dumps(db_summary, ensure_ascii=False)}

Return ONLY valid JSON matching this exact structure:
{{
  "db_suggestions": [
    {{
      "meal_id": "id from database",
      "name": "Meal Name",
      "favourite": true,
      "ingredients": ["Ingredient 1", "Ingredient 2"],
      "tags": ["Tag1"],
      "notes": "Prep note",
      "reason": "Why this saved meal is a great pick right now (e.g. uses X from shopping list or is a favourite)"
    }}
  ],
  "ai_suggestions": [
    {{
      "name": "New Recipe Name",
      "ingredients": ["Ingredient 1", "Ingredient 2", "Ingredient 3"],
      "tags": ["Quick", "Vegetarian"],
      "notes": "Short 1-2 sentence cooking summary",
      "reason": "Why this fits the shopping list / preferences"
    }}
  ]
}}

Rules:
1. In `db_suggestions`, include up to 4 best-matching meals from the user's saved database (prioritizing meals that share ingredients with the shopping list or are marked `favourite: true`).
2. In `ai_suggestions`, propose 4 fresh, delicious meal ideas not already in the database that strictly respect `{dietary}` and avoid `{dislikes_str}` (unless overridden in Guest Mode).
3. Keep ingredient names concise and practical for a UK supermarket shopping list (e.g., "Halloumi", "Courgettes", "Peppers", "Garlic Bread").
"""

    api_key = _get_gemini_api_key(hass, settings)
    if api_key:
        return await _call_gemini_rest(hass, api_key, prompt)

    agent_id = settings.get("ai_conversation_entity", "conversation.google_generative_ai")
    return await _call_ha_conversation_fallback(hass, prompt, agent_id)


async def async_scan_receipt_photo(
    hass: HomeAssistant,
    image_base64: str,
    mime_type: str,
    shopping_items: list[dict[str, Any]],
    settings: dict[str, Any],
) -> dict[str, Any]:
    """Analyze a photo of a printed ESC/POS shopping list to find crossed-out / ticked items."""
    api_key = _get_gemini_api_key(hass, settings)
    if not api_key:
        raise RuntimeError(
            "No Google Generative AI API key found. Ensure the Google Generative AI integration is configured."
        )

    items_list = [
        {
            "uid": item.get("uid"),
            "summary": item.get("summary"),
            "list_type": item.get("list_type", "food"),
        }
        for item in shopping_items
    ]

    prompt = f"""You are examining a photo of a printed paper shopping list (which may contain both FOOD & GROCERIES and NON-FOOD / HOUSEHOLD sections).
On this paper list:
- Items that are CROSSED OUT (struck through with a pen/marker line) OR TICKED / CHECKED (inside or next to the `[ ]` box) have been PICKED UP / BOUGHT.
- Items that are UNMARKED (neither crossed out nor ticked) were NOT picked up and are STILL NEEDED.

Here are the current active items on the digital To-Do shopping lists (Food and Non-Food):
{json.dumps(items_list, ensure_ascii=False)}

Carefully inspect every line on the paper list in the image and match it against the digital To-Do lists above.
Return ONLY valid JSON with this exact structure:
{{
  "bought_items": [
    {{
      "uid": "matching uid from digital list (or null if not in digital list)",
      "summary": "Item name from digital list",
      "list_type": "food or non_food",
      "paper_text": "What was written on paper",
      "mark_type": "crossed_out or ticked"
    }}
  ],
  "still_needed_items": [
    {{
      "uid": "matching uid from digital list",
      "summary": "Item name from digital list",
      "list_type": "food or non_food"
    }}
  ],
  "notes": "Brief 1-sentence summary of what was detected on the paper list"
}}
"""

    return await _call_gemini_rest(
        hass,
        api_key=api_key,
        prompt=prompt,
        image_base64=image_base64,
        mime_type=mime_type,
    )
