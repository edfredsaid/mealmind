/**
 * MealMind Custom Sidebar Panel for Home Assistant
 * Supports:
 * - Multi-week advance Meal Plan Calendar with Drag & Drop, Push (+1d), Skip, Pin, Swap, and Shortest Expiry Date badges
 * - Auto-Scheduling by shortest ingredient expiry date
 * - Persistent Meal Database with ★ Favourites, ingredient pill tagging, and search
 * - Mid-Step Ingredient Review Modal (untick items already in stock before adding to todo.shopping_list)
 * - AI Meal Suggestions (Database/Favourites + New Gemini Recipes) with "We Have Guests / Special Occasion" override
 * - Online Shopping Companion Pop-Out Window with two-way Quick Meal Add/Remove & Expiry Unpack mode
 * - In-Store Paper Receipt Photo Scanner (Gemini Vision) + Post-Scan Planned Meals Summary & Quick Meal Add
 * - ESC/POS Thermal Printer missions (Print Today's Card, Print Next 7 Days, Print Shopping List)
 */

class MealMindPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._initialized = false;
    this._loading = false;
    this._toast = null;

    const params = new URLSearchParams(window.location.search);
    this._isCompanion = params.get("companion") === "1";
    this._activeTab = this._isCompanion ? "shop" : "calendar";
    this._companionSubTab = "list"; // 'list' | 'meals' | 'expiry'

    // Calendar window state: offset in weeks from current week's Monday (or Today)
    this._dayOffset = 0;
    this._numDaysView = 14;
    this._swapSourceDate = null;
    this._dragSourceDate = null;

    // Data from backend
    this._state = {
      settings: {
        dietary_profile: "Vegetarian",
        dislikes: ["feta", "beetroot"],
        custom_preferences: "",
        todo_entity: "todo.shopping_list",
        printer_entity: "notify.hall_stairs_hallway_receipt_printer",
      },
      meals: {},
      schedule: {},
      queue: [],
      all_ingredients: [],
      shopping_list: [],
    };

    // Modals & transient UI states
    this._dayModal = null; // { date, meal_id, meal_name, ingredients, shortest_expiry, pinned, notes, askShop }
    this._mealModal = null; // { id, name, ingredients: [], tags: [], notes, favourite }
    this._ingredientReviewModal = null; // { mealName, items: [{name, checked, onList}], extraItem: '' }
    this._skipModal = null; // { date, reason }

    // Database filters
    this._dbSearch = "";
    this._dbFavOnly = false;
    this._dbTagFilter = "";

    // AI state
    this._aiGuestMode = false;
    this._aiGuestNotes = "";
    this._aiExtraPrompt = "";
    this._aiLoading = false;
    this._aiResults = null; // { db_suggestions: [], ai_suggestions: [] }

    // Receipt Scanner state
    this._scanLoading = false;
    this._scanSummary = null; // { bought_items: [], still_needed_items: [], notes: '', completed_summaries: [] }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized && hass) {
      this._initialized = true;
      this._fetchState();
    }
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
    this._render();
  }

  _showToast(msg, isError = false) {
    this._toast = { msg, isError };
    this._render();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._render();
    }, 4500);
  }

  // ---------------------------------------------------------------------------
  // Date Helpers
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
    if (dateStr === today) return `Today (${label})`;
    if (dateStr === tomorrow) return `Tomorrow (${label})`;
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
        text: `⚠️ Exp ${shortFmt} (Overdue!)`,
        cls: "badge-danger",
      };
    }
    if (expiryDateStr === today || expiryDateStr === tomorrow || expiryDateStr === scheduledDateStr) {
      return {
        text: `⏳ Exp ${shortFmt} (Use Soon)`,
        cls: "badge-warn",
      };
    }
    return {
      text: `📅 Exp ${shortFmt}`,
      cls: "badge-ok",
    };
  }

  // ---------------------------------------------------------------------------
  // Ingredient Review Modal (Mid-Step before adding to Shopping List)
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
        checked: !already, // Pre-check items not already on list; user can untick what they have in stock
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
      this._showToast("No ingredients needed adding to the shopping list.");
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
      this._showToast(`Added ${count} item(s) to the shopping list!`);
    } catch (err) {
      this._showToast("Error adding items: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async _handlePrint(mission, dateStr = null) {
    try {
      this._showToast("Sending job to receipt printer...");
      await this._wsCall({
        type: "mealmind/printer/print",
        mission,
        date: dateStr,
      });
      this._showToast("Printed successfully!");
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
        this._showToast("Pushed meal forward (+1 day)!");
      }
    } catch (err) {
      this._showToast("Push error: " + (err.message || err), true);
    }
  }

  async _handleSkipDay(dateStr, reason = "Eating Out / Skip") {
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/skip_day",
        date: dateStr,
        skip_reason: reason,
        push_existing: true,
      });
      this._updateLocalState(res);
      const skipped = res.action_result && res.action_result.skipped;
      this._showToast(skipped ? `Marked ${dateStr} as skipped & pushed meal!` : `Cleared skip on ${dateStr}`);
    } catch (err) {
      this._showToast("Skip error: " + (err.message || err), true);
    }
  }

  async _handleTogglePin(dateStr) {
    const entry = this._state.schedule[dateStr];
    if (!entry) return;
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/set_day",
        date: dateStr,
        pinned: !entry.pinned,
      });
      this._updateLocalState(res);
    } catch (err) {
      this._showToast("Pin error: " + (err.message || err), true);
    }
  }

  async _handleClearDay(dateStr) {
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/clear_day",
        date: dateStr,
      });
      this._updateLocalState(res);
      this._showToast(`Cleared meal on ${dateStr}`);
    } catch (err) {
      this._showToast("Clear error: " + (err.message || err), true);
    }
  }

  async _handleSwapDays(dateA, dateB) {
    if (!dateA || !dateB || dateA === dateB) return;
    try {
      const res = await this._wsCall({
        type: "mealmind/schedule/swap_days",
        date_a: dateA,
        date_b: dateB,
      });
      this._swapSourceDate = null;
      this._updateLocalState(res);
      this._showToast(`Swapped ${dateA} ↔ ${dateB}`);
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
      this._updateLocalState(res);
      this._showToast(newExpiry ? `Updated expiry to ${newExpiry}` : "Cleared expiry date");
    } catch (err) {
      this._showToast("Failed to update expiry: " + (err.message || err), true);
    }
  }

  _openDayModal(dateStr, prefillMeal = null) {
    const existing = this._state.schedule[dateStr] || {};
    const mealId = prefillMeal ? prefillMeal.id : existing.meal_id || "";
    const dbMeal = mealId && this._state.meals[mealId] ? this._state.meals[mealId] : {};
    const mealName = prefillMeal
      ? prefillMeal.name
      : existing.meal_name || dbMeal.name || "";
    const ingredients = prefillMeal
      ? [...(prefillMeal.ingredients || [])]
      : [...(dbMeal.ingredients || [])];

    this._dayModal = {
      date: dateStr,
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

  async _saveDayModal() {
    if (!this._dayModal) return;
    const m = this._dayModal;
    if (!m.meal_name.trim()) {
      this._showToast("Please enter or select a meal name.", true);
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
      this._showToast(`Scheduled '${mealNameCopy}' on ${m.date}`);
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
    const dateStr = targetDateStr || this._findNextOpenDateStr();
    try {
      // Save to DB first if it has no id
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
      this._showToast(`Scheduled '${mealObj.name}' on ${this._formatDisplayDate(dateStr)}!`);
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
        img.onerror = () => resolve({ dataUrl: reader.result, mimeType: file.type || "image/jpeg" });
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
    this._scanSummary = null;
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
      this._updateLocalState(res);
      this._showToast(
        `Checked off ${(res.completed_summaries || []).length} crossed-out/ticked item(s)!`
      );
    } catch (err) {
      this._scanLoading = false;
      this._showToast("Receipt photo scan failed: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Shopping List Actions & Pop-Out Window
  // ---------------------------------------------------------------------------

  async _completeShoppingItem(uidOrSummary) {
    try {
      const res = await this._wsCall({
        type: "mealmind/shopping/complete_items",
        items: [uidOrSummary],
      });
      this._updateLocalState(res);
    } catch (err) {
      this._showToast("Failed to tick off item: " + (err.message || err), true);
    }
  }

  async _addSingleShoppingItem(itemText) {
    if (!itemText || !itemText.trim()) return;
    try {
      const res = await this._wsCall({
        type: "mealmind/shopping/add_items",
        items: [itemText.trim()],
      });
      this._updateLocalState(res);
    } catch (err) {
      this._showToast("Failed to add item: " + (err.message || err), true);
    }
  }

  _openCompanionPopup() {
    window.open(
      "/mealmind?companion=1",
      "MealMindOnlineShop",
      "width=430,height=840,resizable=yes,scrollbars=yes"
    );
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _renderPlannedMealsQuickWidget() {
    const today = this._todayStr();
    const upcoming = [];
    for (let i = 0; i < 10; i++) {
      const dStr = this._addDaysStr(today, i);
      const slot = this._state.schedule[dStr];
      if (slot && !slot.skipped && (slot.meal_id || slot.meal_name)) {
        upcoming.push({ date: dStr, ...slot });
      }
    }
    const mealsList = Object.values(this._state.meals).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return `
      <div class="card" style="margin-top: 14px;">
        <div class="section-header">
          <div>
            <h3 style="margin:0;">📅 Planned Meals & Quick In-Store / Online Add</h3>
            <div class="subtext">Got inspiration while shopping? Add or remove meals & set shortest expiry dates right here.</div>
          </div>
          <button class="btn btn-primary btn-sm" id="widget-auto-schedule-btn">✨ Auto-Schedule by Expiry</button>
        </div>

        <div class="quick-add-row" style="margin: 12px 0; display:flex; gap:8px; flex-wrap:wrap;">
          <select id="widget-pick-db-meal" class="input" style="flex:1; min-width:160px;">
            <option value="">-- Pick saved meal from Database --</option>
            ${mealsList
              .map(
                (m) =>
                  `<option value="${this._escapeHtml(m.id)}">${m.favourite ? "★ " : ""}${this._escapeHtml(m.name)}</option>`
              )
              .join("")}
          </select>
          <button class="btn btn-secondary btn-sm" id="widget-add-db-meal-btn">+ Plan Saved Meal</button>
          <button class="btn btn-primary btn-sm" id="widget-new-meal-btn">+ New Inspired Meal</button>
        </div>

        ${
          upcoming.length === 0
            ? `<div class="empty-box">No meals currently scheduled for the next 10 days.</div>`
            : `<div class="compact-meal-list">
                ${upcoming
                  .map((item) => {
                    const badge = this._getExpiryBadge(item.date, item.shortest_expiry);
                    return `
                      <div class="compact-meal-row">
                        <div style="flex:1; min-width:140px;">
                          <div style="font-size:12px; opacity:0.75;">${this._escapeHtml(this._formatDisplayDate(item.date))}</div>
                          <div style="font-weight:600;">${this._escapeHtml(item.meal_name)}</div>
                          ${badge ? `<span class="badge ${badge.cls}">${this._escapeHtml(badge.text)}</span>` : ""}
                        </div>
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                          <label style="font-size:11px; opacity:0.8;">Shortest Exp:</label>
                          <input type="date" class="input input-sm quick-exp-input" data-date="${item.date}" value="${item.shortest_expiry || ""}" />
                          <button class="btn btn-danger btn-xs quick-remove-day-btn" data-date="${item.date}" title="Remove meal">✕</button>
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
      const ingredients = dbMeal ? dbMeal.ingredients || [] : [];
      const badge = this._getExpiryBadge(dStr, slot.shortest_expiry);
      const isSwapSelected = this._swapSourceDate === dStr;

      daysHtml.push(`
        <div class="day-card ${dStr === today ? "day-today" : ""} ${isSkipped ? "day-skipped" : ""} ${isSwapSelected ? "day-swap-active" : ""}"
             draggable="true"
             data-date="${dStr}">
          <div class="day-card-header">
            <div class="day-title">
              <span>${this._escapeHtml(this._formatDisplayDate(dStr))}</span>
              ${isPinned ? `<span class="badge badge-pin" title="Pinned to this day">📌 Pinned</span>` : ""}
              ${badge && !isSkipped ? `<span class="badge ${badge.cls}">${this._escapeHtml(badge.text)}</span>` : ""}
            </div>
            <div class="day-actions">
              ${
                this._swapSourceDate && this._swapSourceDate !== dStr
                  ? `<button class="btn btn-primary btn-xs swap-target-btn" data-date="${dStr}">⇄ Swap Here</button>`
                  : `<button class="btn btn-ghost btn-xs swap-start-btn" data-date="${dStr}" title="Swap with another day">⇄</button>`
              }
              ${
                mealName && !isSkipped
                  ? `
                    <button class="btn btn-ghost btn-xs pin-day-btn" data-date="${dStr}" title="${isPinned ? "Unpin" : "Pin to this date"}">📌</button>
                    <button class="btn btn-ghost btn-xs push-day-btn" data-date="${dStr}" title="Push meal +1 day">⏭️ +1d</button>
                    <button class="btn btn-ghost btn-xs shop-day-btn" data-date="${dStr}" title="Review & add ingredients to shopping list">🛒</button>
                  `
                  : ""
              }
              <button class="btn btn-ghost btn-xs skip-day-btn" data-date="${dStr}" title="${isSkipped ? "Unskip day" : "Skip day & push meal"}">
                ${isSkipped ? "↩️ Unskip" : "🚫 Skip"}
              </button>
              ${
                mealName || isSkipped
                  ? `<button class="btn btn-ghost btn-xs clear-day-btn" data-date="${dStr}" title="Clear day">✕</button>`
                  : ""
              }
            </div>
          </div>

          <div class="day-card-body">
            ${
              isSkipped
                ? `<div class="skipped-banner">🚫 ${this._escapeHtml(slot.skip_reason || "Skipped / Eating Out")}</div>`
                : mealName
                ? `
                  <div class="meal-main-row">
                    <div class="meal-title-edit" data-date="${dStr}">
                      ${isFav ? `<span class="fav-star">★</span> ` : ""}
                      <strong>${this._escapeHtml(mealName)}</strong>
                    </div>
                  </div>
                  ${
                    ingredients.length > 0
                      ? `<div class="pill-row">
                          ${ingredients.map((ing) => `<span class="pill">${this._escapeHtml(ing)}</span>`).join("")}
                        </div>`
                      : ""
                  }
                  <div class="expiry-row">
                    <label>Shortest Ingredient Date:</label>
                    <input type="date" class="input input-xs quick-exp-input" data-date="${dStr}" value="${slot.shortest_expiry || ""}" />
                    <button class="btn btn-ghost btn-xs exp-shortcut-btn" data-date="${dStr}" data-days="1">+1d</button>
                    <button class="btn btn-ghost btn-xs exp-shortcut-btn" data-date="${dStr}" data-days="2">+2d</button>
                    <button class="btn btn-ghost btn-xs exp-shortcut-btn" data-date="${dStr}" data-days="4">+4d</button>
                    <button class="btn btn-ghost btn-xs edit-day-btn" data-date="${dStr}">✎ Edit</button>
                  </div>
                `
                : `
                  <div class="empty-day-row">
                    <button class="btn btn-secondary btn-sm edit-day-btn" data-date="${dStr}">+ Plan Meal</button>
                  </div>
                `
            }
          </div>
        </div>
      `);
    }

    const queue = this._state.queue || [];

    return `
      <div class="toolbar-card">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="cal-prev-week">◀ Prev Week</button>
          <button class="btn btn-secondary btn-sm" id="cal-today">Today</button>
          <button class="btn btn-secondary btn-sm" id="cal-next-week">Next Week ▶</button>
          <span style="font-weight:600; margin-left:6px;">
            ${this._escapeHtml(this._formatDisplayDate(startStr))} – ${this._escapeHtml(this._formatDisplayDate(endStr))}
          </span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          ${
            this._swapSourceDate
              ? `<button class="btn btn-warn btn-sm" id="cancel-swap-btn">Cancel Swap (${this._swapSourceDate})</button>`
              : ""
          }
          <button class="btn btn-primary btn-sm" id="auto-schedule-btn">
            ✨ Auto-Schedule by Shortest Expiry
          </button>
        </div>
      </div>

      ${
        queue.length > 0
          ? `
            <div class="card queue-card">
              <div class="section-header">
                <strong>🧺 Unscheduled Meal Queue (${queue.length})</strong>
                <span class="subtext">Click "Auto-Schedule by Shortest Expiry" to slot these into open days automatically.</span>
              </div>
              <div class="pill-row" style="margin-top:8px;">
                ${queue
                  .map(
                    (q) => `
                    <span class="pill pill-lg">
                      ${this._escapeHtml(q.meal_name)}
                      ${q.shortest_expiry ? ` (Exp: ${this._escapeHtml(q.shortest_expiry)})` : ""}
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
      <div class="toolbar-card">
        <div style="display:flex; gap:8px; flex-wrap:wrap; flex:1;">
          <input type="text" id="db-search-input" class="input" placeholder="Search meals or ingredients..." value="${this._escapeHtml(this._dbSearch)}" style="min-width:220px; flex:1;" />
          <button class="btn ${this._dbFavOnly ? "btn-primary" : "btn-secondary"} btn-sm" id="db-fav-toggle">
            ★ Favourites Only
          </button>
          <select id="db-tag-select" class="input input-sm">
            <option value="">All Tags</option>
            ${Array.from(allTags)
              .sort()
              .map(
                (t) =>
                  `<option value="${this._escapeHtml(t)}" ${this._dbTagFilter === t ? "selected" : ""}>${this._escapeHtml(t)}</option>`
              )
              .join("")}
          </select>
        </div>
        <button class="btn btn-primary btn-sm" id="new-db-meal-btn">+ Add Meal to Database</button>
      </div>

      <div class="db-grid">
        ${
          filtered.length === 0
            ? `<div class="empty-box">No saved meals match your filter. Click "+ Add Meal to Database" to add one!</div>`
            : filtered
                .map(
                  (m) => `
                  <div class="card db-meal-card">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                      <div>
                        <button class="star-btn db-star-btn" data-id="${this._escapeHtml(m.id)}" title="Toggle Favourite">
                          ${m.favourite ? "★" : "☆"}
                        </button>
                        <strong style="font-size:16px;">${this._escapeHtml(m.name)}</strong>
                      </div>
                      <div style="display:flex; gap:4px;">
                        <button class="btn btn-ghost btn-xs db-edit-btn" data-id="${this._escapeHtml(m.id)}">✎</button>
                        <button class="btn btn-ghost btn-xs db-del-btn" data-id="${this._escapeHtml(m.id)}">🗑️</button>
                      </div>
                    </div>

                    ${
                      (m.tags || []).length > 0
                        ? `<div class="pill-row" style="margin-top:6px;">
                            ${m.tags.map((t) => `<span class="pill pill-tag">${this._escapeHtml(t)}</span>`).join("")}
                          </div>`
                        : ""
                    }

                    <div class="pill-row" style="margin-top:8px;">
                      ${
                        (m.ingredients || []).length > 0
                          ? m.ingredients.map((ing) => `<span class="pill">${this._escapeHtml(ing)}</span>`).join("")
                          : `<span class="subtext">No ingredients tagged</span>`
                      }
                    </div>

                    ${m.notes ? `<div class="subtext" style="margin-top:8px;">${this._escapeHtml(m.notes)}</div>` : ""}

                    <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
                      <button class="btn btn-primary btn-xs db-plan-next-btn" data-id="${this._escapeHtml(m.id)}">
                        📅 Plan Next Open Day
                      </button>
                      <button class="btn btn-secondary btn-xs db-shop-btn" data-id="${this._escapeHtml(m.id)}">
                        🛒 Review & Shop Ingredients
                      </button>
                    </div>
                  </div>
                `
                )
                .join("")
        }
      </div>
    `;
  }

  _renderAiTab() {
    const s = this._state.settings || {};
    const dislikesStr = Array.isArray(s.dislikes) ? s.dislikes.join(", ") : s.dislikes || "";

    return `
      <div class="card">
        <h3 style="margin-top:0;">✨ AI Meal Suggester (Database Favourites + Gemini Recipes)</h3>
        <div class="subtext" style="margin-bottom:12px;">
          Default Dietary Profile: <strong>${this._escapeHtml(s.dietary_profile || "Vegetarian")}</strong>
          ${dislikesStr ? ` • Avoids: <strong>${this._escapeHtml(dislikesStr)}</strong>` : ""}
          • Active Shopping List Items: <strong>${(this._state.shopping_list || []).length}</strong>
        </div>

        <div class="guest-box ${this._aiGuestMode ? "guest-box-active" : ""}">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:600;">
            <input type="checkbox" id="ai-guest-toggle" ${this._aiGuestMode ? "checked" : ""} />
            🎉 "We Have Guests" / Special Occasion Override
          </label>
          ${
            this._aiGuestMode
              ? `
                <div style="margin-top:8px;">
                  <input type="text" id="ai-guest-notes" class="input" style="width:100%;"
                         placeholder="e.g. Cooking for 4 guests, centrepiece sharing meal, allow halloumi or feta for guests..."
                         value="${this._escapeHtml(this._aiGuestNotes)}" />
                </div>
              `
              : ""
          }
        </div>

        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
          <input type="text" id="ai-extra-prompt" class="input" style="flex:1; min-width:220px;"
                 placeholder="Optional craving or note (e.g. 'quick mid-week', 'use up peppers & courgettes')..."
                 value="${this._escapeHtml(this._aiExtraPrompt)}" />
          <button class="btn btn-primary" id="run-ai-suggest-btn" ${this._aiLoading ? "disabled" : ""}>
            ${this._aiLoading ? "⏳ Asking Gemini..." : "✨ Suggest Meals"}
          </button>
        </div>
      </div>

      ${
        this._aiResults
          ? `
            <div style="margin-top:16px;">
              <h4>★ Recommended From Your Saved Meal Database & Favourites</h4>
              <div class="db-grid">
                ${
                  (this._aiResults.db_suggestions || []).length === 0
                    ? `<div class="empty-box">No specific database matches returned.</div>`
                    : (this._aiResults.db_suggestions || [])
                        .map(
                          (item, idx) => `
                          <div class="card db-meal-card">
                            <div>
                              ${item.favourite ? `<span class="fav-star">★</span> ` : ""}
                              <strong>${this._escapeHtml(item.name)}</strong>
                            </div>
                            <div class="subtext" style="margin-top:4px; color: var(--primary-color);">
                              💡 ${this._escapeHtml(item.reason || "")}
                            </div>
                            <div class="pill-row" style="margin-top:8px;">
                              ${(item.ingredients || []).map((i) => `<span class="pill">${this._escapeHtml(i)}</span>`).join("")}
                            </div>
                            <div style="display:flex; gap:8px; margin-top:12px;">
                              <button class="btn btn-primary btn-xs ai-plan-db-btn" data-idx="${idx}">
                                📅 Plan & Review Ingredients
                              </button>
                            </div>
                          </div>
                        `
                        )
                        .join("")
                }
              </div>

              <h4 style="margin-top:20px;">🆕 Fresh AI Recipe Ideas (Tailored to Your Shopping List & Profile)</h4>
              <div class="db-grid">
                ${(this._aiResults.ai_suggestions || [])
                  .map(
                    (item, idx) => `
                    <div class="card db-meal-card">
                      <div>
                        <strong>${this._escapeHtml(item.name)}</strong>
                      </div>
                      <div class="subtext" style="margin-top:4px; color: var(--primary-color);">
                        💡 ${this._escapeHtml(item.reason || "")}
                      </div>
                      ${item.notes ? `<div class="subtext" style="margin-top:4px;">${this._escapeHtml(item.notes)}</div>` : ""}
                      <div class="pill-row" style="margin-top:8px;">
                        ${(item.ingredients || []).map((i) => `<span class="pill">${this._escapeHtml(i)}</span>`).join("")}
                      </div>
                      <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
                        <button class="btn btn-primary btn-xs ai-plan-new-btn" data-idx="${idx}">
                          📅 Plan, Save to DB & Review Ingredients
                        </button>
                        <button class="btn btn-secondary btn-xs ai-save-only-btn" data-idx="${idx}">
                          💾 Save to Meal DB Only
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

  _renderShoppingAndScanTab() {
    const items = this._state.shopping_list || [];

    return `
      <div class="shop-layout">
        <div class="card">
          <div class="section-header">
            <div>
              <h3 style="margin:0;">🛒 Shopping List (${items.length} to buy)</h3>
              <div class="subtext">Synced live with <code>${this._escapeHtml(this._state.settings.todo_entity)}</code></div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              ${
                !this._isCompanion
                  ? `<button class="btn btn-secondary btn-sm" id="popout-companion-btn">
                      🪟 Pop Out Online Shop Window
                    </button>`
                  : ""
              }
              <button class="btn btn-secondary btn-sm" id="print-shop-btn">
                🖨️ Print Paper List
              </button>
            </div>
          </div>

          <div style="display:flex; gap:8px; margin: 12px 0;">
            <input type="text" id="quick-shop-item-input" class="input" style="flex:1;" placeholder="Quick add item to shopping list..." />
            <button class="btn btn-primary btn-sm" id="quick-shop-item-btn">+ Add</button>
          </div>

          ${
            items.length === 0
              ? `<div class="empty-box">🎉 Shopping list is clear!</div>`
              : `<div class="shop-list">
                  ${items
                    .map(
                      (item) => `
                      <div class="shop-row">
                        <label style="display:flex; align-items:center; gap:10px; flex:1; cursor:pointer;">
                          <input type="checkbox" class="shop-check" data-uid="${this._escapeHtml(item.uid || item.summary)}" />
                          <div>
                            <div style="font-weight:500;">${this._escapeHtml(item.summary)}</div>
                            ${
                              (item.for_meals || []).length > 0
                                ? `<div class="subtext" style="color: var(--primary-color);">For: ${this._escapeHtml(item.for_meals.join(", "))}</div>`
                                : ""
                            }
                          </div>
                        </label>
                        <button class="btn btn-ghost btn-xs copy-shop-btn" data-text="${this._escapeHtml(item.summary)}" title="Copy item name for online supermarket search">
                          📋 Copy
                        </button>
                      </div>
                    `
                    )
                    .join("")}
                </div>`
          }
        </div>

        <div class="card">
          <h3 style="margin-top:0;">📸 Scan Crossed-Out Paper Shopping List</h3>
          <div class="subtext" style="margin-bottom:12px;">
            Back from the shops? Take a photo of your printed receipt list. Items <strong>crossed out or ticked</strong> are marked bought, while unmarked items stay on your to-do list!
          </div>

          <label class="upload-btn-label">
            <input type="file" accept="image/*" capture="environment" id="receipt-file-input" style="display:none;" />
            <span class="btn btn-primary">
              ${this._scanLoading ? "⏳ Scanning Receipt Photo with Gemini..." : "📷 Take Photo / Upload Marked Receipt"}
            </span>
          </label>

          ${
            this._scanSummary
              ? `
                <div class="scan-result-box" style="margin-top:14px;">
                  <div style="font-weight:600; margin-bottom:6px;">
                    ✅ Checked Off (${(this._scanSummary.completed_summaries || []).length}):
                  </div>
                  <div class="pill-row">
                    ${
                      (this._scanSummary.completed_summaries || []).length > 0
                        ? this._scanSummary.completed_summaries
                            .map((s) => `<span class="pill badge-ok">✓ ${this._escapeHtml(s)}</span>`)
                            .join("")
                        : `<span class="subtext">None detected as crossed out/ticked</span>`
                    }
                  </div>
                  <div style="font-weight:600; margin-top:10px; margin-bottom:6px;">
                    🛒 Unmarked / Still Needed (${(this._scanSummary.still_needed_items || []).length}):
                  </div>
                  <div class="pill-row">
                    ${(this._scanSummary.still_needed_items || [])
                      .map((i) => `<span class="pill">${this._escapeHtml(i.summary)}</span>`)
                      .join("")}
                  </div>
                </div>
              `
              : ""
          }
        </div>
      </div>

      ${this._renderPlannedMealsQuickWidget()}
    `;
  }

  _renderPreferencesTab() {
    const s = this._state.settings || {};
    const dislikesStr = Array.isArray(s.dislikes) ? s.dislikes.join(", ") : s.dislikes || "";

    return `
      <div class="card" style="max-width:640px;">
        <h3 style="margin-top:0;">⚙️ Dietary Profile & Integration Settings</h3>
        <div class="form-group">
          <label>Default Dietary Profile</label>
          <input type="text" id="pref-diet" class="input" value="${this._escapeHtml(s.dietary_profile || "Vegetarian")}" />
        </div>
        <div class="form-group">
          <label>Disliked / Excluded Ingredients (comma-separated)</label>
          <input type="text" id="pref-dislikes" class="input" value="${this._escapeHtml(dislikesStr)}" placeholder="e.g. feta, beetroot" />
        </div>
        <div class="form-group">
          <label>General Meal Preferences (used by AI)</label>
          <textarea id="pref-custom" class="input" rows="3">${this._escapeHtml(s.custom_preferences || "")}</textarea>
        </div>
        <div class="form-group">
          <label>Shopping List To-Do Entity</label>
          <input type="text" id="pref-todo" class="input" value="${this._escapeHtml(s.todo_entity || "todo.shopping_list")}" />
        </div>
        <div class="form-group">
          <label>ESC/POS Receipt Printer Notify Entity</label>
          <input type="text" id="pref-printer" class="input" value="${this._escapeHtml(s.printer_entity || "notify.hall_stairs_hallway_receipt_printer")}" />
        </div>
        <button class="btn btn-primary" id="save-prefs-btn">💾 Save Preferences</button>
      </div>
    `;
  }

  _renderModals() {
    let html = "";

    // 1. Day Schedule Modal
    if (this._dayModal) {
      const m = this._dayModal;
      const mealsList = Object.values(this._state.meals || {}).sort((a, b) =>
        (a.name || "").localeCompare(b.name || "")
      );
      html += `
        <div class="modal-backdrop">
          <div class="modal-card">
            <h3 style="margin-top:0;">📅 Plan Meal for ${this._escapeHtml(this._formatDisplayDate(m.date))}</h3>

            <div class="form-group">
              <label>Pick from Saved Meal Database (or type below)</label>
              <select id="day-modal-db-select" class="input">
                <option value="">-- Choose saved meal --</option>
                ${mealsList
                  .map(
                    (dbm) =>
                      `<option value="${this._escapeHtml(dbm.id)}" ${m.meal_id === dbm.id ? "selected" : ""}>
                        ${dbm.favourite ? "★ " : ""}${this._escapeHtml(dbm.name)}
                      </option>`
                  )
                  .join("")}
              </select>
            </div>

            <div class="form-group">
              <label>Meal Name</label>
              <input type="text" id="day-modal-name" class="input" value="${this._escapeHtml(m.meal_name)}" placeholder="e.g. Halloumi Fajitas" />
            </div>

            <div class="form-group">
              <label>Tagged Ingredients</label>
              <div class="pill-row" style="margin-bottom:6px;">
                ${m.ingredients
                  .map(
                    (ing, idx) => `
                    <span class="pill">
                      ${this._escapeHtml(ing)}
                      <button class="pill-del day-ing-del" data-idx="${idx}">✕</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>
              <div style="display:flex; gap:6px;">
                <input type="text" id="day-modal-new-ing" class="input" list="all-ings-datalist" placeholder="Add ingredient(s) comma-separated..." value="${this._escapeHtml(m.newIngredient || "")}" />
                <button class="btn btn-secondary btn-sm" id="day-modal-add-ing-btn">+ Add</button>
              </div>
            </div>

            <div class="form-group">
              <label>Shortest Ingredient Expiry Date (Optional)</label>
              <input type="date" id="day-modal-expiry" class="input" value="${this._escapeHtml(m.shortest_expiry || "")}" />
            </div>

            <div class="form-group">
              <label>Notes</label>
              <input type="text" id="day-modal-notes" class="input" value="${this._escapeHtml(m.notes || "")}" />
            </div>

            <div style="display:flex; gap:16px; margin: 10px 0; flex-wrap:wrap;">
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                <input type="checkbox" id="day-modal-pin" ${m.pinned ? "checked" : ""} />
                📌 Pin to this day
              </label>
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                <input type="checkbox" id="day-modal-ask-shop" ${m.reviewIngredientsAfterSave ? "checked" : ""} />
                🛒 Review ingredients for shopping list after saving
              </label>
            </div>

            <div class="modal-footer">
              <button class="btn btn-secondary" id="day-modal-cancel">Cancel</button>
              <button class="btn btn-primary" id="day-modal-save">Save Meal</button>
            </div>
          </div>
        </div>
      `;
    }

    // 2. Meal Database Create/Edit Modal
    if (this._mealModal) {
      const m = this._mealModal;
      html += `
        <div class="modal-backdrop">
          <div class="modal-card">
            <h3 style="margin-top:0;">${m.id ? "✎ Edit Saved Meal" : "+ Add Meal to Database"}</h3>

            <div class="form-group">
              <label>Meal Name</label>
              <input type="text" id="meal-modal-name" class="input" value="${this._escapeHtml(m.name)}" placeholder="e.g. Veggie Sausage & Mash" />
            </div>

            <div class="form-group">
              <label>Ingredients</label>
              <div class="pill-row" style="margin-bottom:6px;">
                ${m.ingredients
                  .map(
                    (ing, idx) => `
                    <span class="pill">
                      ${this._escapeHtml(ing)}
                      <button class="pill-del meal-ing-del" data-idx="${idx}">✕</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>
              <div style="display:flex; gap:6px;">
                <input type="text" id="meal-modal-new-ing" class="input" list="all-ings-datalist" placeholder="Add ingredient(s) comma-separated..." value="${this._escapeHtml(m.newIngredient || "")}" />
                <button class="btn btn-secondary btn-sm" id="meal-modal-add-ing-btn">+ Add</button>
              </div>
            </div>

            <div class="form-group">
              <label>Tags (e.g. Quick, Comfort, Guest-Friendly)</label>
              <div class="pill-row" style="margin-bottom:6px;">
                ${m.tags
                  .map(
                    (t, idx) => `
                    <span class="pill pill-tag">
                      ${this._escapeHtml(t)}
                      <button class="pill-del meal-tag-del" data-idx="${idx}">✕</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>
              <div style="display:flex; gap:6px;">
                <input type="text" id="meal-modal-new-tag" class="input" placeholder="Add tag(s)..." value="${this._escapeHtml(m.newTag || "")}" />
                <button class="btn btn-secondary btn-sm" id="meal-modal-add-tag-btn">+ Add</button>
              </div>
            </div>

            <div class="form-group">
              <label>Prep / Recipe Notes</label>
              <textarea id="meal-modal-notes" class="input" rows="2">${this._escapeHtml(m.notes)}</textarea>
            </div>

            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin:10px 0;">
              <input type="checkbox" id="meal-modal-fav" ${m.favourite ? "checked" : ""} />
              ★ Mark as a Household Favourite
            </label>

            <div class="modal-footer">
              <button class="btn btn-secondary" id="meal-modal-cancel">Cancel</button>
              <button class="btn btn-primary" id="meal-modal-save">Save to Database</button>
            </div>
          </div>
        </div>
      `;
    }

    // 3. Mid-Step Ingredient Review Modal ("What do you actually need to buy?")
    if (this._ingredientReviewModal) {
      const rm = this._ingredientReviewModal;
      html += `
        <div class="modal-backdrop">
          <div class="modal-card">
            <h3 style="margin-top:0;">🛒 Ingredient Check: ${this._escapeHtml(rm.mealName)}</h3>
            <div class="subtext" style="margin-bottom:12px;">
              Untick anything you <strong>already have in the cupboard/fridge</strong>. Checked items will be added to your shopping list.
            </div>

            <div class="shop-list" style="max-height:280px; overflow-y:auto;">
              ${rm.items
                .map(
                  (item, idx) => `
                  <label class="shop-row" style="cursor:pointer;">
                    <div style="display:flex; align-items:center; gap:10px;">
                      <input type="checkbox" class="ing-review-check" data-idx="${idx}" ${item.checked ? "checked" : ""} />
                      <span style="font-weight:500;">${this._escapeHtml(item.name)}</span>
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

            <div class="form-group" style="margin-top:12px;">
              <label>Need any extra items for this meal?</label>
              <input type="text" id="ing-review-extra" class="input" placeholder="Optional extra item(s), comma-separated..." value="${this._escapeHtml(rm.extraItem || "")}" />
            </div>

            <div class="modal-footer">
              <button class="btn btn-secondary" id="ing-review-skip">Skip (Have Everything)</button>
              <button class="btn btn-primary" id="ing-review-confirm">🛒 Add Selected to Shopping List</button>
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

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          box-sizing: border-box;
          background: var(--primary-background-color, #111318);
          color: var(--primary-text-color, #e2e8f0);
          min-height: 100vh;
          font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
          padding: ${this._isCompanion ? "10px" : "16px 20px 40px"};
        }
        * { box-sizing: border-box; }
        .header-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 16px;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 22px;
          font-weight: 700;
        }
        .nav-tabs {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-bottom: 16px;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.12));
          padding-bottom: 10px;
        }
        .tab-btn {
          background: var(--card-background-color, #1e222b);
          color: var(--primary-text-color, #e2e8f0);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
          border-radius: 10px;
          padding: 8px 14px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .tab-btn.active {
          background: var(--primary-color, #03a9f4);
          color: #fff;
          border-color: var(--primary-color, #03a9f4);
        }
        .card, .toolbar-card {
          background: var(--card-background-color, #1e222b);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          border-radius: 14px;
          padding: 14px 16px;
          margin-bottom: 14px;
        }
        .toolbar-card {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 10px;
        }
        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
          gap: 12px;
        }
        .db-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
          gap: 12px;
        }
        .shop-layout {
          display: grid;
          grid-template-columns: ${this._isCompanion ? "1fr" : "repeat(auto-fit, minmax(320px, 1fr))"};
          gap: 14px;
        }
        .day-card {
          background: var(--card-background-color, #1e222b);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          border-radius: 12px;
          padding: 12px;
          transition: transform 0.12s, border-color 0.12s;
        }
        .day-card.day-today {
          border: 2px solid var(--primary-color, #03a9f4);
        }
        .day-card.day-skipped {
          opacity: 0.7;
          background: rgba(128,128,128,0.08);
        }
        .day-card.day-swap-active {
          border: 2px dashed #f59e0b;
        }
        .day-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.07));
          padding-bottom: 8px;
          margin-bottom: 8px;
        }
        .day-title {
          font-size: 13px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .day-actions {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .meal-main-row {
          margin: 6px 0;
        }
        .meal-title-edit {
          font-size: 16px;
          cursor: pointer;
        }
        .fav-star, .star-btn {
          color: #fbbf24;
          font-size: 18px;
          background: none;
          border: none;
          cursor: pointer;
          padding: 0 4px 0 0;
        }
        .pill-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .pill {
          background: rgba(3, 169, 244, 0.15);
          color: var(--primary-text-color, #e2e8f0);
          border-radius: 999px;
          padding: 3px 10px;
          font-size: 12px;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .pill-tag {
          background: rgba(168, 85, 247, 0.18);
        }
        .pill-lg {
          padding: 5px 12px;
          font-size: 13px;
        }
        .pill-del {
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          font-size: 11px;
          padding: 0 2px;
          opacity: 0.75;
        }
        .badge {
          border-radius: 6px;
          padding: 2px 7px;
          font-size: 11px;
          font-weight: 600;
        }
        .badge-ok { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .badge-warn { background: rgba(245, 158, 11, 0.22); color: #fbbf24; }
        .badge-danger { background: rgba(239, 68, 68, 0.25); color: #f87171; }
        .badge-pin { background: rgba(59, 130, 246, 0.22); color: #60a5fa; }
        .expiry-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 10px;
          font-size: 12px;
          opacity: 0.9;
        }
        .btn {
          border: none;
          border-radius: 8px;
          padding: 8px 13px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .btn-primary { background: var(--primary-color, #03a9f4); color: #fff; }
        .btn-secondary {
          background: rgba(148, 163, 184, 0.18);
          color: var(--primary-text-color, #e2e8f0);
        }
        .btn-warn { background: #f59e0b; color: #111; }
        .btn-danger { background: rgba(239, 68, 68, 0.25); color: #f87171; }
        .btn-ghost {
          background: rgba(148, 163, 184, 0.1);
          color: var(--primary-text-color, #e2e8f0);
        }
        .btn-sm { padding: 6px 10px; font-size: 12px; }
        .btn-xs { padding: 3px 7px; font-size: 11px; border-radius: 6px; }
        .input {
          background: var(--primary-background-color, #111318);
          color: var(--primary-text-color, #e2e8f0);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.18));
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
        }
        .input-sm { padding: 5px 8px; font-size: 12px; }
        .input-xs { padding: 2px 6px; font-size: 11px; }
        .subtext { font-size: 12px; opacity: 0.72; }
        .empty-box {
          padding: 16px;
          text-align: center;
          opacity: 0.7;
          font-size: 13px;
          border: 1px dashed var(--divider-color, rgba(255,255,255,0.15));
          border-radius: 10px;
        }
        .shop-list, .compact-meal-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .shop-row, .compact-meal-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 8px;
          background: rgba(148, 163, 184, 0.07);
        }
        .guest-box {
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.15));
          background: rgba(168, 85, 247, 0.07);
        }
        .guest-box-active {
          border-color: #a855f7;
          background: rgba(168, 85, 247, 0.15);
        }
        .form-group {
          margin-bottom: 12px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .form-group label { font-size: 12px; font-weight: 600; opacity: 0.85; }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.65);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 14px;
        }
        .modal-card {
          background: var(--card-background-color, #1e222b);
          color: var(--primary-text-color, #e2e8f0);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.18));
          border-radius: 16px;
          padding: 18px;
          width: 100%;
          max-width: 500px;
          max-height: 90vh;
          overflow-y: auto;
        }
        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }
        .toast {
          position: fixed;
          bottom: 20px;
          right: 20px;
          padding: 10px 16px;
          border-radius: 10px;
          background: #0284c7;
          color: #fff;
          font-weight: 600;
          font-size: 13px;
          z-index: 2000;
          box-shadow: 0 6px 20px rgba(0,0,0,0.35);
        }
        .toast.error { background: #dc2626; }
        .skipped-banner {
          font-size: 13px;
          font-style: italic;
          opacity: 0.8;
          padding: 6px 0;
        }
      </style>

      ${allIngsDatalist}

      <div class="header-bar">
        <div class="brand">
          <span>🍽️ MealMind</span>
          ${this._isCompanion ? `<span class="badge badge-pin">Online Shop Companion</span>` : ""}
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="top-print-today">🖨️ Print Today's Card</button>
          <button class="btn btn-secondary btn-sm" id="top-print-7d">🖨️ Print Next 7 Days</button>
          <button class="btn btn-secondary btn-sm" id="top-print-shop">🖨️ Print Shopping List</button>
        </div>
      </div>

      <div class="nav-tabs">
        <button class="tab-btn ${this._activeTab === "calendar" ? "active" : ""}" data-tab="calendar">📅 Meal Plan Calendar</button>
        <button class="tab-btn ${this._activeTab === "database" ? "active" : ""}" data-tab="database">🍲 Meal Database (${Object.keys(this._state.meals || {}).length})</button>
        <button class="tab-btn ${this._activeTab === "ai" ? "active" : ""}" data-tab="ai">✨ AI Meal Suggester</button>
        <button class="tab-btn ${this._activeTab === "shop" ? "active" : ""}" data-tab="shop">🛒 Shop & Receipt Scan (${(this._state.shopping_list || []).length})</button>
        <button class="tab-btn ${this._activeTab === "prefs" ? "active" : ""}" data-tab="prefs">⚙️ Preferences</button>
      </div>

      <div class="tab-content">
        ${this._activeTab === "calendar" ? this._renderCalendarTab() : ""}
        ${this._activeTab === "database" ? this._renderDatabaseTab() : ""}
        ${this._activeTab === "ai" ? this._renderAiTab() : ""}
        ${this._activeTab === "shop" ? this._renderShoppingAndScanTab() : ""}
        ${this._activeTab === "prefs" ? this._renderPreferencesTab() : ""}
      </div>

      ${this._renderModals()}
      ${
        this._toast
          ? `<div class="toast ${this._toast.isError ? "error" : ""}">${this._escapeHtml(this._toast.msg)}</div>`
          : ""
      }
    `;

    this._attachListeners();
  }

  _attachListeners() {
    const root = this.shadowRoot;
    if (!root) return;

    // Top print buttons
    const btnToday = root.getElementById("top-print-today");
    if (btnToday) btnToday.onclick = () => this._handlePrint("today_card");
    const btn7d = root.getElementById("top-print-7d");
    if (btn7d) btn7d.onclick = () => this._handlePrint("next_7_days");
    const btnShop = root.getElementById("top-print-shop");
    if (btnShop) btnShop.onclick = () => this._handlePrint("shopping_list");

    // Tab navigation
    root.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.onclick = () => {
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

    // Day Card buttons & Drag-and-Drop
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
        this._swapSourceDate = btn.dataset.date;
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
    root.querySelectorAll(".edit-day-btn, .meal-title-edit").forEach((btn) => {
      btn.onclick = () => this._openDayModal(btn.dataset.date);
    });
    root.querySelectorAll(".shop-day-btn").forEach((btn) => {
      btn.onclick = () => {
        const slot = this._state.schedule[btn.dataset.date] || {};
        const dbMeal = slot.meal_id ? this._state.meals[slot.meal_id] : null;
        const ings = dbMeal ? dbMeal.ingredients || [] : [];
        this._openIngredientReviewModal(slot.meal_name || (dbMeal && dbMeal.name) || "Meal", ings);
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
    const dbTag = root.getElementById("db-tag-select");
    if (dbTag) {
      dbTag.onchange = () => {
        this._dbTagFilter = dbTag.value;
        this._render();
      };
    }
    const newDbMealBtn = root.getElementById("new-db-meal-btn");
    if (newDbMealBtn) newDbMealBtn.onclick = () => this._openMealModal(null);

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
    root.querySelectorAll(".db-shop-btn").forEach((btn) => {
      btn.onclick = () => {
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
    const popoutBtn = root.getElementById("popout-companion-btn");
    if (popoutBtn) popoutBtn.onclick = () => this._openCompanionPopup();
    const printShopBtn = root.getElementById("print-shop-btn");
    if (printShopBtn) printShopBtn.onclick = () => this._handlePrint("shopping_list");

    const quickShopInput = root.getElementById("quick-shop-item-input");
    const quickShopBtn = root.getElementById("quick-shop-item-btn");
    if (quickShopBtn && quickShopInput) {
      quickShopBtn.onclick = () => {
        this._addSingleShoppingItem(quickShopInput.value);
        quickShopInput.value = "";
      };
      quickShopInput.onkeydown = (e) => {
        if (e.key === "Enter") {
          this._addSingleShoppingItem(quickShopInput.value);
          quickShopInput.value = "";
        }
      };
    }

    root.querySelectorAll(".shop-check").forEach((chk) => {
      chk.onchange = () => {
        if (chk.checked) {
          this._completeShoppingItem(chk.dataset.uid);
        }
      };
    });

    root.querySelectorAll(".copy-shop-btn").forEach((btn) => {
      btn.onclick = () => {
        navigator.clipboard.writeText(btn.dataset.text || "");
        this._showToast(`Copied '${btn.dataset.text}' to clipboard!`);
      };
    });

    const receiptInput = root.getElementById("receipt-file-input");
    if (receiptInput) {
      receiptInput.onchange = (e) => this._handleReceiptFileChange(e);
    }

    // Quick Planned Meals Widget (in Shopping / Scan view)
    const widgetAutoBtn = root.getElementById("widget-auto-schedule-btn");
    if (widgetAutoBtn) widgetAutoBtn.onclick = () => this._handleAutoSchedule();

    const widgetAddDbBtn = root.getElementById("widget-add-db-meal-btn");
    const widgetPickSelect = root.getElementById("widget-pick-db-meal");
    if (widgetAddDbBtn && widgetPickSelect) {
      widgetAddDbBtn.onclick = () => {
        const mealId = widgetPickSelect.value;
        if (!mealId || !this._state.meals[mealId]) {
          this._showToast("Select a saved meal first", true);
          return;
        }
        this._quickScheduleMeal(this._state.meals[mealId], null, true);
      };
    }
    const widgetNewMealBtn = root.getElementById("widget-new-meal-btn");
    if (widgetNewMealBtn) {
      widgetNewMealBtn.onclick = () => this._openDayModal(this._findNextOpenDateStr());
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
        const printer = root.getElementById("pref-printer").value.trim();

        const res = await this._wsCall({
          type: "mealmind/settings/update",
          settings: {
            dietary_profile: diet,
            dislikes,
            custom_preferences: custom,
            todo_entity: todo,
            printer_entity: printer,
          },
        });
        this._updateLocalState(res);
        this._showToast("Saved preferences!");
      };
    }

    // Modal 1: Day Schedule Modal listeners
    if (this._dayModal) {
      const dbSel = root.getElementById("day-modal-db-select");
      if (dbSel) {
        dbSel.onchange = () => {
          const chosen = this._state.meals[dbSel.value];
          if (chosen) {
            this._dayModal.meal_id = chosen.id;
            this._dayModal.meal_name = chosen.name;
            this._dayModal.ingredients = [...(chosen.ingredients || [])];
            this._dayModal.notes = chosen.notes || "";
            this._render();
          }
        };
      }
      const nameInp = root.getElementById("day-modal-name");
      if (nameInp) nameInp.oninput = () => (this._dayModal.meal_name = nameInp.value);

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
      if (askShopChk)
        askShopChk.onchange = () => (this._dayModal.reviewIngredientsAfterSave = askShopChk.checked);

      const cancelBtn = root.getElementById("day-modal-cancel");
      if (cancelBtn) {
        cancelBtn.onclick = () => {
          this._dayModal = null;
          this._render();
        };
      }
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

      const cancelBtn = root.getElementById("meal-modal-cancel");
      if (cancelBtn) {
        cancelBtn.onclick = () => {
          this._mealModal = null;
          this._render();
        };
      }
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
  }
}

if (!customElements.get("mealmind-panel")) {
  customElements.define("mealmind-panel", MealMindPanel);
}
