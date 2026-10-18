# MealMind: Smart Meal Planner for Home Assistant

**MealMind** is a lightweight, expiry-aware meal planning custom integration for Home Assistant with a built-in mobile & desktop sidebar panel, two-way `todo.shopping_list` sync, Gemini AI meal & receipt vision support, and ESC/POS thermal receipt printer integration.

## Features

- **Persistent Meal Database & ★ Favourites**:
  - Save past meals with ingredient tags, prep notes, tags (*Quick*, *Comfort*, *Guest-Friendly*), and a ★ Favourite toggle.
  - Pre-seeded with your existing meals and automatically saves new meals when scheduled.
- **Multi-Week Advance Calendar & Shortest Expiry Auto-Scheduler**:
  - Plan 1 main meal per day across the current week, next week, or any future weeks.
  - Tag the **Shortest Ingredient Expiry Date** on planned meals (`+1d`, `+2d`, `+4d`, or date picker).
  - **Auto-Schedule by Shortest Expiry**: Automatically orders unpinned meals and queued meals so the earliest-expiring ingredients are cooked first, skipping over pinned or skipped days.
  - **Fast Calendar Actions**: Drag & Drop or 1-tap **Swap**, **Push (+1d)** (cascades subsequent unpinned meals forward and warns if an ingredient will pass its expiry date), **Skip Day**, and **Pin**.
- **Mid-Step Ingredient Review Modal**:
  - Whenever you schedule a meal or click **Review & Shop Ingredients**, a checklist lets you untick any ingredients you already have in the cupboard/fridge before adding the rest to `todo.shopping_list`.
- **AI Meal Suggester (Database Favourites + New Gemini Recipes)**:
  - Uses your default dietary profile (e.g. *Vegetarian*, avoiding *feta, beetroot*) plus a **"We Have Guests / Special Occasion"** override toggle.
  - Suggests both matching meals from your saved Meal Database/Favourites and fresh AI recipe ideas based on your current shopping list.
- **Online Shopping Companion Pop-Out Window + In-Store Paper Receipt Scanner**:
  - **Pop-Out Online Shop Window**: Narrow companion view designed to sit next to your online supermarket tab with 1-tap item check-off, 1-click item copy, and built-in **Quick Meal Add / Remove** for two-way shopping inspiration.
  - **Scan Crossed-Out Paper Shopping List**: Snap a photo of your printed ESC/POS shopping list — Gemini Vision detects crossed-out and ticked items, marks them completed on `todo.shopping_list`, and displays a post-shop summary of your planned meals to add/remove meals or set expiry dates.
- **ESC/POS Thermal Printer Missions**:
  - `mealmind.print_today_card`: Prints Today's Meal Card (dish, ★ badge, shortest expiry date, ingredients, and notes).
  - `mealmind.print_next_7_days`: Prints the next 7 days meal schedule.
  - `mealmind.print_shopping_list`: Prints active shopping list items with `[ ]` checkboxes.

## Installation via HACS

1. Open **HACS** in Home Assistant → **Integrations** → **⋮ (top right)** → **Custom repositories**.
2. Add your repository URL (`https://github.com/edfredsaid/mealmind`) with category **Integration**.
3. Click **Download** on **MealMind**, then restart Home Assistant.
4. Go to **Settings → Devices & Services → + Add Integration → MealMind**.
