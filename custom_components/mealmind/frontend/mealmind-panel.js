/**
 * MealMind v1.0.2 — Modern Web & Mobile App UI for Home Assistant
 *
 * Designed with:
 * - High-contrast WCAG AA/AAA dark slate & surface elevation palette (no theme contrast bleed)
 * - 44px–48px minimum touch targets across all buttons, rows, and controls
 * - Searchable, filterable Meal Picker Modal (replaces native <select> dropdowns)
 * - Top-level Hero Scanner & Segmented Sub-Views in Shop & Scan (no scrolling past long lists)
 * - Automatic Post-Scan Summary & Planned Meals Review Sheet after scanning a receipt
 * - Responsive Mobile Bottom Navigation Bar + Desktop Top Command Bar
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

    // Shop sub-view on mobile/companion so nothing is buried under long lists:
    // 'list' | 'meals' | 'scan'
    this._shopSubView = "list";

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
        printer_entity: "notify.hall_stairs_hallway_receipt_printer",
      },
      meals: {},
      schedule: {},
      queue: [],
      all_ingredients: [],
      shopping_list: [],
    };

    // Modals
    // 1. Day / Meal Assignment Modal (with searchable database picker + custom editor)
    // { date, mode: 'pick' | 'custom', search: '', favOnly: false, tagFilter: '', meal_id, meal_name, ingredients: [], newIngredient: '', shortest_expiry: '', pinned: false, notes: '', reviewIngredientsAfterSave: true }
    this._dayModal = null;

    // 2. Database Create/Edit Meal Modal
    this._mealModal = null;

    // 3. Mid-Step Ingredient Check Modal ("Untick what you already have in stock")
    this._ingredientReviewModal = null;

    // 4. Post-Scan Results & Planned Meals Modal (opens immediately after receipt photo scan)
    this._postScanModal = false;

    // 5. Print Mission Quick Sheet
    this._printMenuOpen = false;

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
    }, 4200);
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
      };
    }
    return {
      text: `📅 Exp ${shortFmt}`,
      cls: "badge-ok",
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
      this._showToast(`Added ${count} item(s) to your shopping list!`);
    } catch (err) {
      this._showToast("Error adding items: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Core Schedule & Printer Actions
  // ---------------------------------------------------------------------------

  async _handlePrint(mission, dateStr = null) {
    this._printMenuOpen = false;
    try {
      this._showToast("🖨️ Sending print job to receipt printer...");
      await this._wsCall({
        type: "mealmind/printer/print",
        mission,
        date: dateStr,
      });
      this._showToast("✅ Printed successfully!");
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
        this._showToast("⏭️ Pushed meal forward (+1 day)");
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
      this._showToast(
        skipped ? `🚫 Marked ${this._formatDisplayDate(dateStr)} as skipped` : `↩️ Restored ${this._formatDisplayDate(dateStr)}`
      );
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
      this._showToast(!entry.pinned ? "📌 Pinned meal to this day" : "Unpinned meal");
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
      this._showToast(`Cleared meal on ${this._formatDisplayDate(dateStr)}`);
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
      this._showToast(`⇄ Swapped ${this._formatDisplayDate(dateA)} with ${this._formatDisplayDate(dateB)}`);
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
      this._showToast(newExpiry ? `📅 Expiry set to ${newExpiry}` : "Cleared expiry date");
    } catch (err) {
      this._showToast("Failed to update expiry: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Modern Searchable Day / Meal Assignment Modal
  // ---------------------------------------------------------------------------

  _openDayModal(dateStr = null, forceMode = null) {
    const targetDate = dateStr || this._findNextOpenDateStr();
    const existing = this._state.schedule[targetDate] || {};
    const mealId = existing.meal_id || "";
    const dbMeal = mealId && this._state.meals[mealId] ? this._state.meals[mealId] : {};
    const mealName = existing.meal_name || dbMeal.name || "";
    const ingredients = [...(dbMeal.ingredients || [])];
    const hasMealsInDb = Object.keys(this._state.meals || {}).length > 0;

    // Default to 'pick' when assigning an empty slot (if DB has meals), or 'custom' when editing an existing slot
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
    // Switch to custom review step or save immediately?
    // Giving a 1-tap "Assign Immediately" AND an "Edit Details / Expiry" option is super fast!
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
      // Automatically open the Post-Scan Results & Planned Meals Review Sheet!
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
              Got inspiration in the store or unpacking your shop? Add/remove meals or tap to set shortest ingredient expiry dates.
            </p>
          </div>
          <div class="action-cluster">
            <button class="btn btn-secondary quick-open-picker-btn">
              📚 + Add Saved Meal
            </button>
            <button class="btn btn-primary quick-open-custom-btn">
              ✨ + New Inspired Meal
            </button>
            <button class="btn btn-accent quick-auto-schedule-btn">
              ⚡ Auto-Sort by Expiry
            </button>
          </div>
        </div>

        ${
          upcoming.length === 0
            ? `<div class="empty-state">
                <div class="empty-icon">🍽️</div>
                <div>No meals planned for the next 10 days yet.</div>
                <div class="section-subtitle">Tap <strong>+ Add Saved Meal</strong> or <strong>+ New Inspired Meal</strong> above!</div>
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
      const ingredients = dbMeal ? dbMeal.ingredients || [] : [];
      const badge = this._getExpiryBadge(dStr, slot.shortest_expiry);
      const isSwapSelected = this._swapSourceDate === dStr;
      const isSwapTarget = Boolean(this._swapSourceDate && this._swapSourceDate !== dStr);

      daysHtml.push(`
        <div class="day-card ${dStr === today ? "day-today" : ""} ${isSkipped ? "day-skipped" : ""} ${isSwapSelected ? "day-swap-source" : ""} ${isSwapTarget ? "day-swap-target" : ""}"
             draggable="true"
             data-date="${dStr}">
          <div class="day-card-top">
            <div class="day-date-group">
              <span class="day-date-label ${dStr === today ? "today-highlight" : ""}">
                ${this._escapeHtml(this._formatDisplayDate(dStr))}
              </span>
              <div class="badge-row">
                ${isPinned ? `<span class="badge badge-pin">📌 Pinned</span>` : ""}
                ${badge && !isSkipped ? `<span class="badge ${badge.cls}">${this._escapeHtml(badge.text)}</span>` : ""}
              </div>
            </div>
            ${
              isSwapTarget
                ? `<button class="btn btn-accent btn-sm swap-target-btn" data-date="${dStr}">⇄ Swap Here</button>`
                : ""
            }
          </div>

          <div class="day-card-content">
            ${
              isSkipped
                ? `
                  <div class="skipped-box">
                    <span>🚫 ${this._escapeHtml(slot.skip_reason || "Skipped / Eating Out")}</span>
                    <button class="btn btn-secondary btn-sm skip-day-btn" data-date="${dStr}">↩️ Restore Day</button>
                  </div>
                `
                : mealName
                ? `
                  <div class="meal-headline edit-day-btn" data-date="${dStr}">
                    <div class="meal-name-text">
                      ${isFav ? `<span class="fav-star-inline">★</span>` : ""}
                      ${this._escapeHtml(mealName)}
                    </div>
                    <span class="edit-affordance" title="Change or edit meal">✎ Change</span>
                  </div>

                  ${
                    ingredients.length > 0
                      ? `<div class="pill-row" style="margin-top: 8px;">
                          ${ingredients.map((ing) => `<span class="pill">${this._escapeHtml(ing)}</span>`).join("")}
                        </div>`
                      : ""
                  }

                  <div class="day-expiry-bar">
                    <span class="expiry-label">Shortest Date:</span>
                    <div class="expiry-quick-pills">
                      <button class="chip-btn exp-shortcut-btn" data-date="${dStr}" data-days="1">+1d</button>
                      <button class="chip-btn exp-shortcut-btn" data-date="${dStr}" data-days="2">+2d</button>
                      <button class="chip-btn exp-shortcut-btn" data-date="${dStr}" data-days="4">+4d</button>
                    </div>
                    <input type="date" class="input input-date quick-exp-input" data-date="${dStr}" value="${slot.shortest_expiry || ""}" />
                  </div>

                  <div class="day-action-bar">
                    <button class="action-pill push-day-btn" data-date="${dStr}" title="Push meal +1 day">
                      ⏭️ +1d
                    </button>
                    <button class="action-pill swap-start-btn ${isSwapSelected ? "active" : ""}" data-date="${dStr}" title="Swap with another day">
                      ⇄ Swap
                    </button>
                    <button class="action-pill shop-day-btn" data-date="${dStr}" title="Check & add ingredients to shopping list">
                      🛒 Shop
                    </button>
                    <button class="action-pill pin-day-btn ${isPinned ? "active" : ""}" data-date="${dStr}" title="${isPinned ? "Unpin" : "Pin to this date"}">
                      📌 ${isPinned ? "Pinned" : "Pin"}
                    </button>
                    <button class="action-pill skip-day-btn" data-date="${dStr}" title="Skip day & push meal">
                      🚫 Skip
                    </button>
                    <button class="action-pill action-pill-danger clear-day-btn" data-date="${dStr}" title="Clear meal">
                      ✕
                    </button>
                  </div>
                `
                : `
                  <div class="empty-day-slot">
                    <button class="btn-assign-meal edit-day-btn" data-date="${dStr}">
                      <span style="font-size:18px;">＋</span> Choose or Add Meal
                    </button>
                    <div style="display:flex; gap:6px;">
                      ${
                        !isSwapTarget
                          ? `<button class="action-pill skip-day-btn" data-date="${dStr}" title="Mark day as Eating Out / Skip">🚫 Skip</button>`
                          : ""
                      }
                    </div>
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
                <strong>⇄ Swap Mode Active:</strong> Select any day card below to swap with <strong>${this._escapeHtml(this._formatDisplayDate(this._swapSourceDate))}</strong>
              </div>
              <button class="btn btn-secondary btn-sm" id="cancel-swap-btn">✕ Cancel Swap</button>
            </div>
          `
          : ""
      }

      <div class="command-bar">
        <div class="nav-cluster">
          <button class="btn btn-secondary" id="cal-prev-week">◀ Prev 7d</button>
          <button class="btn btn-secondary" id="cal-today">Today</button>
          <button class="btn btn-secondary" id="cal-next-week">Next 7d ▶</button>
          <span class="date-range-title">
            ${this._escapeHtml(this._formatDisplayDate(startStr))} – ${this._escapeHtml(this._formatDisplayDate(endStr))}
          </span>
        </div>
        <div class="action-cluster">
          <button class="btn btn-accent" id="auto-schedule-btn">
            ⚡ Auto-Schedule by Shortest Expiry
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
                  <p class="section-subtitle">Tap "Auto-Schedule by Shortest Expiry" to slot these into open days automatically.</p>
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
            ★ Favourites Only
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
        <button class="btn btn-primary" id="new-db-meal-btn">＋ New Meal</button>
      </div>

      <div class="db-grid">
        ${
          filtered.length === 0
            ? `<div class="empty-state" style="grid-column: 1 / -1;">
                <div class="empty-icon">🍲</div>
                <div>No saved meals match your filter.</div>
                <button class="btn btn-primary" id="empty-new-db-meal-btn" style="margin-top:10px;">＋ Add Your First Meal</button>
              </div>`
            : filtered
                .map(
                  (m) => `
                  <div class="surface-card db-meal-card">
                    <div class="db-card-header">
                      <div style="display:flex; align-items:center; gap:8px;">
                        <button class="star-toggle db-star-btn ${m.favourite ? "active" : ""}" data-id="${this._escapeHtml(m.id)}" title="Toggle Favourite">
                          ${m.favourite ? "★" : "☆"}
                        </button>
                        <h4 class="db-meal-title">${this._escapeHtml(m.name)}</h4>
                      </div>
                      <div style="display:flex; gap:6px;">
                        <button class="icon-btn db-edit-btn" data-id="${this._escapeHtml(m.id)}" title="Edit meal">✎</button>
                        <button class="icon-btn icon-btn-danger db-del-btn" data-id="${this._escapeHtml(m.id)}" title="Delete meal">🗑️</button>
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
                      <button class="btn btn-primary btn-block db-plan-next-btn" data-id="${this._escapeHtml(m.id)}">
                        📅 Plan Next Open Day
                      </button>
                      <button class="btn btn-secondary db-pick-day-btn" data-id="${this._escapeHtml(m.id)}" title="Choose specific date">
                        📆 Pick Date
                      </button>
                      <button class="btn btn-secondary db-shop-btn" data-id="${this._escapeHtml(m.id)}" title="Check & shop ingredients">
                        🛒
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
            <span class="badge badge-pin">🛒 ${(this._state.shopping_list || []).length} items on list</span>
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
          <button class="btn btn-accent btn-lg" id="run-ai-suggest-btn" ${this._aiLoading ? "disabled" : ""}>
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
                              <button class="btn btn-primary btn-block ai-plan-db-btn" data-idx="${idx}">
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
                        <button class="btn btn-primary btn-block ai-plan-new-btn" data-idx="${idx}">
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

  _renderShoppingAndScanTab() {
    const items = this._state.shopping_list || [];
    const today = this._todayStr();
    let upcomingCount = 0;
    for (let i = 0; i < 10; i++) {
      const slot = this._state.schedule[this._addDaysStr(today, i)];
      if (slot && !slot.skipped && (slot.meal_id || slot.meal_name)) upcomingCount++;
    }

    return `
      <!-- Top Action Hero Bar: Always visible at the very top of Shop & Scan (never buried under lists!) -->
      <div class="shop-hero-bar">
        <div class="shop-hero-actions">
          <label class="btn btn-accent btn-lg upload-hero-btn">
            <input type="file" accept="image/*" capture="environment" id="receipt-file-input" style="display:none;" />
            <span>${this._scanLoading ? "⏳ Scanning Receipt..." : "📷 Scan Marked Paper List"}</span>
          </label>

          <button class="btn btn-secondary" id="hero-add-saved-meal-btn">
            📚 + Plan Saved Meal
          </button>
          <button class="btn btn-secondary" id="hero-add-custom-meal-btn">
            ✨ + New Inspired Meal
          </button>
        </div>

        <div class="shop-hero-Right">
          ${
            !this._isCompanion
              ? `<button class="btn btn-secondary" id="popout-companion-btn" title="Open side-by-side companion window for online grocery shopping">
                  🪟 Pop Out Companion
                </button>`
              : ""
          }
          <button class="btn btn-secondary" id="print-shop-btn">
            🖨️ Print Paper List
          </button>
        </div>
      </div>

      <!-- Segmented Sub-View Switcher (especially fast on mobile so you never scroll past 40 items) -->
      <div class="segmented-control">
        <button class="seg-btn ${this._shopSubView === "list" ? "active" : ""}" data-subview="list">
          🛒 To-Buy List (${items.length})
        </button>
        <button class="seg-btn ${this._shopSubView === "meals" ? "active" : ""}" data-subview="meals">
          📅 Planned Meals & Expiry (${upcomingCount})
        </button>
        ${
          this._scanSummary
            ? `<button class="seg-btn ${this._shopSubView === "scan" ? "active" : ""}" data-subview="scan">
                ✅ Last Receipt Scan (${(this._scanSummary.completed_summaries || []).length})
              </button>`
            : ""
        }
      </div>

      <!-- Desktop 2-column split OR Mobile active sub-view -->
      <div class="shop-workspace">
        <div class="shop-col ${this._shopSubView === "list" ? "subview-active" : "subview-hidden-mobile"}">
          <div class="surface-card">
            <div class="section-header" style="margin-bottom: 12px;">
              <div>
                <h3 class="section-title">🛒 Shopping List (${items.length})</h3>
                <p class="section-subtitle">Tap any item to tick it off in <code>${this._escapeHtml(this._state.settings.todo_entity)}</code></p>
              </div>
            </div>

            <div class="quick-input-bar">
              <input type="text" id="quick-shop-item-input" class="input" style="flex:1;" placeholder="Add item to shopping list (e.g. Oat Milk, Courgettes)..." />
              <button class="btn btn-primary" id="quick-shop-item-btn">＋ Add</button>
            </div>

            ${
              items.length === 0
                ? `<div class="empty-state" style="margin-top:14px;">
                    <div class="empty-icon">🎉</div>
                    <div>Your shopping list is completely clear!</div>
                  </div>`
                : `<div class="shop-checklist" style="margin-top: 14px;">
                    ${items
                      .map(
                        (item) => `
                        <div class="shop-item-row">
                          <label class="shop-item-label">
                            <input type="checkbox" class="modern-checkbox shop-check" data-uid="${this._escapeHtml(item.uid || item.summary)}" />
                            <div class="shop-item-text">
                              <div class="shop-item-name">${this._escapeHtml(item.summary)}</div>
                              ${
                                (item.for_meals || []).length > 0
                                  ? `<div class="shop-item-meals">🍲 For: ${this._escapeHtml(item.for_meals.join(", "))}</div>`
                                  : ""
                              }
                            </div>
                          </label>
                          <button class="icon-btn copy-shop-btn" data-text="${this._escapeHtml(item.summary)}" title="Copy item for online supermarket search">
                            📋
                          </button>
                        </div>
                      `
                      )
                      .join("")}
                  </div>`
            }
          </div>
        </div>

        <div class="shop-col ${this._shopSubView === "meals" || this._shopSubView === "scan" ? "subview-active" : "subview-hidden-mobile"}">
          ${
            this._scanSummary
              ? `
                <div class="surface-card scan-summary-card" style="margin-bottom: 16px;">
                  <div class="section-header">
                    <div>
                      <h3 class="section-title">📸 Latest Receipt Photo Scan</h3>
                      <p class="section-subtitle">${this._escapeHtml(this._scanSummary.notes || "Synced with your To-Do shopping list")}</p>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="reopen-scan-modal-btn">Expand</button>
                  </div>
                  <div style="margin-top: 10px;">
                    <div class="day-eyebrow" style="color: #4ade80;">✅ Checked Off as Bought (${(this._scanSummary.completed_summaries || []).length})</div>
                    <div class="pill-row" style="margin-top:6px;">
                      ${
                        (this._scanSummary.completed_summaries || []).length > 0
                          ? this._scanSummary.completed_summaries
                              .map((s) => `<span class="pill badge-ok">✓ ${this._escapeHtml(s)}</span>`)
                              .join("")
                          : `<span class="section-subtitle">None detected as crossed out or ticked</span>`
                      }
                    </div>
                  </div>
                  <div style="margin-top: 12px;">
                    <div class="day-eyebrow" style="color: #fbbf24;">🛒 Unmarked / Still Needed (${(this._scanSummary.still_needed_items || []).length})</div>
                    <div class="pill-row" style="margin-top:6px;">
                      ${
                        (this._scanSummary.still_needed_items || []).length > 0
                          ? (this._scanSummary.still_needed_items || [])
                              .map((i) => `<span class="pill">${this._escapeHtml(i.summary)}</span>`)
                              .join("")
                          : `<span class="section-subtitle">Everything on the list was picked up!</span>`
                      }
                    </div>
                  </div>
                </div>
              `
              : ""
          }

          ${this._renderUpcomingMealsManager(false)}
        </div>
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
        <div class="form-group">
          <label>Shopping List To-Do Entity</label>
          <input type="text" id="pref-todo" class="input" value="${this._escapeHtml(s.todo_entity || "todo.shopping_list")}" />
        </div>
        <div class="form-group">
          <label>ESC/POS Receipt Printer Notify Entity</label>
          <input type="text" id="pref-printer" class="input" value="${this._escapeHtml(s.printer_entity || "notify.hall_stairs_hallway_receipt_printer")}" />
        </div>
        <div style="margin-top: 18px;">
          <button class="btn btn-primary btn-lg" id="save-prefs-btn">💾 Save Preferences</button>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Modals (Searchable Meal Picker, Custom Editor, Ingredient Check, Post-Scan)
  // ---------------------------------------------------------------------------

  _renderModals() {
    let html = "";

    // 1. Searchable Day / Meal Assignment Modal (No native <select> dropdowns!)
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

            <!-- Mode Switcher: Search Saved Database vs Custom / Edit Details -->
            <div class="segmented-control" style="margin: 12px 0 16px;">
              <button class="seg-btn ${m.mode === "pick" ? "active" : ""}" id="day-mode-pick-btn">
                📚 Choose from Meal Database (${meals.length})
              </button>
              <button class="seg-btn ${m.mode === "custom" ? "active" : ""}" id="day-mode-custom-btn">
                ✍️ ${m.meal_name ? `Details & Expiry (${this._escapeHtml(m.meal_name)})` : "New / Custom Meal"}
              </button>
            </div>

            ${
              m.mode === "pick"
                ? `
                  <!-- Search & Filter Bar -->
                  <div class="picker-toolbar">
                    <div class="search-input-wrap" style="flex:1;">
                      <span class="search-icon">🔍</span>
                      <input type="text" id="picker-search-input" class="input input-search"
                             placeholder="Type to search meals or ingredients..."
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

                  <!-- Optional Expiry & Shop Check bar right in the picker -->
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

                  <!-- Tappable Meal Cards List -->
                  <div class="picker-results-list">
                    ${
                      filteredMeals.length === 0
                        ? `
                          <div class="empty-state">
                            <div>No matching saved meals found.</div>
                            <button class="btn btn-primary" id="picker-create-new-btn" style="margin-top:10px;">
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
                                  <button class="btn btn-primary picker-quick-assign" data-id="${this._escapeHtml(dbm.id)}">
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
                  <!-- Custom / Edit Meal Details View -->
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
                    <button class="btn btn-primary btn-lg" id="day-modal-save">💾 Save Meal Plan</button>
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
              <button class="btn btn-primary btn-lg" id="meal-modal-save">💾 Save to Database</button>
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
                    <div class="shop-item-label">
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
              <button class="btn btn-primary btn-lg" id="ing-review-confirm">🛒 Add Checked to List</button>
            </div>
          </div>
        </div>
      `;
    }

    // 4. Post-Scan Results & Planned Meals Review Modal (opens automatically right after scanning a receipt!)
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

            <!-- Embedded Planned Meals & Expiry Unpack Manager right inside the post-scan sheet! -->
            ${this._renderUpcomingMealsManager(true)}

            <div class="modal-footer">
              <button class="btn btn-primary btn-lg" id="done-post-scan-modal">Done</button>
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
    const shopCount = (this._state.shopping_list || []).length;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          /* Explicit High-Contrast Modern Slate Palette — immune to low-contrast HA theme overrides */
          --mm-bg: #0b0f19;
          --mm-surface: #151c2c;
          --mm-surface-elevated: #1e293b;
          --mm-surface-hover: #263349;
          --mm-border: rgba(148, 163, 184, 0.18);
          --mm-border-strong: rgba(148, 163, 184, 0.32);
          --mm-text: #f8fafc;
          --mm-text-muted: #94a3b8;
          --mm-primary: #0284c7;
          --mm-primary-hover: #0369a1;
          --mm-primary-text: #ffffff;
          --mm-accent: #7c3aed;
          --mm-accent-hover: #6d28d9;
          --mm-success-bg: rgba(34, 197, 94, 0.18);
          --mm-success-text: #4ade80;
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
          padding: ${this._isCompanion ? "12px 12px 84px" : "20px 24px 96px"};
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
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 18px;
        }
        .brand-wrap {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .brand-logo {
          width: 42px;
          height: 42px;
          border-radius: 12px;
          background: linear-gradient(135deg, #0284c7, #7c3aed);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
          box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
        }
        .brand-title {
          font-size: 22px;
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

        /* Print Quick Cluster */
        .header-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        /* Desktop Primary Navigation Tabs */
        .desktop-tabs {
          display: flex;
          gap: 8px;
          background: var(--mm-surface);
          padding: 6px;
          border-radius: 14px;
          border: 1px solid var(--mm-border);
          margin-bottom: 20px;
          overflow-x: auto;
        }
        .tab-btn {
          background: transparent;
          color: var(--mm-text-muted);
          border: none;
          border-radius: 10px;
          padding: 10px 16px;
          min-height: 44px;
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
          background: var(--mm-primary);
          color: #ffffff;
          box-shadow: 0 2px 10px rgba(2, 132, 199, 0.4);
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
          font-size: 19px;
        }
        .mob-nav-btn.active {
          color: #ffffff;
          background: var(--mm-primary);
        }

        /* Cards & Command Bars */
        .surface-card {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 16px;
          padding: 18px;
          margin-bottom: 16px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
        }
        .command-bar {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 16px;
          padding: 12px 16px;
          margin-bottom: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
        }
        .nav-cluster, .action-cluster {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .date-range-title {
          font-size: 15px;
          font-weight: 700;
          color: var(--mm-text);
          margin-left: 6px;
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
          font-size: 18px;
          font-weight: 800;
          color: var(--mm-text);
        }
        .section-subtitle {
          margin: 4px 0 0;
          font-size: 13px;
          color: var(--mm-text-muted);
        }

        /* Buttons — 44px minimum touch target & crisp contrast */
        .btn {
          border: 1px solid transparent;
          border-radius: 12px;
          padding: 10px 16px;
          min-height: 44px;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: all 0.15s ease;
          text-decoration: none;
          color: var(--mm-text);
        }
        .btn:active {
          transform: translateY(1px);
        }
        .btn-primary {
          background: var(--mm-primary);
          color: #ffffff;
        }
        .btn-primary:hover {
          background: var(--mm-primary-hover);
        }
        .btn-accent {
          background: linear-gradient(135deg, #7c3aed, #0284c7);
          color: #ffffff;
          box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
        }
        .btn-accent:hover {
          filter: brightness(1.08);
        }
        .btn-secondary {
          background: var(--mm-surface-elevated);
          color: var(--mm-text);
          border-color: var(--mm-border-strong);
        }
        .btn-secondary:hover {
          background: var(--mm-surface-hover);
        }
        .btn-lg {
          min-height: 48px;
          padding: 12px 20px;
          font-size: 15px;
        }
        .btn-sm {
          min-height: 38px;
          padding: 6px 12px;
          font-size: 13px;
          border-radius: 10px;
        }
        .btn-block {
          flex: 1;
        }

        .icon-btn {
          width: 42px;
          height: 42px;
          border-radius: 10px;
          border: 1px solid var(--mm-border);
          background: var(--mm-surface-elevated);
          color: var(--mm-text);
          font-size: 16px;
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
        .icon-btn-danger:hover {
          background: var(--mm-danger-bg);
        }

        /* Inputs */
        .input {
          background: #0f172a;
          color: #f8fafc;
          border: 1px solid var(--mm-border-strong);
          border-radius: 12px;
          padding: 10px 14px;
          min-height: 44px;
          font-size: 14px;
          font-family: inherit;
          color-scheme: dark;
        }
        .input:focus {
          outline: 2px solid var(--mm-primary);
          border-color: transparent;
        }
        .input::placeholder {
          color: #64748b;
        }
        .input-date {
          padding: 6px 10px;
          min-height: 38px;
          font-size: 13px;
        }

        /* Calendar Grid & Day Cards */
        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
          gap: 14px;
        }
        .day-card {
          background: var(--mm-surface);
          border: 1px solid var(--mm-border);
          border-radius: 16px;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition: border-color 0.15s, transform 0.15s;
        }
        .day-card.day-today {
          border: 2px solid #38bdf8;
          box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.2), 0 8px 24px rgba(2, 132, 199, 0.18);
        }
        .day-card.day-skipped {
          background: rgba(21, 28, 44, 0.55);
          border-style: dashed;
        }
        .day-card.day-swap-source {
          border: 2px dashed #fbbf24;
          background: rgba(245, 158, 11, 0.08);
        }
        .day-card.day-swap-target {
          border-color: rgba(124, 58, 237, 0.55);
        }
        .day-card-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding-bottom: 10px;
          border-bottom: 1px solid var(--mm-border);
          margin-bottom: 12px;
        }
        .day-date-group {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .day-date-label {
          font-size: 14px;
          font-weight: 800;
          color: #cbd5e1;
        }
        .day-date-label.today-highlight {
          color: #38bdf8;
        }
        .meal-headline {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          margin: -4px -6px 4px;
          border-radius: 10px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .meal-headline:hover {
          background: var(--mm-surface-elevated);
        }
        .meal-name-text {
          font-size: 17px;
          font-weight: 800;
          color: #ffffff;
        }
        .edit-affordance {
          font-size: 12px;
          font-weight: 700;
          color: #38bdf8;
          background: rgba(56, 189, 248, 0.14);
          padding: 4px 10px;
          border-radius: 8px;
          white-space: nowrap;
        }
        .day-expiry-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 12px;
          padding: 8px 10px;
          background: rgba(15, 23, 42, 0.6);
          border-radius: 10px;
          border: 1px solid var(--mm-border);
        }
        .expiry-label {
          font-size: 12px;
          font-weight: 700;
          color: var(--mm-text-muted);
        }
        .expiry-quick-pills {
          display: flex;
          gap: 4px;
        }
        .chip-btn {
          background: var(--mm-surface-elevated);
          color: #e2e8f0;
          border: 1px solid var(--mm-border-strong);
          border-radius: 8px;
          padding: 5px 9px;
          min-height: 34px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .chip-btn:hover {
          background: var(--mm-primary);
          color: #ffffff;
        }
        .day-action-bar {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--mm-border);
        }
        .action-pill {
          background: var(--mm-surface-elevated);
          color: #e2e8f0;
          border: 1px solid var(--mm-border);
          border-radius: 10px;
          padding: 7px 11px;
          min-height: 38px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex: 1;
          justify-content: center;
          white-space: nowrap;
        }
        .action-pill:hover {
          background: var(--mm-surface-hover);
          color: #ffffff;
        }
        .action-pill.active {
          background: var(--mm-primary);
          color: #ffffff;
          border-color: var(--mm-primary);
        }
        .action-pill-danger {
          flex: 0 0 auto;
          color: var(--mm-danger-text);
        }
        .empty-day-slot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 0 2px;
        }
        .btn-assign-meal {
          flex: 1;
          min-height: 48px;
          border-radius: 12px;
          border: 1px dashed rgba(56, 189, 248, 0.45);
          background: rgba(2, 132, 199, 0.1);
          color: #38bdf8;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: all 0.15s;
        }
        .btn-assign-meal:hover {
          background: var(--mm-primary);
          color: #ffffff;
          border-style: solid;
        }
        .skipped-box {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 0;
          color: var(--mm-text-muted);
          font-weight: 600;
        }
        .swap-banner {
          background: rgba(245, 158, 11, 0.16);
          border: 2px solid #fbbf24;
          color: #fef3c7;
          padding: 12px 16px;
          border-radius: 14px;
          margin-bottom: 16px;
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
          gap: 6px;
          align-items: center;
        }
        .pill {
          background: #1e293b;
          color: #f1f5f9;
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 999px;
          padding: 4px 11px;
          font-size: 12px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .pill-tag {
          background: rgba(124, 58, 237, 0.22);
          color: #ddd6fe;
          border-color: rgba(167, 139, 250, 0.35);
        }
        .pill-lg {
          padding: 6px 13px;
          font-size: 13px;
        }
        .pill-del {
          background: rgba(255, 255, 255, 0.12);
          border: none;
          color: #ffffff;
          border-radius: 50%;
          width: 20px;
          height: 20px;
          cursor: pointer;
          font-size: 11px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .badge {
          border-radius: 8px;
          padding: 4px 9px;
          font-size: 12px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .badge-ok {
          background: var(--mm-success-bg);
          color: var(--mm-success-text);
          border: 1px solid rgba(74, 222, 128, 0.3);
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
          background: rgba(56, 189, 248, 0.18);
          color: #38bdf8;
          border: 1px solid rgba(56, 189, 248, 0.35);
        }

        /* Database & AI Grid */
        .db-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
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
          font-size: 17px;
          font-weight: 800;
          color: #ffffff;
        }
        .star-toggle {
          background: transparent;
          border: none;
          font-size: 22px;
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
          font-size: 13px;
          color: var(--mm-text-muted);
          background: rgba(15, 23, 42, 0.5);
          padding: 8px 10px;
          border-radius: 8px;
        }
        .ai-reason-box {
          margin-top: 8px;
          font-size: 13px;
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
          min-width: 240px;
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
          padding-left: 38px;
        }
        .filter-chip {
          background: var(--mm-surface-elevated);
          color: #cbd5e1;
          border: 1px solid var(--mm-border-strong);
          border-radius: 999px;
          padding: 8px 14px;
          min-height: 40px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .filter-chip.active {
          background: var(--mm-primary);
          color: #ffffff;
          border-color: var(--mm-primary);
        }

        /* Shopping & Scan Layout */
        .shop-hero-bar {
          background: linear-gradient(135deg, rgba(2, 132, 199, 0.18), rgba(124, 58, 237, 0.18));
          border: 1px solid rgba(56, 189, 248, 0.35);
          border-radius: 16px;
          padding: 14px 16px;
          margin-bottom: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
        }
        .shop-hero-actions, .shop-hero-Right {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
        }
        .upload-hero-btn {
          cursor: pointer;
        }

        /* Segmented Control */
        .segmented-control {
          display: flex;
          background: #0f172a;
          padding: 5px;
          border-radius: 14px;
          border: 1px solid var(--mm-border-strong);
          margin-bottom: 16px;
          gap: 6px;
        }
        .seg-btn {
          flex: 1;
          min-height: 44px;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: var(--mm-text-muted);
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          padding: 8px 12px;
          transition: all 0.15s;
        }
        .seg-btn.active {
          background: var(--mm-primary);
          color: #ffffff;
          box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35);
        }

        .shop-workspace {
          display: grid;
          grid-template-columns: ${this._isCompanion ? "1fr" : "repeat(auto-fit, minmax(360px, 1fr))"};
          gap: 16px;
          align-items: start;
        }
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
          padding: 12px 14px;
          min-height: 54px;
          border-radius: 12px;
          background: var(--mm-surface-elevated);
          border: 1px solid var(--mm-border);
          transition: background 0.12s;
        }
        .shop-item-row:hover {
          background: var(--mm-surface-hover);
        }
        .shop-item-label {
          display: flex;
          align-items: center;
          gap: 14px;
          flex: 1;
          cursor: pointer;
        }
        .modern-checkbox {
          width: 24px;
          height: 24px;
          accent-color: var(--mm-primary);
          cursor: pointer;
          flex-shrink: 0;
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
          padding: 14px 16px;
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
          z-index: 1000;
          padding: 16px;
        }
        .modal-sheet {
          background: var(--mm-surface);
          color: var(--mm-text);
          border: 1px solid var(--mm-border-strong);
          border-radius: 20px;
          padding: 22px;
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
          font-size: 20px;
          font-weight: 800;
          color: #ffffff;
        }
        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 20px;
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
          padding: 12px 14px;
          border-radius: 14px;
          background: var(--mm-surface-elevated);
          border: 1px solid var(--mm-border);
          transition: all 0.12s;
        }
        .picker-meal-row:hover {
          border-color: #38bdf8;
          background: var(--mm-surface-hover);
        }
        .picker-meal-row.selected {
          border: 2px solid #38bdf8;
          background: rgba(2, 132, 199, 0.18);
        }
        .picker-meal-info {
          flex: 1;
          cursor: pointer;
        }
        .picker-meal-name {
          font-size: 16px;
          font-weight: 800;
          color: #ffffff;
        }
        .picker-meal-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        /* Scan Modal Grid */
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
          padding: 28px 18px;
          text-align: center;
          color: var(--mm-text-muted);
          border: 1px dashed var(--mm-border-strong);
          border-radius: 14px;
          background: rgba(15, 23, 42, 0.4);
        }
        .empty-icon {
          font-size: 32px;
          margin-bottom: 8px;
        }

        /* Toast */
        .toast {
          position: fixed;
          bottom: 84px;
          right: 20px;
          padding: 12px 18px;
          border-radius: 12px;
          background: #0284c7;
          color: #ffffff;
          font-weight: 700;
          font-size: 14px;
          z-index: 2000;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45);
        }
        .toast.error {
          background: #dc2626;
        }

        /* Responsive Mobile Rules */
        @media (max-width: 768px) {
          :host {
            padding: 14px 12px 92px;
          }
          .desktop-tabs {
            display: none;
          }
          .mobile-bottom-nav {
            display: flex;
          }
          .subview-hidden-mobile {
            display: none !important;
          }
          .modal-backdrop {
            align-items: flex-end;
            padding: 0;
          }
          .modal-sheet {
            border-radius: 22px 22px 0 0;
            max-height: 92vh;
            padding: 18px 16px 28px;
          }
        }
      </style>

      ${allIngsDatalist}

      <!-- Header Bar -->
      <div class="app-header">
        <div class="brand-wrap">
          <div class="brand-logo">🍽️</div>
          <div>
            <h1 class="brand-title">MealMind</h1>
            <p class="brand-subtitle">
              ${this._isCompanion ? "Online Shopping Companion" : "Smart Meal Planner & Receipt Sync"}
            </p>
          </div>
        </div>

        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" id="top-print-today">🖨️ Today's Card</button>
          <button class="btn btn-secondary btn-sm" id="top-print-7d">🖨️ Next 7 Days</button>
          <button class="btn btn-secondary btn-sm" id="top-print-shop">🖨️ Shopping List</button>
        </div>
      </div>

      <!-- Desktop Segmented Navigation -->
      <div class="desktop-tabs">
        <button class="tab-btn ${this._activeTab === "calendar" ? "active" : ""}" data-tab="calendar">
          📅 Meal Calendar
        </button>
        <button class="tab-btn ${this._activeTab === "shop" ? "active" : ""}" data-tab="shop">
          🛒 Shop & Receipt Scan <span class="tab-count">${shopCount}</span>
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

    // Tab navigation (Desktop & Mobile bottom nav)
    root.querySelectorAll(".tab-btn, .mob-nav-btn").forEach((btn) => {
      btn.onclick = () => {
        this._activeTab = btn.dataset.tab;
        this._render();
      };
    });

    // Shop Sub-View switcher
    root.querySelectorAll(".seg-btn[data-subview]").forEach((btn) => {
      btn.onclick = () => {
        this._shopSubView = btn.dataset.subview;
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
        const slot = this._state.schedule[btn.dataset.date] || {};
        const dbMeal = slot.meal_id ? this._state.meals[slot.meal_id] : null;
        const ings = dbMeal ? dbMeal.ingredients || [] : [];
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

    const heroSavedBtn = root.getElementById("hero-add-saved-meal-btn");
    if (heroSavedBtn) {
      heroSavedBtn.onclick = () => this._openDayModal(this._findNextOpenDateStr(), "pick");
    }
    const heroCustomBtn = root.getElementById("hero-add-custom-meal-btn");
    if (heroCustomBtn) {
      heroCustomBtn.onclick = () => this._openDayModal(this._findNextOpenDateStr(), "custom");
    }

    root.querySelectorAll(".quick-open-picker-btn").forEach((btn) => {
      btn.onclick = () => this._openDayModal(this._findNextOpenDateStr(), "pick");
    });
    root.querySelectorAll(".quick-open-custom-btn").forEach((btn) => {
      btn.onclick = () => this._openDayModal(this._findNextOpenDateStr(), "custom");
    });
    root.querySelectorAll(".quick-auto-schedule-btn").forEach((btn) => {
      btn.onclick = () => this._handleAutoSchedule();
    });

    const reopenScanModalBtn = root.getElementById("reopen-scan-modal-btn");
    if (reopenScanModalBtn) {
      reopenScanModalBtn.onclick = () => {
        this._postScanModal = true;
        this._render();
      };
    }

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
  }
}

if (!customElements.get("mealmind-panel")) {
  customElements.define("mealmind-panel", MealMindPanel);
}
