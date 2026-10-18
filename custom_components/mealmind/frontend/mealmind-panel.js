/**
 * MealMind v1.0.4 — Modern Web & Mobile App UI for Home Assistant
 *
 * Key UX & Visual Hierarchy Refinements (v1.0.4):
 * - HA Companion App & Mobile Sidebar Toggle (☰ dispatches 'hass-toggle-menu')
 * - Semantic Colour Hierarchy:
 *     • Emerald (#10b981) for primary creation/add/plan actions
 *     • Violet (#8b5cf6) for AI & Smart actions (Auto-Schedule, Scan Receipt, AI Chef)
 *     • Amber (#f59e0b) for schedule shifting (+1d Push) & expiry attention
 *     • Sky (#0ea5e9) for active navigation & Today highlight
 * - Reduced Information Density with ⋯ (3-Dot) Pop-Out Menus on Calendar & Database cards
 * - Consolidated 🖨️ Print ▾ Popover Menu + New "Print Next 7 Days' Meal Cards (All Planned)"
 * - Flattened Single-Layer Toolbar on the Shopping List view (no multi-layer sub-nav stacks)
 * - Explicit Checkbox-Only Completion on Shopping List rows + Instant ↩️ Undo (Toast + Tray)
 */

class MealMindPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._initialized = false;
    this._toast = null;

    const params = new URLSearchParams(window.location.search);
    this._isCompanion = params.get("companion") === "1";
    this._activeTab = this._isCompanion ? "shop" : "calendar";

    // Food vs Non-Food Shopping List category switcher: 'food' | 'non_food' | 'both'
    this._shopListCategory = "food";

    // Recently completed shopping items for 1-tap Undo
    // [{ summary, listType, time }]
    this._recentlyCompleted = [];
    this._showRecentlyCompleted = false;

    // Pop-out menus & inline pickers (only one open at a time)
    this._printMenuOpen = false;
    this._shopMoreMenuOpen = false;
    this._openCardMenuDate = null;
    this._openExpiryDate = null;
    this._openDbMenuId = null;

    // Calendar window state
    this._dayOffset = 0;
    this._numDaysView = 14;
    this._swapSourceDate = null;
    this._dragSourceDate = null;

    // Backend state
    this._state = {
      settings: {
        dietary_profile: "Vegetarian",
        dislikes: ["feta", "beetroot"],
        custom_preferences: "",
        todo_entity: "todo.shopping_list",
        non_food_todo_entity: "todo.non_food_shopping",
        printer_entity: "notify.hall_stairs_hallway_receipt_printer",
      },
      meals: {},
      schedule: {},
      queue: [],
      all_ingredients: [],
      shopping_list: [],
      non_food_shopping_list: [],
    };

    // Modals
    // 1. Day / Meal Assignment Modal (searchable database picker + custom editor)
    this._dayModal = null;

    // 2. Database Create/Edit Meal Modal
    this._mealModal = null;

    // 3. Mid-Step Ingredient Check Modal ("Untick what you already have in stock")
    this._ingredientReviewModal = null;

    // 4. Post-Scan Results & Planned Meals Modal
    this._postScanModal = false;

    // 5. Planned Meals & Expiry Unpack Modal (accessible in 1 click from Shop toolbar)
    this._unpackModal = false;

    // Database tab filters
    this._dbSearch = "";
    this._dbFavOnly = false;
    this._dbTagFilter = "";

    // AI Chef state
    this._aiGuestMode = false;
    this._aiGuestNotes = "";
    this._aiExtraPrompt = "";
    this._aiLoading = false;
    this._aiResults = null;

    // Receipt Scanner state
    this._scanLoading = false;
    this._scanSummary = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized && hass) {
      this._initialized = true;
      this._fetchState();
    }
  }

  _closeAllMenus() {
    this._printMenuOpen = false;
    this._shopMoreMenuOpen = false;
    this._openCardMenuDate = null;
    this._openDbMenuId = null;
  }

  _toggleHaSidebar() {
    this.dispatchEvent(
      new CustomEvent("hass-toggle-menu", {
        bubbles: true,
        composed: true,
      })
    );
  }

  async _wsCall(payload) {
    if (!this._hass) return null;
    return await this._hass.callWS(payload);
  }

  async _fetchState() {
    if (!this._hass) return;
    try {
      const res = await this._wsCall({ type: "mealmind/get_state" });
      if (res) {
        this._updateLocalState(res);
      }
    } catch (err) {
      console.error("MealMind failed to load state:", err);
      this._showToast("Failed to load MealMind state: " + (err.message || err), true);
    }
  }

  _updateLocalState(res) {
    if (res.settings) this._state.settings = res.settings;
    if (res.meals) this._state.meals = res.meals;
    if (res.schedule) this._state.schedule = res.schedule;
    if (res.queue) this._state.queue = res.queue;
    if (res.all_ingredients) this._state.all_ingredients = res.all_ingredients;
    if (res.shopping_list) this._state.shopping_list = res.shopping_list;
    if (res.non_food_shopping_list) this._state.non_food_shopping_list = res.non_food_shopping_list;
    this._render();
  }

  _showToast(msg, isError = false, undoAction = null) {
    this._toast = { msg, isError, undoAction };
    this._render();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(
      () => {
        this._toast = null;
        this._render();
      },
      undoAction ? 6500 : 4200
    );
  }

  // ---------------------------------------------------------------------------
  // Date & Formatting Helpers
  // ---------------------------------------------------------------------------

  _todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  _addDaysStr(baseDateStr, days) {
    const [y, m, d] = baseDateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d + days);
    const ry = dt.getFullYear();
    const rm = String(dt.getMonth() + 1).padStart(2, "0");
    const rd = String(dt.getDate()).padStart(2, "0");
    return `${ry}-${rm}-${rd}`;
  }

  _formatDisplayDate(dateStr) {
    if (!dateStr) return "";
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const today = this._todayStr();
    const tomorrow = this._addDaysStr(today, 1);
    const label = dt.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    if (dateStr === today) return `Today • ${label}`;
    if (dateStr === tomorrow) return `Tomorrow • ${label}`;
    return label;
  }

  _getExpiryBadge(scheduledDateStr, expiryDateStr) {
    if (!expiryDateStr) return null;
    const today = this._todayStr();
    const tomorrow = this._addDaysStr(today, 1);
    const [y, m, d] = expiryDateStr.split("-").map(Number);
    const shortFmt = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;

    if (scheduledDateStr > expiryDateStr || expiryDateStr < today) {
      return {
        text: `⚠️ Exp ${shortFmt} (Overdue)`,
        cls: "badge-danger",
        stripe: "stripe-danger",
      };
    }
    if (
      expiryDateStr === today ||
      expiryDateStr === tomorrow ||
      expiryDateStr === scheduledDateStr
    ) {
      return {
        text: `⏳ Exp ${shortFmt} (Use Soon)`,
        cls: "badge-warn",
        stripe: "stripe-warn",
      };
    }
    return {
      text: `📅 Exp ${shortFmt}`,
      cls: "badge-ok",
      stripe: "stripe-ok",
    };
  }

  _escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------------------
  // Mid-Step Ingredient Review Modal
  // ---------------------------------------------------------------------------

  _openIngredientReviewModal(mealName, ingredientsList) {
    const onListLower = new Set(
      (this._state.shopping_list || []).map((i) => (i.summary || "").trim().toLowerCase())
    );
    const items = (ingredientsList || []).map((ing) => {
      const clean = String(ing).trim();
      const already = onListLower.has(clean.toLowerCase());
      return {
        name: clean,
        checked: !already,
        onList: already,
      };
    });
    this._ingredientReviewModal = {
      mealName: mealName || "Meal",
      items,
      extraItem: "",
    };
    this._render();
  }

  async _confirmIngredientReview() {
    if (!this._ingredientReviewModal) return;
    const selected = this._ingredientReviewModal.items
      .filter((i) => i.checked)
      .map((i) => i.name);
    const extra = (this._ingredientReviewModal.extraItem || "").trim();
    if (extra) {
      extra.split(",").forEach((x) => {
        if (x.trim()) selected.push(x.trim());
      });
    }
    this._ingredientReviewModal = null;
    if (selected.length === 0) {
      this._showToast("No extra ingredients needed for the shopping list.");
      this._render();
      return;
    }
    try {
      const res = await this._wsCall({
        type: "mealmind/shopping/add_items",
        items: selected,
      });
      this._updateLocalState(res);
      const count = (res.added_items || []).length;
      this._showToast(`Added ${count} item(s) to your Food shopping list!`);
    } catch (err) {
      this._showToast("Error adding items: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Core Schedule & Printer Actions
  // ---------------------------------------------------------------------------

  async _handlePrint(mission, dateStr = null) {
    this._closeAllMenus();
    this._render();
    try {
      this._showToast("🖨️ Sending print job to receipt printer...");
      const res = await this._wsCall({
        type: "mealmind/printer/print",
        mission,
        date: dateStr,
      });
      if (mission === "next_7_days_cards" && res && typeof res.printed_count === "number") {
        this._showToast(
          res.printed_count > 0
            ? `✅ Printed ${res.printed_count} individual Meal Card(s)!`
            : "ℹ️ No planned meals found in the next 7 days."
        );
      } else {
        this._showToast("✅ Printed successfully!");
      }
    } catch (err) {
      this._showToast("Printer error: " + (err.message || err), true);
    }
  }

  async _handleAutoSchedule() {
    try {
      const startStr = this._addDaysStr(this._todayStr(), Math.max(0, this._dayOffset));
      const res = await this._wsCall({
        type: "mealmind/schedule/auto_schedule",
        start_date: startStr,
        num_days: this._numDaysView,
      });
      this._updateLocalState(res);
      const warnings = (res.action_result && res.action_result.warnings) || [];
      if (warnings.length > 0) {
        this._showToast("⚠️ Auto-scheduled with expiry warning: " + warnings[0], true);
      } else {
        this._showToast("✨ Auto-scheduled meals by shortest ingredient expiry!");
      }
    } catch (err) {
      this._showToast("Auto-schedule error: " + (err.message || err), true);
    }
  }

  async _handlePushDay(dateStr) {
    this._closeAllMenus();
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/push_day",
        date: dateStr,
        days: 1,
      });
      this._updateLocalState(res);
      const warnings = (res.action_result && res.action_result.warnings) || [];
      if (warnings.length > 0) {
        this._showToast("⚠️ Pushed (+1d): " + warnings[0], true);
      } else {
        this._showToast("⏭️ Pushed meal forward (+1 day)");
      }
    } catch (err) {
      this._showToast("Push error: " + (err.message || err), true);
    }
  }

  async _handleSkipDay(dateStr, reason = "Eating Out / Skip") {
    this._closeAllMenus();
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/skip_day",
        date: dateStr,
        skip_reason: reason,
        push_existing: true,
      });
      this._updateLocalState(res);
      const skipped = res.action_result && res.action_result.skipped;
      this._showToast(
        skipped
          ? `🚫 Marked ${this._formatDisplayDate(dateStr)} as skipped`
          : `↩️ Restored ${this._formatDisplayDate(dateStr)}`
      );
    } catch (err) {
      this._showToast("Skip error: " + (err.message || err), true);
    }
  }

  async _handleTogglePin(dateStr) {
    this._closeAllMenus();
    const entry = this._state.schedule[dateStr];
    if (!entry) return;
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/set_day",
        date: dateStr,
        pinned: !entry.pinned,
      });
      this._updateLocalState(res);
      this._showToast(!entry.pinned ? "📌 Pinned meal to this day" : "Unpinned meal");
    } catch (err) {
      this._showToast("Pin error: " + (err.message || err), true);
    }
  }

  async _handleClearDay(dateStr) {
    this._closeAllMenus();
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/clear_day",
        date: dateStr,
      });
      this._updateLocalState(res);
      this._showToast(`Cleared meal on ${this._formatDisplayDate(dateStr)}`);
    } catch (err) {
      this._showToast("Clear error: " + (err.message || err), true);
    }
  }

  async _handleSwapDays(dateA, dateB) {
    this._closeAllMenus();
    if (!dateA || !dateB || dateA === dateB) return;
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/swap_days",
        date_a: dateA,
        date_b: dateB,
      });
      this._swapSourceDate = null;
      this._updateLocalState(res);
      this._showToast(
        `⇄ Swapped ${this._formatDisplayDate(dateA)} with ${this._formatDisplayDate(dateB)}`
      );
    } catch (err) {
      this._showToast("Swap error: " + (err.message || err), true);
    }
  }

  async _handleQuickExpiryChange(dateStr, newExpiry) {
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/set_day",
        date: dateStr,
        shortest_expiry: newExpiry || "",
      });
      this._openExpiryDate = null;
      this._updateLocalState(res);
      this._showToast(newExpiry ? `📅 Expiry set to ${newExpiry}` : "Cleared expiry date");
    } catch (err) {
      this._showToast("Failed to update expiry: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Modern Searchable Day / Meal Assignment Modal
  // ---------------------------------------------------------------------------

  _openDayModal(dateStr = null, forceMode = null) {
    this._closeAllMenus();
    const targetDate = dateStr || this._findNextOpenDateStr();
    const existing = this._state.schedule[targetDate] || {};
    const mealId = existing.meal_id || "";
    const dbMeal = mealId && this._state.meals[mealId] ? this._state.meals[mealId] : {};
    const mealName = existing.meal_name || dbMeal.name || "";
    const ingredients = [...(dbMeal.ingredients || [])];
    const hasMealsInDb = Object.keys(this._state.meals || {}).length > 0;

    const initialMode =
      forceMode || (mealName ? "custom" : hasMealsInDb ? "pick" : "custom");

    this._dayModal = {
      date: targetDate,
      mode: initialMode, // 'pick' | 'custom'
      search: "",
      favOnly: false,
      tagFilter: "",
      meal_id: mealId || null,
      meal_name: mealName,
      ingredients,
      newIngredient: "",
      shortest_expiry: existing.shortest_expiry || "",
      pinned: Boolean(existing.pinned),
      notes: existing.notes || dbMeal.notes || "",
      reviewIngredientsAfterSave: true,
    };
    this._render();
  }

  _selectDbMealInDayModal(meal) {
    if (!this._dayModal || !meal) return;
    this._dayModal.meal_id = meal.id;
    this._dayModal.meal_name = meal.name;
    this._dayModal.ingredients = [...(meal.ingredients || [])];
    this._dayModal.notes = meal.notes || "";
    this._dayModal.mode = "custom";
    this._render();
  }

  async _quickAssignFromPicker(meal) {
    if (!this._dayModal || !meal) return;
    const dateStr = this._dayModal.date;
    const expiry = this._dayModal.shortest_expiry || null;
    const askShop = this._dayModal.reviewIngredientsAfterSave;
    this._dayModal = null;
    await this._quickScheduleMeal(
      { ...meal, shortest_expiry: expiry },
      dateStr,
      askShop
    );
  }

  async _saveDayModal() {
    if (!this._dayModal) return;
    const m = this._dayModal;
    if (!m.meal_name.trim()) {
      this._showToast("Please select a meal or enter a meal name.", true);
      return;
    }
    const pendingIng = (m.newIngredient || "").trim();
    if (pendingIng) {
      pendingIng.split(",").forEach((i) => {
        if (i.trim() && !m.ingredients.includes(i.trim())) m.ingredients.push(i.trim());
      });
    }

    const askShop = m.reviewIngredientsAfterSave && m.ingredients.length > 0;
    const mealNameCopy = m.meal_name.trim();
    const ingredientsCopy = [...m.ingredients];

    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/set_day",
        date: m.date,
        meal_id: m.meal_id || null,
        meal_name: mealNameCopy,
        ingredients: ingredientsCopy,
        shortest_expiry: m.shortest_expiry || null,
        pinned: m.pinned,
        notes: m.notes,
      });
      this._dayModal = null;
      this._updateLocalState(res);
      this._showToast(`Scheduled '${mealNameCopy}' on ${this._formatDisplayDate(m.date)}`);
      if (askShop) {
        this._openIngredientReviewModal(mealNameCopy, ingredientsCopy);
      }
    } catch (err) {
      this._showToast("Error saving day: " + (err.message || err), true);
    }
  }

  _findNextOpenDateStr() {
    const today = this._todayStr();
    for (let i = 0; i < 45; i++) {
      const dStr = this._addDaysStr(today, i);
      const slot = this._state.schedule[dStr];
      if (!slot || (!slot.meal_id && !slot.meal_name && !slot.skipped)) {
        return dStr;
      }
    }
    return today;
  }

  async _quickScheduleMeal(mealObj, targetDateStr = null, askShop = true) {
    this._closeAllMenus();
    const dateStr = targetDateStr || this._findNextOpenDateStr();
    try {
      let mealId = mealObj.id || mealObj.meal_id || null;
      const ingredients = mealObj.ingredients || [];
      if (!mealId) {
        const savedRes = await this._wsCall({
          type: "mealmind/meals/save",
          meal: {
            name: mealObj.name,
            ingredients,
            tags: mealObj.tags || [],
            notes: mealObj.notes || "",
            favourite: Boolean(mealObj.favourite),
          },
        });
        this._updateLocalState(savedRes);
        if (savedRes.saved_meal) mealId = savedRes.saved_meal.id;
      }

      const res = await this._wsCall({
        type: "mealmind/schedule/set_day",
        date: dateStr,
        meal_id: mealId,
        meal_name: mealObj.name,
        ingredients,
        shortest_expiry: mealObj.shortest_expiry || null,
        notes: mealObj.notes || "",
      });
      this._updateLocalState(res);
      this._showToast(`📅 Scheduled '${mealObj.name}' for ${this._formatDisplayDate(dateStr)}`);
      if (askShop && ingredients.length > 0) {
        this._openIngredientReviewModal(mealObj.name, ingredients);
      }
    } catch (err) {
      this._showToast("Failed to schedule meal: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Meal Database Modal & Actions
  // ---------------------------------------------------------------------------

  _openMealModal(meal = null) {
    this._closeAllMenus();
    if (meal) {
      this._mealModal = {
        id: meal.id,
        name: meal.name || "",
        ingredients: [...(meal.ingredients || [])],
        newIngredient: "",
        tags: [...(meal.tags || [])],
        newTag: "",
        notes: meal.notes || "",
        favourite: Boolean(meal.favourite),
      };
    } else {
      this._mealModal = {
        id: null,
        name: "",
        ingredients: [],
        newIngredient: "",
        tags: [],
        newTag: "",
        notes: "",
        favourite: false,
      };
    }
    this._render();
  }

  async _saveMealModal() {
    if (!this._mealModal) return;
    const m = this._mealModal;
    if (!m.name.trim()) {
      this._showToast("Meal name is required", true);
      return;
    }
    if (m.newIngredient && m.newIngredient.trim()) {
      m.newIngredient.split(",").forEach((x) => {
        if (x.trim() && !m.ingredients.includes(x.trim())) m.ingredients.push(x.trim());
      });
    }
    if (m.newTag && m.newTag.trim()) {
      m.newTag.split(",").forEach((x) => {
        if (x.trim() && !m.tags.includes(x.trim())) m.tags.push(x.trim());
      });
    }

    try {
      const res = await this._wsCall({
        type: "mealmind/meals/save",
        meal: {
          id: m.id,
          name: m.name.trim(),
          ingredients: m.ingredients,
          tags: m.tags,
          notes: m.notes,
          favourite: m.favourite,
        },
      });
      this._mealModal = null;
      this._updateLocalState(res);
      this._showToast(`Saved '${m.name.trim()}' to Meal Database!`);
    } catch (err) {
      this._showToast("Failed to save meal: " + (err.message || err), true);
    }
  }

  async _toggleMealFavourite(meal) {
    this._closeAllMenus();
    try {
      const res = await this._wsCall({
        type: "mealmind/meals/save",
        meal: {
          ...meal,
          favourite: !meal.favourite,
        },
      });
      this._updateLocalState(res);
    } catch (err) {
      this._showToast("Error updating favourite: " + (err.message || err), true);
    }
  }

  async _deleteMeal(mealId) {
    this._closeAllMenus();
    try {
      const res = await this._wsCall({
        type: "mealmind/meals/delete",
        meal_id: mealId,
      });
      this._updateLocalState(res);
      this._showToast("Deleted meal from database.");
    } catch (err) {
      this._showToast("Error deleting meal: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // AI Suggestions & Receipt Scanning
  // ---------------------------------------------------------------------------

  async _runAiSuggest() {
    this._aiLoading = true;
    this._render();
    try {
      const res = await this._wsCall({
        type: "mealmind/ai/suggest",
        guest_mode: this._aiGuestMode,
        guest_notes: this._aiGuestNotes,
        extra_prompt: this._aiExtraPrompt,
      });
      this._aiResults = res.suggestions || { db_suggestions: [], ai_suggestions: [] };
      this._aiLoading = false;
      this._render();
    } catch (err) {
      this._aiLoading = false;
      this._showToast("AI suggestion failed: " + (err.message || err), true);
    }
  }

  _compressImageFile(file, maxDim = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read image file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () =>
          resolve({ dataUrl: reader.result, mimeType: file.type || "image/jpeg" });
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve({ dataUrl, mimeType: "image/jpeg" });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async _handleReceiptFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    this._scanLoading = true;
    this._render();

    try {
      const { dataUrl, mimeType } = await this._compressImageFile(file);
      const res = await this._wsCall({
        type: "mealmind/receipt/scan",
        image_base64: dataUrl,
        mime_type: mimeType,
        auto_complete: true,
      });
      this._scanLoading = false;
      this._scanSummary = {
        ...(res.scan_result || {}),
        completed_summaries: res.completed_summaries || [],
      };
      this._postScanModal = true;
      this._updateLocalState(res);
      this._showToast(
        `✅ Checked off ${(res.completed_summaries || []).length} crossed-out/ticked item(s)!`
      );
    } catch (err) {
      this._scanLoading = false;
      this._showToast("Receipt photo scan failed: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Shopping List Actions (Explicit Checkbox + Undo) & Pop-Out Window
  // ---------------------------------------------------------------------------

  async _completeShoppingItem(uidOrSummary, summaryText, listType = "food") {
    const cleanSummary = (summaryText || uidOrSummary || "").trim();
    const lt = listType || "food";
    try {
      const res = await this._wsCall({
        type: "mealmind/shopping/complete_items",
        items: [uidOrSummary],
        list_type: lt,
      });
      if (cleanSummary) {
        this._recentlyCompleted = [
          { summary: cleanSummary, listType: lt, id: Date.now() + Math.random() },
          ...this._recentlyCompleted.filter(
            (x) => !(x.summary.toLowerCase() === cleanSummary.toLowerCase() && x.listType === lt)
          ),
        ].slice(0, 15);
      }
      this._updateLocalState(res);
      this._showToast(`✓ Ticked off '${cleanSummary}'`, false, {
        label: "↩️ Undo",
        summary: cleanSummary,
        listType: lt,
      });
    } catch (err) {
      this._showToast("Failed to tick off item: " + (err.message || err), true);
    }
  }

  async _undoCompletedShoppingItem(summaryText, listType = "food") {
    if (!summaryText) return;
    try {
      this._recentlyCompleted = this._recentlyCompleted.filter(
        (x) => !(x.summary.toLowerCase() === summaryText.toLowerCase() && x.listType === listType)
      );
      const res = await this._wsCall({
        type: "mealmind/shopping/add_items",
        items: [summaryText],
        list_type: listType || "food",
      });
      this._toast = null;
      this._updateLocalState(res);
      this._showToast(`↩️ Restored '${summaryText}' back to your list`);
    } catch (err) {
      this._showToast("Failed to undo item: " + (err.message || err), true);
    }
  }

  async _addSingleShoppingItem(itemText, listType = "food") {
    if (!itemText || !itemText.trim()) return;
    try {
      const res = await this._wsCall({
        type: "mealmind/shopping/add_items",
        items: [itemText.trim()],
        list_type: listType || "food",
      });
      this._updateLocalState(res);
      this._showToast(
        `Added '${itemText.trim()}' to ${listType === "non_food" ? "Non-Food" : "Food"} list!`
      );
    } catch (err) {
      this._showToast("Failed to add item: " + (err.message || err), true);
    }
  }

  _openCompanionPopup() {
    this._closeAllMenus();
    window.open(
      "/mealmind?companion=1",
      "MealMindOnlineShop",
      "width=440,height=860,resizable=yes,scrollbars=yes"
    );
  }

  // ---------------------------------------------------------------------------
  // UI Section Renderers
  // ---------------------------------------------------------------------------

  _renderUpcomingMealsManager(inModal = false) {
    const today = this._todayStr();
    const upcoming = [];
    for (let i = 0; i < 10; i++) {
      const dStr = this._addDaysStr(today, i);
      const slot = this._state.schedule[dStr];
      if (slot && !slot.skipped && (slot.meal_id || slot.meal_name)) {
        upcoming.push({ date: dStr, ...slot });
      }
    }

    return `
      <div class="${inModal ? "" : "surface-card"}">
        <div class="section-header" style="margin-bottom: 14px;">
          <div>
            <h3 class="section-title">📅 Planned Meals & Expiry Unpack</h3>
            <p class="section-subtitle">
              Unpacking your shop? Set shortest ingredient expiry dates or add inspired meals.
            </p>
          </div>
          <div class="action-cluster">
            <button class="btn btn-emerald btn-sm quick-open-picker-btn">
              ＋ Saved Meal
            </button>
            <button class="btn btn-secondary btn-sm quick-open-custom-btn">
              ✍️ Custom Meal
            </button>
            <button class="btn btn-violet btn-sm quick-auto-schedule-btn">
              ⚡ Auto-Sort by Expiry
            </button>
          </div>
        </div>

        ${
          upcoming.length === 0
            ? `<div class="empty-state">
                <div class="empty-icon">🍽️</div>
                <div>No meals planned for the next 10 days yet.</div>
              </div>`
            : `<div class="stack-list">
                ${upcoming
                  .map((item) => {
                    const badge = this._getExpiryBadge(item.date, item.shortest_expiry);
                    return `
                      <div class="list-item-card">
                        <div class="list-item-main">
                          <div class="day-eyebrow">${this._escapeHtml(this._formatDisplayDate(item.date))}</div>
                          <div class="list-item-title">${this._escapeHtml(item.meal_name)}</div>
                          ${badge ? `<div style="margin-top:4px;"><span class="badge ${badge.cls}">${this._escapeHtml(badge.text)}</span></div>` : ""}
                        </div>
                        <div class="expiry-controls">
                          <div class="expiry-quick-pills">
                            <button class="chip-btn exp-shortcut-btn" data-date="${item.date}" data-days="1">+1d</button>
                            <button class="chip-btn exp-shortcut-btn" data-date="${item.date}" data-days="2">+2d</button>
                            <button class="chip-btn exp-shortcut-btn" data-date="${item.date}" data-days="4">+4d</button>
                          </div>
                          <input type="date" class="input input-date quick-exp-input" data-date="${item.date}" value="${item.shortest_expiry || ""}" title="Shortest ingredient expiry date" />
                          <button class="icon-btn icon-btn-danger quick-remove-day-btn" data-date="${item.date}" title="Remove meal">✕</button>
                        </div>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
        }
      </div>
    `;
  }

  _renderCalendarTab() {
    const today = this._todayStr();
    const startStr = this._addDaysStr(today, this._dayOffset);
    const endStr = this._addDaysStr(startStr, this._numDaysView - 1);

    const daysHtml = [];
    for (let i = 0; i < this._numDaysView; i++) {
      const dStr = this._addDaysStr(startStr, i);
      const slot = this._state.schedule[dStr] || {};
      const mealId = slot.meal_id;
      const dbMeal = mealId && this._state.meals[mealId] ? this._state.meals[mealId] : null;
      const mealName = slot.meal_name || (dbMeal ? dbMeal.name : "");
      const isSkipped = Boolean(slot.skipped);
      const isPinned = Boolean(slot.pinned);
      const isFav = Boolean(dbMeal && dbMeal.favourite);
      const ingredients =
        slot.ingredients && slot.ingredients.length > 0
          ? slot.ingredients
          : dbMeal
          ? dbMeal.ingredients || []
          : [];
      const badge = this._getExpiryBadge(dStr, slot.shortest_expiry);
      const isSwapSelected = this._swapSourceDate === dStr;
      const isSwapTarget = Boolean(this._swapSourceDate && this._swapSourceDate !== dStr);
      const isMenuOpen = this._openCardMenuDate === dStr;
      const isExpiryOpen = this._openExpiryDate === dStr;

      const stripeClass = isSkipped
        ? ""
        : mealName
        ? badge
          ? badge.stripe
          : isPinned
          ? "stripe-pin"
          : "stripe-planned"
        : "";

      daysHtml.push(`
        <div class="day-card ${dStr === today ? "day-today" : ""} ${!mealName && !isSkipped ? "day-unplanned" : ""} ${isSkipped ? "day-skipped" : ""} ${stripeClass} ${isSwapSelected ? "day-swap-source" : ""} ${isSwapTarget ? "day-swap-target" : ""}"
             draggable="true"
             data-date="${dStr}">
          <div class="day-card-top">
            <div class="day-date-group">
              <span class="day-date-label ${dStr === today ? "today-highlight" : ""}">
                ${this._escapeHtml(this._formatDisplayDate(dStr))}
              </span>
              ${isPinned ? `<span class="badge badge-pin" title="Pinned to this day">📌</span>` : ""}
              ${
                mealName && !isSkipped
                  ? badge
                    ? `<button class="badge-interactive ${badge.cls} toggle-exp-popover-btn" data-date="${dStr}" title="Tap to change shortest ingredient expiry date">
                        ${this._escapeHtml(badge.text)} ▾
                      </button>`
                    : `<button class="badge-interactive badge-subtle toggle-exp-popover-btn" data-date="${dStr}" title="Tap to set shortest ingredient expiry date">
                        📅 Set Expiry
                      </button>`
                  : ""
              }
            </div>

            <div class="card-top-right">
              ${
                isSwapTarget
                  ? `<button class="btn btn-violet btn-xs swap-target-btn" data-date="${dStr}">⇄ Swap Here</button>`
                  : ""
              }
              <div class="menu-anchor">
                <button class="kebab-btn card-menu-toggle-btn" data-date="${dStr}" title="More options">⋯</button>
                ${
                  isMenuOpen
                    ? `
                      <div class="pop-menu">
                        ${
                          mealName && !isSkipped
                            ? `
                              <button class="pop-menu-item edit-day-btn" data-date="${dStr}">
                                <span>✎</span> Change / Edit Meal
                              </button>
                              <button class="pop-menu-item toggle-exp-popover-btn" data-date="${dStr}">
                                <span>📅</span> Set Expiry Date
                              </button>
                              <button class="pop-menu-item swap-start-btn" data-date="${dStr}">
                                <span>⇄</span> ${isSwapSelected ? "Cancel Swap" : "Swap with Another Day"}
                              </button>
                              <button class="pop-menu-item pin-day-btn" data-date="${dStr}">
                                <span>📌</span> ${isPinned ? "Unpin Meal" : "Pin Meal to This Day"}
                              </button>
                              <button class="pop-menu-item print-day-card-btn" data-date="${dStr}">
                                <span>🖨️</span> Print This Day's Meal Card
                              </button>
                              <div class="pop-menu-divider"></div>
                              <button class="pop-menu-item skip-day-btn" data-date="${dStr}">
                                <span>🚫</span> Skip Day & Push Meal
                              </button>
                              <button class="pop-menu-item pop-menu-danger clear-day-btn" data-date="${dStr}">
                                <span>🗑️</span> Clear Meal
                              </button>
                            `
                            : isSkipped
                            ? `
                              <button class="pop-menu-item skip-day-btn" data-date="${dStr}">
                                <span>↩️</span> Restore Day
                              </button>
                            `
                            : `
                              <button class="pop-menu-item edit-day-btn" data-date="${dStr}">
                                <span>＋</span> Plan a Meal
                              </button>
                              <button class="pop-menu-item skip-day-btn" data-date="${dStr}">
                                <span>🚫</span> Mark Day as Skipped / Eating Out
                              </button>
                            `
                        }
                      </div>
                    `
                    : ""
                }
              </div>
            </div>
          </div>

          ${
            isExpiryOpen && mealName && !isSkipped
              ? `
                <div class="inline-expiry-drawer">
                  <div class="expiry-drawer-header">
                    <span>Shortest Ingredient Expiry:</span>
                    <button class="chip-btn exp-clear-btn" data-date="${dStr}">Clear</button>
                  </div>
                  <div class="expiry-drawer-controls">
                    <div class="expiry-quick-pills">
                      <button class="chip-btn exp-shortcut-btn" data-date="${dStr}" data-days="1">+1d</button>
                      <button class="chip-btn exp-shortcut-btn" data-date="${dStr}" data-days="2">+2d</button>
                      <button class="chip-btn exp-shortcut-btn" data-date="${dStr}" data-days="4">+4d</button>
                    </div>
                    <input type="date" class="input input-date quick-exp-input" data-date="${dStr}" value="${slot.shortest_expiry || ""}" />
                  </div>
                </div>
              `
              : ""
          }

          <div class="day-card-content">
            ${
              isSkipped
                ? `
                  <div class="skipped-box">
                    <span>🚫 ${this._escapeHtml(slot.skip_reason || "Skipped / Eating Out")}</span>
                    <button class="btn btn-secondary btn-xs skip-day-btn" data-date="${dStr}">↩️ Restore</button>
                  </div>
                `
                : mealName
                ? `
                  <div class="meal-headline edit-day-btn" data-date="${dStr}" title="Tap to change or edit meal">
                    <div class="meal-name-text">
                      ${isFav ? `<span class="fav-star-inline">★</span>` : ""}
                      ${this._escapeHtml(mealName)}
                    </div>
                  </div>

                  ${
                    ingredients.length > 0
                      ? `<div class="pill-row" style="margin-top: 6px;">
                          ${ingredients
                            .slice(0, 5)
                            .map((ing) => `<span class="pill">${this._escapeHtml(ing)}</span>`)
                            .join("")}
                          ${
                            ingredients.length > 5
                              ? `<span class="pill pill-muted">+${ingredients.length - 5} more</span>`
                              : ""
                          }
                        </div>`
                      : ""
                  }

                  <div class="day-card-footer">
                    <button class="btn-chip btn-chip-amber push-day-btn" data-date="${dStr}" title="Push meal forward +1 day">
                      ⏭️ Push +1d
                    </button>
                    <button class="btn-chip btn-chip-emerald shop-day-btn" data-date="${dStr}" title="Check & add ingredients to shopping list">
                      🛒 Ingredients
                    </button>
                  </div>
                `
                : `
                  <div class="empty-day-slot">
                    <button class="btn-assign-meal edit-day-btn" data-date="${dStr}">
                      <span>＋</span> Plan Meal
                    </button>
                  </div>
                `
            }
          </div>
        </div>
      `);
    }

    const queue = this._state.queue || [];

    return `
      ${
        this._swapSourceDate
          ? `
            <div class="swap-banner">
              <div>
                <strong>⇄ Swap Mode Active:</strong> Tap <strong>⇄ Swap Here</strong> on any day card to swap with <strong>${this._escapeHtml(this._formatDisplayDate(this._swapSourceDate))}</strong>
              </div>
              <button class="btn btn-secondary btn-sm" id="cancel-swap-btn">✕ Cancel Swap</button>
            </div>
          `
          : ""
      }

      <div class="command-bar">
        <div class="nav-cluster">
          <button class="btn btn-secondary btn-sm" id="cal-prev-week">◀ Prev 7d</button>
          <button class="btn btn-secondary btn-sm" id="cal-today">Today</button>
          <button class="btn btn-secondary btn-sm" id="cal-next-week">Next 7d ▶</button>
          <span class="date-range-title">
            ${this._escapeHtml(this._formatDisplayDate(startStr))} – ${this._escapeHtml(this._formatDisplayDate(endStr))}
          </span>
        </div>
        <div class="action-cluster">
          <button class="btn btn-violet" id="auto-schedule-btn">
            ⚡ Auto-Sort by Expiry
          </button>
        </div>
      </div>

      ${
        queue.length > 0
          ? `
            <div class="surface-card queue-banner">
              <div class="section-header">
                <div>
                  <h4 style="margin:0; font-size:15px;">🧺 Unscheduled Meal Queue (${queue.length})</h4>
                  <p class="section-subtitle">Tap "⚡ Auto-Sort by Expiry" to slot these into open days automatically.</p>
                </div>
              </div>
              <div class="pill-row" style="margin-top:10px;">
                ${queue
                  .map(
                    (q) => `
                    <span class="pill pill-lg">
                      ${this._escapeHtml(q.meal_name)}
                      ${q.shortest_expiry ? ` • Exp ${this._escapeHtml(q.shortest_expiry)}` : ""}
                      <button class="pill-del queue-del-btn" data-qid="${q.queue_id}">✕</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>
            </div>
          `
          : ""
      }

      <div class="calendar-grid">
        ${daysHtml.join("")}
      </div>
    `;
  }

  _renderDatabaseTab() {
    const meals = Object.values(this._state.meals || {});
    const search = (this._dbSearch || "").trim().toLowerCase();

    const allTags = new Set();
    meals.forEach((m) => (m.tags || []).forEach((t) => allTags.add(t)));

    const filtered = meals
      .filter((m) => {
        if (this._dbFavOnly && !m.favourite) return false;
        if (this._dbTagFilter && !(m.tags || []).includes(this._dbTagFilter)) return false;
        if (search) {
          const inName = (m.name || "").toLowerCase().includes(search);
          const inIng = (m.ingredients || []).some((i) => i.toLowerCase().includes(search));
          const inTag = (m.tags || []).some((t) => t.toLowerCase().includes(search));
          return inName || inIng || inTag;
        }
        return true;
      })
      .sort((a, b) => {
        if (Boolean(b.favourite) !== Boolean(a.favourite)) return b.favourite ? 1 : -1;
        return (a.name || "").localeCompare(b.name || "");
      });

    return `
      <div class="command-bar">
        <div class="search-filter-bar">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="db-search-input" class="input input-search" placeholder="Search saved meals, ingredients, or tags..." value="${this._escapeHtml(this._dbSearch)}" />
          </div>
          <button class="filter-chip ${this._dbFavOnly ? "active" : ""}" id="db-fav-toggle">
            ★ Favourites
          </button>
          ${Array.from(allTags)
            .sort()
            .map(
              (t) => `
              <button class="filter-chip db-tag-chip ${this._dbTagFilter === t ? "active" : ""}" data-tag="${this._escapeHtml(t)}">
                #${this._escapeHtml(t)}
              </button>
            `
            )
            .join("")}
        </div>
        <button class="btn btn-emerald" id="new-db-meal-btn">＋ New Saved Meal</button>
      </div>

      <div class="db-grid">
        ${
          filtered.length === 0
            ? `<div class="empty-state" style="grid-column: 1 / -1;">
                <div class="empty-icon">🍲</div>
                <div>No saved meals match your filter.</div>
                <button class="btn btn-emerald" id="empty-new-db-meal-btn" style="margin-top:10px;">＋ Add Your First Meal</button>
              </div>`
            : filtered
                .map((m) => {
                  const isDbMenuOpen = this._openDbMenuId === m.id;
                  return `
                  <div class="surface-card db-meal-card">
                    <div class="db-card-header">
                      <div style="display:flex; align-items:center; gap:8px;">
                        <button class="star-toggle db-star-btn ${m.favourite ? "active" : ""}" data-id="${this._escapeHtml(m.id)}" title="Toggle Favourite">
                          ${m.favourite ? "★" : "☆"}
                        </button>
                        <h4 class="db-meal-title">${this._escapeHtml(m.name)}</h4>
                      </div>
                      <div class="menu-anchor">
                        <button class="kebab-btn db-menu-toggle-btn" data-id="${this._escapeHtml(m.id)}" title="Meal options">⋯</button>
                        ${
                          isDbMenuOpen
                            ? `
                              <div class="pop-menu">
                                <button class="pop-menu-item db-shop-btn" data-id="${this._escapeHtml(m.id)}">
                                  <span>🛒</span> Check Ingredients for Shop
                                </button>
                                <button class="pop-menu-item db-edit-btn" data-id="${this._escapeHtml(m.id)}">
                                  <span>✎</span> Edit Meal Details
                                </button>
                                <button class="pop-menu-item db-star-btn" data-id="${this._escapeHtml(m.id)}">
                                  <span>★</span> ${m.favourite ? "Remove from Favourites" : "Mark as Favourite"}
                                </button>
                                <div class="pop-menu-divider"></div>
                                <button class="pop-menu-item pop-menu-danger db-del-btn" data-id="${this._escapeHtml(m.id)}">
                                  <span>🗑️</span> Delete Saved Meal
                                </button>
                              </div>
                            `
                            : ""
                        }
                      </div>
                    </div>

                    ${
                      (m.tags || []).length > 0
                        ? `<div class="pill-row" style="margin-top:8px;">
                            ${m.tags.map((t) => `<span class="pill pill-tag">#${this._escapeHtml(t)}</span>`).join("")}
                          </div>`
                        : ""
                    }

                    <div class="pill-row" style="margin-top:10px; flex:1;">
                      ${
                        (m.ingredients || []).length > 0
                          ? m.ingredients.map((ing) => `<span class="pill">${this._escapeHtml(ing)}</span>`).join("")
                          : `<span class="section-subtitle">No ingredients tagged</span>`
                      }
                    </div>

                    ${m.notes ? `<div class="meal-notes">${this._escapeHtml(m.notes)}</div>` : ""}

                    <div class="db-card-actions">
                      <button class="btn btn-emerald btn-block db-plan-next-btn" data-id="${this._escapeHtml(m.id)}">
                        📅 Plan Next Open Day
                      </button>
                      <button class="btn btn-secondary db-pick-day-btn" data-id="${this._escapeHtml(m.id)}" title="Choose specific date">
                        📆 Pick Date
                      </button>
                    </div>
                  </div>
                `;
                })
                .join("")
        }
      </div>
    `;
  }

  _renderAiTab() {
    const s = this._state.settings || {};
    const dislikesStr = Array.isArray(s.dislikes) ? s.dislikes.join(", ") : s.dislikes || "";

    return `
      <div class="surface-card">
        <div class="section-header">
          <div>
            <h3 class="section-title">✨ AI Chef & Meal Suggester</h3>
            <p class="section-subtitle">
              Suggests both your <strong>★ Saved Database Favourites</strong> and <strong>Fresh Gemini Recipes</strong> matched to your current shopping list.
            </p>
          </div>
          <div class="badge-row">
            <span class="badge badge-ok">🥗 ${this._escapeHtml(s.dietary_profile || "Vegetarian")}</span>
            ${dislikesStr ? `<span class="badge badge-warn">🚫 No ${this._escapeHtml(dislikesStr)}</span>` : ""}
            <span class="badge badge-pin">🛒 ${(this._state.shopping_list || []).length} food items</span>
          </div>
        </div>

        <div class="guest-override-card ${this._aiGuestMode ? "active" : ""}" style="margin-top: 14px;">
          <label class="toggle-row">
            <input type="checkbox" class="modern-checkbox" id="ai-guest-toggle" ${this._aiGuestMode ? "checked" : ""} />
            <div>
              <div style="font-weight:700; font-size:15px;">🎉 "We Have Guests" / Special Occasion Mode</div>
              <div class="section-subtitle">Temporarily customize or override your default dietary/dislike rules for a special meal</div>
            </div>
          </label>
          ${
            this._aiGuestMode
              ? `
                <div style="margin-top:12px;">
                  <input type="text" id="ai-guest-notes" class="input" style="width:100%;"
                         placeholder="e.g. Cooking for 4 guests, impressive sharing dinner, allow feta/halloumi for guests..."
                         value="${this._escapeHtml(this._aiGuestNotes)}" />
                </div>
              `
              : ""
          }
        </div>

        <div class="ai-prompt-row">
          <input type="text" id="ai-extra-prompt" class="input" style="flex:1;"
                 placeholder="Any cravings or notes? (e.g. 'under 25 mins', 'cosy autumn dinner', 'use up mushrooms')..."
                 value="${this._escapeHtml(this._aiExtraPrompt)}" />
          <button class="btn btn-violet btn-lg" id="run-ai-suggest-btn" ${this._aiLoading ? "disabled" : ""}>
            ${this._aiLoading ? "⏳ Asking Gemini..." : "✨ Get Meal Ideas"}
          </button>
        </div>
      </div>

      ${
        this._aiResults
          ? `
            <div style="margin-top:20px;">
              <h3 class="section-title" style="margin-bottom:12px;">★ Best Matches From Your Saved Meals & Favourites</h3>
              <div class="db-grid">
                ${
                  (this._aiResults.db_suggestions || []).length === 0
                    ? `<div class="empty-state">No specific saved database matches returned.</div>`
                    : (this._aiResults.db_suggestions || [])
                        .map(
                          (item, idx) => `
                          <div class="surface-card db-meal-card">
                            <div class="db-card-header">
                              <h4 class="db-meal-title">
                                ${item.favourite ? `<span class="fav-star-inline">★</span> ` : ""}
                                ${this._escapeHtml(item.name)}
                              </h4>
                            </div>
                            <div class="ai-reason-box">💡 ${this._escapeHtml(item.reason || "")}</div>
                            <div class="pill-row" style="margin-top:10px; flex:1;">
                              ${(item.ingredients || []).map((i) => `<span class="pill">${this._escapeHtml(i)}</span>`).join("")}
                            </div>
                            <div class="db-card-actions">
                              <button class="btn btn-emerald btn-block ai-plan-db-btn" data-idx="${idx}">
                                📅 Plan & Check Ingredients
                              </button>
                            </div>
                          </div>
                        `
                        )
                        .join("")
                }
              </div>

              <h3 class="section-title" style="margin: 24px 0 12px;">🆕 Fresh Gemini Recipe Ideas</h3>
              <div class="db-grid">
                ${(this._aiResults.ai_suggestions || [])
                  .map(
                    (item, idx) => `
                    <div class="surface-card db-meal-card">
                      <div class="db-card-header">
                        <h4 class="db-meal-title">${this._escapeHtml(item.name)}</h4>
                      </div>
                      <div class="ai-reason-box">💡 ${this._escapeHtml(item.reason || "")}</div>
                      ${item.notes ? `<div class="meal-notes">${this._escapeHtml(item.notes)}</div>` : ""}
                      <div class="pill-row" style="margin-top:10px; flex:1;">
                        ${(item.ingredients || []).map((i) => `<span class="pill">${this._escapeHtml(i)}</span>`).join("")}
                      </div>
                      <div class="db-card-actions">
                        <button class="btn btn-emerald btn-block ai-plan-new-btn" data-idx="${idx}">
                          📅 Plan & Save
                        </button>
                        <button class="btn btn-secondary ai-save-only-btn" data-idx="${idx}">
                          💾 Save Only
                        </button>
                      </div>
                    </div>
                  `
                  )
                  .join("")}
              </div>
            </div>
          `
          : ""
      }
    `;
  }

  _renderShoppingItemRow(item, listType = "food", showCategoryBadge = false) {
    const lt = item.list_type || listType || "food";
    // IMPORTANT: Not wrapped in <label>! Only clicking the explicit .shop-check-btn completes the item.
    return `
      <div class="shop-item-row">
        <div class="shop-item-main">
          <button type="button"
                  class="shop-check-btn"
                  data-uid="${this._escapeHtml(item.uid || item.summary)}"
                  data-summary="${this._escapeHtml(item.summary)}"
                  data-list-type="${this._escapeHtml(lt)}"
                  title="Tick off item">
            <span class="shop-check-circle">✓</span>
          </button>
          <div class="shop-item-text">
            <div class="shop-item-name">
              ${this._escapeHtml(item.summary)}
              ${
                showCategoryBadge
                  ? lt === "non_food"
                    ? `<span class="badge badge-warn" style="margin-left:6px; font-size:11px;">🧻 Non-Food</span>`
                    : `<span class="badge badge-ok" style="margin-left:6px; font-size:11px;">🍎 Food</span>`
                  : ""
              }
            </div>
            ${
              (item.for_meals || []).length > 0
                ? `<div class="shop-item-meals">🍲 For: ${this._escapeHtml(item.for_meals.join(", "))}</div>`
                : ""
            }
          </div>
        </div>
        <button class="icon-btn copy-shop-btn" data-text="${this._escapeHtml(item.summary)}" title="Copy item name for online supermarket search">
          📋
        </button>
      </div>
    `;
  }

  _renderShoppingAndScanTab() {
    const foodItems = this._state.shopping_list || [];
    const nonFoodItems = this._state.non_food_shopping_list || [];
    const totalShopCount = foodItems.length + nonFoodItems.length;

    const today = this._todayStr();
    let upcomingCount = 0;
    for (let i = 0; i < 10; i++) {
      const slot = this._state.schedule[this._addDaysStr(today, i)];
      if (slot && !slot.skipped && (slot.meal_id || slot.meal_name)) upcomingCount++;
    }

    const cat = this._shopListCategory || "food";

    return `
      <!-- Single Unified Shopping Toolbar: Category Pills on Left + Primary Actions & ⋯ on Right -->
      <div class="shop-unified-toolbar">
        <div class="shop-category-pills">
          <button class="cat-pill cat-pill-food shop-cat-btn ${cat === "food" ? "active" : ""}" data-cat="food">
            🍎 Food <span class="cat-count">${foodItems.length}</span>
          </button>
          <button class="cat-pill cat-pill-nf shop-cat-btn ${cat === "non_food" ? "active" : ""}" data-cat="non_food">
            🧻 Non-Food <span class="cat-count">${nonFoodItems.length}</span>
          </button>
          <button class="cat-pill cat-pill-both shop-cat-btn ${cat === "both" ? "active" : ""}" data-cat="both">
            📋 All <span class="cat-count">${totalShopCount}</span>
          </button>
        </div>

        <div class="shop-toolbar-actions">
          <label class="btn btn-violet upload-hero-btn" title="Take a photo of your marked paper list to auto-complete items">
            <input type="file" accept="image/*" capture="environment" id="receipt-file-input" style="display:none;" />
            <span>${this._scanLoading ? "⏳ Scanning..." : "📷 Scan List"}</span>
          </label>

          <button class="btn btn-secondary" id="open-unpack-modal-btn" title="Set shortest expiry dates or plan meals while unpacking">
            📅 Unpack / Expiry (${upcomingCount})
          </button>

          <div class="menu-anchor">
            <button class="kebab-btn" id="shop-more-menu-btn" title="More shopping & meal actions">⋯</button>
            ${
              this._shopMoreMenuOpen
                ? `
                  <div class="pop-menu">
                    <button class="pop-menu-item" id="print-shop-btn">
                      <span>🖨️</span> Print Paper Shopping List
                    </button>
                    <button class="pop-menu-item" id="hero-add-saved-meal-btn">
                      <span>📚</span> Plan a Saved Meal
                    </button>
                    <button class="pop-menu-item" id="hero-add-custom-meal-btn">
                      <span>✨</span> Add New Inspired Meal
                    </button>
                    ${
                      this._scanSummary
                        ? `
                          <button class="pop-menu-item" id="reopen-scan-modal-btn">
                            <span>📸</span> View Last Receipt Scan Summary
                          </button>
                        `
                        : ""
                    }
                    ${
                      !this._isCompanion
                        ? `
                          <div class="pop-menu-divider"></div>
                          <button class="pop-menu-item" id="popout-companion-btn">
                            <span>🪟</span> Pop Out Companion Window
                          </button>
                        `
                        : ""
                    }
                  </div>
                `
                : ""
            }
          </div>
        </div>
      </div>

      <!-- Main Shopping Card -->
      <div class="surface-card">
        <!-- Quick Add Bar -->
        <div class="quick-input-bar" style="flex-wrap:wrap; margin-bottom: 14px;">
          <input type="text" id="quick-shop-item-input" class="input" style="flex:1; min-width:200px;"
                 placeholder="${
                   cat === "non_food"
                     ? "Add non-food item (e.g. Toothpaste, Kitchen Roll, Bin Bags)..."
                     : cat === "food"
                     ? "Add food item (e.g. Oat Milk, Courgettes, Halloumi)..."
                     : "Type an item to add to Food or Non-Food..."
                 }" />
          ${
            cat === "both"
              ? `
                <button class="btn btn-emerald" id="quick-shop-add-food-btn">＋ 🍎 Food</button>
                <button class="btn btn-amber" id="quick-shop-add-nf-btn">＋ 🧻 Non-Food</button>
              `
              : `
                <button class="btn ${cat === "non_food" ? "btn-amber" : "btn-emerald"}" id="quick-shop-item-btn">
                  ＋ Add ${cat === "non_food" ? "Non-Food" : "Food"}
                </button>
              `
          }
        </div>

        <div class="shop-hint-row">
          <span>Tap the circle <strong>✓</strong> on the left of an item to tick it off.</span>
          ${
            this._recentlyCompleted.length > 0
              ? `<button class="undo-pill-btn" id="undo-latest-btn">
                  ↩️ Undo '${this._escapeHtml(this._recentlyCompleted[0].summary)}'
                </button>`
              : ""
          }
        </div>

        <!-- List Content -->
        ${
          cat === "food"
            ? foodItems.length === 0
              ? `<div class="empty-state" style="margin-top:10px;">
                  <div class="empty-icon">🍎</div>
                  <div>Your Food & Groceries shopping list is clear!</div>
                </div>`
              : `<div class="shop-checklist" style="margin-top: 10px;">
                  ${foodItems.map((item) => this._renderShoppingItemRow(item, "food", false)).join("")}
                </div>`
            : cat === "non_food"
            ? nonFoodItems.length === 0
              ? `<div class="empty-state" style="margin-top:10px;">
                  <div class="empty-icon">🧻</div>
                  <div>Your Non-Food & Household shopping list is clear!</div>
                </div>`
              : `<div class="shop-checklist" style="margin-top: 10px;">
                  ${nonFoodItems.map((item) => this._renderShoppingItemRow(item, "non_food", false)).join("")}
                </div>`
            : totalShopCount === 0
            ? `<div class="empty-state" style="margin-top:10px;">
                <div class="empty-icon">🎉</div>
                <div>Both your Food and Non-Food shopping lists are completely clear!</div>
              </div>`
            : `
              <div style="margin-top: 12px;">
                <div class="day-eyebrow" style="margin-bottom: 8px; color: #4ade80;">
                  🍎 FOOD & GROCERIES (${foodItems.length})
                </div>
                ${
                  foodItems.length === 0
                    ? `<div class="section-subtitle" style="margin-bottom: 14px;">No food items needed.</div>`
                    : `<div class="shop-checklist" style="margin-bottom: 18px;">
                        ${foodItems.map((item) => this._renderShoppingItemRow(item, "food", false)).join("")}
                      </div>`
                }

                <div class="day-eyebrow" style="margin-bottom: 8px; color: #fbbf24;">
                  🧻 NON-FOOD & HOUSEHOLD (${nonFoodItems.length})
                </div>
                ${
                  nonFoodItems.length === 0
                    ? `<div class="section-subtitle">No non-food items needed.</div>`
                    : `<div class="shop-checklist">
                        ${nonFoodItems.map((item) => this._renderShoppingItemRow(item, "non_food", false)).join("")}
                      </div>`
                }
              </div>
            `
        }

        ${
          this._recentlyCompleted.length > 0
            ? `
              <div class="recently-completed-tray">
                <button class="recently-completed-toggle" id="toggle-recent-completed-btn">
                  <span>↩️ Recently Ticked Off (${this._recentlyCompleted.length}) — Tap to restore</span>
                  <span>${this._showRecentlyCompleted ? "▴" : "▾"}</span>
                </button>
                ${
                  this._showRecentlyCompleted
                    ? `
                      <div class="pill-row" style="margin-top: 10px;">
                        ${this._recentlyCompleted
                          .map(
                            (rc) => `
                            <button class="restore-chip-btn" data-summary="${this._escapeHtml(rc.summary)}" data-list-type="${this._escapeHtml(rc.listType)}">
                              ↩️ ${this._escapeHtml(rc.summary)}
                              <span style="opacity:0.7; font-size:11px;">(${rc.listType === "non_food" ? "🧻" : "🍎"})</span>
                            </button>
                          `
                          )
                          .join("")}
                      </div>
                    `
                    : ""
                }
              </div>
            `
            : ""
        }
      </div>
    `;
  }

  _renderPreferencesTab() {
    const s = this._state.settings || {};
    const dislikesStr = Array.isArray(s.dislikes) ? s.dislikes.join(", ") : s.dislikes || "";

    return `
      <div class="surface-card" style="max-width:680px;">
        <h3 class="section-title">⚙️ Dietary Profile & Integration Settings</h3>
        <p class="section-subtitle" style="margin-bottom: 18px;">
          These defaults are automatically respected by the AI Meal Suggester unless overridden with "We Have Guests" mode.
        </p>

        <div class="form-group">
          <label>Default Dietary Profile</label>
          <input type="text" id="pref-diet" class="input" value="${this._escapeHtml(s.dietary_profile || "Vegetarian")}" />
        </div>
        <div class="form-group">
          <label>Disliked / Excluded Ingredients (comma-separated)</label>
          <input type="text" id="pref-dislikes" class="input" value="${this._escapeHtml(dislikesStr)}" placeholder="e.g. feta, beetroot" />
        </div>
        <div class="form-group">
          <label>General Household Meal Preferences (used by AI Chef)</label>
          <textarea id="pref-custom" class="input" rows="3" placeholder="e.g. Prefer 30-minute mid-week dinners, love Mexican, Italian, and Thai flavours...">${this._escapeHtml(s.custom_preferences || "")}</textarea>
        </div>
        <div class="form-row-2col">
          <div class="form-group">
            <label>🍎 Food Shopping To-Do Entity</label>
            <input type="text" id="pref-todo" class="input" value="${this._escapeHtml(s.todo_entity || "todo.shopping_list")}" />
          </div>
          <div class="form-group">
            <label>🧻 Non-Food Shopping To-Do Entity</label>
            <input type="text" id="pref-non-food-todo" class="input" value="${this._escapeHtml(s.non_food_todo_entity || "todo.non_food_shopping")}" />
          </div>
        </div>
        <div class="form-group">
          <label>🖨️ ESC/POS Receipt Printer Notify Entity</label>
          <input type="text" id="pref-printer" class="input" value="${this._escapeHtml(s.printer_entity || "notify.hall_stairs_hallway_receipt_printer")}" />
        </div>
        <div style="margin-top: 18px;">
          <button class="btn btn-emerald btn-lg" id="save-prefs-btn">💾 Save Preferences</button>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Modals (Searchable Meal Picker, Custom Editor, Ingredient Check, Post-Scan, Unpack)
  // ---------------------------------------------------------------------------

  _renderModals() {
    let html = "";

    // 1. Searchable Day / Meal Assignment Modal
    if (this._dayModal) {
      const m = this._dayModal;
      const meals = Object.values(this._state.meals || {});
      const search = (m.search || "").trim().toLowerCase();

      const allTags = new Set();
      meals.forEach((dbm) => (dbm.tags || []).forEach((t) => allTags.add(t)));

      const filteredMeals = meals
        .filter((dbm) => {
          if (m.favOnly && !dbm.favourite) return false;
          if (m.tagFilter && !(dbm.tags || []).includes(m.tagFilter)) return false;
          if (search) {
            const inName = (dbm.name || "").toLowerCase().includes(search);
            const inIng = (dbm.ingredients || []).some((i) => i.toLowerCase().includes(search));
            const inTag = (dbm.tags || []).some((t) => t.toLowerCase().includes(search));
            return inName || inIng || inTag;
          }
          return true;
        })
        .sort((a, b) => {
          if (Boolean(b.favourite) !== Boolean(a.favourite)) return b.favourite ? 1 : -1;
          return (a.name || "").localeCompare(b.name || "");
        });

      html += `
        <div class="modal-backdrop" id="day-modal-backdrop">
          <div class="modal-sheet modal-sheet-lg">
            <div class="modal-header">
              <div>
                <div class="day-eyebrow">PLANNING MEAL FOR</div>
                <h3 class="modal-title">📅 ${this._escapeHtml(this._formatDisplayDate(m.date))}</h3>
              </div>
              <button class="icon-btn" id="day-modal-cancel" title="Close">✕</button>
            </div>

            <div class="segmented-control" style="margin: 12px 0 16px;">
              <button class="seg-btn ${m.mode === "pick" ? "active" : ""}" id="day-mode-pick-btn">
                📚 Saved Meals (${meals.length})
              </button>
              <button class="seg-btn ${m.mode === "custom" ? "active" : ""}" id="day-mode-custom-btn">
                ✍️ ${m.meal_name ? `Details & Expiry (${this._escapeHtml(m.meal_name)})` : "New / Custom Meal"}
              </button>
            </div>

            ${
              m.mode === "pick"
                ? `
                  <div class="picker-toolbar">
                    <div class="search-input-wrap" style="flex:1;">
                      <span class="search-icon">🔍</span>
                      <input type="text" id="picker-search-input" class="input input-search"
                             placeholder="Search meals or ingredients..."
                             value="${this._escapeHtml(m.search || "")}" />
                    </div>
                    <button class="filter-chip ${m.favOnly ? "active" : ""}" id="picker-fav-btn">
                      ★ Favourites
                    </button>
                  </div>

                  ${
                    allTags.size > 0
                      ? `<div class="pill-row" style="margin-bottom: 12px;">
                          <button class="filter-chip picker-tag-btn ${!m.tagFilter ? "active" : ""}" data-tag="">All</button>
                          ${Array.from(allTags)
                            .sort()
                            .map(
                              (t) => `
                              <button class="filter-chip picker-tag-btn ${m.tagFilter === t ? "active" : ""}" data-tag="${this._escapeHtml(t)}">
                                #${this._escapeHtml(t)}
                              </button>
                            `
                            )
                            .join("")}
                        </div>`
                      : ""
                  }

                  <div class="picker-options-bar">
                    <label class="toggle-row" style="cursor:pointer;">
                      <input type="checkbox" class="modern-checkbox" id="day-modal-ask-shop" ${m.reviewIngredientsAfterSave ? "checked" : ""} />
                      <span style="font-size:13px; font-weight:600;">🛒 Review ingredients for shopping list</span>
                    </label>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span style="font-size:12px; color:#cbd5e1;">Expiry:</span>
                      <input type="date" id="day-modal-expiry" class="input input-date" value="${this._escapeHtml(m.shortest_expiry || "")}" />
                    </div>
                  </div>

                  <div class="picker-results-list">
                    ${
                      filteredMeals.length === 0
                        ? `
                          <div class="empty-state">
                            <div>No matching saved meals found.</div>
                            <button class="btn btn-emerald" id="picker-create-new-btn" style="margin-top:10px;">
                              ✍️ Create "${this._escapeHtml(m.search || "New Meal")}"
                            </button>
                          </div>
                        `
                        : filteredMeals
                            .map(
                              (dbm) => `
                              <div class="picker-meal-row ${m.meal_id === dbm.id ? "selected" : ""}">
                                <div class="picker-meal-info picker-quick-assign" data-id="${this._escapeHtml(dbm.id)}">
                                  <div class="picker-meal-name">
                                    ${dbm.favourite ? `<span class="fav-star-inline">★</span>` : ""}
                                    ${this._escapeHtml(dbm.name)}
                                  </div>
                                  <div class="pill-row" style="margin-top:6px;">
                                    ${(dbm.ingredients || [])
                                      .map((ing) => `<span class="pill">${this._escapeHtml(ing)}</span>`)
                                      .join("")}
                                  </div>
                                </div>
                                <div class="picker-meal-actions">
                                  <button class="btn btn-secondary btn-sm picker-customize-btn" data-id="${this._escapeHtml(dbm.id)}" title="Customize ingredients or expiry before saving">
                                    ✎ Edit
                                  </button>
                                  <button class="btn btn-emerald picker-quick-assign" data-id="${this._escapeHtml(dbm.id)}">
                                    ✓ Choose
                                  </button>
                                </div>
                              </div>
                            `
                            )
                            .join("")
                    }
                  </div>
                `
                : `
                  <div class="form-group">
                    <label>Meal Name</label>
                    <input type="text" id="day-modal-name" class="input" value="${this._escapeHtml(m.meal_name)}" placeholder="e.g. Crispy Halloumi Fajitas" />
                  </div>

                  <div class="form-group">
                    <label>Tagged Ingredients</label>
                    <div class="pill-row" style="margin-bottom:8px;">
                      ${
                        m.ingredients.length === 0
                          ? `<span class="section-subtitle">No ingredients tagged yet</span>`
                          : m.ingredients
                              .map(
                                (ing, idx) => `
                                <span class="pill pill-lg">
                                  ${this._escapeHtml(ing)}
                                  <button class="pill-del day-ing-del" data-idx="${idx}">✕</button>
                                </span>
                              `
                              )
                              .join("")
                      }
                    </div>
                    <div class="quick-input-bar">
                      <input type="text" id="day-modal-new-ing" class="input" list="all-ings-datalist" style="flex:1;" placeholder="Add ingredient(s), comma-separated..." value="${this._escapeHtml(m.newIngredient || "")}" />
                      <button class="btn btn-secondary" id="day-modal-add-ing-btn">＋ Add</button>
                    </div>
                  </div>

                  <div class="form-row-2col">
                    <div class="form-group">
                      <label>Shortest Ingredient Expiry Date</label>
                      <input type="date" id="day-modal-expiry" class="input" value="${this._escapeHtml(m.shortest_expiry || "")}" />
                    </div>
                    <div class="form-group">
                      <label>Date Change</label>
                      <input type="date" id="day-modal-date-change" class="input" value="${this._escapeHtml(m.date)}" />
                    </div>
                  </div>

                  <div class="form-group">
                    <label>Prep / Recipe Notes</label>
                    <input type="text" id="day-modal-notes" class="input" value="${this._escapeHtml(m.notes || "")}" placeholder="Optional cooking notes..." />
                  </div>

                  <div class="modal-toggles">
                    <label class="toggle-row">
                      <input type="checkbox" class="modern-checkbox" id="day-modal-pin" ${m.pinned ? "checked" : ""} />
                      <span>📌 Pin meal to this day (won't move during auto-schedule)</span>
                    </label>
                    <label class="toggle-row">
                      <input type="checkbox" class="modern-checkbox" id="day-modal-ask-shop" ${m.reviewIngredientsAfterSave ? "checked" : ""} />
                      <span>🛒 Check & add needed ingredients to shopping list after saving</span>
                    </label>
                  </div>

                  <div class="modal-footer">
                    <button class="btn btn-secondary" id="day-modal-cancel-btn">Cancel</button>
                    <button class="btn btn-emerald btn-lg" id="day-modal-save">💾 Save Meal Plan</button>
                  </div>
                `
            }
          </div>
        </div>
      `;
    }

    // 2. Meal Database Create/Edit Modal
    if (this._mealModal) {
      const m = this._mealModal;
      html += `
        <div class="modal-backdrop">
          <div class="modal-sheet">
            <div class="modal-header">
              <h3 class="modal-title">${m.id ? "✎ Edit Saved Meal" : "＋ Add Meal to Database"}</h3>
              <button class="icon-btn" id="meal-modal-close">✕</button>
            </div>

            <div class="form-group" style="margin-top:12px;">
              <label>Meal Name</label>
              <input type="text" id="meal-modal-name" class="input" value="${this._escapeHtml(m.name)}" placeholder="e.g. Veggie Sausage & Mash" />
            </div>

            <div class="form-group">
              <label>Ingredients</label>
              <div class="pill-row" style="margin-bottom:8px;">
                ${m.ingredients
                  .map(
                    (ing, idx) => `
                    <span class="pill pill-lg">
                      ${this._escapeHtml(ing)}
                      <button class="pill-del meal-ing-del" data-idx="${idx}">✕</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>
              <div class="quick-input-bar">
                <input type="text" id="meal-modal-new-ing" class="input" list="all-ings-datalist" style="flex:1;" placeholder="Add ingredient(s), comma-separated..." value="${this._escapeHtml(m.newIngredient || "")}" />
                <button class="btn btn-secondary" id="meal-modal-add-ing-btn">＋ Add</button>
              </div>
            </div>

            <div class="form-group">
              <label>Tags (e.g. Quick, Comfort, Guest-Friendly)</label>
              <div class="pill-row" style="margin-bottom:8px;">
                ${m.tags
                  .map(
                    (t, idx) => `
                    <span class="pill pill-tag pill-lg">
                      #${this._escapeHtml(t)}
                      <button class="pill-del meal-tag-del" data-idx="${idx}">✕</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>
              <div class="quick-input-bar">
                <input type="text" id="meal-modal-new-tag" class="input" style="flex:1;" placeholder="Add tag(s)..." value="${this._escapeHtml(m.newTag || "")}" />
                <button class="btn btn-secondary" id="meal-modal-add-tag-btn">＋ Add</button>
              </div>
            </div>

            <div class="form-group">
              <label>Prep / Recipe Notes</label>
              <textarea id="meal-modal-notes" class="input" rows="2">${this._escapeHtml(m.notes)}</textarea>
            </div>

            <label class="toggle-row" style="margin: 14px 0;">
              <input type="checkbox" class="modern-checkbox" id="meal-modal-fav" ${m.favourite ? "checked" : ""} />
              <span style="font-weight:700;">★ Mark as a Household Favourite</span>
            </label>

            <div class="modal-footer">
              <button class="btn btn-secondary" id="meal-modal-cancel">Cancel</button>
              <button class="btn btn-emerald btn-lg" id="meal-modal-save">💾 Save to Database</button>
            </div>
          </div>
        </div>
      `;
    }

    // 3. Mid-Step Ingredient Check Modal
    if (this._ingredientReviewModal) {
      const rm = this._ingredientReviewModal;
      html += `
        <div class="modal-backdrop">
          <div class="modal-sheet">
            <div class="modal-header">
              <div>
                <div class="day-eyebrow">SHOPPING LIST CHECK</div>
                <h3 class="modal-title">🛒 Ingredients for ${this._escapeHtml(rm.mealName)}</h3>
              </div>
            </div>
            <p class="section-subtitle" style="margin: 8px 0 14px;">
              Untick anything you <strong>already have in stock</strong>. Checked items will be added to your shopping list.
            </p>

            <div class="shop-checklist" style="max-height:320px; overflow-y:auto;">
              ${rm.items
                .map(
                  (item, idx) => `
                  <label class="shop-item-row" style="cursor:pointer;">
                    <div class="shop-item-main">
                      <input type="checkbox" class="modern-checkbox ing-review-check" data-idx="${idx}" ${item.checked ? "checked" : ""} />
                      <span class="shop-item-name">${this._escapeHtml(item.name)}</span>
                    </div>
                    ${
                      item.onList
                        ? `<span class="badge badge-warn">Already on list</span>`
                        : `<span class="badge badge-ok">Need to buy</span>`
                    }
                  </label>
                `
                )
                .join("")}
            </div>

            <div class="form-group" style="margin-top:14px;">
              <label>Need any extra items while you're at it?</label>
              <input type="text" id="ing-review-extra" class="input" placeholder="Optional extra item(s), comma-separated..." value="${this._escapeHtml(rm.extraItem || "")}" />
            </div>

            <div class="modal-footer">
              <button class="btn btn-secondary" id="ing-review-skip">Skip (Have Everything)</button>
              <button class="btn btn-emerald btn-lg" id="ing-review-confirm">🛒 Add Checked to List</button>
            </div>
          </div>
        </div>
      `;
    }

    // 4. Post-Scan Results & Planned Meals Review Modal
    if (this._postScanModal && this._scanSummary) {
      html += `
        <div class="modal-backdrop">
          <div class="modal-sheet modal-sheet-lg">
            <div class="modal-header">
              <div>
                <div class="day-eyebrow" style="color:#4ade80;">RECEIPT SCAN COMPLETE</div>
                <h3 class="modal-title">✅ Shopping List Updated & Unpack Review</h3>
              </div>
              <button class="icon-btn" id="close-post-scan-modal">✕</button>
            </div>

            <div class="scan-modal-grid" style="margin: 14px 0;">
              <div class="scan-stat-box scan-stat-ok">
                <div class="day-eyebrow" style="color:#4ade80;">✓ BOUGHT & TICKED OFF (${(this._scanSummary.completed_summaries || []).length})</div>
                <div class="pill-row" style="margin-top:8px;">
                  ${
                    (this._scanSummary.completed_summaries || []).length > 0
                      ? this._scanSummary.completed_summaries
                          .map((s) => `<span class="pill badge-ok">✓ ${this._escapeHtml(s)}</span>`)
                          .join("")
                      : `<span class="section-subtitle">No newly crossed-out items</span>`
                  }
                </div>
              </div>

              <div class="scan-stat-box scan-stat-warn">
                <div class="day-eyebrow" style="color:#fbbf24;">🛒 UNMARKED / STILL NEEDED (${(this._scanSummary.still_needed_items || []).length})</div>
                <div class="pill-row" style="margin-top:8px;">
                  ${
                    (this._scanSummary.still_needed_items || []).length > 0
                      ? (this._scanSummary.still_needed_items || [])
                          .map((i) => `<span class="pill">${this._escapeHtml(i.summary)}</span>`)
                          .join("")
                      : `<span class="section-subtitle">All items were bought!</span>`
                  }
                </div>
              </div>
            </div>

            <hr class="divider" />

            ${this._renderUpcomingMealsManager(true)}

            <div class="modal-footer">
              <button class="btn btn-emerald btn-lg" id="done-post-scan-modal">Done</button>
            </div>
          </div>
        </div>
      `;
    }

    // 5. Planned Meals & Expiry Unpack Modal (from Shopping toolbar)
    if (this._unpackModal) {
      html += `
        <div class="modal-backdrop">
          <div class="modal-sheet modal-sheet-lg">
            <div class="modal-header">
              <div>
                <div class="day-eyebrow">UNPACKING & EXPIRY DATES</div>
                <h3 class="modal-title">📅 Planned Meals (Next 10 Days)</h3>
              </div>
              <button class="icon-btn" id="close-unpack-modal">✕</button>
            </div>
            <div style="margin-top: 12px;">
              ${this._renderUpcomingMealsManager(true)}
            </div>
            <div class="modal-footer">
              <button class="btn btn-emerald" id="done-unpack-modal">Done</button>
            </div>
          </div>
        </div>
      `;
    }

    return html;
  }

  _render() {
    if (!this.shadowRoot) return;

    const allIngsDatalist = `
      <datalist id="all-ings-datalist">
        ${(this._state.all_ingredients || [])
          .map((i) => `<option value="${this._escapeHtml(i)}"></option>`)
          .join("")}
      </datalist>
    `;

    const mealCount = Object.keys(this._state.meals || {}).length;
    const shopCount =
      (this._state.shopping_list || []).length +
      (this._state.non_food_shopping_list || []).length;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --mm-bg: #0b0f19;
          --mm-surface: #151c2c;
          --mm-surface-elevated: #1e293b;
          --mm-surface-hover: #263349;
          --mm-border: rgba(148, 163, 184, 0.16);
          --mm-border-strong: rgba(148, 163, 184, 0.3);
          --mm-text: #f8fafc;
          --mm-text-muted: #94a3b8;

          /* Semantic Mission Colors */
          --mm-sky: #0284c7;
          --mm-sky-bright: #38bdf8;
          --mm-emerald: #059669;
          --mm-emerald-hover: #047857;
          --mm-emerald-bright: #10b981;
          --mm-violet: #7c3aed;
          --mm-violet-hover: #6d28d9;
          --mm-amber: #d97706;
          --mm-amber-bright: #f59e0b;

          --mm-success-bg: rgba(16, 185, 129, 0.18);
          --mm-success-text: #34d399;
          --mm-warn-bg: rgba(245, 158, 11, 0.2);
          --mm-warn-text: #fbbf24;
          --mm-danger-bg: rgba(239, 68, 68, 0.2);
          --mm-danger-text: #f87171;

          display: block;
          box-sizing: border-box;
          background: var(--mm-bg);
          color: var(--mm-text);
          min-height: 100vh;
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          padding: ${this._isCompanion ? "12px 12px 84px" : "18px 22px 96px"};
          line-height: 1.45;
          -webkit-font-smoothing: antialiased;
        }
        *, *::before, *::after {
          box-sizing: border-box;
        }

        /* Top App Bar */
        .app-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .brand-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .ha-menu-btn {
          width: 42px;
          height: 42px;
          border-radius: 12px;
          border: 1px solid var(--mm-border-strong);
          background: var(--mm-surface-elevated);
          color: var(--mm-text);
          font-size: 20px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s;
        }
        .ha-menu-btn:hover {
          background: var(--mm-surface-hover);
        }
        .brand-logo {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: linear-gradient(135deg, #059669, #0284c7);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          box-shadow: 0 4px 12px rgba(5, 150, 105, 0.3);
        }
        .brand-title {
          font-size: 20px;
          font-weight: 800;
          letter-spacing: -0.02em;
          color: var(--mm-text);
          margin: 0;
        }
        .brand-subtitle {
          font-size: 12px;
          color: var(--mm-text-muted);
          margin: 0;
        }
        .header-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        /* Pop-out 3-Dot & Print Dropdown Menus */
        .menu-anchor {
          position: relative;
          display: inline-flex;
        }
        .kebab-btn {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          border: 1px solid var(--mm-border);
          background: rgba(30, 41, 59, 0.75);
          color: #cbd5e1;
          font-size: 18px;
          font-weight: 800;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s;
        }
        .kebab-btn:hover {
          background: var(--mm-surface-hover);
          color: #ffffff;
          border-color: var(--mm-border-strong);
        }
        .pop-menu {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          min-width: 245px;
          background: #1e293b;
          border: 1px solid rgba(148, 163, 184, 0.35);
          border-radius: 14px;
          padding: 6px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
          z-index: 1200;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .pop-menu-wide {
          min-width: 290px;
        }
        .pop-menu-item {
          width: 100%;
          border: none;
          background: transparent;
          color: #f1f5f9;
          padding: 10px 12px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 600;
          text-align: left;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 10px;
          transition: background 0.12s;
        }
        .pop-menu-item:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .pop-menu-item-sub {
          display: block;
          font-size: 11px;
          font-weight: 500;
          color: #94a3b8;
          margin-top: 2px;
        }
        .pop-menu-danger {
          color: #f87171;
        }
        .pop-menu-danger:hover {
          background: rgba(239, 68, 68, 0.15);
        }
        .pop-menu-divider {
          height: 1px;
          background: var(--mm-border);
          margin: 4px 6px;
        }

        /* Desktop Primary Navigation Tabs */
        .desktop-tabs {
          display: flex;
          gap: 6px;
          background: var(--mm-surface);
          padding: 5px;
          border-radius: 14px;
          border: 1px solid var(--mm-border);
          margin-bottom: 18px;
          overflow-x: auto;
        }
        .tab-btn {
          background: transparent;
          color: var(--mm-text-muted);
          border: none;
          border-radius: 10px;
          padding: 9px 16px;
          min-height: 42px;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
          transition: all 0.15s ease;
        }
        .tab-btn:hover {
          color: var(--mm-text);
          background: rgba(255, 255, 255, 0.05);
        }
        .tab-btn.active {
          background: var(--mm-sky);
          color: #ffffff;
          box-shadow: 0 2px 10px rgba(2, 132, 199, 0.35);
        }
        .tab-count {
          background: rgba(0, 0, 0, 0.25);
          color: #ffffff;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
        }

        /* Mobile Bottom Bar */
        .mobile-bottom-nav {
          display: none;
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(12px);
          border-top: 1px solid var(--mm-border-strong);
          z-index: 900;
          padding: 6px 8px env(safe-area-inset-bottom, 6px);
          justify-content: space-around;
        }
        .mob-nav-btn {
          background: transparent;
          border: none;
          color: var(--mm-text-muted);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 3px;
          padding: 6px 10px;
          min-height: 50px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          flex: 1;
        }
        .mob-nav-btn .mob-icon {
          font-size: 18px;
        }
        .mob-nav-btn.active {
          color: #ffffff;
          background: var(--mm-sky);
        }

        /* Cards & Command Bars */
        .surface-card {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 16px;
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
        }
        .command-bar {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 14px;
          padding: 10px 14px;
          margin-bottom: 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }
        .nav-cluster, .action-cluster {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .date-range-title {
          font-size: 14px;
          font-weight: 700;
          color: var(--mm-text);
          margin-left: 4px;
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 12px;
        }
        .section-title {
          margin: 0;
          font-size: 17px;
          font-weight: 800;
          color: var(--mm-text);
        }
        .section-subtitle {
          margin: 3px 0 0;
          font-size: 13px;
          color: var(--mm-text-muted);
        }

        /* Semantic Buttons */
        .btn {
          border: 1px solid transparent;
          border-radius: 11px;
          padding: 9px 15px;
          min-height: 42px;
          font-size: 13.5px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          transition: all 0.15s ease;
          text-decoration: none;
          color: var(--mm-text);
        }
        .btn:active {
          transform: translateY(1px);
        }
        .btn-emerald {
          background: var(--mm-emerald);
          color: #ffffff;
          box-shadow: 0 2px 10px rgba(5, 150, 105, 0.3);
        }
        .btn-emerald:hover {
          background: var(--mm-emerald-hover);
        }
        .btn-violet {
          background: linear-gradient(135deg, #7c3aed, #6d28d9);
          color: #ffffff;
          box-shadow: 0 3px 12px rgba(124, 58, 237, 0.35);
        }
        .btn-violet:hover {
          filter: brightness(1.08);
        }
        .btn-amber {
          background: var(--mm-amber);
          color: #ffffff;
        }
        .btn-amber:hover {
          filter: brightness(1.08);
        }
        .btn-primary {
          background: var(--mm-sky);
          color: #ffffff;
        }
        .btn-secondary {
          background: var(--mm-surface-elevated);
          color: #e2e8f0;
          border-color: var(--mm-border-strong);
        }
        .btn-secondary:hover {
          background: var(--mm-surface-hover);
          color: #ffffff;
        }
        .btn-lg {
          min-height: 46px;
          padding: 11px 18px;
          font-size: 14.5px;
        }
        .btn-sm {
          min-height: 36px;
          padding: 6px 12px;
          font-size: 12.5px;
          border-radius: 9px;
        }
        .btn-xs {
          min-height: 30px;
          padding: 4px 10px;
          font-size: 12px;
          border-radius: 8px;
        }
        .btn-block {
          flex: 1;
        }

        /* Colored Compact Card Action Chips */
        .btn-chip {
          border-radius: 9px;
          padding: 6px 12px;
          min-height: 34px;
          font-size: 12.5px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          transition: all 0.15s;
        }
        .btn-chip-amber {
          background: rgba(245, 158, 11, 0.14);
          color: #fbbf24;
          border: 1px solid rgba(245, 158, 11, 0.35);
        }
        .btn-chip-amber:hover {
          background: rgba(245, 158, 11, 0.26);
          color: #fef3c7;
        }
        .btn-chip-emerald {
          background: rgba(16, 185, 129, 0.14);
          color: #34d399;
          border: 1px solid rgba(16, 185, 129, 0.35);
        }
        .btn-chip-emerald:hover {
          background: rgba(16, 185, 129, 0.26);
          color: #ecfdf5;
        }

        .icon-btn {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          border: 1px solid var(--mm-border);
          background: var(--mm-surface-elevated);
          color: var(--mm-text);
          font-size: 15px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .icon-btn:hover {
          background: var(--mm-surface-hover);
        }
        .icon-btn-danger {
          color: var(--mm-danger-text);
          border-color: rgba(239, 68, 68, 0.3);
        }

        /* Inputs */
        .input {
          background: #0f172a;
          color: #f8fafc;
          border: 1px solid var(--mm-border-strong);
          border-radius: 11px;
          padding: 9px 13px;
          min-height: 42px;
          font-size: 14px;
          font-family: inherit;
          color-scheme: dark;
        }
        .input:focus {
          outline: 2px solid var(--mm-sky-bright);
          border-color: transparent;
        }
        .input::placeholder {
          color: #64748b;
        }
        .input-date {
          padding: 5px 9px;
          min-height: 34px;
          font-size: 12.5px;
        }

        /* Calendar Grid & Day Cards */
        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
          gap: 12px;
        }
        .day-card {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 15px;
          padding: 12px 14px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition: border-color 0.15s;
        }
        .day-card.stripe-planned {
          border-left: 4px solid #10b981;
        }
        .day-card.stripe-ok {
          border-left: 4px solid #10b981;
        }
        .day-card.stripe-warn {
          border-left: 4px solid #f59e0b;
        }
        .day-card.stripe-danger {
          border-left: 4px solid #ef4444;
        }
        .day-card.stripe-pin {
          border-left: 4px solid #38bdf8;
        }
        .day-card.day-today {
          border: 2px solid #38bdf8;
          box-shadow: 0 4px 20px rgba(2, 132, 199, 0.18);
        }
        .day-card.day-unplanned {
          background: rgba(21, 28, 44, 0.65);
          border-style: dashed;
        }
        .day-card.day-skipped {
          background: rgba(15, 23, 42, 0.45);
          border-style: dashed;
          opacity: 0.82;
        }
        .day-card.day-swap-source {
          border: 2px dashed #fbbf24;
          background: rgba(245, 158, 11, 0.08);
        }
        .day-card.day-swap-target {
          border-color: rgba(124, 58, 237, 0.6);
        }
        .day-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .day-date-group {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .card-top-right {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .day-date-label {
          font-size: 13px;
          font-weight: 800;
          color: #cbd5e1;
        }
        .day-date-label.today-highlight {
          color: #38bdf8;
        }
        .badge-interactive {
          border-radius: 8px;
          padding: 3px 8px;
          font-size: 11.5px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .badge-subtle {
          background: rgba(148, 163, 184, 0.12);
          color: #94a3b8;
          border: 1px dashed rgba(148, 163, 184, 0.3);
        }
        .badge-subtle:hover {
          color: #f8fafc;
          border-color: #94a3b8;
        }

        /* Inline Collapsible Expiry Drawer (Only open when clicked) */
        .inline-expiry-drawer {
          background: #0f172a;
          border: 1px solid var(--mm-border-strong);
          border-radius: 11px;
          padding: 9px 11px;
          margin-bottom: 10px;
        }
        .expiry-drawer-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11.5px;
          font-weight: 700;
          color: var(--mm-text-muted);
          margin-bottom: 6px;
        }
        .expiry-drawer-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          flex-wrap: wrap;
        }

        .meal-headline {
          padding: 4px 6px;
          margin: 0 -6px;
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .meal-headline:hover {
          background: var(--mm-surface-elevated);
        }
        .meal-name-text {
          font-size: 16px;
          font-weight: 800;
          color: #ffffff;
          line-height: 1.3;
        }
        .day-card-footer {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--mm-border);
        }
        .empty-day-slot {
          padding: 4px 0 2px;
        }
        .btn-assign-meal {
          width: 100%;
          min-height: 42px;
          border-radius: 11px;
          border: 1px dashed rgba(16, 185, 129, 0.45);
          background: rgba(16, 185, 129, 0.1);
          color: #34d399;
          font-size: 13.5px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s;
        }
        .btn-assign-meal:hover {
          background: var(--mm-emerald);
          color: #ffffff;
          border-style: solid;
        }
        .skipped-box {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 4px 0;
          color: var(--mm-text-muted);
          font-size: 13px;
          font-weight: 600;
        }
        .swap-banner {
          background: rgba(245, 158, 11, 0.16);
          border: 2px solid #fbbf24;
          color: #fef3c7;
          padding: 10px 14px;
          border-radius: 12px;
          margin-bottom: 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }

        /* Pills & Badges */
        .pill-row, .badge-row {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          align-items: center;
        }
        .pill {
          background: #1e293b;
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.22);
          border-radius: 999px;
          padding: 3px 10px;
          font-size: 11.5px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .pill-muted {
          background: transparent;
          color: #94a3b8;
          border-style: dashed;
        }
        .pill-tag {
          background: rgba(124, 58, 237, 0.2);
          color: #ddd6fe;
          border-color: rgba(167, 139, 250, 0.3);
        }
        .pill-lg {
          padding: 5px 12px;
          font-size: 12.5px;
        }
        .pill-del {
          background: rgba(255, 255, 255, 0.14);
          border: none;
          color: #ffffff;
          border-radius: 50%;
          width: 18px;
          height: 18px;
          cursor: pointer;
          font-size: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .badge {
          border-radius: 8px;
          padding: 3px 8px;
          font-size: 11.5px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .badge-ok {
          background: var(--mm-success-bg);
          color: var(--mm-success-text);
          border: 1px solid rgba(52, 211, 153, 0.3);
        }
        .badge-warn {
          background: var(--mm-warn-bg);
          color: var(--mm-warn-text);
          border: 1px solid rgba(251, 191, 36, 0.35);
        }
        .badge-danger {
          background: var(--mm-danger-bg);
          color: var(--mm-danger-text);
          border: 1px solid rgba(248, 113, 113, 0.35);
        }
        .badge-pin {
          background: rgba(56, 189, 248, 0.16);
          color: #38bdf8;
          border: 1px solid rgba(56, 189, 248, 0.3);
        }

        .expiry-quick-pills {
          display: flex;
          gap: 4px;
        }
        .chip-btn {
          background: var(--mm-surface-elevated);
          color: #e2e8f0;
          border: 1px solid var(--mm-border-strong);
          border-radius: 7px;
          padding: 4px 8px;
          min-height: 30px;
          font-size: 11.5px;
          font-weight: 700;
          cursor: pointer;
        }
        .chip-btn:hover {
          background: var(--mm-sky);
          color: #ffffff;
        }

        /* Database & AI Grid */
        .db-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 14px;
        }
        .db-meal-card {
          display: flex;
          flex-direction: column;
          margin-bottom: 0;
        }
        .db-card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
        }
        .db-meal-title {
          margin: 0;
          font-size: 16px;
          font-weight: 800;
          color: #ffffff;
        }
        .star-toggle {
          background: transparent;
          border: none;
          font-size: 20px;
          color: #64748b;
          cursor: pointer;
          padding: 2px;
          line-height: 1;
        }
        .star-toggle.active, .fav-star-inline {
          color: #fbbf24;
        }
        .meal-notes {
          margin-top: 10px;
          font-size: 12.5px;
          color: var(--mm-text-muted);
          background: rgba(15, 23, 42, 0.5);
          padding: 7px 10px;
          border-radius: 8px;
        }
        .ai-reason-box {
          margin-top: 8px;
          font-size: 12.5px;
          font-weight: 600;
          color: #38bdf8;
          background: rgba(2, 132, 199, 0.12);
          padding: 8px 10px;
          border-radius: 10px;
        }
        .db-card-actions {
          display: flex;
          gap: 8px;
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid var(--mm-border);
        }

        /* Search & Filter Chips */
        .search-filter-bar {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
          flex: 1;
        }
        .search-input-wrap {
          position: relative;
          min-width: 220px;
          flex: 1;
        }
        .search-icon {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          pointer-events: none;
        }
        .input-search {
          width: 100%;
          padding-left: 36px;
        }
        .filter-chip {
          background: var(--mm-surface-elevated);
          color: #cbd5e1;
          border: 1px solid var(--mm-border-strong);
          border-radius: 999px;
          padding: 7px 13px;
          min-height: 38px;
          font-size: 12.5px;
          font-weight: 700;
          cursor: pointer;
        }
        .filter-chip.active {
          background: var(--mm-sky);
          color: #ffffff;
          border-color: var(--mm-sky);
        }

        /* Flattened Single-Layer Shopping Toolbar */
        .shop-unified-toolbar {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 14px;
          padding: 10px 12px;
          margin-bottom: 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }
        .shop-category-pills {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .cat-pill {
          border: 1px solid var(--mm-border-strong);
          background: var(--mm-surface-elevated);
          color: #cbd5e1;
          border-radius: 10px;
          padding: 8px 13px;
          min-height: 40px;
          font-size: 13.5px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          transition: all 0.15s;
        }
        .cat-count {
          background: rgba(0, 0, 0, 0.3);
          padding: 1px 7px;
          border-radius: 999px;
          font-size: 11.5px;
        }
        .cat-pill-food.active {
          background: var(--mm-emerald);
          color: #ffffff;
          border-color: var(--mm-emerald-bright);
          box-shadow: 0 2px 10px rgba(5, 150, 105, 0.35);
        }
        .cat-pill-nf.active {
          background: var(--mm-amber);
          color: #ffffff;
          border-color: var(--mm-amber-bright);
          box-shadow: 0 2px 10px rgba(217, 119, 6, 0.35);
        }
        .cat-pill-both.active {
          background: var(--mm-sky);
          color: #ffffff;
          border-color: var(--mm-sky-bright);
        }
        .shop-toolbar-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .upload-hero-btn {
          cursor: pointer;
        }
        .shop-hint-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          font-size: 12px;
          color: var(--mm-text-muted);
          margin-bottom: 6px;
        }
        .undo-pill-btn {
          background: rgba(245, 158, 11, 0.18);
          color: #fbbf24;
          border: 1px solid rgba(245, 158, 11, 0.4);
          border-radius: 999px;
          padding: 4px 12px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .undo-pill-btn:hover {
          background: rgba(245, 158, 11, 0.3);
        }

        /* Shopping List Rows — Explicit Checkbox Button Only */
        .quick-input-bar {
          display: flex;
          gap: 8px;
        }
        .shop-checklist, .stack-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .shop-item-row, .list-item-card {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          min-height: 52px;
          border-radius: 12px;
          background: var(--mm-surface-elevated);
          border: 1px solid var(--mm-border);
        }
        .shop-item-main {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
        }
        .shop-check-btn {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          border: 2px solid rgba(148, 163, 184, 0.45);
          background: #0f172a;
          color: transparent;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: all 0.15s;
        }
        .shop-check-btn:hover, .shop-check-btn:focus-visible {
          border-color: #10b981;
          background: rgba(16, 185, 129, 0.18);
          color: #34d399;
        }
        .shop-check-circle {
          font-size: 16px;
          font-weight: 900;
          line-height: 1;
        }
        .shop-item-text {
          user-select: text;
        }
        .shop-item-name, .list-item-title {
          font-size: 15px;
          font-weight: 700;
          color: #ffffff;
        }
        .shop-item-meals {
          font-size: 12px;
          font-weight: 600;
          color: #38bdf8;
          margin-top: 2px;
        }

        /* Recently Completed Undo Tray */
        .recently-completed-tray {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px dashed var(--mm-border-strong);
        }
        .recently-completed-toggle {
          width: 100%;
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid var(--mm-border);
          color: #cbd5e1;
          border-radius: 10px;
          padding: 8px 12px;
          font-size: 12.5px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .restore-chip-btn {
          background: rgba(30, 41, 59, 0.9);
          color: #e2e8f0;
          border: 1px solid var(--mm-border-strong);
          border-radius: 999px;
          padding: 6px 12px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .restore-chip-btn:hover {
          border-color: #34d399;
          color: #34d399;
        }

        .segmented-control {
          display: flex;
          background: #0f172a;
          padding: 4px;
          border-radius: 12px;
          border: 1px solid var(--mm-border-strong);
          gap: 6px;
        }
        .seg-btn {
          flex: 1;
          min-height: 40px;
          border: none;
          border-radius: 9px;
          background: transparent;
          color: var(--mm-text-muted);
          font-size: 13.5px;
          font-weight: 700;
          cursor: pointer;
          padding: 7px 12px;
        }
        .seg-btn.active {
          background: var(--mm-sky);
          color: #ffffff;
        }

        .modern-checkbox {
          width: 22px;
          height: 22px;
          accent-color: var(--mm-emerald);
          cursor: pointer;
          flex-shrink: 0;
        }
        .day-eyebrow {
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #38bdf8;
        }
        .expiry-controls {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }

        /* Guest Box & AI */
        .guest-override-card {
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid var(--mm-border-strong);
          background: var(--mm-surface-elevated);
        }
        .guest-override-card.active {
          border-color: #a855f7;
          background: rgba(124, 58, 237, 0.15);
        }
        .toggle-row {
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
        }
        .ai-prompt-row {
          display: flex;
          gap: 10px;
          margin-top: 14px;
          flex-wrap: wrap;
        }

        /* Modals & Bottom Sheets */
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(3, 7, 18, 0.8);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1300;
          padding: 16px;
        }
        .modal-sheet {
          background: var(--mm-surface);
          color: var(--mm-text);
          border: 1px solid var(--mm-border-strong);
          border-radius: 20px;
          padding: 20px;
          width: 100%;
          max-width: 560px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
        }
        .modal-sheet-lg {
          max-width: 680px;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }
        .modal-title {
          margin: 2px 0 0;
          font-size: 19px;
          font-weight: 800;
          color: #ffffff;
        }
        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 18px;
          padding-top: 14px;
          border-top: 1px solid var(--mm-border);
        }
        .modal-toggles {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-top: 14px;
          padding: 12px;
          border-radius: 12px;
          background: rgba(15, 23, 42, 0.5);
        }

        /* Searchable Meal Picker List inside Day Modal */
        .picker-toolbar {
          display: flex;
          gap: 8px;
          margin-bottom: 10px;
          flex-wrap: wrap;
        }
        .picker-options-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          padding: 10px 12px;
          background: #0f172a;
          border-radius: 12px;
          border: 1px solid var(--mm-border);
          margin-bottom: 12px;
        }
        .picker-results-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-height: 48vh;
          overflow-y: auto;
          padding-right: 4px;
        }
        .picker-meal-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 11px 14px;
          border-radius: 13px;
          background: var(--mm-surface-elevated);
          border: 1px solid var(--mm-border);
        }
        .picker-meal-row:hover {
          border-color: #10b981;
          background: var(--mm-surface-hover);
        }
        .picker-meal-info {
          flex: 1;
          cursor: pointer;
        }
        .picker-meal-name {
          font-size: 15.5px;
          font-weight: 800;
          color: #ffffff;
        }
        .picker-meal-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .scan-modal-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 12px;
        }
        .scan-stat-box {
          padding: 12px 14px;
          border-radius: 12px;
          background: #0f172a;
          border: 1px solid var(--mm-border);
        }
        .divider {
          border: none;
          border-top: 1px solid var(--mm-border);
          margin: 16px 0;
        }

        /* Forms & Empty States */
        .form-group {
          margin-bottom: 14px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .form-group label {
          font-size: 13px;
          font-weight: 700;
          color: #cbd5e1;
        }
        .form-row-2col {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
        }
        .empty-state {
          padding: 24px 16px;
          text-align: center;
          color: var(--mm-text-muted);
          border: 1px dashed var(--mm-border-strong);
          border-radius: 14px;
          background: rgba(15, 23, 42, 0.4);
        }
        .empty-icon {
          font-size: 28px;
          margin-bottom: 6px;
        }

        /* Toast with Interactive Undo Button */
        .toast {
          position: fixed;
          bottom: 84px;
          right: 20px;
          padding: 11px 16px;
          border-radius: 12px;
          background: #0f172a;
          border: 1px solid #38bdf8;
          color: #ffffff;
          font-weight: 700;
          font-size: 13.5px;
          z-index: 2000;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .toast.error {
          background: #7f1d1d;
          border-color: #f87171;
        }
        .toast-undo-btn {
          background: #f59e0b;
          color: #0b0f19;
          border: none;
          border-radius: 8px;
          padding: 5px 11px;
          font-size: 12.5px;
          font-weight: 800;
          cursor: pointer;
        }

        /* Responsive Mobile Rules */
        @media (max-width: 768px) {
          :host {
            padding: 12px 10px 92px;
          }
          .desktop-tabs {
            display: none;
          }
          .mobile-bottom-nav {
            display: flex;
          }
          .modal-backdrop {
            align-items: flex-end;
            padding: 0;
          }
          .modal-sheet {
            border-radius: 22px 22px 0 0;
            max-height: 92vh;
            padding: 18px 14px 28px;
          }
        }
      </style>

      ${allIngsDatalist}

      <!-- Header Bar with Home Assistant Companion Sidebar Toggle + Consolidated Print Dropdown -->
      <div class="app-header">
        <div class="brand-wrap">
          <button class="ha-menu-btn" id="ha-menu-toggle-btn" title="Open Home Assistant Sidebar Menu">
            ☰
          </button>
          <div class="brand-logo">🍽️</div>
          <div>
            <h1 class="brand-title">MealMind</h1>
            <p class="brand-subtitle">
              ${this._isCompanion ? "Shopping Companion" : "Smart Meal Planner"}
            </p>
          </div>
        </div>

        <div class="header-actions">
          ${
            this._isCompanion
              ? `<button class="btn btn-secondary btn-sm" id="exit-companion-btn">← Close</button>`
              : ""
          }
          <div class="menu-anchor">
            <button class="btn btn-secondary btn-sm" id="toggle-print-menu-btn">
              🖨️ Print ▾
            </button>
            ${
              this._printMenuOpen
                ? `
                  <div class="pop-menu pop-menu-wide">
                    <button class="pop-menu-item" id="top-print-today">
                      <span>📄</span>
                      <div>
                        <div>Today's Meal Card</div>
                        <span class="pop-menu-item-sub">Full recipe card with ingredients & notes for today</span>
                      </div>
                    </button>
                    <button class="pop-menu-item" id="top-print-7d-cards">
                      <span>🗂️</span>
                      <div>
                        <div>Next 7 Days' Meal Cards (All Planned)</div>
                        <span class="pop-menu-item-sub">Prints an individual full card for every planned day</span>
                      </div>
                    </button>
                    <button class="pop-menu-item" id="top-print-7d">
                      <span>📅</span>
                      <div>
                        <div>Next 7 Days Summary Ticket</div>
                        <span class="pop-menu-item-sub">Compact single-slip weekly schedule overview</span>
                      </div>
                    </button>
                    <div class="pop-menu-divider"></div>
                    <button class="pop-menu-item" id="top-print-shop">
                      <span>🛒</span>
                      <div>
                        <div>Shopping List (Food & Non-Food)</div>
                        <span class="pop-menu-item-sub">Checkbox paper list for pen check-off & photo scan</span>
                      </div>
                    </button>
                  </div>
                `
                : ""
            }
          </div>
        </div>
      </div>

      <!-- Desktop Segmented Navigation -->
      <div class="desktop-tabs">
        <button class="tab-btn ${this._activeTab === "calendar" ? "active" : ""}" data-tab="calendar">
          📅 Meal Calendar
        </button>
        <button class="tab-btn ${this._activeTab === "shop" ? "active" : ""}" data-tab="shop">
          🛒 Shopping List <span class="tab-count">${shopCount}</span>
        </button>
        <button class="tab-btn ${this._activeTab === "database" ? "active" : ""}" data-tab="database">
          🍲 Saved Meals <span class="tab-count">${mealCount}</span>
        </button>
        <button class="tab-btn ${this._activeTab === "ai" ? "active" : ""}" data-tab="ai">
          ✨ AI Chef
        </button>
        <button class="tab-btn ${this._activeTab === "prefs" ? "active" : ""}" data-tab="prefs">
          ⚙️ Preferences
        </button>
      </div>

      <!-- Main Tab Content -->
      <div class="tab-content">
        ${this._activeTab === "calendar" ? this._renderCalendarTab() : ""}
        ${this._activeTab === "database" ? this._renderDatabaseTab() : ""}
        ${this._activeTab === "ai" ? this._renderAiTab() : ""}
        ${this._activeTab === "shop" ? this._renderShoppingAndScanTab() : ""}
        ${this._activeTab === "prefs" ? this._renderPreferencesTab() : ""}
      </div>

      <!-- Mobile Thumb-Friendly Bottom Bar -->
      <nav class="mobile-bottom-nav">
        <button class="mob-nav-btn ${this._activeTab === "calendar" ? "active" : ""}" data-tab="calendar">
          <span class="mob-icon">📅</span>
          <span>Plan</span>
        </button>
        <button class="mob-nav-btn ${this._activeTab === "shop" ? "active" : ""}" data-tab="shop">
          <span class="mob-icon">🛒</span>
          <span>Shop (${shopCount})</span>
        </button>
        <button class="mob-nav-btn ${this._activeTab === "database" ? "active" : ""}" data-tab="database">
          <span class="mob-icon">🍲</span>
          <span>Meals (${mealCount})</span>
        </button>
        <button class="mob-nav-btn ${this._activeTab === "ai" ? "active" : ""}" data-tab="ai">
          <span class="mob-icon">✨</span>
          <span>AI Chef</span>
        </button>
        <button class="mob-nav-btn ${this._activeTab === "prefs" ? "active" : ""}" data-tab="prefs">
          <span class="mob-icon">⚙️</span>
          <span>Prefs</span>
        </button>
      </nav>

      ${this._renderModals()}
      ${
        this._toast
          ? `<div class="toast ${this._toast.isError ? "error" : ""}">
              <span>${this._escapeHtml(this._toast.msg)}</span>
              ${
                this._toast.undoAction
                  ? `<button class="toast-undo-btn" id="toast-undo-btn">${this._escapeHtml(this._toast.undoAction.label)}</button>`
                  : ""
              }
            </div>`
          : ""
      }
    `;

    this._attachListeners();
  }

  _attachListeners() {
    const root = this.shadowRoot;
    if (!root) return;

    // HA Sidebar Toggle (fixes missing sidebar button on Companion App!)
    const haMenuBtn = root.getElementById("ha-menu-toggle-btn");
    if (haMenuBtn) {
      haMenuBtn.onclick = () => this._toggleHaSidebar();
    }

    const exitCompanionBtn = root.getElementById("exit-companion-btn");
    if (exitCompanionBtn) {
      exitCompanionBtn.onclick = () => {
        if (window.opener) {
          window.close();
        } else {
          window.location.href = "/mealmind";
        }
      };
    }

    // Consolidated Print Dropdown Menu
    const togglePrintBtn = root.getElementById("toggle-print-menu-btn");
    if (togglePrintBtn) {
      togglePrintBtn.onclick = (e) => {
        e.stopPropagation();
        const next = !this._printMenuOpen;
        this._closeAllMenus();
        this._printMenuOpen = next;
        this._render();
      };
    }
    const btnToday = root.getElementById("top-print-today");
    if (btnToday) btnToday.onclick = () => this._handlePrint("today_card");
    const btn7dCards = root.getElementById("top-print-7d-cards");
    if (btn7dCards) btn7dCards.onclick = () => this._handlePrint("next_7_days_cards");
    const btn7d = root.getElementById("top-print-7d");
    if (btn7d) btn7d.onclick = () => this._handlePrint("next_7_days");
    const btnShop = root.getElementById("top-print-shop");
    if (btnShop) btnShop.onclick = () => this._handlePrint("shopping_list");

    // Toast Undo button
    const toastUndoBtn = root.getElementById("toast-undo-btn");
    if (toastUndoBtn && this._toast && this._toast.undoAction) {
      toastUndoBtn.onclick = () => {
        const ua = this._toast.undoAction;
        this._undoCompletedShoppingItem(ua.summary, ua.listType);
      };
    }

    // Tab navigation (Desktop & Mobile bottom nav)
    root.querySelectorAll(".tab-btn, .mob-nav-btn").forEach((btn) => {
      btn.onclick = () => {
        this._closeAllMenus();
        this._activeTab = btn.dataset.tab;
        this._render();
      };
    });

    // Calendar navigation & auto-schedule
    const prevWk = root.getElementById("cal-prev-week");
    if (prevWk) {
      prevWk.onclick = () => {
        this._dayOffset -= 7;
        this._render();
      };
    }
    const todayBtn = root.getElementById("cal-today");
    if (todayBtn) {
      todayBtn.onclick = () => {
        this._dayOffset = 0;
        this._render();
      };
    }
    const nextWk = root.getElementById("cal-next-week");
    if (nextWk) {
      nextWk.onclick = () => {
        this._dayOffset += 7;
        this._render();
      };
    }
    const autoBtn = root.getElementById("auto-schedule-btn");
    if (autoBtn) autoBtn.onclick = () => this._handleAutoSchedule();

    const cancelSwap = root.getElementById("cancel-swap-btn");
    if (cancelSwap) {
      cancelSwap.onclick = () => {
        this._swapSourceDate = null;
        this._render();
      };
    }

    // Queue delete
    root.querySelectorAll(".queue-del-btn").forEach((btn) => {
      btn.onclick = async () => {
        const res = await this._wsCall({
          type: "mealmind/queue/remove",
          queue_id: btn.dataset.qid,
        });
        this._updateLocalState(res);
      };
    });

    // Day Card 3-dot menu toggle & Expiry inline drawer toggle
    root.querySelectorAll(".card-menu-toggle-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const dStr = btn.dataset.date;
        const next = this._openCardMenuDate === dStr ? null : dStr;
        this._closeAllMenus();
        this._openCardMenuDate = next;
        this._render();
      };
    });

    root.querySelectorAll(".toggle-exp-popover-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const dStr = btn.dataset.date;
        this._closeAllMenus();
        this._openExpiryDate = this._openExpiryDate === dStr ? null : dStr;
        this._render();
      };
    });

    root.querySelectorAll(".exp-clear-btn").forEach((btn) => {
      btn.onclick = () => this._handleQuickExpiryChange(btn.dataset.date, "");
    });

    root.querySelectorAll(".print-day-card-btn").forEach((btn) => {
      btn.onclick = () => this._handlePrint("today_card", btn.dataset.date);
    });

    // Day Card Drag-and-Drop
    root.querySelectorAll(".day-card").forEach((card) => {
      const dStr = card.dataset.date;
      card.ondragstart = (ev) => {
        this._dragSourceDate = dStr;
        ev.dataTransfer.setData("text/plain", dStr);
      };
      card.ondragover = (ev) => {
        ev.preventDefault();
      };
      card.ondrop = (ev) => {
        ev.preventDefault();
        const src = this._dragSourceDate || ev.dataTransfer.getData("text/plain");
        if (src && src !== dStr) {
          this._handleSwapDays(src, dStr);
        }
      };
    });

    root.querySelectorAll(".swap-start-btn").forEach((btn) => {
      btn.onclick = () => {
        this._closeAllMenus();
        this._swapSourceDate =
          this._swapSourceDate === btn.dataset.date ? null : btn.dataset.date;
        this._render();
      };
    });
    root.querySelectorAll(".swap-target-btn").forEach((btn) => {
      btn.onclick = () => this._handleSwapDays(this._swapSourceDate, btn.dataset.date);
    });
    root.querySelectorAll(".pin-day-btn").forEach((btn) => {
      btn.onclick = () => this._handleTogglePin(btn.dataset.date);
    });
    root.querySelectorAll(".push-day-btn").forEach((btn) => {
      btn.onclick = () => this._handlePushDay(btn.dataset.date);
    });
    root.querySelectorAll(".skip-day-btn").forEach((btn) => {
      btn.onclick = () => this._handleSkipDay(btn.dataset.date);
    });
    root.querySelectorAll(".clear-day-btn").forEach((btn) => {
      btn.onclick = () => this._handleClearDay(btn.dataset.date);
    });
    root.querySelectorAll(".edit-day-btn").forEach((btn) => {
      btn.onclick = () => this._openDayModal(btn.dataset.date);
    });
    root.querySelectorAll(".shop-day-btn").forEach((btn) => {
      btn.onclick = () => {
        this._closeAllMenus();
        const slot = this._state.schedule[btn.dataset.date] || {};
        const dbMeal = slot.meal_id ? this._state.meals[slot.meal_id] : null;
        const ings =
          slot.ingredients && slot.ingredients.length > 0
            ? slot.ingredients
            : dbMeal
            ? dbMeal.ingredients || []
            : [];
        this._openIngredientReviewModal(
          slot.meal_name || (dbMeal && dbMeal.name) || "Meal",
          ings
        );
      };
    });
    root.querySelectorAll(".quick-exp-input").forEach((inp) => {
      inp.onchange = () => this._handleQuickExpiryChange(inp.dataset.date, inp.value);
    });
    root.querySelectorAll(".exp-shortcut-btn").forEach((btn) => {
      btn.onclick = () => {
        const dStr = btn.dataset.date;
        const days = Number(btn.dataset.days || 1);
        const expDate = this._addDaysStr(this._todayStr(), days);
        this._handleQuickExpiryChange(dStr, expDate);
      };
    });

    // Database tab listeners
    const dbSearch = root.getElementById("db-search-input");
    if (dbSearch) {
      dbSearch.oninput = () => {
        this._dbSearch = dbSearch.value;
        this._render();
        const el = this.shadowRoot.getElementById("db-search-input");
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      };
    }
    const dbFav = root.getElementById("db-fav-toggle");
    if (dbFav) {
      dbFav.onclick = () => {
        this._dbFavOnly = !this._dbFavOnly;
        this._render();
      };
    }
    root.querySelectorAll(".db-tag-chip").forEach((chip) => {
      chip.onclick = () => {
        const t = chip.dataset.tag;
        this._dbTagFilter = this._dbTagFilter === t ? "" : t;
        this._render();
      };
    });
    const newDbMealBtn = root.getElementById("new-db-meal-btn");
    if (newDbMealBtn) newDbMealBtn.onclick = () => this._openMealModal(null);
    const emptyNewDbBtn = root.getElementById("empty-new-db-meal-btn");
    if (emptyNewDbBtn) emptyNewDbBtn.onclick = () => this._openMealModal(null);

    root.querySelectorAll(".db-menu-toggle-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const next = this._openDbMenuId === id ? null : id;
        this._closeAllMenus();
        this._openDbMenuId = next;
        this._render();
      };
    });

    root.querySelectorAll(".db-star-btn").forEach((btn) => {
      btn.onclick = () => {
        const meal = this._state.meals[btn.dataset.id];
        if (meal) this._toggleMealFavourite(meal);
      };
    });
    root.querySelectorAll(".db-edit-btn").forEach((btn) => {
      btn.onclick = () => {
        const meal = this._state.meals[btn.dataset.id];
        if (meal) this._openMealModal(meal);
      };
    });
    root.querySelectorAll(".db-del-btn").forEach((btn) => {
      btn.onclick = () => this._deleteMeal(btn.dataset.id);
    });
    root.querySelectorAll(".db-plan-next-btn").forEach((btn) => {
      btn.onclick = () => {
        const meal = this._state.meals[btn.dataset.id];
        if (meal) this._quickScheduleMeal(meal, null, true);
      };
    });
    root.querySelectorAll(".db-pick-day-btn").forEach((btn) => {
      btn.onclick = () => {
        const meal = this._state.meals[btn.dataset.id];
        if (meal) {
          this._openDayModal(this._findNextOpenDateStr(), "custom");
          this._selectDbMealInDayModal(meal);
        }
      };
    });
    root.querySelectorAll(".db-shop-btn").forEach((btn) => {
      btn.onclick = () => {
        this._closeAllMenus();
        const meal = this._state.meals[btn.dataset.id];
        if (meal) this._openIngredientReviewModal(meal.name, meal.ingredients || []);
      };
    });

    // AI Tab listeners
    const aiGuestToggle = root.getElementById("ai-guest-toggle");
    if (aiGuestToggle) {
      aiGuestToggle.onchange = () => {
        this._aiGuestMode = aiGuestToggle.checked;
        this._render();
      };
    }
    const aiGuestNotes = root.getElementById("ai-guest-notes");
    if (aiGuestNotes) {
      aiGuestNotes.oninput = () => {
        this._aiGuestNotes = aiGuestNotes.value;
      };
    }
    const aiExtraPrompt = root.getElementById("ai-extra-prompt");
    if (aiExtraPrompt) {
      aiExtraPrompt.oninput = () => {
        this._aiExtraPrompt = aiExtraPrompt.value;
      };
    }
    const runAiBtn = root.getElementById("run-ai-suggest-btn");
    if (runAiBtn) runAiBtn.onclick = () => this._runAiSuggest();

    root.querySelectorAll(".ai-plan-db-btn").forEach((btn) => {
      btn.onclick = () => {
        const item = (this._aiResults.db_suggestions || [])[Number(btn.dataset.idx)];
        if (item) this._quickScheduleMeal(item, null, true);
      };
    });
    root.querySelectorAll(".ai-plan-new-btn").forEach((btn) => {
      btn.onclick = () => {
        const item = (this._aiResults.ai_suggestions || [])[Number(btn.dataset.idx)];
        if (item) this._quickScheduleMeal(item, null, true);
      };
    });
    root.querySelectorAll(".ai-save-only-btn").forEach((btn) => {
      btn.onclick = async () => {
        const item = (this._aiResults.ai_suggestions || [])[Number(btn.dataset.idx)];
        if (!item) return;
        const res = await this._wsCall({
          type: "mealmind/meals/save",
          meal: {
            name: item.name,
            ingredients: item.ingredients || [],
            tags: item.tags || [],
            notes: item.notes || "",
            favourite: false,
          },
        });
        this._updateLocalState(res);
        this._showToast(`Saved '${item.name}' to your Meal Database!`);
      };
    });

    // Shopping & Scan Tab listeners
    const shopMoreBtn = root.getElementById("shop-more-menu-btn");
    if (shopMoreBtn) {
      shopMoreBtn.onclick = (e) => {
        e.stopPropagation();
        const next = !this._shopMoreMenuOpen;
        this._closeAllMenus();
        this._shopMoreMenuOpen = next;
        this._render();
      };
    }

    const openUnpackBtn = root.getElementById("open-unpack-modal-btn");
    if (openUnpackBtn) {
      openUnpackBtn.onclick = () => {
        this._closeAllMenus();
        this._unpackModal = true;
        this._render();
      };
    }

    const popoutBtn = root.getElementById("popout-companion-btn");
    if (popoutBtn) popoutBtn.onclick = () => this._openCompanionPopup();
    const printShopBtn = root.getElementById("print-shop-btn");
    if (printShopBtn) printShopBtn.onclick = () => this._handlePrint("shopping_list");

    const heroSavedBtn = root.getElementById("hero-add-saved-meal-btn");
    if (heroSavedBtn) {
      heroSavedBtn.onclick = () => this._openDayModal(this._findNextOpenDateStr(), "pick");
    }
    const heroCustomBtn = root.getElementById("hero-add-custom-meal-btn");
    if (heroCustomBtn) {
      heroCustomBtn.onclick = () => this._openDayModal(this._findNextOpenDateStr(), "custom");
    }

    root.querySelectorAll(".quick-open-picker-btn").forEach((btn) => {
      btn.onclick = () => {
        this._unpackModal = false;
        this._openDayModal(this._findNextOpenDateStr(), "pick");
      };
    });
    root.querySelectorAll(".quick-open-custom-btn").forEach((btn) => {
      btn.onclick = () => {
        this._unpackModal = false;
        this._openDayModal(this._findNextOpenDateStr(), "custom");
      };
    });
    root.querySelectorAll(".quick-auto-schedule-btn").forEach((btn) => {
      btn.onclick = () => this._handleAutoSchedule();
    });

    const reopenScanModalBtn = root.getElementById("reopen-scan-modal-btn");
    if (reopenScanModalBtn) {
      reopenScanModalBtn.onclick = () => {
        this._closeAllMenus();
        this._postScanModal = true;
        this._render();
      };
    }

    // Food vs Non-Food Category switcher
    root.querySelectorAll(".shop-cat-btn").forEach((btn) => {
      btn.onclick = () => {
        this._shopListCategory = btn.dataset.cat || "food";
        this._render();
      };
    });

    const quickShopInput = root.getElementById("quick-shop-item-input");
    const quickShopBtn = root.getElementById("quick-shop-item-btn");
    const quickAddFoodBtn = root.getElementById("quick-shop-add-food-btn");
    const quickAddNfBtn = root.getElementById("quick-shop-add-nf-btn");

    const targetListType =
      this._shopListCategory === "non_food" ? "non_food" : "food";

    if (quickShopBtn && quickShopInput) {
      quickShopBtn.onclick = () => {
        this._addSingleShoppingItem(quickShopInput.value, targetListType);
        quickShopInput.value = "";
      };
    }
    if (quickAddFoodBtn && quickShopInput) {
      quickAddFoodBtn.onclick = () => {
        this._addSingleShoppingItem(quickShopInput.value, "food");
        quickShopInput.value = "";
      };
    }
    if (quickAddNfBtn && quickShopInput) {
      quickAddNfBtn.onclick = () => {
        this._addSingleShoppingItem(quickShopInput.value, "non_food");
        quickShopInput.value = "";
      };
    }
    if (quickShopInput) {
      quickShopInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          this._addSingleShoppingItem(quickShopInput.value, targetListType);
          quickShopInput.value = "";
        }
      };
    }

    // Explicit checkbox button only!
    root.querySelectorAll(".shop-check-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this._completeShoppingItem(
          btn.dataset.uid,
          btn.dataset.summary,
          btn.dataset.listType || "food"
        );
      };
    });

    // Undo / Restore recently completed items
    const undoLatestBtn = root.getElementById("undo-latest-btn");
    if (undoLatestBtn && this._recentlyCompleted.length > 0) {
      undoLatestBtn.onclick = () => {
        const latest = this._recentlyCompleted[0];
        this._undoCompletedShoppingItem(latest.summary, latest.listType);
      };
    }
    const toggleRecentBtn = root.getElementById("toggle-recent-completed-btn");
    if (toggleRecentBtn) {
      toggleRecentBtn.onclick = () => {
        this._showRecentlyCompleted = !this._showRecentlyCompleted;
        this._render();
      };
    }
    root.querySelectorAll(".restore-chip-btn").forEach((btn) => {
      btn.onclick = () => {
        this._undoCompletedShoppingItem(
          btn.dataset.summary,
          btn.dataset.listType || "food"
        );
      };
    });

    root.querySelectorAll(".copy-shop-btn").forEach((btn) => {
      btn.onclick = () => {
        navigator.clipboard.writeText(btn.dataset.text || "");
        this._showToast(`📋 Copied '${btn.dataset.text}' to clipboard!`);
      };
    });

    const receiptInput = root.getElementById("receipt-file-input");
    if (receiptInput) {
      receiptInput.onchange = (e) => this._handleReceiptFileChange(e);
    }

    root.querySelectorAll(".quick-remove-day-btn").forEach((btn) => {
      btn.onclick = () => this._handleClearDay(btn.dataset.date);
    });

    // Preferences Tab listeners
    const savePrefsBtn = root.getElementById("save-prefs-btn");
    if (savePrefsBtn) {
      savePrefsBtn.onclick = async () => {
        const diet = root.getElementById("pref-diet").value.trim();
        const dislikesRaw = root.getElementById("pref-dislikes").value;
        const dislikes = dislikesRaw
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const custom = root.getElementById("pref-custom").value.trim();
        const todo = root.getElementById("pref-todo").value.trim();
        const nfTodoEl = root.getElementById("pref-non-food-todo");
        const nfTodo = nfTodoEl ? nfTodoEl.value.trim() : "todo.non_food_shopping";
        const printer = root.getElementById("pref-printer").value.trim();

        const res = await this._wsCall({
          type: "mealmind/settings/update",
          settings: {
            dietary_profile: diet,
            dislikes,
            custom_preferences: custom,
            todo_entity: todo,
            non_food_todo_entity: nfTodo,
            printer_entity: printer,
          },
        });
        this._updateLocalState(res);
        this._showToast("💾 Saved preferences!");
      };
    }

    // Modal 1: Searchable Day / Meal Assignment Modal listeners
    if (this._dayModal) {
      const modePickBtn = root.getElementById("day-mode-pick-btn");
      if (modePickBtn) {
        modePickBtn.onclick = () => {
          this._dayModal.mode = "pick";
          this._render();
        };
      }
      const modeCustomBtn = root.getElementById("day-mode-custom-btn");
      if (modeCustomBtn) {
        modeCustomBtn.onclick = () => {
          this._dayModal.mode = "custom";
          this._render();
        };
      }

      const pickerSearch = root.getElementById("picker-search-input");
      if (pickerSearch) {
        pickerSearch.oninput = () => {
          this._dayModal.search = pickerSearch.value;
          this._render();
          const el = this.shadowRoot.getElementById("picker-search-input");
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        };
      }

      const pickerFavBtn = root.getElementById("picker-fav-btn");
      if (pickerFavBtn) {
        pickerFavBtn.onclick = () => {
          this._dayModal.favOnly = !this._dayModal.favOnly;
          this._render();
        };
      }

      root.querySelectorAll(".picker-tag-btn").forEach((btn) => {
        btn.onclick = () => {
          this._dayModal.tagFilter = btn.dataset.tag || "";
          this._render();
        };
      });

      const pickerCreateNewBtn = root.getElementById("picker-create-new-btn");
      if (pickerCreateNewBtn) {
        pickerCreateNewBtn.onclick = () => {
          this._dayModal.meal_name = this._dayModal.search || "";
          this._dayModal.mode = "custom";
          this._render();
        };
      }

      root.querySelectorAll(".picker-quick-assign").forEach((el) => {
        el.onclick = () => {
          const meal = this._state.meals[el.dataset.id];
          if (meal) this._quickAssignFromPicker(meal);
        };
      });

      root.querySelectorAll(".picker-customize-btn").forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const meal = this._state.meals[btn.dataset.id];
          if (meal) this._selectDbMealInDayModal(meal);
        };
      });

      const nameInp = root.getElementById("day-modal-name");
      if (nameInp) nameInp.oninput = () => (this._dayModal.meal_name = nameInp.value);

      const dateChangeInp = root.getElementById("day-modal-date-change");
      if (dateChangeInp) {
        dateChangeInp.onchange = () => {
          if (dateChangeInp.value) this._dayModal.date = dateChangeInp.value;
        };
      }

      const newIngInp = root.getElementById("day-modal-new-ing");
      const addIngBtn = root.getElementById("day-modal-add-ing-btn");
      const addDayIng = () => {
        if (!newIngInp || !newIngInp.value.trim()) return;
        newIngInp.value.split(",").forEach((x) => {
          if (x.trim() && !this._dayModal.ingredients.includes(x.trim())) {
            this._dayModal.ingredients.push(x.trim());
          }
        });
        this._dayModal.newIngredient = "";
        this._render();
      };
      if (addIngBtn) addIngBtn.onclick = addDayIng;
      if (newIngInp) {
        newIngInp.oninput = () => (this._dayModal.newIngredient = newIngInp.value);
        newIngInp.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addDayIng();
          }
        };
      }
      root.querySelectorAll(".day-ing-del").forEach((btn) => {
        btn.onclick = () => {
          this._dayModal.ingredients.splice(Number(btn.dataset.idx), 1);
          this._render();
        };
      });

      const expInp = root.getElementById("day-modal-expiry");
      if (expInp) expInp.onchange = () => (this._dayModal.shortest_expiry = expInp.value);
      const notesInp = root.getElementById("day-modal-notes");
      if (notesInp) notesInp.oninput = () => (this._dayModal.notes = notesInp.value);
      const pinChk = root.getElementById("day-modal-pin");
      if (pinChk) pinChk.onchange = () => (this._dayModal.pinned = pinChk.checked);
      const askShopChk = root.getElementById("day-modal-ask-shop");
      if (askShopChk) {
        askShopChk.onchange = () =>
          (this._dayModal.reviewIngredientsAfterSave = askShopChk.checked);
      }

      const closeDayModal = () => {
        this._dayModal = null;
        this._render();
      };
      const cancelBtn = root.getElementById("day-modal-cancel");
      if (cancelBtn) cancelBtn.onclick = closeDayModal;
      const cancelBtn2 = root.getElementById("day-modal-cancel-btn");
      if (cancelBtn2) cancelBtn2.onclick = closeDayModal;

      const saveBtn = root.getElementById("day-modal-save");
      if (saveBtn) saveBtn.onclick = () => this._saveDayModal();
    }

    // Modal 2: Meal Database Modal listeners
    if (this._mealModal) {
      const nameInp = root.getElementById("meal-modal-name");
      if (nameInp) nameInp.oninput = () => (this._mealModal.name = nameInp.value);

      const newIngInp = root.getElementById("meal-modal-new-ing");
      const addIngBtn = root.getElementById("meal-modal-add-ing-btn");
      const addMealIng = () => {
        if (!newIngInp || !newIngInp.value.trim()) return;
        newIngInp.value.split(",").forEach((x) => {
          if (x.trim() && !this._mealModal.ingredients.includes(x.trim())) {
            this._mealModal.ingredients.push(x.trim());
          }
        });
        this._mealModal.newIngredient = "";
        this._render();
      };
      if (addIngBtn) addIngBtn.onclick = addMealIng;
      if (newIngInp) {
        newIngInp.oninput = () => (this._mealModal.newIngredient = newIngInp.value);
        newIngInp.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addMealIng();
          }
        };
      }
      root.querySelectorAll(".meal-ing-del").forEach((btn) => {
        btn.onclick = () => {
          this._mealModal.ingredients.splice(Number(btn.dataset.idx), 1);
          this._render();
        };
      });

      const newTagInp = root.getElementById("meal-modal-new-tag");
      const addTagBtn = root.getElementById("meal-modal-add-tag-btn");
      const addMealTag = () => {
        if (!newTagInp || !newTagInp.value.trim()) return;
        newTagInp.value.split(",").forEach((x) => {
          if (x.trim() && !this._mealModal.tags.includes(x.trim())) {
            this._mealModal.tags.push(x.trim());
          }
        });
        this._mealModal.newTag = "";
        this._render();
      };
      if (addTagBtn) addTagBtn.onclick = addMealTag;
      if (newTagInp) {
        newTagInp.oninput = () => (this._mealModal.newTag = newTagInp.value);
        newTagInp.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addMealTag();
          }
        };
      }
      root.querySelectorAll(".meal-tag-del").forEach((btn) => {
        btn.onclick = () => {
          this._mealModal.tags.splice(Number(btn.dataset.idx), 1);
          this._render();
        };
      });

      const notesInp = root.getElementById("meal-modal-notes");
      if (notesInp) notesInp.oninput = () => (this._mealModal.notes = notesInp.value);
      const favChk = root.getElementById("meal-modal-fav");
      if (favChk) favChk.onchange = () => (this._mealModal.favourite = favChk.checked);

      const closeMealModal = () => {
        this._mealModal = null;
        this._render();
      };
      const cancelBtn = root.getElementById("meal-modal-cancel");
      if (cancelBtn) cancelBtn.onclick = closeMealModal;
      const closeBtn = root.getElementById("meal-modal-close");
      if (closeBtn) closeBtn.onclick = closeMealModal;
      const saveBtn = root.getElementById("meal-modal-save");
      if (saveBtn) saveBtn.onclick = () => this._saveMealModal();
    }

    // Modal 3: Mid-Step Ingredient Review Modal listeners
    if (this._ingredientReviewModal) {
      root.querySelectorAll(".ing-review-check").forEach((chk) => {
        chk.onchange = () => {
          const idx = Number(chk.dataset.idx);
          if (this._ingredientReviewModal.items[idx]) {
            this._ingredientReviewModal.items[idx].checked = chk.checked;
          }
        };
      });
      const extraInp = root.getElementById("ing-review-extra");
      if (extraInp) {
        extraInp.oninput = () => (this._ingredientReviewModal.extraItem = extraInp.value);
      }
      const skipBtn = root.getElementById("ing-review-skip");
      if (skipBtn) {
        skipBtn.onclick = () => {
          this._ingredientReviewModal = null;
          this._render();
        };
      }
      const confirmBtn = root.getElementById("ing-review-confirm");
      if (confirmBtn) confirmBtn.onclick = () => this._confirmIngredientReview();
    }

    // Modal 4: Post-Scan Results & Planned Meals Review Sheet
    if (this._postScanModal) {
      const closeScan = () => {
        this._postScanModal = false;
        this._render();
      };
      const closeBtn = root.getElementById("close-post-scan-modal");
      if (closeBtn) closeBtn.onclick = closeScan;
      const doneBtn = root.getElementById("done-post-scan-modal");
      if (doneBtn) doneBtn.onclick = closeScan;
    }

    // Modal 5: Unpack / Expiry Modal Sheet
    if (this._unpackModal) {
      const closeUnpack = () => {
        this._unpackModal = false;
        this._render();
      };
      const closeBtn = root.getElementById("close-unpack-modal");
      if (closeBtn) closeBtn.onclick = closeUnpack;
      const doneBtn = root.getElementById("done-unpack-modal");
      if (doneBtn) doneBtn.onclick = closeUnpack;
    }
  }
}

if (!customElements.get("mealmind-panel")) {
  customElements.define("mealmind-panel", MealMindPanel);
}
