/* ==================================================================
   NEW — in-app dialogs, replacing the browser's own grey boxes.
   ==================================================================

   Replaced 78 alert(), 28 confirm() and 12 prompt() calls. Those look
   different on every phone and browser, ignore the portal's styling
   entirely, and for a prompt you get a plain text field for something
   that can only ever be an amount — so no numeric keyboard and no
   validation.

   Three functions, all returning a promise, so a call site reads almost
   like the one it replaced:

     alert(x)              ->  showAlert(x)
     if (!confirm(x))      ->  if (!(await showConfirm(x)))
     const y = prompt(x)   ->  const y = await showPrompt(x)

   Own class names rather than the portal's existing modal classes: those
   differ between the two portals, and then the same dialog would behave
   differently depending on where you opened it. Colours do come from the
   portal, through a handful of CSS variables.
   ================================================================== */

const kcDialogState = {
  open: 0,
  previousFocus: null
};

function kcDialogLockScroll(on) {
  kcDialogState.open += on ? 1 : -1;

  if (kcDialogState.open < 0) kcDialogState.open = 0;

  const busy = kcDialogState.open > 0;

  document.documentElement.classList.toggle("kc-dialog-open", busy);
  document.body.classList.toggle("kc-dialog-open", busy);
}

function kcDialogEscapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Default validation for the amount dialogs.
 *
 * The old prompt() accepted anything: an empty line, "abc", a negative
 * number. That went to the server and came back as an error, or worse, as
 * an order of zero euros. Caught here instead, next to the field, without
 * having to start over.
 *
 * Comma and dot both work: on a Dutch keyboard you type a comma, and that
 * should simply be accepted.
 */
function kcMoneyCheck(value) {
  const text = String(value || "").replace(/\s/g, "").replace(",", ".");

  if (!text) return "Please enter an amount.";

  const amount = Number(text);

  if (!Number.isFinite(amount)) return "That is not a valid amount.";
  if (amount <= 0) return "The amount must be higher than 0.";

  return "";
}

/**
 * The core. The three exported functions are a thin layer around it.
 *
 * kind:    "alert" | "confirm" | "prompt"
 * options: { title, confirmLabel, cancelLabel, danger, money,
 *            placeholder, value, validate }
 */
function kcDialog(kind, message, options) {
  const opts = options || {};

  return new Promise((done) => {
    const layer = document.createElement("div");
    layer.className = "kc-dialog";
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");

    const hasInput = kind === "prompt";
    const hasCancel = kind !== "alert";

    const title = opts.title || (kind === "confirm" ? "Are you sure?" : "");
    const confirmLabel = opts.confirmLabel || (kind === "alert" ? "OK" : "Confirm");

    layer.innerHTML =
      '<div class="kc-dialog-backdrop" data-kc-cancel></div>' +
      '<div class="kc-dialog-card">' +
        (title ? '<h3 class="kc-dialog-title">' + kcDialogEscapeHtml(title) + "</h3>" : "") +
        '<p class="kc-dialog-text">' + kcDialogEscapeHtml(message) + "</p>" +
        (hasInput
          ? '<label class="kc-dialog-field' + (opts.money ? " money" : "") + '">' +
              (opts.money ? '<span class="kc-dialog-prefix">&euro;</span>' : "") +
              '<input class="kc-dialog-input" type="text"' +
              (opts.money ? ' inputmode="decimal"' : "") +
              ' placeholder="' + kcDialogEscapeHtml(opts.placeholder || "") + '"' +
              ' value="' + kcDialogEscapeHtml(opts.value || "") + '" />' +
            "</label>" +
            '<p class="kc-dialog-error" hidden></p>'
          : "") +
        '<div class="kc-dialog-actions">' +
          (hasCancel
            ? '<button type="button" class="kc-dialog-btn cancel" data-kc-cancel>' +
              kcDialogEscapeHtml(opts.cancelLabel || "Cancel") + "</button>"
            : "") +
          '<button type="button" class="kc-dialog-btn confirm' +
          (opts.danger ? " danger" : "") + '">' + kcDialogEscapeHtml(confirmLabel) + "</button>" +
        "</div>" +
      "</div>";

    document.body.appendChild(layer);
    kcDialogLockScroll(true);

    // So focus returns to the button you came from after closing, instead
    // of jumping to the top of the page.
    if (kcDialogState.open === 1) {
      kcDialogState.previousFocus = document.activeElement;
    }

    const input = layer.querySelector(".kc-dialog-input");
    const errorEl = layer.querySelector(".kc-dialog-error");
    const confirmButton = layer.querySelector(".kc-dialog-btn.confirm");

    function close(result) {
      document.removeEventListener("keydown", onKeyDown, true);
      layer.remove();
      kcDialogLockScroll(false);

      if (kcDialogState.open === 0 && kcDialogState.previousFocus) {
        try {
          kcDialogState.previousFocus.focus();
        } catch (err) {
          /* the element is gone; nothing to focus */
        }

        kcDialogState.previousFocus = null;
      }

      done(result);
    }

    function cancel() {
      close(kind === "prompt" ? null : kind === "confirm" ? false : undefined);
    }

    function confirm() {
      if (!hasInput) {
        close(kind === "confirm" ? true : undefined);
        return;
      }

      const value = input.value.trim();

      // The caller decides what counts as valid; without a check anything
      // goes through and the behaviour matches the old prompt().
      if (typeof opts.validate === "function") {
        const problem = opts.validate(value);

        if (problem) {
          errorEl.textContent = problem;
          errorEl.hidden = false;
          input.focus();
          input.select();
          return;
        }
      }

      close(value);
    }

    layer.querySelectorAll("[data-kc-cancel]").forEach((el) => {
      el.addEventListener("click", cancel);
    });

    confirmButton.addEventListener("click", confirm);

    function onKeyDown(event) {
      // Only the topmost dialog reacts, otherwise two close at once when
      // one is opened on top of another.
      if (layer !== document.querySelector(".kc-dialog:last-of-type")) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }

      if (event.key === "Enter") {
        // In a multi-line field Enter should add a line, not submit.
        if (event.target && event.target.tagName === "TEXTAREA") return;

        event.preventDefault();
        confirm();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);

    // One frame later, so the input opens the keyboard on mobile.
    requestAnimationFrame(() => {
      if (input) {
        input.focus();
        input.select();
      } else {
        confirmButton.focus();
      }
    });
  });
}

function showAlert(message, options) {
  // FIXED - twee vensters over elkaar bij dezelfde weigering.
  //
  // Wordt een handeling geweigerd omdat Discord ontbreekt, dan opent het
  // omhulsel om fetch het Discord-venster. Maar de handler die de fout
  // opving riep daarna gewoon zijn eigen showAlert aan, en dan staat er een
  // kaal "OK"-blokje bovenop het venster dat de knop bevat die het probleem
  // oplost. Je leest de melding twee keer en kunt de nuttige helft niet
  // bereiken.
  //
  // Dit hier in plaats van bij elk van de 32 aanroepers: een melding hoort
  // sowieso niet over een openstaand Discord-venster heen te vallen, waar
  // hij ook vandaan komt.
  if (window.kcDiscordGate?.isOpen()) return Promise.resolve();

  return kcDialog("alert", message, options);
}

function showConfirm(message, options) {
  return kcDialog("confirm", message, options);
}

function showPrompt(message, options) {
  return kcDialog("prompt", message, options);
}

const dashboardConfig = {
  quick: {
    label: "Quick Deals",
    tabs: [
      { key: "open_claims", label: "Open Claims" },
      { key: "confirmed", label: "Confirmed" },
      { key: "label_requested", label: "Label Requested" },
      { key: "ready_to_ship", label: "Ready To Ship" },
      { key: "shipped", label: "Shipped" },
      { key: "delivered", label: "Delivered" }
    ]
  },

  wtb: {
    label: "Want To Buys",
    tabs: [
      { key: "offers", label: "Offers", statusFilters: ["open", "counter", "denied"] },
      { key: "accepted", label: "Accepted" },
      { key: "confirmed", label: "Confirmed" },
      { key: "label_requested", label: "Label Requested" },
      { key: "ready_to_ship", label: "Ready To Ship" },
      { key: "shipped", label: "Shipped" },
      { key: "delivered", label: "Delivered" }
    ]
  },

  consignment: {
    label: "Consignment",
    tabs: [
      { key: "inventory", label: "Inventory" },
      { key: "offers", label: "Offers", statusFilters: ["open", "counter", "denied"] },
      { key: "accepted", label: "Accepted" },
      { key: "confirmed", label: "Confirmed" },
      { key: "label_requested", label: "Label Requested" },
      { key: "ready_to_ship", label: "Ready To Ship" },
      { key: "shipped", label: "Shipped" },
      { key: "delivered", label: "Delivered" }
    ]
  },

  buying: {
    label: "Buying",
    tabs: [
      { key: "open_wtbs", label: "Open WTBs" },
      { key: "offers", label: "Offers", statusFilters: ["open", "counter", "denied"] },
      { key: "accepted", label: "Accepted" },
      // CHANGED - sidebar label only; the key, the Discord copy and the
      // Airtable status are untouched. "Payment Required" plus the
      // attention badge did not fit the narrower sidebar, and this row is
      // the one that must never be the one that truncates.
      { key: "payment_required", label: "Payment Due" },
      { key: "confirmed", label: "Confirmed" },
      { key: "label_requested", label: "Label Requested" },
      { key: "ready_to_ship", label: "Ready To Ship" },
      { key: "shipped", label: "Shipped" },
      { key: "delivered", label: "Delivered" }
    ]
  },

  history: {
    label: "History",
    tabs: [
      { key: "completed", label: "Sales" },
      { key: "issues", label: "Issues" }
    ]
  }
};

const skeletonColumns = [
  "Product",
  "Size",
  "Order ID",
  "Payout",
  "VAT Type",
  "Date",
  "Action"
];

const consignmentInventoryColumns = [
  "Product",
  "Size",
  "VAT Type",
  "Selling Price",
  "Lowest Price",
  "Quantity",
  "Action"
];

const consignmentOfferColumns = [
  "Product",
  "Size",
  "Order ID",
  "Your Price",
  "Offer",
  "VAT Type",
  "Date",
  "Action"
];

let dashboardSeller = JSON.parse(localStorage.getItem("kc_seller") || "null");
let activeSection = localStorage.getItem("kc_dashboard_section") || "quick";
let activeTab = localStorage.getItem("kc_dashboard_tab") || "open_claims";
// NEW — additive only: which status pill (open/counter/denied) is
// active, for any tab that has statusFilters configured. Shared across
// sections/tabs — each tab's own fetch reads this when building its
// request, and switching tabs resets it back to "open".
let activeOfferStatusFilter = "open";
// NEW — additive only: pill counts (per section:tab, per status), kept
// entirely separate from dashboardCountsCache so they never get summed
// into that object's section totals (see setConsignmentCount).
let dashboardPillCountsCache = {};

const dashboardTitle = document.getElementById("dashboardTitle");
const dashboardSellerName = document.getElementById("dashboardSellerName");
const dashboardSellerId = document.getElementById("dashboardSellerId");
const dashboardLogoutBtn = document.getElementById("dashboardLogoutBtn");
const dashboardLoginPanel = document.getElementById("dashboardLoginPanel");
const dashboardContent = document.getElementById("dashboardContent");
const dashboardLoginForm = document.getElementById("dashboardLoginForm");
const dashboardLoginEmail = document.getElementById("dashboardLoginEmail");
const dashboardLoginPassword = document.getElementById("dashboardLoginPassword");
const dashboardLoginError = document.getElementById("dashboardLoginError");
const dashboardForgotPasswordBtn = document.getElementById("dashboardForgotPasswordBtn");
const dashboardStats = document.getElementById("dashboardStats");
const dashboardStatsToggle = document.getElementById("dashboardStatsToggle");
const dashboardSubtabTitle = document.getElementById("dashboardSubtabTitle");
const dashboardSubtabDescription = document.getElementById("dashboardSubtabDescription");
const dashboardPillRow = document.getElementById("dashboardPillRow");
const dashboardTableHead = document.getElementById("dashboardTableHead");
const dashboardTableBody = document.getElementById("dashboardTableBody");
const dashboardRefreshBtn = document.getElementById("dashboardRefreshBtn");
const dashboardSearchInput = document.getElementById("dashboardSearchInput");
const dashboardMobileMenuBtn = document.getElementById("dashboardMobileMenuBtn");
const dashboardSidebarBackdrop = document.getElementById("dashboardSidebarBackdrop");
const dashboardSidebar = document.querySelector(".dashboard-sidebar");
const editOfferModal = document.getElementById("editOfferModal");
const editOfferForm = document.getElementById("editOfferForm");
const editOfferOrderRecordId = document.getElementById("editOfferOrderRecordId");
const editOfferVatType = document.getElementById("editOfferVatType");
const editOfferVatTypeLabel = document.getElementById("editOfferVatTypeLabel");
const editOfferAmount = document.getElementById("editOfferAmount");
const editOfferError = document.getElementById("editOfferError");
const editOfferCurrentLowest = document.getElementById("editOfferCurrentLowest");
const issueModal = document.getElementById("issueModal");
const issueForm = document.getElementById("issueForm");
const issueInventoryId = document.getElementById("issueInventoryId");
const issueNotes = document.getElementById("issueNotes");
const issueError = document.getElementById("issueError");

const viewIssueModal = document.getElementById("viewIssueModal");
const viewIssueNote = document.getElementById("viewIssueNote");

const labelInstructionsModal = document.getElementById("labelInstructionsModal");
const confirmLabelDownloadBtn = document.getElementById("confirmLabelDownloadBtn");

const consignmentAddStockModal = document.getElementById("consignmentAddStockModal");
const consignmentAddStockForm = document.getElementById("consignmentAddStockForm");
const consignmentSkuInput = document.getElementById("consignmentSkuInput");
const consignmentSizeRows = document.getElementById("consignmentSizeRows");
const consignmentAddSizeRowBtn = document.getElementById("consignmentAddSizeRowBtn");
const consignmentAddAnotherProductBtn = document.getElementById("consignmentAddAnotherProductBtn");
const consignmentAddStockError = document.getElementById("consignmentAddStockError");
const consignmentAddStockSuccess = document.getElementById("consignmentAddStockSuccess");
const consignmentCsvModal = document.getElementById("consignmentCsvModal");
const consignmentCsvForm = document.getElementById("consignmentCsvForm");
const consignmentCsvMode = document.getElementById("consignmentCsvMode");
const consignmentCsvFileInput = document.getElementById("consignmentCsvFileInput");
const consignmentCsvPreview = document.getElementById("consignmentCsvPreview");
const consignmentCsvError = document.getElementById("consignmentCsvError");
const consignmentEditStockModal = document.getElementById("consignmentEditStockModal");
const consignmentEditStockForm = document.getElementById("consignmentEditStockForm");
const consignmentEditStockId = document.getElementById("consignmentEditStockId");
const consignmentEditSellingPriceInput = document.getElementById("consignmentEditSellingPriceInput");
const consignmentEditQuantityInput = document.getElementById("consignmentEditQuantityInput");
const consignmentEditStockError = document.getElementById("consignmentEditStockError");
const consignmentCsvDuplicateModal = document.getElementById("consignmentCsvDuplicateModal");
const consignmentCsvDuplicateList = document.getElementById("consignmentCsvDuplicateList");
const consignmentCsvDuplicateBackBtn = document.getElementById("consignmentCsvDuplicateBackBtn");
const dashboardConsignorCta = document.getElementById("dashboardConsignorCta");

let pendingLabelUrl = "";

function canAccessSection(section) {
  if (section !== "consignment") return true;
  return dashboardSeller?.consignor === true;
}

function syncConsignmentAccess() {
  const section = document.querySelector("[data-consignment-nav-section]");
  section?.classList.toggle("hidden", !canAccessSection("consignment"));

  dashboardConsignorCta?.classList.toggle(
    "hidden",
    !dashboardSeller || dashboardSeller.consignor === true
  );

  if (!canAccessSection(activeSection)) {
    activeSection = "quick";
    activeTab = "open_claims";
    localStorage.setItem("kc_dashboard_section", activeSection);
    localStorage.setItem("kc_dashboard_tab", activeTab);
  }
}

function safeSection(section) {
  return dashboardConfig[section] && canAccessSection(section) ? section : "quick";
}

function safeTab(section, tab) {
  const tabs = dashboardConfig[section].tabs;
  return tabs.some((item) => item.key === tab) ? tab : tabs[0].key;
}

function renderSubnav() {
  Object.entries(dashboardConfig).forEach(([section, config]) => {
    const wrap = document.querySelector(`[data-subnav="${section}"]`);
    if (!wrap) return;

    wrap.innerHTML = config.tabs.map((tab) => {
      const count = Number(dashboardCountsCache?.[section]?.[tab.key] || 0);

      // Warning on ANY buying tab holding an unpaid deal, not just
      // Delivered — a trusted buyer proceeds unpaid through every status.
      const showWarning =
        section === "buying" &&
        Number(dashboardCountsCache?.buying?.[`${tab.key}_payment_warning`] || 0) > 0;

      return `
        <button class="dashboard-subnav-btn" type="button" data-section="${section}" data-tab="${tab.key}">
          <span class="dashboard-subnav-label">${tab.label}</span>
          <span class="dashboard-subnav-meta">
            ${showWarning ? `<span class="dashboard-subnav-warning" title="Outstanding payment">!</span>` : ""}
            <span class="dashboard-subnav-count${count ? "" : " zero"}" data-count-key="${section}:${tab.key}">${count}</span>
          </span>
        </button>
      `;
    }).join("");
  });
}

// CHANGED - the drawer is position: fixed, so a scroll gesture that ran
// past its end carried straight on into the page behind it: you dragged the
// sidebar and watched the background move instead.
//
// Locking the body is the only thing that reliably holds on iOS - overflow:
// hidden alone does not - and position: fixed loses the scroll position, so
// it has to be stored and put back by hand.
let sidebarScrollY = 0;

function setSidebarOpen(open) {
  const locked = document.body.classList.contains("sidebar-locked");

  if (open && !locked) {
    sidebarScrollY = window.scrollY;
    document.body.style.top = `-${sidebarScrollY}px`;
    document.body.classList.add("sidebar-locked");
  } else if (!open && locked) {
    document.body.classList.remove("sidebar-locked");
    document.body.style.top = "";
    window.scrollTo(0, sidebarScrollY);
  }

  dashboardSidebar?.classList.toggle("open", open);
  dashboardSidebarBackdrop?.classList.toggle("open", open);
}

// Turning the phone while the drawer is open takes the drawer away with
// the media query but would leave the page locked, which reads as a
// frozen screen.
window.addEventListener("resize", () => {
  if (
    document.body.classList.contains("sidebar-locked") &&
    window.matchMedia("(min-width: 1101px)").matches
  ) {
    setSidebarOpen(false);
  }
});

function bindNavigation() {
    dashboardMobileMenuBtn?.addEventListener("click", () => {
    setSidebarOpen(true);
  });

  dashboardSidebarBackdrop?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
  
  document.querySelectorAll("[data-dashboard-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = safeSection(button.dataset.dashboardSection);
      const subnav = document.querySelector(`[data-subnav="${section}"]`);

      button.classList.toggle("open");
      subnav?.classList.toggle("open");
    });
  });

  document.querySelectorAll(".dashboard-subnav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveView(button.dataset.section, button.dataset.tab);
  
      setSidebarOpen(false);
    });
  });
}

function setActiveView(section, tab) {
  activeSection = safeSection(section);
  activeTab = safeTab(activeSection, tab);
  activeOfferStatusFilter = "open";

  localStorage.setItem("kc_dashboard_section", activeSection);
  localStorage.setItem("kc_dashboard_tab", activeTab);

  syncDashboardUi();
}

function getActiveTabConfig() {
  return dashboardConfig[activeSection].tabs.find((tab) => tab.key === activeTab);
}

// NEW — additive only: generic pill row for any tab with statusFilters
// configured (currently just consignment's merged "Offers" tab; the
// same mechanism will be reused for the other sections next). Pill
// labels/counts are generic across all statusFilters tabs — the count
// per pill comes from the same fetch as the active pill's data, so an
// inactive pill's count only updates once you've visited it at least
// once this session (avoiding N extra requests just to show numbers
// you haven't asked to see yet).
const pillLabels = { open: "Open", counter: "Countered", denied: "Denied" };

function renderPillRow(tabConfig) {
  if (!tabConfig?.statusFilters?.length) {
    dashboardPillRow.classList.add("hidden");
    dashboardPillRow.innerHTML = "";
    return;
  }

  dashboardPillRow.classList.remove("hidden");

  dashboardPillRow.innerHTML = tabConfig.statusFilters.map((statusKey) => {
    const countKey = `${activeSection}:${activeTab}:${statusKey}`;
    const count = dashboardPillCountsCache?.[`${activeSection}:${activeTab}`]?.[statusKey] ?? "";

    return `
      <button
        class="dashboard-pill-btn ${statusKey === activeOfferStatusFilter ? "active" : ""}"
        type="button"
        data-status-filter="${statusKey}"
      >
        <span>${pillLabels[statusKey] || statusKey}</span>
        <span class="dashboard-pill-count" data-pill-count-key="${countKey}">${count}</span>
      </button>
    `;
  }).join("");

  dashboardPillRow.querySelectorAll("[data-status-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.statusFilter === activeOfferStatusFilter) return;
      activeOfferStatusFilter = btn.dataset.statusFilter;
      renderPillRow(tabConfig);

      loadDashboardData().catch((err) => {
        dashboardTableBody.innerHTML = `
          <tr>
            <td colspan="${skeletonColumns.length}">
              <div class="dashboard-empty-state">
                <strong>${escapeHtml(err.message)}</strong>
              </div>
            </td>
          </tr>
        `;
      });
    });
  });
}

function syncDashboardUi() {
  activeSection = safeSection(activeSection);
  activeTab = safeTab(activeSection, activeTab);

  const sectionConfig = dashboardConfig[activeSection];
  const tabConfig = getActiveTabConfig();

  dashboardTitle.textContent = sectionConfig.label;
  dashboardSubtabTitle.textContent = tabConfig.label;
  dashboardSubtabDescription.textContent = "";

  renderPillRow(tabConfig);

  document.querySelectorAll("[data-dashboard-section]").forEach((button) => {
    const isActiveSection = button.dataset.dashboardSection === activeSection;
    const subnav = document.querySelector(`[data-subnav="${button.dataset.dashboardSection}"]`);

    // CHANGED - this forced every other section shut on every tab
    // switch. Opening the section you just navigated into is helpful;
    // collapsing the ones you deliberately expanded is not. A section
    // now closes only when you click its own header.
    if (isActiveSection) {
      button.classList.add("open");
      subnav?.classList.add("open");
    }

    // "open" used to double as the highlight, which only worked because
    // exactly one section was ever open. Now that several can be, the
    // highlight needs its own class.
    button.classList.toggle("active", isActiveSection);
  });
  
  document.querySelectorAll(".dashboard-subnav-btn").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.section === activeSection &&
      button.dataset.tab === activeTab
    );
  });

  renderStats();

  loadDashboardData().catch((err) => {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>${escapeHtml(err.message)}</strong>
          </div>
        </td>
      </tr>
    `;
  });
}

let dashboardCountsCache = {
  quick: {},
  wtb: {},
  consignment: {},
  buying: {},
  history: {}
};

let quickCountsCache = {};
let statsOpen = false;

// CHANGED - a count of zero is noise, and in a 168 px sidebar it costs the
// width the label needs. Every place that writes a nav count goes through
// here, so the rule cannot drift apart between them again.
function setNavCount(el, value) {
  if (!el) return;

  const n = Number(value || 0);

  el.textContent = n;
  el.classList.toggle("zero", n === 0);
}

function setConsignmentCount(key, value) {
  const count = Number(value || 0);

  dashboardCountsCache.consignment = {
    ...(dashboardCountsCache.consignment || {}),
    [key]: count
  };

  document.querySelectorAll(`[data-count-key="consignment:${key}"]`)
    .forEach((el) => {
      setNavCount(el, count);
    });

  const total = Object.values(dashboardCountsCache.consignment || {})
    .reduce((sum, item) => sum + Number(item || 0), 0);

  document.querySelectorAll('[data-count-group="consignment"]')
    .forEach((el) => {
      setNavCount(el, total);
    });

  renderStats();
}

async function loadDashboardCounts() {
  if (!dashboardSeller) return;

  const params = new URLSearchParams({
    seller_record_id: dashboardSeller.id,
    seller_id: dashboardSeller.seller_id
  });

  const response = await fetch(`/api/dashboard/counts?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.details || data.error || "Failed to load dashboard counts");
  }

  dashboardCountsCache = {
    quick: {},
    wtb: {},
    consignment: {},
    buying: {},
    history: {},
    ...(data || {})
  };

  quickCountsCache = dashboardCountsCache.quick || {};

  renderSubnav();

  document.querySelectorAll(".dashboard-subnav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveView(button.dataset.section, button.dataset.tab);

      setSidebarOpen(false);
    });
  });

  Object.entries(dashboardCountsCache).forEach(([section, counts]) => {
    const total = Object.entries(counts || {})
      // Every buying tab now carries its own "<tab>_payment_warning"
      // counter, and none of them are rows — they would inflate the
      // section total if summed.
      .filter(([key]) => !key.endsWith("_payment_warning"))
      .reduce((sum, [, value]) => sum + Number(value || 0), 0);

    document.querySelectorAll(`[data-count-group="${section}"]`)
      .forEach((el) => {
        setNavCount(el, total);
      });
  });

  renderStats();
}

function renderStats() {
  const statsPanel = document.querySelector(".dashboard-stats-panel");

  if (window.innerWidth <= 768) {
    statsPanel?.classList.toggle("open", statsOpen);
  } else {
    statsPanel?.classList.add("open");
  }

  const cards = dashboardConfig[activeSection].tabs;

  dashboardStats.innerHTML = cards.map((tab) => `
    <article class="dashboard-stat-card ${tab.key === activeTab ? "active" : ""}">
      <div class="dashboard-stat-label">${tab.label}</div>
      <div class="dashboard-stat-value">
        ${dashboardCountsCache[activeSection]?.[tab.key] || 0}
      </div>
    </article>
  `).join("");
}

function isMobileDashboard() {
  // DISABLED — this returned window.innerWidth <= 768, which let eight
  // render functions write their own mobile HTML on top of the normal
  // table. Two implementations of the same table, and they drifted apart:
  // some tabs got the new card layout, others stayed on the old one.
  //
  // Every table now writes the same rows and the stylesheet turns them into
  // cards below 768 pixels. The mobile branch stays in place in case it has
  // to come back, but is no longer reached.
  return false;
}

function setMobileTableMode(isMobile = isMobileDashboard()) {
  const table = dashboardTableBody.closest(".dashboard-table");

  if (isMobile) {
    table?.classList.add("mobile-cards");
  } else {
    table?.classList.remove("mobile-cards");
  }
}

function mobileActionButton(html) {
  return html || "";
}

function renderMobileOrderCards(items, options = {}) {
  setMobileTableMode(true);

  const {
    primaryLabel = "Payout",
    primaryValue = (item) => item.payout || item.offer || "-",
    secondaryLabel = "Date",
    secondaryValue = (item) => item.date || "-",
    statusDot = null,
    actions = () => ""
  } = options;

  dashboardTableBody.innerHTML = items.map((item) => {
    const dotClass = statusDot ? statusDot(item) : "";

    return `
      <tr>
        <td>
          <article class="dashboard-mobile-card">
            <div class="dashboard-mobile-card-top">

              ${
                dotClass
                  ? `<div class="dashboard-mobile-status ${dotClass}"></div>`
                  : ""
              }

              <div class="dashboard-mobile-main">
                <div class="dashboard-mobile-product">
                  ${escapeHtml(item.product || "-")}
                </div>

                <div class="dashboard-mobile-size">
                  Size: ${escapeHtml(item.size || "-")}
                </div>

                <div class="dashboard-mobile-bottom-row">
                  <div class="dashboard-mobile-meta">

                    <div class="dashboard-mobile-meta-item">
                      <div class="dashboard-mobile-meta-label">${escapeHtml(primaryLabel)}</div>
                      <div class="dashboard-mobile-meta-value">
                        ${escapeHtml(primaryValue(item) || "-")}
                      </div>
                    </div>

                    <div class="dashboard-mobile-meta-item">
                      <div class="dashboard-mobile-meta-label">${escapeHtml(secondaryLabel)}</div>
                      <div class="dashboard-mobile-meta-value">
                        ${escapeHtml(secondaryValue(item) || "-")}
                      </div>
                    </div>
                    ${
                      options.thirdLabel
                        ? `
                          <div class="dashboard-mobile-meta-item">
                            <div class="dashboard-mobile-meta-label">${escapeHtml(options.thirdLabel)}</div>
                            <div class="dashboard-mobile-meta-value">
                              ${escapeHtml(options.thirdValue(item) || "-")}
                            </div>
                          </div>
                        `
                        : ""
                    }

                  </div>

                  <div class="dashboard-mobile-actions">
                    ${actions(item)}
                  </div>
                </div>
              </div>
            </div>
          </article>
        </td>
      </tr>
    `;
  }).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// NEW — a column's width follows what it holds, not where it sits in the
// row. The same seven sizes as the Lojiq portal, so a date is equally wide
// in both.
const COLUMN_SIZE_BY_HEADER = {
  "Amount": "col-money",
  "Brand": "col-code",
  "Buyer's Last Offer": "col-money",
  "Current Lowest": "col-money",
  "Date": "col-date",
  "Denied": "col-date",
  "Filter": "col-short",
  "Issue": "col-status",
  "Lowest Price": "col-money",
  "Max Price": "col-money",
  "My Last Offer": "col-money",
  "Offer": "col-money",
  "Order ID": "col-code",
  "Payment": "col-status",
  "Payout": "col-money",
  "Quantity": "col-short",
  "SKU": "col-code",
  "Seller's Last Offer": "col-money",
  "Seller's Offer": "col-money",
  "Selling Price": "col-money",
  "Size": "col-short",
  "Status": "col-status",
  "Tracking": "col-long",
  "VAT Type": "col-type",
  "WTB ID": "col-code",
  "Your Offer": "col-money",
  "Your Price": "col-money"
};


// NEW — the action column had a fixed width and was usually mostly empty.
// It is now measured against the buttons actually in it.
//
// Measure the buttons themselves, not the row holding them: that row
// stretches to fill the cell, so measuring it means measuring your own
// result.
function fitDashboardColumns() {
  const tabel = document.querySelector(".dashboard-table");
  if (!tabel) return;

  // On a narrow screen these are cards, and a card has no column width.
  if (window.matchMedia("(max-width: 768px)").matches) {
    tabel.style.removeProperty("--action-width");
    tabel.style.minWidth = "";
    return;
  }

  const rowEls = Array.from(
    document.querySelectorAll("#dashboardTableBody .dashboard-action-col .dashboard-action-row")
  );

  if (rowEls.length) {
    const widest = Math.max(...rowEls.map((rowEl) => {
      // CHANGED - a row with an accept block is a grid: two of its buttons
      // sit stacked in the second column. Adding all three widths together
      // then reports the old side-by-side width, so the column stayed wide
      // and the buttons floated in it with space to spare.
      //
      // Such a row is width: fit-content, so it does not stretch and its own
      // width is the honest answer.
      if (rowEl.querySelector(".action-accept")) {
        return rowEl.getBoundingClientRect().width;
      }

      const btnEls = Array.from(rowEl.children).filter((k) => k.getBoundingClientRect().width > 0);
      if (!btnEls.length) return 0;
      const gapWidth = parseFloat(getComputedStyle(rowEl).gap) || 0;
      return btnEls.reduce((som, k) => som + k.getBoundingClientRect().width, 0)
           + gapWidth * (btnEls.length - 1);
    }));

    if (widest > 0) {
      tabel.style.setProperty("--action-width", Math.ceil(widest) + 36 + "px");
    }
  }

  // Keep enough room for Product, or it collapses to unreadable.
  const fixedWidth = Array.from(document.querySelectorAll("#dashboardTableHead th"))
    .filter((th) => !th.classList.contains("dashboard-product-col"))
    .reduce((som, th) => som + th.getBoundingClientRect().width, 0);

  tabel.style.minWidth = Math.round(fixedWidth + 275) + "px";
}

window.addEventListener("resize", () => {
  fitDashboardColumns();
});

// NEW — additive: SKU, Size and Brand each had their own column, which put
// them far from the product name they describe. They now sit under that name
// in the same block. Nothing is lost; every table gets three columns
// narrower. Both field names occur in the API, hence the two.
// NEW — one place for amounts on buttons. The existing code did
// `€${Number(payout)}`, which turns 172,50 into "172.5": a dot instead of a
// comma and the trailing zero gone. If the value cannot be read, the button
// gets no amount at all rather than "€NaN".
function amountForButton(rawValue) {
  const messageText = String(rawValue === null || rawValue === undefined ? "" : rawValue).trim();
  if (!messageText) return "";

  // Already formatted by the API (for example "€ 172,50")? Leave it be.
  if (messageText.indexOf("\u20ac") >= 0) return messageText;

  const parsed = Number(messageText.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return "";

  // CHANGED - this used toFixed(2) unconditionally, so a round amount
  // came out as "172,00". Sellers enter whole numbers, so most amounts
  // are whole and should read clean; a genuine decimal (a VAT
  // conversion landing on 102,10) still has to stay visible exactly as
  // computed. Same rule as moneySmartValue on the server.
  const isWhole = Math.abs(parsed - Math.round(parsed)) < 0.005;

  return "\u20ac " + (isWhole
    ? String(Math.round(parsed))
    : parsed.toFixed(2).replace(".", ","));
}

// NEW — the same formatting for money in a column. Differs from the button
// version in two ways: a value that is not money is kept as-is ("Margin" or a
// dash can end up in such a cell), and empty becomes a dash rather than
// nothing.
function amountForColumn(rawValue) {
  const messageText = String(rawValue === null || rawValue === undefined ? "" : rawValue).trim();
  if (!messageText) return "-";

  const formatted = amountForButton(messageText);
  return formatted || escapeHtml(messageText);
}

function dashboardProductCell(item) {
  const labelText = item.product || item.product_name || "-";

  // The SKU is what people search on most, so it gets the full text colour;
  // size and brand stay secondary.
  const parts = [];
  if (item.sku) parts.push(`<span class="dashboard-product-sku">${escapeHtml(item.sku)}</span>`);
  if (item.size) parts.push(escapeHtml(`Size ${item.size}`));
  if (item.brand) parts.push(escapeHtml(item.brand));
  const meta = parts.join(" &middot; ");

  return `
    <div class="dashboard-product-name">${escapeHtml(labelText)}</div>
    ${meta ? `<div class="dashboard-product-meta">${meta}</div>` : ""}
  `;
}

// NEW — every header cell goes through here. The class decides which column
// stays put while scrolling. One place, so no table can end up with a header
// missing the class while its cells have it — which is how you get a header
// that scrolls away while the content underneath stays.
function dashboardHeadCell(label) {
  const columnClass =
    label === "Product"
      ? "dashboard-product-col"
      : label === "Size"
        ? "dashboard-size-col"
        : label === "Action" || label === "Actions"
          ? "dashboard-action-col"
          : COLUMN_SIZE_BY_HEADER[label] || "col-default";

  return `<th${columnClass ? ` class="${columnClass}"` : ""}>${label}</th>`;
}

// NEW — the cells are written out by hand per table and therefore have no
// idea which column they belong to. This reads the header and puts it on the
// cells: the class that pins the column, and the column name as data-label.
function syncDashboardCellColumns() {
  if (!dashboardTableHead || !dashboardTableBody) return;

  const headCells = Array.from(dashboardTableHead.querySelectorAll("th")).map((th) => ({
    labelText: th.textContent.trim(),
    product: th.classList.contains("dashboard-product-col"),
    actie: th.classList.contains("dashboard-action-col"),
    // The header's width class has to sit on the cells below it too,
    // otherwise the header decides one width and the cell another.
    sizeLabel: Array.from(th.classList).find((k) => k.indexOf("col-") === 0) || ""
  }));

  dashboardTableBody.querySelectorAll("tr").forEach((rowEl) => {
    // The empty state is a single cell with a colspan; it belongs to no
    // column.
    if (rowEl.children.length === 1 && rowEl.children[0].hasAttribute("colspan")) return;

    Array.from(rowEl.children).forEach((cel, i) => {
      const kop = headCells[i];
      if (!kop) return;

      if (kop.labelText) cel.setAttribute("data-label", kop.labelText);
      if (kop.product) cel.classList.add("dashboard-product-col");
      if (kop.actie) cel.classList.add("dashboard-action-col");
      if (kop.sizeLabel) cel.classList.add(kop.sizeLabel);

      // The number of buttons decides how many columns the action cell gets
      // on a card. Counting them here is more reliable than leaving it to
      // the stylesheet: auto-fit left an empty column in some browsers.
      if (kop.actie) {
        const qty = cel.querySelectorAll("button, a").length;
        cel.style.setProperty("--action-buttons", String(Math.max(1, Math.min(qty, 3))));
      }
    });
  });
}

if (dashboardTableBody) {
  new MutationObserver(() => {
    syncDashboardCellColumns();
    fitDashboardColumns();
    filterVisibleRows();
  }).observe(dashboardTableBody, { childList: true });
}

// NEW — one filter after rendering, instead of one per render path. The rows
// are already in the table, so anything the search term does not match is
// hidden. That covers every path, including paths added later.
//
// The counts in the sidebar and on the pills keep counting what actually
// exists: those come from the API and are not touched here.
function dashboardSearchTerm() {
  return String(dashboardSearchInput?.value || "").trim().toLowerCase();
}

function filterVisibleRows() {
  const tableBody = dashboardTableBody;
  if (!tableBody) return;

  const rowEls = Array.from(tableBody.querySelectorAll("tr"))
    .filter((rowEl) => !rowEl.dataset.searchNotice);

  const term = dashboardSearchTerm();
  let hitCount = 0;

  rowEls.forEach((rowEl) => {
    // The empty state is a cell with a colspan; it must always stay.
    const isEmptyState = rowEl.children.length === 1 && rowEl.children[0].hasAttribute("colspan");

    if (!term || isEmptyState) {
      rowEl.style.display = "";
      if (!isEmptyState) hitCount++;
      return;
    }

    const isHit = rowEl.textContent.toLowerCase().includes(term);
    rowEl.style.display = isHit ? "" : "none";
    if (isHit) hitCount++;
  });

  // A row of its own when the term matches nothing, otherwise you stare at
  // an empty table with no idea why.
  //
  // FIXED - this froze the browser, and consignors reported it as the site
  // crashing. The bug was the pair of statements this replaces:
  //
  //     const bestaande = tableBody.querySelector("[data-search-notice]");
  //     if (bestaande) bestaande.remove();
  //     if (term && hitCount === 0 && rowEls.length) { ...appendChild... }
  //
  // A MutationObserver on this same table calls filterVisibleRows on every
  // childList change. Removing the notice and adding it back are two such
  // changes, so the observer fired, which ran this again, which removed and
  // re-added, forever. The tab locked up.
  //
  // Appending is the only thing that starts it, and appending needs zero
  // hits. That sounds narrow, and it is not: every reload writes a
  // "Loading..." row first, and that row is an empty state - shown always,
  // counted never. So a table holding just that row is already at zero hits
  // with one row present, which is exactly the condition. Anything that
  // reloads the table while the search box has text in it hangs the page.
  //
  // That is why four reports that looked unrelated are one bug: deleting a
  // row, saving in Edit Stock, switching tabs, and typing until nothing
  // matches. The first three never even reach their own result set.
  //
  // The Edit Stock report is the clearest symptom. Its handler closes the
  // dialog and resets the button before reloading, so by the time it hangs
  // both have already happened - but a blocked main thread never repaints,
  // so the screen keeps showing the dialog with "Saving..." on it.
  //
  // The fix is to leave the table alone when it is already correct. The
  // notice carries the term it was written for; if that still matches, it
  // stays untouched, no mutation is recorded, and the observer has nothing
  // to react to. Every path now settles after one pass.
  const bestaande = tableBody.querySelector("[data-search-notice]");
  const gewenst = term && hitCount === 0 && rowEls.length ? term : "";

  if (bestaande && bestaande.dataset.searchNotice === gewenst) return;

  if (bestaande) bestaande.remove();

  if (gewenst) {
    const notice = document.createElement("tr");

    // The term doubles as the marker: it says both "this is the notice" and
    // "this is what it was written for". A plain "1" could not tell a
    // stale notice from a current one.
    notice.dataset.searchNotice = gewenst;

    notice.innerHTML =
      '<td colspan="20" style="padding:28px 14px;text-align:center;opacity:.7">' +
      "No results for \u201c" + term.replace(/[<>&]/g, "") + "\u201d" +
      "</td>";

    tableBody.appendChild(notice);
  }
}

// NEW — additive: dialogs did not behave. The page behind them scrolled
// along, and Escape closed nothing. Both belong to the dialog itself rather
// than to whatever opens it, so this sits in one place for every dialog in
// this portal.
(function () {
  const VENSTERS = ".dashboard-modal";
  const SLUITKNOPPEN = ".dashboard-modal-close";

  function openDialogs() {
    return Array.from(document.querySelectorAll(VENSTERS))
      .filter((v) => getComputedStyle(v).display !== "none");
  }

  function syncOpenState() {
    const open = openDialogs().length > 0;
    document.documentElement.classList.toggle("modal-open", open);
    document.body.classList.toggle("modal-open", open);
  }

  // Watch only the dialogs, not the whole page: the tables change classes
  // constantly and none of that needs to trigger anything here.
  const observer = new MutationObserver(syncOpenState);
  document.querySelectorAll(VENSTERS).forEach((v) => {
    observer.observe(v, { attributes: true, attributeFilter: ["class", "style"] });
  });

  document.addEventListener("keydown", (evt) => {
    if (evt.key !== "Escape") return;

    const open = openDialogs();
    if (!open.length) return;

    // Close the topmost dialog through its own close button, so whatever
    // cleanup is attached to it still runs.
    const topDialog = open[open.length - 1];
    const btnEl = topDialog.querySelector(SLUITKNOPPEN);

    if (btnEl) {
      btnEl.click();
    } else {
      topDialog.classList.add("hidden");
      topDialog.style.display = "none";
    }

    syncOpenState();
  });

  // NEW - a dialog closed while you were selecting text in it.
  //
  // Press inside a field, drag past the edge of the card, release: the
  // browser calls that a click, the backdrop takes it as "clicked outside",
  // and the dialog shuts with your input still in it. Selecting an email
  // address to correct it was enough to lose the whole form.
  //
  // A release is only a click-outside if the press started outside too.
  // Both must land off the card. Real clicks on the backdrop are unchanged:
  // there the press starts there as well.
  //
  // Capture phase, because the close handlers sit on the backdrops
  // themselves and this has to get there first.
  const KAARTEN = ".dashboard-modal-card, .dashboard-login-card";

  let persBegon = null;

  document.addEventListener("mousedown", (evt) => {
    persBegon = evt.target;
  }, true);

  document.addEventListener("click", (evt) => {
    if (!persBegon?.closest) return;

    const begonInKaart = persBegon.closest(KAARTEN);
    if (!begonInKaart) return;

    const eindigdeInKaart = evt.target?.closest?.(KAARTEN);
    if (eindigdeInKaart) return;

    evt.stopPropagation();
    evt.preventDefault();
  }, true);

  syncOpenState();
})();

function cleanSkuInput(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\-\/ ]/g, "")
    .replace(/^\s+|\s+$/g, "");
}

function cleanSizeInput(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.\/ ]/g, "")
    .replace(/^\s+|\s+$/g, "");
}

function cleanWholeNumberInput(value) {
  return String(value || "")
    .replace(/[^\d]/g, "")
    .replace(/^\s+|\s+$/g, "");
}

function detectCsvDelimiter(headerLine) {
  const line = String(headerLine || "");

  const commaCount = (line.match(/,/g) || []).length;
  const semicolonCount = (line.match(/;/g) || []).length;
  const tabCount = (line.match(/\t/g) || []).length;

  if (semicolonCount > commaCount && semicolonCount >= tabCount) return ";";
  if (tabCount > commaCount && tabCount > semicolonCount) return "\t";

  return ",";
}

function parseCsvLine(line, delimiter = ",") {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === delimiter && !insideQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function parseConsignmentCsv(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one stock row.");
  }

  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter)
    .map((header) =>
      String(header || "")
        .replace(/^\uFEFF/, "")
        .trim()
    )
    .filter(Boolean);
  const normalizedHeaders = headers.map((header) => header.toLowerCase());

  const requiredColumns = [
    "sku",
    "size eu",
    "vat type",
    "selling price (suggested)",
    "quantity"
  ];

  const missingColumns = requiredColumns.filter(
    (column) => !normalizedHeaders.includes(column)
  );

  if (missingColumns.length) {
    throw new Error(`Missing required columns: ${missingColumns.join(", ")}`);
  }

  const columnIndex = (name) => normalizedHeaders.indexOf(name);

  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line, delimiter);
    while (values.length > headers.length) {
      const lastValue = values[values.length - 1];
    
      if (String(lastValue || "").trim() === "") {
        values.pop();
      } else {
        break;
      }
    }

    return {
      row_number: index + 2,
      sku: cleanSkuInput(values[columnIndex("sku")]),
      size: cleanSizeInput(values[columnIndex("size eu")]),
      vat_type: String(values[columnIndex("vat type")] || "").trim(),
      selling_price_suggested: cleanWholeNumberInput(values[columnIndex("selling price (suggested)")]),
      quantity: cleanWholeNumberInput(values[columnIndex("quantity")])
    };
  });

  const errors = [];

  rows.forEach((row) => {
    if (!row.sku) errors.push(`Row ${row.row_number}: missing SKU`);
    if (!row.size) errors.push(`Row ${row.row_number}: missing Size EU`);
    if (!["Margin", "VAT0", "VAT21"].includes(row.vat_type)) {
      errors.push(`Row ${row.row_number}: VAT Type must be Margin, VAT0 or VAT21`);
    }
    if (!row.selling_price_suggested) {
      errors.push(`Row ${row.row_number}: missing Selling Price`);
    }
    if (!row.quantity) {
      errors.push(`Row ${row.row_number}: missing Quantity`);
    }
  });

  return {
    rows,
    errors
  };
}

function getDuplicateCsvSkuSizeRows(rows) {
  const seen = new Set();
  const duplicates = new Set();

  rows.forEach((row) => {
    const key = `${cleanSkuInput(row.sku)} / ${cleanSizeInput(row.size)}`;

    if (seen.has(key)) {
      duplicates.add(key);
    }

    seen.add(key);
  });

  return [...duplicates];
}

function openConsignmentCsvDuplicateModal(duplicates) {
  consignmentCsvDuplicateList.innerHTML = duplicates
    .map((duplicate) => `<div>${escapeHtml(duplicate)}</div>`)
    .join("");

  consignmentCsvDuplicateModal.classList.remove("hidden");
}

function closeConsignmentCsvDuplicateModal() {
  consignmentCsvDuplicateModal.classList.add("hidden");
}

function bindConsignmentInputCleaning() {
  consignmentSkuInput?.addEventListener("input", () => {
    const cursor = consignmentSkuInput.selectionStart;
    consignmentSkuInput.value = cleanSkuInput(consignmentSkuInput.value);
    consignmentSkuInput.setSelectionRange(cursor, cursor);
  });

  consignmentSizeRows?.addEventListener("input", (event) => {
    const sizeInput = event.target.closest(".consignment-size-input");
    const priceInput = event.target.closest(".consignment-price-input");
    const quantityInput = event.target.closest(".consignment-quantity-input");

    if (sizeInput) {
      const cursor = sizeInput.selectionStart;
      sizeInput.value = cleanSizeInput(sizeInput.value);
      sizeInput.setSelectionRange(cursor, cursor);
    }

    if (priceInput) {
      priceInput.value = cleanWholeNumberInput(priceInput.value);
    }

    if (quantityInput) {
      quantityInput.value = cleanWholeNumberInput(quantityInput.value);
    }
  });
  consignmentEditSellingPriceInput?.addEventListener("input", () => {
    consignmentEditSellingPriceInput.value =
      cleanWholeNumberInput(consignmentEditSellingPriceInput.value);
  });
    
  consignmentEditQuantityInput?.addEventListener("input", () => {
    consignmentEditQuantityInput.value =
      cleanWholeNumberInput(consignmentEditQuantityInput.value);
  });
}

// A trusted buyer's deal proceeds without payment on purpose, so "not
// settled yet" has to stay visible in EVERY fulfilment tab — otherwise the
// only signal is a Discord DM that scrolls away. The Mollie link lives on
// the Member WTB record, so the Pay action is available from any status.
function renderBuyingPaymentCell(item) {
  if (!item.requires_payment) {
    return `<td><span class="dashboard-status-pill dashboard-status-open">Paid</span></td>`;
  }

  // No Pay button here on purpose: renderBuyingPaymentAction already renders
  // one in the Action column of every tab, and two buttons for the same
  // Mollie link is how they drift apart. This cell is purely the signal
  // that something is still owed.
  const label = item.waiting_for_mollie ? "Waiting for Mollie" : "Not Paid";

  // The warning triangle lives on the tab badge (see renderSubnav), so this
  // cell only carries the status itself.
  return `<td><span class="dashboard-status-pill dashboard-status-not-paid">${label}</span></td>`;
}

const buyingOpenWtbColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Filter",
  "Max Price",
  "Current Lowest",
  "VAT Type",
  "Status",
  "Date",
  "Action"
];

const buyingOffersColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Max Price",
  "Offer",
  "Status",
  "Date",
  "Action"
];

const buyingAcceptedColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Status",
  "Payment",
  "Date",
  "Action"
];

const buyingPaymentRequiredColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Status",
  "Payment",
  "Date",
  "Action"
];

const wtbAcceptedColumns = [
  "Product",
  "Size",
  "Order ID",
  "Payout",
  "VAT Type",
  "Date",
  "Status"
];

const buyingConfirmedColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Payment",
  "Status",
  "Date",
  "Action"
];

const buyingLabelRequestedColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Status",
  "Payment",
  "Date",
  "Action"
];

const buyingReadyToShipColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Tracking",
  "Status",
  "Payment",
  "Date",
  "Action"
];

const buyingShippedColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Status",
  "Payment",
  "Date",
  "Action"
];

const buyingDeliveredColumns = [
  "Product",
  "Size",
  "WTB ID",
  "Amount",
  "VAT Type",
  "Status",
  "Payment",
  "Date",
  "Action"
];

function renderConsignmentInventoryRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = consignmentInventoryColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${consignmentInventoryColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No consignment inventory yet</strong>
            <span>Upload or add stock to start selling through consignment.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  if (isMobileDashboard()) {
    renderMobileOrderCards(items, {
      primaryLabel: "Selling",
      primaryValue: (item) =>
        item.selling_price_suggested
          ? `€${item.selling_price_suggested}`
          : "-",
      secondaryLabel: "Lowest",
      secondaryValue: (item) =>
        item.lowest_suggested_price
          ? `€${item.lowest_suggested_price}`
          : "-",
      thirdLabel: "Qty",
      thirdValue: (item) => item.quantity || "0",
      actions: (item) => `
        <button
          class="dashboard-mobile-btn dashboard-mobile-edit-btn"
          type="button"
          data-consignment-edit-id="${escapeHtml(item.id || "")}"
          data-current-price="${escapeHtml(item.selling_price_suggested || "")}"
          data-current-quantity="${escapeHtml(item.quantity || "")}"
        >
          Edit
        </button>
  
        <button
          class="dashboard-mobile-btn dashboard-mobile-delete-btn"
          type="button"
          data-consignment-delete-id="${escapeHtml(item.id || "")}"
        >
          Delete
        </button>
      `
    });
  
    dashboardTableBody.querySelectorAll(".dashboard-mobile-product")
      .forEach((el, index) => {
        const item = items[index];
        el.textContent = item.product_name || "-";
      });
  
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${amountForColumn(item.selling_price_suggested)}</td>
      <td>${amountForColumn(item.lowest_suggested_price)}</td>
      <td>${escapeHtml(item.quantity || "0")}</td>
      <td>
        <div class="dashboard-action-row">
          <button
            class="dashboard-edit-btn"
            type="button"
            data-consignment-edit-id="${escapeHtml(item.id || "")}"
            data-current-price="${escapeHtml(item.selling_price_suggested || "")}"
            data-current-quantity="${escapeHtml(item.quantity || "")}"
          >
            Edit
          </button>
        
          <button
            class="dashboard-delete-btn"
            type="button"
            data-consignment-delete-id="${escapeHtml(item.id || "")}"
            title="Delete inventory"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2">
              <path d="M3 6h18" stroke="currentColor"/>
              <path d="M8 6V4h8v2" stroke="currentColor"/>
              <path d="M19 6l-1 14H6L5 6" stroke="currentColor"/>
              <path d="M10 11v6" stroke="currentColor"/>
              <path d="M14 11v6" stroke="currentColor"/>
            </svg>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderConsignmentOfferRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  setMobileTableMode(false);

  // NEW — additive only: three distinct pill renderers. Kept as one
  // simple table for all screen sizes for now (no mobile-card split) —
  // a full mobile-friendly redesign is planned as a separate pass.

  if (activeOfferStatusFilter === "denied") {
    const deniedColumns = ["Product", "Size", "Order ID", "Your Offer", "Denied", "Actions"];

    dashboardTableHead.innerHTML = deniedColumns.map((c) => dashboardHeadCell(c)).join("");

    if (!items.length) {
      dashboardTableBody.innerHTML = `
        <tr><td colspan="${deniedColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No denied offers</strong>
          </div>
        </td></tr>
      `;
      return;
    }

    dashboardTableBody.innerHTML = items.map((item) => {
      // A denied item that DOES have a previous_offer_id already got
      // auto-reopened onto that prior round (visible in Open/Countered
      // now) — retrying here would create a confusing second thread,
      // so only offer Retry for genuine dead ends.
      const canRetry = !item.previous_offer_id;

      return `
        <tr>
          <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
          <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${amountForColumn(item.consignor_counter_price || item.seller_price)}</td>
          <td>${item.denied_at ? escapeHtml(new Date(item.denied_at).toLocaleDateString("en-GB")) : "-"}</td>
          <td>
            <div class="dashboard-action-row">
              ${canRetry ? `
                <button class="dashboard-confirm-btn" type="button" data-consignment-retry-offer-id="${escapeHtml(item.id || "")}">Retry</button>
              ` : ""}
              <button class="dashboard-deny-btn" type="button" data-consignment-cancel-offer-id="${escapeHtml(item.id || "")}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    return;
  }

  if (activeOfferStatusFilter === "counter") {
    const counterColumns = ["Product", "Size", "Order ID", "Your Offer", "Buyer's Last Offer", "Date", "Actions"];

    dashboardTableHead.innerHTML = counterColumns.map((c) => dashboardHeadCell(c)).join("");

    if (!items.length) {
      dashboardTableBody.innerHTML = `
        <tr><td colspan="${counterColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No pending counters</strong>
          </div>
        </td></tr>
      `;
      return;
    }

    dashboardTableBody.innerHTML = items.map((item) => {
      // Edit and Accept-Previous both need a prior round to work
      // against — the very first counter (created via Retry, or a
      // legacy single-row round) has neither.
      const hasPrior = !!item.previous_offer_id;

      return `
        <tr>
          <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
          <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${amountForColumn(item.consignor_counter_price || item.seller_price)}</td>
          <td>${amountForColumn(item.previous_store_price)}</td>
          <td>${(item.consignor_counter_at || item.created_at) ? escapeHtml(new Date(item.consignor_counter_at || item.created_at).toLocaleDateString("en-GB")) : "-"}</td>
          <td>
            <div class="dashboard-action-row">
              ${hasPrior ? `
                <button class="dashboard-counter-btn" type="button" data-consignment-offer-edit-id="${escapeHtml(item.id || "")}">Edit</button>
                <button class="dashboard-confirm-btn" type="button" data-consignment-accept-previous-id="${escapeHtml(item.id || "")}">${item.previous_store_price ? `Accept €${escapeHtml(item.previous_store_price)}` : "Accept Previous"}</button>
              ` : ""}
              <button class="dashboard-deny-btn" type="button" data-consignment-cancel-offer-id="${escapeHtml(item.id || "")}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    return;
  }

  // "open" — awaiting the consignor's own action: accept, counter
  // (unless it's a Member Buy/Offer item, which never supports
  // countering — matches the Discord behavior exactly), or deny.
  dashboardTableHead.innerHTML = consignmentOfferColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${consignmentOfferColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No consignment offers yet</strong>
            <span>When one of your consignment items matches an order, it will show here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  dashboardTableBody.innerHTML = items.map((item) => {
    const canCounter = item.source_type !== "member_wtb";

    return `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.seller_price)}</td>
      <td>${amountForColumn(item.offer_price)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${item.created_at ? escapeHtml(new Date(item.created_at).toLocaleDateString("en-GB")) : "-"}</td>
      <td>
        <div class="dashboard-action-row">
          <button
            class="dashboard-confirm-btn action-accept"
            type="button"
            data-consignment-confirm-offer-id="${escapeHtml(item.id || "")}"
          >
            <span class="accept-kop">ACCEPT</span>
            <span class="accept-amount">${escapeHtml(amountForButton(item.offer_price))}</span>
          </button>

          ${canCounter ? `
            <button
              class="dashboard-counter-btn"
              type="button"
              data-consignment-counter-offer-id="${escapeHtml(item.id || "")}"
              data-is-counter-offer="${item.is_counter_offer ? "true" : "false"}"
            >
              Counter
            </button>
          ` : ""}

          <button
            class="dashboard-deny-btn"
            type="button"
            data-consignment-deny-offer-id="${escapeHtml(item.id || "")}"
          >
            Deny
          </button>
        </div>
      </td>
    </tr>
  `;
  }).join("");
}

function renderBuyingPaymentAction(item) {
  if (item.waiting_for_mollie) {
    return `
      <button
        class="dashboard-track-blue-btn"
        type="button"
        disabled
      >
        Waiting for Mollie
      </button>
    `;
  }

  const payableStatuses = [
    "Awaiting Payment",
    "Expired",
    "Cancelled",
    "Failed"
  ];

  if (
    payableStatuses.includes(
      item.payment_status
    )
  ) {
    return `
      <button
        class="dashboard-confirm-btn"
        type="button"
        data-member-wtb-pay-id="${escapeHtml(
          item.member_wtb_record_id || item.id || ""
        )}"
      >
        Pay
      </button>
    `;
  }

  return "";
}

function renderBuyingAcceptedRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingAcceptedColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingAcceptedColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No accepted offers yet</strong>
            <span>Accepted offers waiting for seller processing will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.offer)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-offer">Waiting for seller</span></td>
      ${renderBuyingPaymentCell(item)}
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        ${renderBuyingPaymentAction(item) || "-"}
      </td>
    </tr>
  `).join("");
}

// NEW — the consignment Accepted tab: a confirmation went out and the
// consignor has not answered yet. Two ways to act on it, so nobody has to
// leave the portal: a link straight to the exact Discord embed, and a
// Confirm button that runs the same code the Discord button does.
function renderConsignmentAcceptedRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  // Same layout as the Confirmed tab on purpose — one column set for the
  // whole consignment section rather than a private one per tab.
  dashboardTableHead.innerHTML = skeletonColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>Nothing waiting for you</strong>
            <span>Matches waiting for your confirmation will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.payout)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <button
          class="dashboard-confirm-btn action-accept"
          type="button"
          data-consignment-confirm="${escapeHtml(item.seller_offer_record_id)}"
        >
          <span class="accept-kop">CONFIRM</span>
          <span class="accept-amount">${escapeHtml(amountForButton(item.payout))}</span>
        </button>
        <button
          class="dashboard-deny-btn"
          type="button"
          data-consignment-deny="${escapeHtml(item.seller_offer_record_id)}"
        >
          Deny
        </button>
        ${
          item.discord_url
            ? `
              <a
                class="dashboard-discord-btn"
                href="${escapeHtml(item.discord_url)}"
                target="_blank"
                rel="noopener"
              >
                Discord
              </a>
            `
            : ""
        }
      </td>
    </tr>
  `).join("");

  // Deny sits next to Confirm so the consignor can answer either way
  // without going to Discord. Same two endpoints the Discord buttons hit.
  dashboardTableBody
    .querySelectorAll("[data-consignment-deny]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const sellerOfferRecordId = button.getAttribute("data-consignment-deny");

        if (!(await showConfirm("Deny this match? The order goes back to other sellers."))) return;

        button.disabled = true;
        button.textContent = "Denying...";

        try {
          const response = await fetch("/api/dashboard/consignment-deny", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              seller_record_id: dashboardSeller.id,
              seller_offer_record_id: sellerOfferRecordId
            })
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Could not deny. Please try again.");
          }

          await loadDashboardData();
        } catch (err) {
          button.disabled = false;
          button.textContent = "Deny";
          showAlert(err.message);
        }
      });
    });

  dashboardTableBody
    .querySelectorAll("[data-consignment-confirm]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const sellerOfferRecordId = button.getAttribute("data-consignment-confirm");

        button.disabled = true;
        button.textContent = "Confirming...";

        try {
          const response = await fetch("/api/dashboard/consignment-confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              seller_record_id: dashboardSeller.id,
              seller_offer_record_id: sellerOfferRecordId
            })
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Could not confirm. Please try again.");
          }

          await loadDashboardData();
        } catch (err) {
          button.disabled = false;
          button.textContent = "Confirm";
          showAlert(err.message);
        }
      });
    });
}

function renderBuyingOpenWtbRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingOpenWtbColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingOpenWtbColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No open WTBs</strong>
            <span>Your open buying requests will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.inventory_filter || "-")}</td>
      <td>${amountForColumn(item.max_price)}</td>
      <td>${amountForColumn(item.current_lowest)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-open">Open</span></td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <button
          class="dashboard-delete-btn"
          type="button"
          data-buying-delete-wtb-id="${escapeHtml(item.member_wtb_record_id || "")}"
          title="Cancel WTB"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2">
            <path d="M3 6h18" stroke="currentColor"/>
            <path d="M8 6V4h8v2" stroke="currentColor"/>
            <path d="M19 6l-1 14H6L5 6" stroke="currentColor"/>
            <path d="M10 11v6" stroke="currentColor"/>
            <path d="M14 11v6" stroke="currentColor"/>
          </svg>
        </button>
      </td>
    </tr>
  `).join("");
}

function renderBuyingOfferRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingOffersColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingOffersColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No offers yet</strong>
            <span>Offers for your buying requests will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.max_price)}</td>
      <td>${amountForColumn(item.offer)}</td>
      <td><span class="dashboard-status-pill dashboard-status-offer">Offer Received</span></td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <div class="dashboard-action-row">
          <button class="dashboard-confirm-btn action-accept" type="button" data-buying-accept-offer-id="${escapeHtml(item.member_wtb_record_id || "")}">
            <span class="accept-kop">ACCEPT</span>
            <span class="accept-amount">${escapeHtml(amountForButton(item.offer))}</span>
          </button>
          <button class="dashboard-deny-btn" type="button" data-buying-deny-offer-id="${escapeHtml(item.member_wtb_record_id || "")}">
            Deny
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderBuyingPaymentRequiredRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingPaymentRequiredColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingPaymentRequiredColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No payments required</strong>
            <span>Orders waiting for payment will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.amount)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>
        ${
          item.waiting_for_mollie
            ? `
              <span class="dashboard-status-pill dashboard-status-open">
                Waiting for Mollie
              </span>
            `
            : `
              <span class="dashboard-status-pill dashboard-status-payment">
                Payment Required
              </span>
            `
        }
      </td>
      ${renderBuyingPaymentCell(item)}
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        ${renderBuyingPaymentAction(item) || "-"}
      </td>
    </tr>
  `).join("");
}

function renderBuyingConfirmedRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingConfirmedColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingConfirmedColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No confirmed orders</strong>
            <span>Confirmed buying orders will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.amount)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      ${renderBuyingPaymentCell(item)}
      <td><span class="dashboard-status-pill dashboard-status-open">Confirmed</span></td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        ${renderBuyingPaymentAction(item) || "-"}
      </td>
    </tr>
  `).join("");
}

function renderBuyingLabelRequestedRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingLabelRequestedColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingLabelRequestedColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No label requests</strong>
            <span>Orders waiting for label upload will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.amount)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-payment">Waiting for Label</span></td>
      ${renderBuyingPaymentCell(item)}
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <div class="dashboard-action-row">
          <a
            class="dashboard-confirm-btn"
            href="${escapeHtml(item.label_url || "#")}"
            target="_blank"
            rel="noopener"
          >
            Upload
          </a>
      
          ${renderBuyingPaymentAction(item)}
        </div>
      </td>
    </tr>
  `).join("");
}

function renderBuyingReadyToShipRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingReadyToShipColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingReadyToShipColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No orders ready to ship</strong>
            <span>Orders with uploaded labels will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.amount)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${escapeHtml(item.tracking_number || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-open">Ready to Ship</span></td>
      ${renderBuyingPaymentCell(item)}
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        ${renderBuyingPaymentAction(item) || "-"}
      </td>
    </tr>
  `).join("");
}

function renderBuyingShippedRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingShippedColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingShippedColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No shipped orders</strong>
            <span>Buying orders that are currently shipped will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.amount)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-open">Shipped</span></td>
      ${renderBuyingPaymentCell(item)}
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <div class="dashboard-action-row">
          ${
            item.tracking_url
              ? `<a
                  class="dashboard-track-blue-btn"
                  href="${escapeHtml(item.tracking_url)}"
                  target="_blank"
                  rel="noopener"
                >
                  Track
                </a>`
              : ""
          }
      
          ${renderBuyingPaymentAction(item)}
        </div>
      </td>
    </tr>
  `).join("");
}

function renderBuyingDeliveredRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingDeliveredColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingDeliveredColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No delivered orders</strong>
            <span>Delivered buying orders will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.amount)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>
        ${
          item.waiting_for_mollie
            ? `<span class="dashboard-status-pill dashboard-status-open">
                Waiting for Mollie
              </span>`
            : item.requires_payment
              ? `<span class="dashboard-status-pill dashboard-status-not-paid">
                  Not Paid
                </span>`
              : `<span class="dashboard-status-pill dashboard-status-open">
                  Delivered
                </span>`
        }
      </td>
      ${renderBuyingPaymentCell(item)}
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <div class="dashboard-action-row">
          ${
            item.tracking_url
              ? `<a class="dashboard-track-blue-btn" href="${escapeHtml(item.tracking_url)}" target="_blank" rel="noopener">Track</a>`
              : ""
          }

          ${renderBuyingPaymentAction(item)}
        </div>
      </td>
    </tr>
  `).join("");
}


function renderWtbAcceptedRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = wtbAcceptedColumns
    .map((column) => dashboardHeadCell(column === "Status" ? "Action" : column))
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${wtbAcceptedColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No accepted offers yet</strong>
            <span>
              At this moment there are no accepted offers waiting for processing.
            </span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  if (isMobileDashboard()) {
    renderMobileOrderCards(items, {
      primaryLabel: "Offer",
      primaryValue: (item) => item.offer,
      secondaryLabel: "Date",
      secondaryValue: (item) => item.date,
      thirdLabel: "Action",
      thirdValue: (item) => item.discord_url ? "Discord available" : "Processing..."
    });
    return;
  }
  
  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.offer)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        ${
          item.discord_url
            ? `
              <a
                class="dashboard-discord-btn"
                href="${escapeHtml(item.discord_url)}"
                target="_blank"
                rel="noopener"
              >
                Discord
              </a>
            `
            : escapeHtml(item.status || "Offer accepted, waiting processing..")
        }
      </td>
    </tr>
  `).join("");
}

const wtbOpenOfferColumns = [
  "",
  "Product",
  "Size",
  "Order ID",
  "Offer",
  "VAT Type",
  "Current Lowest",
  "Date",
  "Action"
];

function renderWtbOpenOffersRows(offers) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.add("open-offers-table");

  const table = dashboardTableBody.closest(".dashboard-table");

  if (window.innerWidth <= 768) {
    table?.classList.add("mobile-cards");
  } else {
    table?.classList.remove("mobile-cards");
  }

  dashboardTableHead.innerHTML = wtbOpenOfferColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!offers.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${wtbOpenOfferColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No offers yet</strong>
            <span>At this moment there are no open offers in this stage.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  if (window.innerWidth <= 768) {
    dashboardTableBody.innerHTML = offers.map((offer) => `
      <tr>
        <td>
          <article class="dashboard-mobile-card">
            <div class="dashboard-mobile-card-top">
              <div class="dashboard-mobile-status ${offer.status === "Lowest" ? "lowest" : "beaten"}"></div>

              <div class="dashboard-mobile-main">
                <div class="dashboard-mobile-product">${escapeHtml(offer.product || "-")}</div>
                <div class="dashboard-mobile-size">Size: ${escapeHtml(offer.size || "-")}</div>

                <div class="dashboard-mobile-bottom-row">

                  <div class="dashboard-mobile-meta">
                
                    <div class="dashboard-mobile-meta-item">
                      <div class="dashboard-mobile-meta-label">Offer</div>
                      <div class="dashboard-mobile-meta-value">
                        ${escapeHtml(offer.offer || "-")}
                      </div>
                    </div>
                
                    <div class="dashboard-mobile-meta-item">
                      <div class="dashboard-mobile-meta-label">Lowest</div>
                      <div class="dashboard-mobile-meta-value">
                        ${escapeHtml(offer.current_lowest || "-")}
                      </div>
                    </div>
                
                  </div>
                
                  <div class="dashboard-mobile-actions">
                    <button
                      class="dashboard-mobile-btn dashboard-mobile-edit-btn"
                      type="button"
                      data-edit-offer-id="${escapeHtml(offer.id || "")}"
                      data-member-wtb-record-id="${escapeHtml(offer.member_wtb_record_id || "")}"
                      data-order-record-id="${escapeHtml(offer.order_record_id || "")}"
                      data-vat-type="${escapeHtml(offer.vat_type || "")}"
                      data-current-offer="${escapeHtml(offer.offer_raw || "")}"
                      data-current-lowest="${escapeHtml(offer.current_lowest || "-")}"
                    >
                      Edit
                    </button>

                    <button
                      class="dashboard-mobile-btn dashboard-mobile-delete-btn"
                      type="button"
                      data-delete-offer-id="${escapeHtml(offer.id)}"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </td>
      </tr>
    `).join("");

    return;
  }

  dashboardTableBody.innerHTML = offers.map((offer) => `
    <tr>
      <td>
        <div class="dashboard-status-dot ${offer.status === "Lowest" ? "dashboard-status-dot-lowest" : "dashboard-status-dot-beaten"}"></div>
      </td>
      <td class="dashboard-product-col">${dashboardProductCell(offer)}</td>
      <td class="dashboard-size-col">${escapeHtml(offer.size || "-")}</td>
      <td>${escapeHtml(offer.order_id || "-")}</td>
      <td>${amountForColumn(offer.offer)}</td>
      <td>${escapeHtml(offer.vat_type || "-")}</td>
      <td>${amountForColumn(offer.current_lowest)}</td>
      <td>${escapeHtml(offer.date || "-")}</td>
      <td>
        <div class="dashboard-action-row">
          <button
            class="dashboard-edit-btn"
            type="button"
            data-edit-offer-id="${escapeHtml(offer.id || "")}"
            data-member-wtb-record-id="${escapeHtml(offer.member_wtb_record_id || "")}"
            data-order-record-id="${escapeHtml(offer.order_record_id || "")}"
            data-vat-type="${escapeHtml(offer.vat_type || "")}"
            data-current-offer="${escapeHtml(offer.offer_raw || "")}"
            data-current-lowest="${escapeHtml(offer.current_lowest || "-")}"
          >
            Edit
          </button>
      
          <button
            class="dashboard-delete-btn"
            type="button"
            data-delete-offer-id="${escapeHtml(offer.id || "")}"
            title="Delete offer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2">
              <path d="M3 6h18" stroke="currentColor"/>
              <path d="M8 6V4h8v2" stroke="currentColor"/>
              <path d="M19 6l-1 14H6L5 6" stroke="currentColor"/>
              <path d="M10 11v6" stroke="currentColor"/>
              <path d="M14 11v6" stroke="currentColor"/>
            </svg>
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

// NEW — additive only: renders the merged Want To Buys "Offers" tab.
// Items come tagged with _kind: "fresh" (never countered, from Seller
// Offers — has the lowest-offer dot indicator + normalized current
// lowest column, both restored from the old separate tab), "own_counter"
// (seller's own pending counter, awaiting the store/buyer), "counter"
// (store/buyer's counter, seller must respond), or "denied".
// NEW — additive only: mirror of renderWtbUnifiedOfferRows for the
// buyer's side. _kind: "fresh" (never responded to, from the existing
// buying-offers endpoint), "seller_counter" (seller just countered
// back, buyer must respond), "my_counter" (buyer's own pending
// counter, awaiting the seller), "denied".
function renderBuyingUnifiedOfferRows(items) {
  setMobileTableMode(false);

  const isDenied = activeOfferStatusFilter === "denied";
  const isOpen = activeOfferStatusFilter === "open";

  // NEW — his request: "My Offer" was ambiguous. For Open it's the
  // buyer's stated Max Price (their ceiling), with a separate "My
  // Last Offer" column for their actual last counter (if any) so they
  // can weigh a fresh seller offer against what they last put
  // forward. For Countered, "My Offer" stays as-is (it IS their
  // current pending counter, no "last" needed). For Denied, it's
  // their actual denied counter, so "My Last Offer" fits better than
  // "My Offer". "Seller's Counter" → "Seller's Last Offer", matching
  // WTB's "Buyer's Last Offer" naming — the seller's shown price here
  // isn't always literally a counter (could be their original,
  // never-countered ask).
  const columns = isDenied
    ? ["Product", "Size", "WTB ID", "Max Price", "My Last Offer", "Seller's Last Offer", "VAT Type", "Denied", "Actions"]
    : isOpen
      ? ["Product", "Size", "WTB ID", "Max Price", "My Last Offer", "Seller's Offer", "VAT Type", "Date", "Actions"]
      : ["Product", "Size", "WTB ID", "Max Price", "My Offer", "Seller's Last Offer", "VAT Type", "Date", "Actions"];

  dashboardTableHead.innerHTML = columns.map((c) => dashboardHeadCell(c)).join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr><td colspan="${columns.length}">
        <div class="dashboard-empty-state">
          <div class="dashboard-empty-icon">◇</div>
          <strong>Nothing here yet</strong>
        </div>
      </td></tr>
    `;
    return;
  }

  dashboardTableBody.innerHTML = items.map((item) => {
    // FIXED — this restricted Max Price display to "fresh" items only,
    // even though it's just a static property of the WTB itself (not
    // tied to negotiation state) — now that the backend correctly
    // returns it for every kind, no reason to hide it once a
    // negotiation is underway; the buyer still wants to weigh offers
    // against their original ceiling throughout.
    const maxPrice = item.max_price || null;
    const myOffer = item._kind === "my_counter" ? item.my_offer : null;
    const myLastOffer = (item._kind === "seller_counter" || item._kind === "denied" || item._kind === "fresh") ? item.my_offer : null;
    const sellersOffer = item._kind === "fresh" ? item.offer : item.sellers_offer;
    const dateValue = item._kind === "fresh" ? (item.raw_date || item.date) : (item.denied_at || item.raw_date);

    if (isDenied) {
      // NEW — additive only: his exact scenario — a genuinely fresh
      // offer denied outright (no prior counter ever existed, so no
      // Counter Offers record to retry against) needs different
      // actions than a regular denied round: Counter (a fresh first
      // counter via create-from-fresh, not Retry) and Delete (the new
      // buyer-delete-denied endpoint, since the regular buyer-cancel
      // only knows how to delete a Counter Offers record, and this
      // item's id is a Seller Offer record instead).
      const isFreshDenied = item._kind === "fresh_denied";

      return `
        <tr>
          <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
          <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${amountForColumn(maxPrice)}</td>
          <td>${amountForColumn(myLastOffer)}</td>
          <td>${amountForColumn(sellersOffer)}</td>
          <td>${escapeHtml(item.vat_type || "-")}</td>
          <td>${dateValue ? escapeHtml(new Date(dateValue).toLocaleDateString("en-GB")) : "-"}</td>
          <td>
            <div class="dashboard-action-row">
              ${item.member_wtb_record_id ? `
                <button class="dashboard-confirm-btn" type="button" data-buying-accept-current-lowest-id="${escapeHtml(item.member_wtb_record_id || "")}" data-buying-accept-payout="${escapeHtml(item.sellers_offer_payout ?? "")}" data-buying-accept-vat-type="${escapeHtml(item.vat_type || "")}" data-buying-accept-record-id="${escapeHtml(isFreshDenied ? "" : (item.id || ""))}" data-buying-accept-seller-offer-id="${escapeHtml(item.seller_offer_record_id || "")}">${`Accept ${escapeHtml(amountForButton(sellersOffer))}`.trim()}</button>
              ` : ""}
              ${isFreshDenied ? `
                <button class="dashboard-counter-btn" type="button" data-buying-counter-id="${escapeHtml(item.member_wtb_record_id || "")}" data-buying-counter-kind="fresh" data-buying-seller-offer-id="${escapeHtml(item.seller_offer_record_id || "")}">Counter</button>
                <button class="dashboard-deny-btn" type="button" data-buying-delete-denied-id="${escapeHtml(item.seller_offer_record_id || item.id || "")}">Delete</button>
              ` : `
                ${item.previous_record_id ? `
                  <button class="dashboard-counter-btn" type="button" data-buying-retry-counter-id="${escapeHtml(item.id || "")}">Retry</button>
                ` : ""}
                <button class="dashboard-deny-btn" type="button" data-buying-cancel-offer-id="${escapeHtml(item.id || "")}">Delete</button>
              `}
            </div>
          </td>
        </tr>
      `;
    }

    let actionsCell;
    if (item._kind === "fresh" || item._kind === "seller_counter") {
      // FIXED — his explicit correction: the Counter button should
      // stay visible even when there's no room, so both buyer and
      // seller can see WHY there's no room by clicking it — not have
      // it silently disappear. Carries the no_room flag as a data
      // attribute so the click handler can show the explanation
      // immediately, without a wasted round trip to the server.
      const counterButtonHtml = `<button class="dashboard-counter-btn" type="button" data-buying-counter-id="${escapeHtml(item.id || item.member_wtb_record_id || "")}" data-buying-counter-kind="${item._kind}" data-buying-seller-offer-id="${escapeHtml(item.seller_offer_record_id || "")}" data-buying-counter-no-room="${item.no_room_to_counter ? "1" : "0"}">Counter</button>`;

      actionsCell = `
        <button class="dashboard-confirm-btn" type="button" data-buying-accept-current-lowest-id="${escapeHtml(item.member_wtb_record_id || "")}" data-buying-accept-payout="${escapeHtml(item.sellers_offer_payout ?? "")}" data-buying-accept-vat-type="${escapeHtml(item.vat_type || "")}" data-buying-accept-record-id="${escapeHtml(item._kind === "fresh" ? "" : (item.id || ""))}" data-buying-accept-seller-offer-id="${escapeHtml(item.seller_offer_record_id || "")}">${`Accept ${escapeHtml(amountForButton(sellersOffer))}`.trim()}</button>
        ${counterButtonHtml}
        <button class="dashboard-deny-btn" type="button" data-buying-deny-id="${escapeHtml(item.id || item.member_wtb_record_id || "")}" data-buying-deny-kind="${item._kind}" data-buying-deny-seller-offer-id="${escapeHtml(item.seller_offer_record_id || "")}">Deny</button>
      `;
    } else {
      // "my_counter" — buyer's own pending counter, awaiting seller.
      actionsCell = `
        <button class="dashboard-confirm-btn" type="button" data-buying-accept-current-lowest-id="${escapeHtml(item.member_wtb_record_id || "")}" data-buying-accept-payout="${escapeHtml(item.sellers_offer_payout ?? "")}" data-buying-accept-vat-type="${escapeHtml(item.vat_type || "")}" data-buying-accept-record-id="${escapeHtml(item.id || "")}" data-buying-accept-seller-offer-id="${escapeHtml(item.seller_offer_record_id || "")}">${`Accept ${escapeHtml(amountForButton(sellersOffer))}`.trim()}</button>
        <button class="dashboard-counter-btn" type="button" data-buying-edit-counter-id="${escapeHtml(item.id || "")}">Edit</button>
        <button class="dashboard-deny-btn" type="button" data-buying-cancel-offer-id="${escapeHtml(item.id || "")}">Delete</button>
      `;
    }

    return `
      <tr>
        <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
        <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
        <td>${escapeHtml(item.order_id || "-")}</td>
        ${isOpen ? `
          <td>${amountForColumn(maxPrice)}</td>
          <td>${amountForColumn(myLastOffer)}</td>
        ` : `
          <td>${amountForColumn(maxPrice)}</td>
          <td>${amountForColumn(myOffer)}</td>
        `}
        <td>${amountForColumn(sellersOffer)}</td>
        <td>${escapeHtml(item.vat_type || "-")}</td>
        <td>${dateValue ? escapeHtml(new Date(dateValue).toLocaleDateString("en-GB")) : "-"}</td>
        <td>
          <div class="dashboard-action-row">
            ${actionsCell}
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function renderWtbUnifiedOfferRows(items) {
  setMobileTableMode(false);

  const isDenied = activeOfferStatusFilter === "denied";
  const columns = isDenied
    ? ["", "Product", "Size", "Order ID", "Your Offer", "VAT Type", "Buyer's Last Offer", "Current Lowest", "Denied", "Actions"]
    : ["", "Product", "Size", "Order ID", "Your Offer", (activeOfferStatusFilter === "counter" ? "Counter Offer" : "Buyer's Last Offer"), "VAT Type", "Current Lowest", "Date", "Actions"];

  dashboardTableHead.innerHTML = columns.map((c) => dashboardHeadCell(c)).join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr><td colspan="${columns.length}">
        <div class="dashboard-empty-state">
          <div class="dashboard-empty-icon">◇</div>
          <strong>Nothing here yet</strong>
        </div>
      </td></tr>
    `;
    return;
  }

  dashboardTableBody.innerHTML = items.map((item) => {
    // FIXED — "Your Offer" was showing counter_payout (the STORE's
    // counter, converted to seller-payout terms) for "counter" items,
    // which is confusing — it made it look like the seller had
    // offered the store's own counter price. "Your Offer" must always
    // be the SELLER's own position (their initial offer, or the last
    // thing THEY placed) — original_offer, never counter_payout.
    const amount = item._kind === "fresh" ? item.offer : item.original_offer;

    const dateValue = item._kind === "fresh" ? item.raw_date : (item.denied_at || item.raw_date);

    if (isDenied) {
      const isFreshDenied = item._kind === "fresh_denied";

      return `
        <tr>
          <td>${item.status ? `<div class="dashboard-status-dot ${item.status === "Lowest" ? "dashboard-status-dot-lowest" : "dashboard-status-dot-beaten"}"></div>` : ""}</td>
          <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
          <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${amountForColumn(amount)}</td>
          <td>${escapeHtml(item.vat_type || "-")}</td>
          <td>${isFreshDenied ? "-" : escapeHtml(item.previous_store_price || "-")}</td>
          <td>${item.current_lowest ? escapeHtml(item.current_lowest) : "-"}</td>
          <td>${dateValue ? escapeHtml(new Date(dateValue).toLocaleDateString("en-GB")) : "-"}</td>
          <td>
            <div class="dashboard-action-row">
              ${isFreshDenied ? `
                <button class="dashboard-counter-btn" type="button" data-wtb-retry-fresh-offer-id="${escapeHtml(item.id || "")}" data-vat-type="${escapeHtml(item.vat_type || "")}" data-denied-amount="${escapeHtml(item.original_offer || "")}">Retry</button>
                <button class="dashboard-deny-btn" type="button" data-wtb-delete-fresh-offer-id="${escapeHtml(item.id || "")}">Delete</button>
              ` : `
                ${(item.previous_record_id || item.previous_store_price) ? `
                  <button class="dashboard-confirm-btn" type="button" data-wtb-accept-previous-id="${escapeHtml(item.id || "")}">${item.previous_store_price ? `Accept ${escapeHtml(item.previous_store_price)}` : "Accept Previous"}</button>
                  <button class="dashboard-counter-btn" type="button" data-wtb-retry-counter-id="${escapeHtml(item.id || "")}">Retry</button>
                ` : ""}
                <button class="dashboard-deny-btn" type="button" data-wtb-cancel-offer-id="${escapeHtml(item.id || "")}">Delete</button>
              `}
            </div>
          </td>
        </tr>
      `;
    }

    // The dot indicator and Current Lowest column now apply to BOTH
    // "fresh" AND "own_counter" items — the backend computes the same
    // same-VAT-scale comparison for both, so a seller mid-counter can
    // still see if someone else has undercut them in the meantime.
    // FIXED — item.status is correctly null for Member WTB items (the
    // "am I still the lowest seller" comparison only exists for Store
    // Orders, via a rollup that has no Member WTB equivalent) — but
    // this ternary had no null case, so it fell through to "beaten"
    // (red dot) by default, falsely implying another seller had
    // undercut them when no such comparison was ever made.
    const hasLowestData = (item._kind === "fresh" || item._kind === "own_counter" || item._kind === "counter") && item.status !== null;
    const dotCell = hasLowestData
      ? `<div class="dashboard-status-dot ${item.status === "Lowest" ? "dashboard-status-dot-lowest" : "dashboard-status-dot-beaten"}"></div>`
      : "";

    const currentLowestCell = (item._kind === "fresh" || item._kind === "own_counter" || item._kind === "counter") ? (item.current_lowest || "-") : "-";
    // FIXED — this column now covers both: for "own_counter" it's the
    // store's PREVIOUS position (before the seller's own counter,
    // used for Accept-Previous); for "counter" it's the store's
    // CURRENT counter — the thing the seller now needs to respond to.
    // Same concept either way: the buyer's latest figure on the table.
    const buyersLastOfferCell = item._kind === "own_counter"
      ? (item.previous_store_price || "-")
      : (item._kind === "counter" ? (item.counter_payout || "-") : "-");

    let actionsCell;
    if (item._kind === "fresh") {
      actionsCell = `
        <button
          class="dashboard-edit-btn"
          type="button"
          data-edit-offer-id="${escapeHtml(item.id || "")}"
          data-member-wtb-record-id="${escapeHtml(item.member_wtb_record_id || "")}"
          data-order-record-id="${escapeHtml(item.order_record_id || "")}"
          data-vat-type="${escapeHtml(item.vat_type || "")}"
          data-current-offer="${escapeHtml(item.offer_raw || "")}"
          data-current-lowest="${escapeHtml(item.current_lowest || "-")}"
        >Edit</button>
        <button class="dashboard-deny-btn" type="button" data-delete-offer-id="${escapeHtml(item.id || "")}">Delete</button>
      `;
    } else if (item._kind === "own_counter") {
      actionsCell = `
        ${item.previous_record_id ? `
          <button class="dashboard-counter-btn" type="button" data-wtb-edit-counter-id="${escapeHtml(item.id || "")}">Edit</button>
          <button class="dashboard-confirm-btn" type="button" data-wtb-accept-previous-id="${escapeHtml(item.id || "")}">${item.previous_store_price ? `Accept ${escapeHtml(item.previous_store_price)}` : "Accept Previous"}</button>
        ` : ""}
        <button class="dashboard-deny-btn" type="button" data-wtb-cancel-counter-id="${escapeHtml(item.id || "")}">Delete</button>
      `;
    } else {
      // "counter" — store/buyer just moved, seller must respond.
      actionsCell = `
        <button class="dashboard-confirm-btn" type="button" data-wtb-seller-accept-id="${escapeHtml(item.id || "")}">${item.counter_payout ? `Accept ${escapeHtml(item.counter_payout)}` : "Accept"}</button>
        <button class="dashboard-counter-btn" type="button" data-wtb-seller-counter-id="${escapeHtml(item.id || "")}" data-wtb-seller-counter-is-member-wtb="${item.is_member_wtb ? "1" : "0"}">Counter</button>
        <button class="dashboard-deny-btn" type="button" data-wtb-seller-deny-id="${escapeHtml(item.id || "")}">Deny</button>
      `;
    }

    return `
      <tr>
        <td>${dotCell}</td>
        <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
        <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
        <td>${escapeHtml(item.order_id || "-")}</td>
        <td>${amountForColumn(amount)}</td>
        <td>${amountForColumn(buyersLastOfferCell)}</td>
        <td>${escapeHtml(item.vat_type || "-")}</td>
        <td>${amountForColumn(currentLowestCell)}</td>
        <td>${dateValue ? escapeHtml(new Date(dateValue).toLocaleDateString("en-GB")) : "-"}</td>
        <td>
          <div class="dashboard-action-row">
            ${actionsCell}
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function renderReadyToShipRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = skeletonColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    renderTableShell();
    return;
  }

  if (isMobileDashboard()) {
    renderMobileOrderCards(items, {
      primaryLabel: "Payout",
      primaryValue: (item) => item.payout,
      secondaryLabel: "Date",
      secondaryValue: (item) => item.date,
      actions: (item) => `
        ${
          item.label_url
            ? `<button
                  class="dashboard-mobile-btn dashboard-mobile-download-btn"
                  type="button"
                  data-label-url="${escapeHtml(item.label_url)}"
                  title="Download label"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>`
            : ""
        }
        ${
          item.discord_url
            ? `<a
                class="dashboard-mobile-btn dashboard-mobile-discord-btn"
                href="${escapeHtml(item.discord_url)}"
                target="_blank"
                rel="noopener"
              >
                Discord
              </a>`
            : ""
        }
      `
    });
    return;
  }
  
  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.payout)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${escapeHtml(item.date || "-")}</td>

      <td>
        <div class="dashboard-action-row">
          ${
            item.label_url
              ? `
                <button
                  class="dashboard-download-btn"
                  type="button"
                  data-label-url="${escapeHtml(item.label_url)}"
                  title="Download label"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path
                      d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              `
              : ""
          }

          ${
            item.discord_url
              ? `
                <a
                  class="dashboard-discord-btn"
                  href="${escapeHtml(item.discord_url)}"
                  target="_blank"
                  rel="noopener"
                >
                  DISCORD
                </a>
              `
              : ""
          }

          ${
            !item.label_url && !item.discord_url
              ? "-"
              : ""
          }
        </div>
      </td>
    </tr>
  `).join("");
}

function renderTrackingRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = skeletonColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    renderTableShell();
    return;
  }

  if (isMobileDashboard()) {
    renderMobileOrderCards(items, {
      primaryLabel: "Payout",
      primaryValue: (item) => item.payout,
      secondaryLabel: "Date",
      secondaryValue: (item) => item.date,
      actions: (item) => `
        ${
          item.tracking_url
            ? `<a
                class="dashboard-mobile-btn dashboard-mobile-track-btn"
                href="${escapeHtml(item.tracking_url)}"
                target="_blank"
                rel="noopener"
              >
                Track
              </a>`
            : ""
        }
        ${
          item.discord_url
            ? `<a class="dashboard-mobile-btn dashboard-mobile-discord-btn" href="${escapeHtml(item.discord_url)}" target="_blank" rel="noopener">Discord</a>`
            : ""
        }
      `
    });
    return;
  }
  
  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.payout)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${escapeHtml(item.date || "-")}</td>

      <td>
        <div class="dashboard-action-row">
          ${
            item.tracking_url
              ? `
                <a
                  class="dashboard-track-btn"
                  href="${escapeHtml(item.tracking_url)}"
                  target="_blank"
                  rel="noopener"
                >
                  TRACK
                </a>
              `
              : ""
          }

          ${
            item.discord_url
              ? `
                <a
                  class="dashboard-discord-btn"
                  href="${escapeHtml(item.discord_url)}"
                  target="_blank"
                  rel="noopener"
                >
                  DISCORD
                </a>
              `
              : ""
          }

          ${
            !item.tracking_url && !item.discord_url
              ? "-"
              : ""
          }
        </div>
      </td>
    </tr>
  `).join("");
}

const historyIssueColumns = [
  "Product",
  "Size",
  "Order ID",
  "Payout",
  "VAT Type",
  "Date",
  "Issue",
  "Status",
  "Action"
];

function renderHistoryIssuesRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = historyIssueColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!items.length) {
    renderTableShell();
    return;
  }

  if (isMobileDashboard()) {
    renderMobileOrderCards(items, {
      primaryLabel: "Payout",
      primaryValue: (item) => item.payout,
      secondaryLabel: "Status",
      secondaryValue: (item) => item.issue_status,
      actions: (item) => `
        <button
          class="dashboard-mobile-btn dashboard-mobile-download-btn"
          type="button"
          data-issue-note="${escapeHtml(item.issue_notes || "")}"
        >
          View
        </button>

        <button
          class="dashboard-mobile-btn dashboard-mobile-solved-btn"
          type="button"
          data-solve-issue-id="${escapeHtml(item.id)}"
        >
          Solved
        </button>
      `
    });
    return;
  }

  setMobileTableMode(false);

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(item)}</td>
      <td class="dashboard-size-col">${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${amountForColumn(item.payout)}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <button
          class="dashboard-view-btn"
          type="button"
          data-issue-note="${escapeHtml(item.issue_notes || "")}"
        >
          VIEW
        </button>
      </td>
      <td>${escapeHtml(item.issue_status || "-")}</td>
      <td>
        <button
          class="dashboard-solve-btn"
          type="button"
          data-solve-issue-id="${escapeHtml(item.id)}"
        >
          SOLVED
        </button>
      </td>
    </tr>
  `).join("");
}

function renderHistorySalesRows(items) {
  if (isMobileDashboard()) {
    dashboardTableHead.innerHTML = skeletonColumns
      .map((column) => dashboardHeadCell(column))
      .join("");

    if (!items.length) {
      renderTableShell();
      return;
    }

    renderMobileOrderCards(items, {
      primaryLabel: "Payout",
      primaryValue: (item) => item.payout,
      secondaryLabel: "Date",
      secondaryValue: (item) => item.date,
      actions: (item) => `
        <button
          class="dashboard-mobile-btn dashboard-mobile-issue-btn"
          type="button"
          data-report-issue-id="${escapeHtml(item.id)}"
        >
          Issue
        </button>
      `
    });

    return;
  }

  renderOpenClaimsRows(
    items.map((item) => ({
      ...item,
      discord_url: ""
    }))
  );

  dashboardTableBody.querySelectorAll("tr").forEach((row, index) => {
    const item = items[index];
    const actionCell = row.querySelector("td:last-child");

    if (!actionCell || !item) return;

    actionCell.innerHTML = `
      <button
        class="dashboard-issue-btn"
        type="button"
        data-report-issue-id="${escapeHtml(item.id)}"
      >
        ISSUE
      </button>
    `;
  });
}

function renderOpenClaimsRows(claims) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");
  dashboardTableHead.innerHTML = skeletonColumns
    .map((column) => dashboardHeadCell(column))
    .join("");

  if (!claims.length) {
    renderTableShell();
    return;
  }

  if (isMobileDashboard()) {
    renderMobileOrderCards(claims, {
      primaryLabel: "Payout",
      primaryValue: (item) => item.payout,
      secondaryLabel: "Date",
      secondaryValue: (item) => item.date,
      actions: (item) => `
        ${
          item.discord_url
            ? `<a class="dashboard-mobile-btn dashboard-mobile-discord-btn" href="${escapeHtml(item.discord_url)}" target="_blank" rel="noopener">Discord</a>`
            : ""
        }
      `
    });
    return;
  }
  
  setMobileTableMode(false);

  dashboardTableBody.innerHTML = claims.map((claim) => `
    <tr>
      <td class="dashboard-product-col">${dashboardProductCell(claim)}</td>
      <td class="dashboard-size-col">${escapeHtml(claim.size || "-")}</td>
      <td>${escapeHtml(claim.order_id || "-")}</td>
      <td>${amountForColumn(claim.payout)}</td>
      <td>${escapeHtml(claim.vat_type || "-")}</td>
      <td>${escapeHtml(claim.date || "-")}</td>

      <td>
        ${
          claim.discord_url
            ? `
              <a
                class="dashboard-discord-btn"
                href="${escapeHtml(claim.discord_url)}"
                target="_blank"
                rel="noopener"
              >
                DISCORD
              </a>
            `
            : "-"
        }
      </td>
    </tr>
  `).join("");
}

function renderConfirmedRows(items) {
  if (!items.length) {
    renderTableShell();
    return;
  }

  const canRequestLabel = (item) =>
    !item.member_wtb_record_id ||
    ["Paid", "Trusted"].includes(String(item.payment_status || "").trim());

  if (isMobileDashboard()) {
    renderMobileOrderCards(items, {
      primaryLabel: "Payout",
      primaryValue: (item) => item.payout,
      secondaryLabel: "Date",
      secondaryValue: (item) => item.date,
      actions: (item) => `
        ${
          item.discord_url
            ? `<a
                class="dashboard-mobile-btn dashboard-mobile-discord-btn"
                href="${escapeHtml(item.discord_url)}"
                target="_blank"
                rel="noopener"
              >
                Discord
              </a>`
            : ""
        }

        ${
          canRequestLabel(item)
            ? `
              <button
                class="dashboard-mobile-btn dashboard-mobile-request-label-btn"
                type="button"
                data-request-label-id="${escapeHtml(item.order_record_id || "")}"
                data-member-wtb-record-id="${escapeHtml(item.member_wtb_record_id || "")}"
              >
                Request Label
              </button>
            `
            : ""
        }
      `
    });

    return;
  }

  renderOpenClaimsRows(items);

  dashboardTableBody.querySelectorAll("tr").forEach((row, index) => {
    const item = items[index];
    const actionCell = row.querySelector("td:last-child");

    if (!actionCell || !item) return;

    actionCell.innerHTML = `
      <div class="dashboard-action-stack">
        ${
          item.discord_url
            ? `
              <a
                class="dashboard-discord-btn"
                href="${escapeHtml(item.discord_url)}"
                target="_blank"
                rel="noopener"
              >
                Discord
              </a>
            `
            : ""
        }

        ${
          canRequestLabel(item)
            ? `
              <button
                class="dashboard-issue-btn dashboard-request-label-btn"
                type="button"
                data-request-label-id="${escapeHtml(item.order_record_id || "")}"
                data-member-wtb-record-id="${escapeHtml(item.member_wtb_record_id || "")}"
              >
                Request Label
              </button>
            `
            : ""
        }
      </div>
    `;
  });
}

let csvImportStatusTimer = null;
let csvImportCompletedHideTimer = null;

function getCsvImportStatusEl() {
  return document.getElementById("consignmentCsvImportStatus");
}

// NEW — the list of skipped rows.
//
// The import skips a row when StockX does not know the SKU exactly. Without
// this list such a row disappears silently: the counter says "completed" and
// the inventory is quietly smaller than the file you uploaded.
//
// Same shape as the duplicate-rows dialog, but amber instead of red. That
// difference is deliberate: duplicates block the upload and have to be fixed
// first, while this is a notice after the fact with everything else already
// imported. Red would suggest nothing went through.
//
// Built from code rather than placed in dashboard.html, so that file does not
// have to ship. The classes match the other dialogs, so Escape and the scroll
// lock apply to it automatically.
let skippedRowsDialog = null;

function buildSkippedRowsDialog() {
  if (skippedRowsDialog) return skippedRowsDialog;

  const dialogEl = document.createElement("div");
  dialogEl.className = "dashboard-modal hidden";
  dialogEl.id = "consignmentCsvSkippedModal";

  dialogEl.innerHTML = `
    <div class="dashboard-modal-backdrop" data-skipped-close></div>

    <div class="dashboard-modal-card">
      <h2>Rows we could not add</h2>
      <p>
        These SKUs are not in our catalog, so they were left out. Everything
        else from your file was imported.
      </p>

      <div class="consignment-skipped-list" id="consignmentCsvSkippedList"></div>

      <p class="consignment-skipped-help">
        Please double-check these SKUs. If you believe one of them is correct,
        get in touch and we will look into it.
      </p>

      <button type="button" class="dashboard-issue-submit-btn" data-skipped-close>
        Back
      </button>
    </div>
  `;

  document.body.appendChild(dialogEl);

  dialogEl.querySelectorAll("[data-skipped-close]").forEach((btnEl) => {
    btnEl.addEventListener("click", () => {
      dialogEl.classList.add("hidden");
      document.documentElement.classList.remove("modal-open");
      document.body.classList.remove("modal-open");
    });
  });

  skippedRowsDialog = dialogEl;

  return dialogEl;
}

function showSkippedRows(skippedRows) {
  const dialogEl = buildSkippedRowsDialog();
  const listEl = dialogEl.querySelector("#consignmentCsvSkippedList");

  listEl.innerHTML = (skippedRows || [])
    .map((r) => {
      const sku = escapeHtml(String(r.sku ?? ""));
      const sizeLabel = r.size ? escapeHtml(String(r.size)) : "";
      const qty = r.quantity ? escapeHtml(String(r.quantity)) : "";

      const metaText = [sizeLabel && `Size ${sizeLabel}`, qty && `${qty} pcs`]
        .filter(Boolean)
        .join(" &middot; ");

      return `
        <div>
          <span class="consignment-skipped-sku">${sku}</span>
          ${metaText ? `<span class="consignment-skipped-meta">${metaText}</span>` : ""}
        </div>
      `;
    })
    .join("");

  dialogEl.classList.remove("hidden");
  document.documentElement.classList.add("modal-open");
  document.body.classList.add("modal-open");
}

// NEW — remember which finished import you have already seen.
//
// loadCsvImportStatus always fetches the latest job, and that stops changing
// once it completes. Without this, the notice from your previous import
// reappeared every time you opened this tab.
//
// Stored per seller, since one browser can be used for several accounts.
function csvImportSeenKey() {
  return `csv-import-gezien:${dashboardSeller?.id || "onbekend"}`;
}

function csvImportWasSeen(jobId) {
  if (!jobId) return false;

  try {
    return localStorage.getItem(csvImportSeenKey()) === String(jobId);
  } catch {
    // Private mode or blocked storage: better to show the notice too often
    // than to hide a skipped row.
    return false;
  }
}

function rememberCsvImportSeen(jobId) {
  if (!jobId) return;

  try {
    localStorage.setItem(csvImportSeenKey(), String(jobId));
  } catch {
    /* niets aan te doen, zie hierboven */
  }
}

// NEW — the edit-offer dialog was laid out wrong.
//
// The VAT block and the Save button shared .dashboard-offer-action-row, but
// the rule that turns that into a row lives inside @media (max-width: 768px)
// and therefore only applies on a phone. On a desktop it fell apart: the VAT
// type as a full-width panel, with Save underneath as a small button on the
// left.
//
// Beyond that, the VAT type should not be a panel at all. It is not a choice
// and not an input — it is fixed for this offer — so it belongs as a label on
// the amount field, not as a separate line below it.
//
// The HTML is untouched; the pieces are moved here. The id stays the same, so
// the code that fills the label keeps working.
(function () {
  const moneyValue = document.getElementById("editOfferAmount");
  const btw = document.getElementById("editOfferVatTypeLabel");

  if (!moneyValue || !btw) return;

  const omhulsel = document.createElement("div");
  omhulsel.className = "dashboard-field-with-suffix";

  moneyValue.parentNode.insertBefore(omhulsel, moneyValue);
  omhulsel.appendChild(moneyValue);
  omhulsel.appendChild(btw);

  btw.classList.add("dashboard-field-suffix");

  // The now-empty panel and the row around it have nothing left in them.
  document.querySelector(".dashboard-locked-vat")?.remove();

  const rowEl = document.querySelector(".dashboard-offer-action-row");
  const btnEl = rowEl?.querySelector(".dashboard-offer-save-btn");

  if (rowEl && btnEl) {
    rowEl.parentNode.insertBefore(btnEl, rowEl);
    rowEl.remove();
  }
})();

function renderCsvImportStatus(job) {
  const el = getCsvImportStatusEl();
  if (!el) return;

  clearTimeout(csvImportCompletedHideTimer);

  if (!job) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }

  const processed = Number(job.processed_rows || 0);
  const total = Number(job.total_rows || 0);

  el.className = "csv-import-status-pill";

  if (job.status === "processing" || job.status === "queued") {
    el.textContent =
      job.status === "queued"
        ? `⏳ Import queued`
        : `⏳ Importing ${processed}/${total}`;
  
    el.classList.add("processing");
    return;
  }

  const overgeslagen = Array.isArray(job.skipped_json) ? job.skipped_json : [];

  if (job.status === "completed") {
    // CHANGED — two things.
    //
    // First, this always said "completed", even when rows had been skipped.
    // Your inventory then does not match the file you uploaded and you see
    // nothing about it.
    //
    // Second, the notice came back on every visit to this tab. The latest
    // job is always fetched, and that stays the same forever: an import from
    // last week showed up again for fifteen seconds every time, as if it
    // were still running. Dismissing is now remembered, and auto-hiding
    // counts as dismissing.
    if (csvImportWasSeen(job.id)) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }

    if (overgeslagen.length) {
      el.classList.add("skipped");
      el.title = "Click to see which rows were skipped";

      el.innerHTML = `
        <span class="csv-import-status-mark" aria-hidden="true">!</span>
        <span class="csv-import-status-text" role="button" tabindex="0">
          ${processed - overgeslagen.length}/${total} imported,
          ${overgeslagen.length} skipped
        </span>
        <button type="button" class="csv-import-status-dismiss"
                aria-label="Dismiss">&times;</button>
      `;

      const openen = () => showSkippedRows(overgeslagen);
      const messageText = el.querySelector(".csv-import-status-text");

      messageText.addEventListener("click", openen);
      messageText.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          openen();
        }
      });

      // Stays until dismissed: hiding itself would mean you miss it if you
      // look away for a moment, and then your inventory is quietly smaller
      // than your file.
      el.querySelector(".csv-import-status-dismiss")
        .addEventListener("click", () => {
          rememberCsvImportSeen(job.id);
          el.classList.add("hidden");
          el.textContent = "";
        });

      return;
    }

    el.textContent = `✅ Import completed`;
    el.classList.add("completed");
    el.onclick = null;

    csvImportCompletedHideTimer = setTimeout(() => {
      rememberCsvImportSeen(job.id);
      el.classList.add("hidden");
      el.textContent = "";
    }, 15000);

    return;
  }

  if (job.status === "failed") {
    el.textContent = `❌ Import failed (${processed}/${total})`;

    el.classList.add("failed");
    return;
  }

  el.classList.add("hidden");
}

async function loadCsvImportStatus() {
  if (!dashboardSeller?.id) return;

  const params = new URLSearchParams({
    seller_record_id: dashboardSeller.id
  });

  const response = await fetch(`/api/consignment/csv-import/latest?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) return;

  renderCsvImportStatus(data.job);

  if (
    data.job &&
    ["queued", "processing"].includes(data.job.status)
  ) {
    startCsvImportStatusPolling();
  }
}

function startCsvImportStatusPolling() {
  clearInterval(csvImportStatusTimer);

  csvImportStatusTimer = setInterval(async () => {
    if (activeSection !== "consignment" || activeTab !== "inventory") {
      clearInterval(csvImportStatusTimer);
      csvImportStatusTimer = null;
      return;
    }

    await loadCsvImportStatus();
  }, 5000);
}

async function loadDashboardData() {
  if (!dashboardSeller) return;

  // Race guard — each load captures a token AND the pill it was started
  // for (section/tab/offer-filter). A slow fetch that finishes after the
  // user switched pills — or after a newer load started — must NOT render
  // its now-stale result over the current view. Checked right before
  // every async render below via loadStillCurrent().
  const __loadToken = (window.__dashboardLoadToken = (window.__dashboardLoadToken || 0) + 1);
  const __loadSection = activeSection;
  const __loadTab = activeTab;
  const __loadOfferFilter = activeOfferStatusFilter;
  const loadStillCurrent = () =>
    __loadToken === window.__dashboardLoadToken &&
    __loadSection === activeSection &&
    __loadTab === activeTab &&
    __loadOfferFilter === activeOfferStatusFilter;

  document.getElementById("consignmentInventoryActions")?.remove();

  if (activeSection === "buying" && activeTab === "open_wtbs") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingOpenWtbColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading open WTBs...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-open-wtbs?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load open WTBs");
    }
  
    renderBuyingOpenWtbRows(data.items || []);
  
    dashboardCountsCache.buying.open_wtbs = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:open_wtbs"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "accepted") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingAcceptedColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading accepted offers.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-accepted?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying accepted");
    }
  
    renderBuyingAcceptedRows(data.items || []);
  
    dashboardCountsCache.buying.accepted = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:accepted"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "payment_required") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingPaymentRequiredColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading payments.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-payment-required?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load payments");
    }
  
    renderBuyingPaymentRequiredRows(data.items || []);
  
    dashboardCountsCache.buying.payment_required = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:payment_required"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "confirmed") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingConfirmedColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading confirmed orders.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-confirmed?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying confirmed");
    }
  
    renderBuyingConfirmedRows(data.items || []);
  
    dashboardCountsCache.buying.confirmed = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:confirmed"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "label_requested") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingLabelRequestedColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading label requests.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-label-requested?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying label requested");
    }
  
    renderBuyingLabelRequestedRows(data.items || []);
  
    dashboardCountsCache.buying.label_requested = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:label_requested"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "ready_to_ship") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingReadyToShipColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading ready to ship orders.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-ready-to-ship?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying ready to ship");
    }
  
    renderBuyingReadyToShipRows(data.items || []);
  
    dashboardCountsCache.buying.ready_to_ship = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:ready_to_ship"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "shipped") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingShippedColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading shipped orders.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-shipped?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying shipped");
    }
  
    renderBuyingShippedRows(data.items || []);
  
    dashboardCountsCache.buying.shipped = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:shipped"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "buying" && activeTab === "delivered") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingDeliveredColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading delivered orders.</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-delivered?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying delivered");
    }
  
    renderBuyingDeliveredRows(data.items || []);
  
    dashboardCountsCache.buying.delivered = data.count || 0;
    dashboardCountsCache.buying.delivered_payment_warning = data.payment_warning_count || 0;
  
    document.querySelectorAll('[data-count-key="buying:delivered"]')
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
    document.querySelectorAll('[data-warning-key="buying:delivered"]')
      .forEach((el) => {
        el.classList.toggle("hidden", Number(data.payment_warning_count || 0) <= 0);
      });
  
    renderStats();
  
    return;
  }

  if (activeSection === "consignment" && activeTab === "inventory") {
    document.getElementById("consignmentInventoryActions")?.remove();
    
    dashboardSubtabDescription.innerHTML = "";
  
    document.getElementById("consignmentCsvImportStatus")?.remove();
  
    dashboardSubtabTitle.insertAdjacentHTML("afterend", `
      <div class="csv-import-status-pill hidden" id="consignmentCsvImportStatus"></div>
    `);
  
    loadCsvImportStatus().catch(() => {});
  
    dashboardRefreshBtn.insertAdjacentHTML("beforebegin", `
      <div class="consignment-inventory-actions" id="consignmentInventoryActions">
        <button class="dashboard-issue-submit-btn" type="button" id="consignmentOpenAddStockBtn">
          <span class="desktop-only-inline">+ Add Stock</span>
          <span class="mobile-only-inline">+ Add</span>
        </button>
    
        <button class="dashboard-refresh-btn consignment-desktop-only" type="button" id="consignmentOpenCsvUploadBtn">
          + Upload CSV
        </button>
      </div>
    `);
    
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${consignmentInventoryColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading consignment inventory...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/consignment/inventory?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load consignment inventory"
      );
    }
  
    const searchTerm = String(dashboardSearchInput?.value || "")
      .trim()
      .toLowerCase();
    
    const inventoryItems = data.items || [];
    
    const filteredInventoryItems = searchTerm
      ? inventoryItems.filter((item) => {
          const searchable = [
            item.product_name,
            item.sku,
            item.size,
            item.brand,
            item.vat_type,
            item.selling_price_suggested,
            item.lowest_suggested_price,
            item.quantity
          ]
            .map((value) => String(value || "").toLowerCase())
            .join(" ");
    
          return searchable.includes(searchTerm);
        })
      : inventoryItems;
    
    renderConsignmentInventoryRows(filteredInventoryItems);
  
    const inventoryQuantityCount = (data.items || [])
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    
    setConsignmentCount("inventory", inventoryQuantityCount);
  
    return;
  }

  if (activeSection === "consignment" && activeTab === "confirmed") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading confirmed consignment sales...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/consignment-confirmed?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load confirmed consignment sales"
      );
    }
  
    renderConfirmedRows(data.items || []);
  
    setConsignmentCount("confirmed", data.count || 0);
  
    return;
  }

  const consignmentStatusEndpointMap = {
    accepted: "consignment-accepted",
    label_requested: "consignment-label-requested",
    ready_to_ship: "consignment-ready-to-ship",
    shipped: "consignment-shipped",
    delivered: "consignment-delivered"
  };
  
  if (
    activeSection === "consignment" &&
    consignmentStatusEndpointMap[activeTab]
  ) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>
              Loading consignment ${activeTab.replaceAll("_", " ")}...
            </strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const endpoint =
      consignmentStatusEndpointMap[activeTab];
  
    const response = await fetch(
      `/api/dashboard/${endpoint}?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load consignment sales"
      );
    }
  
    if (activeTab === "accepted") {
      renderConsignmentAcceptedRows(data.items || []);
    } else if (activeTab === "ready_to_ship") {
      renderReadyToShipRows(data.items || []);
    } else if (
      activeTab === "shipped" ||
      activeTab === "delivered"
    ) {
      renderTrackingRows(data.items || []);
    } else {
      renderOpenClaimsRows(data.items || []);
    }
  
    setConsignmentCount(activeTab, data.count || 0);
  
    return;
  }
  
  // FIXED — this catch-all sits BEFORE the unified Offers branch further
  // down, so without excluding "offers" it swallowed that tab: an empty
  // shell rendered, no fetch, and switching pills appeared to do nothing.
  // The old consignment Offers branch used to sit above this line; moving
  // the logic below it is what exposed this.
  if (activeSection === "consignment" && activeTab !== "offers") {
    renderTableShell();
    return;
  }

  if (activeSection === "buying" && activeTab === "offers") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="dashboard-empty-state">
            <strong>Loading offers...</strong>
          </div>
        </td>
      </tr>
    `;

    if (activeOfferStatusFilter === "open") {
      // Mirrors WTB's Open: combines two sources — genuinely fresh
      // seller offers the buyer hasn't responded to yet (existing
      // buying-offers endpoint) AND rounds where the seller just
      // countered back (buying-counter-offers?filter=open).
      const [freshRes, sellerCounterRes] = await Promise.all([
        fetch(`/api/dashboard/buying-offers?${new URLSearchParams({
          seller_record_id: dashboardSeller.id
        }).toString()}`),
        fetch(`/api/dashboard/buying-counter-offers?${new URLSearchParams({
          seller_record_id: dashboardSeller.id,
          filter: "open"
        }).toString()}`)
      ]);

      const freshData = await freshRes.json();
      const sellerCounterData = await sellerCounterRes.json();

      if (!freshRes.ok || !sellerCounterRes.ok) {
        throw new Error(
          freshData.error || sellerCounterData.error || "Failed to load offers"
        );
      }

      const merged = [
        ...(freshData.items || []).map((item) => ({ ...item, _kind: "fresh" })),
        ...(sellerCounterData.items || []).map((item) => ({ ...item, _kind: "seller_counter" }))
      ];

      renderBuyingUnifiedOfferRows(merged);

      const count = merged.length;
      dashboardPillCountsCache["buying:offers"] = {
        ...(dashboardPillCountsCache["buying:offers"] || {}),
        open: count
      };
      document
        .querySelectorAll('[data-pill-count-key="buying:offers:open"]')
        .forEach((el) => { el.textContent = count; });

      return;
    }

    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      filter: activeOfferStatusFilter === "denied" ? "denied" : "countered"
    });

    const response = await fetch(`/api/dashboard/buying-counter-offers?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load offers");
    }

    renderBuyingUnifiedOfferRows(
      (data.items || []).map((item) => ({
        ...item,
        // FIXED — this always overwrote _kind, discarding the
        // backend's own "fresh_denied" tag on items merged in from a
        // fresh, never-countered offer denied outright (his exact
        // fresh_no_floor deny scenario) — losing the distinction
        // needed to show the correct Accept/Counter/Delete buttons
        // for that case. Only applies the generic fallback when the
        // backend didn't already tag the item itself.
        _kind: item._kind || (activeOfferStatusFilter === "denied" ? "denied" : "my_counter")
      }))
    );

    const count = data.count || 0;
    dashboardPillCountsCache["buying:offers"] = {
      ...(dashboardPillCountsCache["buying:offers"] || {}),
      [activeOfferStatusFilter]: count
    };
    document
      .querySelectorAll(`[data-pill-count-key="buying:offers:${activeOfferStatusFilter}"]`)
      .forEach((el) => { el.textContent = count; });

    return;
  }

  // NEW — one branch serves both Offers tabs. Consignment offers ARE
  // Seller Offers now, so the Consignment tab reuses this exact fetch,
  // renderer and action buttons; only the scope differs. A second copy of
  // this logic for consignment is precisely the drift this rewrite removes.
  if (
    (activeSection === "wtb" || activeSection === "consignment") &&
    activeTab === "offers"
  ) {
    const offerScope = activeSection === "consignment" ? "consignment" : "";
    const pillCacheKey = `${activeSection}:offers`;
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="dashboard-empty-state">
            <strong>Loading offers...</strong>
          </div>
        </td>
      </tr>
    `;

    if (activeOfferStatusFilter === "open") {
      // "Open" combines two sources: genuinely fresh, never-countered
      // offers (Seller Offers table) AND the seller's own pending
      // counter awaiting the store/buyer (Counter Offers table, Store
      // Counter Price empty) — both belong here per his clarification.
      const [freshRes, ownCounterRes] = await Promise.all([
        fetch(`/api/dashboard/wtb-open-offers?${new URLSearchParams({
          seller_record_id: dashboardSeller.id,
          seller_id: dashboardSeller.seller_id,
          ...(offerScope ? { scope: offerScope } : {})
        }).toString()}`),
        fetch(`/api/dashboard/wtb-counter-offers?${new URLSearchParams({
          seller_record_id: dashboardSeller.id,
          filter: "open",
          ...(offerScope ? { scope: offerScope } : {})
        }).toString()}`)
      ]);

      const freshData = await freshRes.json();
      const ownCounterData = await ownCounterRes.json();

      if (!freshRes.ok || !ownCounterRes.ok) {
        throw new Error(
          freshData.error || ownCounterData.error || "Failed to load offers"
        );
      }

      const merged = [
        ...(freshData.items || []).map((item) => ({ ...item, _kind: "fresh" })),
        ...(ownCounterData.items || []).map((item) => ({ ...item, _kind: "own_counter" }))
      ];

      if (!loadStillCurrent()) return;
      renderWtbUnifiedOfferRows(merged);

      const count = merged.length;
      dashboardPillCountsCache[pillCacheKey] = {
        ...(dashboardPillCountsCache[pillCacheKey] || {}),
        open: count
      };

      // CHANGED - this ran for consignment only, so the Want To Buys and
      // Buying badges kept whatever the counts endpoint had guessed and
      // never agreed with the list on screen. The stat tile reads the
      // same cache, which is why it showed 0 next to a table with a row
      // in it.
      //
      // The Open pill is the authoritative number for every section;
      // summing all three pills would count one negotiation twice.
      dashboardCountsCache[activeSection] = {
        ...(dashboardCountsCache[activeSection] || {}),
        offers: count
      };

      setNavCount(
        document.querySelector(`[data-count-key="${activeSection}:offers"]`),
        count
      );

      if (activeSection === "consignment") {
        setConsignmentCount("offers", count);
      }

      renderStats();

      document
        .querySelectorAll(`[data-pill-count-key="${pillCacheKey}:open"]`)
        .forEach((el) => { el.textContent = count; });

      return;
    }

    // "counter" (displayed as "Countered") and "denied" both come from
    // the same Counter Offers query, just filtered differently.
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      filter: activeOfferStatusFilter === "denied" ? "denied" : "countered",
      ...(offerScope ? { scope: offerScope } : {})
    });

    const response = await fetch(`/api/dashboard/wtb-counter-offers?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load offers");
    }

    // Race guard — a newer load started or the pill changed while this
    // slow fetch was in flight; discard this now-stale result.
    if (!loadStillCurrent()) return;

    renderWtbUnifiedOfferRows(
      // FIXED — this unconditionally forced _kind to "denied"/"counter",
      // discarding the backend's own "fresh_denied" tag on items merged
      // in from the Seller Offers table — so isFreshDenied was always
      // false, and Retry never showed for a genuinely fresh, never-
      // countered offer that was denied outright (only the bare Delete
      // did, since it also has no previous_record_id). Now only
      // defaults when the backend hasn't already tagged it.
      (data.items || []).map((item) => ({
        ...item,
        _kind: item._kind || (activeOfferStatusFilter === "denied" ? "denied" : "counter")
      }))
    );

    const count = data.count || 0;
    dashboardPillCountsCache[pillCacheKey] = {
      ...(dashboardPillCountsCache[pillCacheKey] || {}),
      [activeOfferStatusFilter]: count
    };
    document
      .querySelectorAll(`[data-pill-count-key="${pillCacheKey}:${activeOfferStatusFilter}"]`)
      .forEach((el) => { el.textContent = count; });

    return;
  }

  if (activeSection === "wtb" && activeTab === "accepted") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${wtbAcceptedColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading accepted offers...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      seller_id: dashboardSeller.seller_id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-accepted?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load accepted offers"
      );
    }
  
    renderWtbAcceptedRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:accepted"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.accepted = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "wtb" && activeTab === "confirmed") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading confirmed WTB sales...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-confirmed?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load confirmed WTB sales"
      );
    }
  
    renderConfirmedRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:confirmed"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.confirmed = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "wtb" && activeTab === "label_requested") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading label requested WTB sales...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-label-requested?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load label requested WTB sales"
      );
    }
  
    renderOpenClaimsRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:label_requested"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.label_requested = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "wtb" && activeTab === "ready_to_ship") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading ready to ship WTB sales...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-ready-to-ship?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load ready to ship WTB sales"
      );
    }
  
    renderReadyToShipRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:ready_to_ship"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.ready_to_ship = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "wtb" && activeTab === "shipped") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading shipped WTB sales...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-shipped?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load shipped WTB sales"
      );
    }
  
    renderTrackingRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:shipped"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.shipped = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "wtb" && activeTab === "delivered") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading delivered WTB sales...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-delivered?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load delivered WTB sales"
      );
    }
  
    renderTrackingRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:delivered"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.delivered = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "wtb" && activeTab === "open_offers") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${wtbOpenOfferColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading open offers...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      seller_id: dashboardSeller.seller_id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-open-offers?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load open offers"
      );
    }
  
    renderWtbOpenOffersRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:open_offers"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }

    dashboardCountsCache.wtb.open_offers = data.count || 0;
  
    renderStats();
  
    return;
  }

  if (activeSection === "quick" && activeTab === "confirmed") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading confirmed quick deals...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/quick-confirmed?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load confirmed quick deals"
      );
    }
  
    renderConfirmedRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="quick:confirmed"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    return;
  }

  if (activeSection === "quick" && activeTab === "label_requested") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading label requested quick deals...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/quick-label-requested?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load label requested quick deals"
      );
    }
  
    renderOpenClaimsRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="quick:label_requested"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    return;
  }

  if (activeSection === "quick" && activeTab === "ready_to_ship") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading ready to ship quick deals...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/quick-ready-to-ship?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load ready to ship quick deals"
      );
    }
  
    renderReadyToShipRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="quick:ready_to_ship"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    return;
  }

  if (activeSection === "quick" && activeTab === "shipped") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading shipped quick deals...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/quick-shipped?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load shipped quick deals"
      );
    }
  
    renderTrackingRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="quick:shipped"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    return;
  }

  if (activeSection === "quick" && activeTab === "delivered") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading delivered quick deals...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/quick-delivered?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load delivered quick deals"
      );
    }
  
    renderTrackingRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="quick:delivered"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    return;
  }

  if (activeSection === "history" && activeTab === "completed") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading completed history...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      seller_id: dashboardSeller.seller_id
    });
  
    const response = await fetch(
      `/api/dashboard/history-completed?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load completed history"
      );
    }
  
    renderHistorySalesRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="history:completed"]'
    );
  
    setNavCount(countEl, data.count || 0);

    document.querySelectorAll('[data-count-group="history"]')
    .forEach((el) => {
      setNavCount(el, data.count || 0);
    });

    quickCountsCache.completed = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "history" && activeTab === "issues") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${historyIssueColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading history issues...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/history-issues?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load history issues"
      );
    }
  
    renderHistoryIssuesRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="history:issues"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.history.issues = data.count || 0;
    renderStats();
  
    return;
  }

  if (activeSection === "quick" && activeTab === "open_claims") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading open claims...</strong>
          </div>
        </td>
      </tr>
    `;

    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });

    const response = await fetch(
      `/api/dashboard/open-claims?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load open claims"
      );
    }

    renderOpenClaimsRows(data.claims || []);

    const countEl = document.querySelector(
      '[data-count-key="quick:open_claims"]'
    );

    if (countEl) {
      countEl.textContent = data.count || 0;
    }

    return;
  }

  renderTableShell();
}

function renderTableShell() {
  dashboardTableHead.innerHTML = skeletonColumns.map((column) => dashboardHeadCell(column)).join("");
  dashboardTableBody.innerHTML = `
    <tr>
      <td colspan="${skeletonColumns.length}">
        <div class="dashboard-empty-state">
          <div class="dashboard-empty-icon">◇</div>
          <strong>No orders yet</strong>

          <span>
            At this moment there are no orders in this stage.
            Please check the other statuses to find the order you're looking for.
          </span>
        </div>
      </td>
    </tr>
  `;
}

function syncAuthUi() {
  if (dashboardSeller) {
    dashboardLoginPanel.classList.add("hidden");
    dashboardContent.classList.remove("hidden");
    dashboardLogoutBtn.classList.remove("hidden");
    document.querySelector(".dashboard-mobile-menu-btn")?.classList.remove("hidden");
    document.querySelector(".dashboard-account")?.classList.remove("hidden");
    document.getElementById("sellerDashboard")?.classList.remove("auth-only");
    document.querySelector(".dashboard-sidebar")?.classList.remove("hidden");
    document.querySelector(".dashboard-topbar")?.classList.remove("hidden");
    dashboardSellerName.textContent = dashboardSeller.discord || dashboardSeller.email || "Seller";
    dashboardSellerId.textContent = dashboardSeller.seller_id || dashboardSeller.id || "Seller account";
    activeSection = safeSection(
      localStorage.getItem("kc_dashboard_section") || "quick"
    );
    
    activeTab = safeTab(
      activeSection,
      localStorage.getItem("kc_dashboard_tab") || "open_claims"
    );
    
    syncConsignmentAccess();
    syncDashboardUi();
    loadDashboardCounts().catch(console.error);
  } else {
    dashboardLoginPanel.classList.remove("hidden");
    dashboardContent.classList.add("hidden");
    dashboardLogoutBtn.classList.add("hidden");
    document.querySelector(".dashboard-mobile-menu-btn")?.classList.add("hidden");
    document.querySelector(".dashboard-account")?.classList.add("hidden");
    document.getElementById("sellerDashboard")?.classList.add("auth-only");
    document.querySelector(".dashboard-sidebar")?.classList.add("hidden");
    document.querySelector(".dashboard-topbar")?.classList.add("hidden");
    dashboardSellerName.textContent = "Not logged in";
    dashboardSellerId.textContent = "Login required";
    syncConsignmentAccess();
  }
}

function openEditOfferModal(button) {
  editOfferError.textContent = "";
  editOfferForm.dataset.offerId = button.dataset.editOfferId || "";
  editOfferForm.dataset.memberWtbRecordId = button.dataset.memberWtbRecordId || "";
  editOfferOrderRecordId.value = button.dataset.orderRecordId || "";
  editOfferVatType.value = button.dataset.vatType || "";
  editOfferVatTypeLabel.textContent = button.dataset.vatType || "-";
  editOfferAmount.value = button.dataset.currentOffer || "";
  editOfferCurrentLowest.textContent =
    button.dataset.currentLowest || "-";

  editOfferModal.classList.remove("hidden");

  if (window.innerWidth > 768) {
    editOfferAmount.focus();
    editOfferAmount.select();
  }
}

function closeEditOfferModal() {
  editOfferModal.classList.add("hidden");
}

/*
 * Only offer the VAT types this seller may actually sell.
 *
 * The server already refuses the rest - /api/consignment/inventory/manual
 * runs refuseIneligibleConsignmentVat before it writes anything - so this
 * changes nothing about what can be added. It stops a seller filling in a
 * SKU, a price and a list of sizes before being told the very first choice
 * was never open to them.
 *
 * seller.vat_types is computed by that same server-side rule, so the two
 * cannot drift apart. The rule itself: no VAT ID means Margin only, a
 * Dutch company cannot sell VAT0 to a Dutch B.V., and a foreign company
 * cannot sell VAT21.
 *
 * A session stored before this field existed has no vat_types. Then every
 * option stays open and the server keeps the last word - exactly the old
 * behaviour, which is safer than guessing the rule again here.
 */
function applyConsignmentVatRestrictions() {
  const allowed = Array.isArray(dashboardSeller?.vat_types) && dashboardSeller.vat_types.length
    ? dashboardSeller.vat_types
    : null;

  const cards = document.querySelectorAll(
    "#consignmentAddStockForm .consignment-vat-card"
  );

  cards.forEach((card) => {
    const input = card.querySelector('input[name="consignmentVatType"]');

    if (!input) return;

    const blocked = Boolean(allowed) && !allowed.includes(input.value);

    input.disabled = blocked;
    card.classList.toggle("is-unavailable", blocked);

    // Greyed out with no reason given is its own small mystery.
    if (blocked) {
      card.title = "Not available for the company details on your profile.";
      if (input.checked) input.checked = false;
    } else {
      card.removeAttribute("title");
    }
  });

  // Margin is open to everyone, so there is always somewhere to land when
  // the selected type turns out not to be this seller's to pick.
  const stillChecked = document.querySelector(
    '#consignmentAddStockForm input[name="consignmentVatType"]:checked'
  );

  if (!stillChecked) {
    const margin = document.querySelector(
      '#consignmentAddStockForm input[name="consignmentVatType"][value="Margin"]'
    );

    if (margin) margin.checked = true;
  }
}

function openConsignmentAddStockModal() {
  consignmentAddStockError.textContent = "";
  consignmentAddStockSuccess.textContent = "";
  resetConsignmentAddStockForm();
  applyConsignmentVatRestrictions();
  consignmentAddStockModal.classList.remove("hidden");

  if (window.innerWidth > 768) {
    consignmentSkuInput.focus();
  }
}

function closeConsignmentAddStockModal() {
  consignmentAddStockModal.classList.add("hidden");
}

function openConsignmentCsvModal(mode) {
  consignmentCsvMode.value = mode;
  consignmentCsvFileInput.value = "";
  consignmentCsvPreview.textContent = "";
  consignmentCsvError.textContent = "";
  consignmentCsvModal.classList.remove("hidden");
}

function closeConsignmentCsvModal() {
  consignmentCsvModal.classList.add("hidden");
}

function openConsignmentEditStockModal(button) {
  consignmentEditStockError.textContent = "";
  consignmentEditStockId.value = button.dataset.consignmentEditId || "";
  consignmentEditSellingPriceInput.value = button.dataset.currentPrice || "";
  consignmentEditQuantityInput.value = button.dataset.currentQuantity || "";

  consignmentEditStockModal.classList.remove("hidden");

  if (window.innerWidth > 768) {
    consignmentEditSellingPriceInput.focus();
    consignmentEditSellingPriceInput.select();
  }
}

function closeConsignmentEditStockModal() {
  consignmentEditStockModal.classList.add("hidden");
}

function getSelectedConsignmentVatType() {
  return document.querySelector('input[name="consignmentVatType"]:checked')?.value || "Margin";
}

function createConsignmentSizeRow() {
  const row = document.createElement("div");
  row.className = "consignment-size-row has-remove";

  row.innerHTML = `
    <label>
      <input class="consignment-size-input" type="text" required />
    </label>
  
    <label>
      <input class="consignment-price-input" type="text" inputmode="numeric" required />
    </label>
  
    <label>
      <input class="consignment-quantity-input" type="text" inputmode="numeric" required />
    </label>
  
    <button type="button" class="dashboard-modal-close consignment-remove-size-btn">×</button>
  `;

  return row;
}

function resetConsignmentAddStockForm() {
  consignmentAddStockForm.reset();

  consignmentSizeRows.innerHTML = `
    <div class="consignment-size-row">
      <label>
        Size EU
        <input class="consignment-size-input" type="text" required />
      </label>

      <label>
        Selling Price
        <input class="consignment-price-input" type="text" inputmode="numeric" required />
      </label>

      <label>
        Quantity
        <input class="consignment-quantity-input" type="text" inputmode="numeric" required />
      </label>
    </div>
  `;
}

async function submitConsignmentStockRows() {
  const sku = cleanSkuInput(consignmentSkuInput.value);
  consignmentSkuInput.value = sku;
  const vatType = getSelectedConsignmentVatType();
  const rows = [...consignmentSizeRows.querySelectorAll(".consignment-size-row")];

  for (const row of rows) {
    const sizeInput = row.querySelector(".consignment-size-input");
    const priceInput = row.querySelector(".consignment-price-input");
    const quantityInput = row.querySelector(".consignment-quantity-input");
    
    const size = cleanSizeInput(sizeInput?.value);
    const price = cleanWholeNumberInput(priceInput?.value);
    const quantity = cleanWholeNumberInput(quantityInput?.value);
    
    if (sizeInput) sizeInput.value = size;
    if (priceInput) priceInput.value = price;
    if (quantityInput) quantityInput.value = quantity;

    const response = await fetch("/api/consignment/inventory/manual", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        seller_record_id: dashboardSeller.id,
        seller_id: dashboardSeller.seller_id,
        sku,
        size,
        vat_type: vatType,
        selling_price_suggested: price,
        quantity
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to add stock");
    }
  }
}

function openIssueModal(inventoryId) {
  issueError.textContent = "";
  issueInventoryId.value = inventoryId || "";
  issueNotes.value = "";

  issueModal.classList.remove("hidden");
  if (window.innerWidth > 768) {
    issueNotes.focus();
  }
}

function closeIssueModal() {
  issueModal.classList.add("hidden");
}

function openViewIssueModal(note) {
  viewIssueNote.textContent = note || "No issue note found.";
  viewIssueModal.classList.remove("hidden");
}

function closeViewIssueModal() {
  viewIssueModal.classList.add("hidden");
}

async function handleDeleteOffer(button) {
  const offerId = button.dataset.deleteOfferId;

  const confirmed = await showConfirm(
    "Are you sure you want to delete this offer?"
  );

  if (!confirmed) return;

  button.disabled = true;

  try {
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });

    const response = await fetch(
      `/api/dashboard/wtb-open-offers/${offerId}?${params.toString()}`,
      {
        method: "DELETE"
      }
    );

    const raw = await response.text();

    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(raw || "Delete endpoint did not return JSON");
    }

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to delete offer");
    }

    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    showAlert(err.message);
  } finally {
    button.disabled = false;
  }
}

async function handleCancelBuyingWtb(button) {
  const memberWtbRecordId = button.dataset.buyingDeleteWtbId;

  const confirmed = await showConfirm(
    "Are you sure you want to cancel this Want To Buy?"
  );

  if (!confirmed) return;

  button.disabled = true;

  try {
    const response = await fetch("/api/dashboard/buying/cancel-wtb", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        member_wtb_record_id: memberWtbRecordId
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.details || data.error || "Failed to cancel Want To Buy"
      );
    }

    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    showAlert(err.message);
  } finally {
    button.disabled = false;
  }
}

dashboardStatsToggle?.addEventListener("click", () => {
  if (window.innerWidth > 768) return;

  statsOpen = !statsOpen;

  document
    .querySelector(".dashboard-stats-panel")
    ?.classList.toggle("open", statsOpen);
});

dashboardContent.addEventListener("click", (event) => {
  const addStockButton = event.target.closest("#consignmentOpenAddStockBtn");

  if (addStockButton) {
    openConsignmentAddStockModal();
  }

  const csvButton = event.target.closest("#consignmentOpenCsvUploadBtn");

  if (csvButton) {
    openConsignmentCsvModal("add");
  }
});

dashboardTableBody.addEventListener("click", async (event) => {
    const consignmentCounterOfferButton = event.target.closest("[data-consignment-counter-offer-id]");

    if (consignmentCounterOfferButton) {
      const offerId = consignmentCounterOfferButton.dataset.consignmentCounterOfferId;
      // FIXED — this always called /counter, even when responding to a
      // store's counter-back (is_counter_offer=true on the item),
      // which needs /consignor-counter instead (a different endpoint
      // that creates a new chained round rather than updating round 1
      // in place).
      const isStoreCounterBack = consignmentCounterOfferButton.dataset.isCounterOffer === "true";

      const raw = await showPrompt("Enter your requested payout. Example: 250", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });
    
      if (!raw) return;
    
      const counterPrice = Number(
        String(raw)
          .replace(/[^\d.,-]/g, "")
          .replace(",", ".")
      );
    
      if (!Number.isFinite(counterPrice) || counterPrice <= 0) {
        showAlert("Please enter a valid counter price. Example: 250");
        return;
      }
    
      consignmentCounterOfferButton.disabled = true;
      consignmentCounterOfferButton.textContent = "Sending...";
    
      try {
        const endpoint = isStoreCounterBack ? "consignor-counter" : "counter";

        const response = await fetch(`/api/consignment/offers/${offerId}/${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            seller_record_id: dashboardSeller.id,
            counter_price: counterPrice,
            price: counterPrice
          })
        });
    
        const data = await response.json();
    
        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to submit counter offer");
        }
    
        showAlert(`Counter offer sent to store. Store offer: €${Number(data.store_offer_price).toFixed(2)} (${data.store_offer_vat_type})`);
    
        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert("Could not submit counter offer. Please try again or contact support.");
      } finally {
        consignmentCounterOfferButton.disabled = false;
        consignmentCounterOfferButton.textContent = "Counter";
      }
    
      return;
    }
  
    const consignmentConfirmOfferButton = event.target.closest("[data-consignment-confirm-offer-id]");

    if (consignmentConfirmOfferButton) {
      const offerId = consignmentConfirmOfferButton.dataset.consignmentConfirmOfferId;
  
      consignmentConfirmOfferButton.disabled = true;
      consignmentConfirmOfferButton.textContent = "Confirming...";
  
      try {
        const response = await fetch(`/api/consignment/offers/${offerId}/confirm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            seller_record_id: dashboardSeller.id
          })
        });
  
        const data = await response.json();
  
        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to confirm offer");
        }
  
        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert(err.message);
      } finally {
        consignmentConfirmOfferButton.disabled = false;
        consignmentConfirmOfferButton.textContent = "Confirm";
      }
  
      return;
    }
  
    const consignmentDenyOfferButton = event.target.closest("[data-consignment-deny-offer-id]");
  
    if (consignmentDenyOfferButton) {
      const offerId = consignmentDenyOfferButton.dataset.consignmentDenyOfferId;
  
      consignmentDenyOfferButton.disabled = true;
  
      try {
        const response = await fetch(`/api/consignment/offers/${offerId}/deny`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            seller_record_id: dashboardSeller.id
          })
        });
  
        const data = await response.json();
  
        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to deny offer");
        }
  
        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert(err.message);
      } finally {
        consignmentDenyOfferButton.disabled = false;
      }
  
      return;
    }

    // NEW — additive only: Edit a pending counter (Countered pill).
    const consignmentOfferEditButton = event.target.closest("[data-consignment-offer-edit-id]");

    if (consignmentOfferEditButton) {
      const offerId = consignmentOfferEditButton.dataset.consignmentOfferEditId;

      const raw = await showPrompt("Enter your new counter. Example: 250", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });
      if (!raw) return;

      const newPrice = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(newPrice) || newPrice <= 0) {
        showAlert("Please enter a valid price. Example: 250");
        return;
      }

      consignmentOfferEditButton.disabled = true;
      consignmentOfferEditButton.textContent = "Saving...";

      try {
        const response = await fetch(`/api/consignment/offers/${offerId}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seller_record_id: dashboardSeller.id,
            price: newPrice
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to update your counter");
        }

        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert(err.message);
      } finally {
        consignmentOfferEditButton.disabled = false;
        consignmentOfferEditButton.textContent = "Edit";
      }

      return;
    }

    // NEW — additive only: fall back to accepting the store's previous
    // position instead of waiting on a response to your own pending
    // counter (Countered pill).
    const consignmentAcceptPreviousButton = event.target.closest("[data-consignment-accept-previous-id]");

    if (consignmentAcceptPreviousButton) {
      const offerId = consignmentAcceptPreviousButton.dataset.consignmentAcceptPreviousId;
      const originalLabel = consignmentAcceptPreviousButton.textContent;

      if (!(await showConfirm("Accept the store's previous offer instead of waiting for a response to your counter?"))) {
        return;
      }

      consignmentAcceptPreviousButton.disabled = true;
      consignmentAcceptPreviousButton.textContent = "Accepting...";

      try {
        const response = await fetch(`/api/consignment/offers/${offerId}/accept-previous`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seller_record_id: dashboardSeller.id })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to accept the previous offer");
        }

        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert(err.message);
      } finally {
        consignmentAcceptPreviousButton.disabled = false;
        consignmentAcceptPreviousButton.textContent = originalLabel;
      }

      return;
    }

    // NEW — additive only: soft-delete a pending counter (Countered)
    // or a denied offer (Denied) the seller no longer wants to pursue.
    const consignmentCancelOfferButton = event.target.closest("[data-consignment-cancel-offer-id]");

    if (consignmentCancelOfferButton) {
      const offerId = consignmentCancelOfferButton.dataset.consignmentCancelOfferId;

      if (!(await showConfirm("Remove this offer? This can't be undone."))) return;

      consignmentCancelOfferButton.disabled = true;

      try {
        const response = await fetch(`/api/consignment/offers/${offerId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seller_record_id: dashboardSeller.id })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to remove offer");
        }

        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert(err.message);
      } finally {
        consignmentCancelOfferButton.disabled = false;
      }

      return;
    }

    // NEW — additive only: Retry from the Denied pill — a fresh
    // counter after a dead-end denial, must be higher than what was
    // denied.
    const consignmentRetryButton = event.target.closest("[data-consignment-retry-offer-id]");

    if (consignmentRetryButton) {
      const offerId = consignmentRetryButton.dataset.consignmentRetryOfferId;

      const raw = await showPrompt("Enter your new, higher counter. Example: 250", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });
      if (!raw) return;

      const retryPrice = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(retryPrice) || retryPrice <= 0) {
        showAlert("Please enter a valid price. Example: 250");
        return;
      }

      consignmentRetryButton.disabled = true;
      consignmentRetryButton.textContent = "Sending...";

      try {
        const response = await fetch(`/api/consignment/offers/${offerId}/consignor-retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seller_record_id: dashboardSeller.id,
            price: retryPrice
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.details || data.error || "Failed to submit your new counter");
        }

        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        showAlert(err.message);
      } finally {
        consignmentRetryButton.disabled = false;
        consignmentRetryButton.textContent = "Retry";
      }

      return;
    }

  const consignmentEditButton = event.target.closest("[data-consignment-edit-id]");

  if (consignmentEditButton) {
    openConsignmentEditStockModal(consignmentEditButton);
    return;
  }
  
  const consignmentDeleteButton = event.target.closest("[data-consignment-delete-id]");

  if (consignmentDeleteButton) {
    const inventoryId = consignmentDeleteButton.dataset.consignmentDeleteId;

    consignmentDeleteButton.disabled = true;

    try {
      const response = await fetch(`/api/consignment/inventory/${inventoryId}`, {
        method: "DELETE"
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete inventory");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
    } finally {
      consignmentDeleteButton.disabled = false;
    }

    return;
  }
  const issueButton = event.target.closest("[data-report-issue-id]");
  const labelButton = event.target.closest("[data-label-url]");
  const viewIssueButton = event.target.closest("[data-issue-note]");
  const solveIssueButton = event.target.closest("[data-solve-issue-id]");
  const editButton = event.target.closest("[data-edit-offer-id]");
  const deleteButton = event.target.closest("[data-delete-offer-id]");
  const buyingDeleteButton = event.target.closest("[data-buying-delete-wtb-id]");
  const buyingAcceptOfferButton = event.target.closest("[data-buying-accept-offer-id]");
  const buyingDenyOfferButton = event.target.closest("[data-buying-deny-offer-id]");
  const requestLabelButton = event.target.closest("[data-request-label-id]");

  if (requestLabelButton) {
    const orderRecordId = requestLabelButton.dataset.requestLabelId || "";
    const memberWtbRecordId = requestLabelButton.dataset.memberWtbRecordId || "";
  
    if (!orderRecordId && !memberWtbRecordId) {
      showAlert("Missing order or Member WTB record ID.");
      return;
    }
  
    requestLabelButton.disabled = true;
    requestLabelButton.textContent = "REQUESTING.";
  
    try {
      const response = await fetch(
        memberWtbRecordId
          ? "/api/dashboard/member-wtb-request-label"
          : "/api/dashboard/request-label",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(
            memberWtbRecordId
              ? { member_wtb_record_id: memberWtbRecordId }
              : { order_record_id: orderRecordId }
          )
        }
      );
  
      const data = await response.json();
  
      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to request label");
      }
  
      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message || "Failed to request label");
      requestLabelButton.disabled = false;
      requestLabelButton.textContent = "REQUEST LABEL";
    }
  
    return;
  }

  if (labelButton) {
    pendingLabelUrl = labelButton.dataset.labelUrl || "";
    labelInstructionsModal?.classList.remove("hidden");
    return;
  }
  
  if (issueButton) {
    openIssueModal(issueButton.dataset.reportIssueId);
    return;
  }
  
  if (viewIssueButton) {
    openViewIssueModal(viewIssueButton.dataset.issueNote || "");
    return;
  }
  
  if (solveIssueButton) {
    const confirmed = await showConfirm("Mark this issue as solved?");
  
    if (!confirmed) return;
  
    const response = await fetch(
      `/api/dashboard/history/${solveIssueButton.dataset.solveIssueId}/solve-issue`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller_record_id: dashboardSeller.id
        })
      }
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      showAlert(data.details || data.error || "Failed to solve issue");
      return;
    }
  
    await loadDashboardData();
    await loadDashboardCounts();
    return;
  }

  if (editButton) {
    openEditOfferModal(editButton);
    return;
  }

  // FIXED — this button existed in the HTML (and the variable was
  // declared above) but was never actually wired to anything — Delete
  // silently did nothing. The backend endpoint already existed.
  if (deleteButton) {
    const offerId = deleteButton.dataset.deleteOfferId;
    if (!offerId) return;

    if (!(await showConfirm("Delete this offer? This can't be undone."))) return;

    deleteButton.disabled = true;

    try {
      const response = await fetch(
        `/api/dashboard/wtb-open-offers/${offerId}?${new URLSearchParams({ seller_record_id: dashboardSeller.id }).toString()}`,
        { method: "DELETE" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      deleteButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: seller directly accepts the store/buyer's
  // current counter.
  const wtbSellerAcceptButton = event.target.closest("[data-wtb-seller-accept-id]");
  if (wtbSellerAcceptButton) {
    const offerId = wtbSellerAcceptButton.dataset.wtbSellerAcceptId;
    const originalLabel = wtbSellerAcceptButton.textContent;

    if (!(await showConfirm("Accept this offer?"))) return;

    wtbSellerAcceptButton.disabled = true;
    wtbSellerAcceptButton.textContent = "Accepting...";

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/seller-accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to accept the offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbSellerAcceptButton.disabled = false;
      wtbSellerAcceptButton.textContent = originalLabel;
    }

    return;
  }

  // NEW — additive only: seller denies the store/buyer's current
  // counter — reopens the prior round if there is one, matching the
  // existing Discord deny behavior.
  const wtbSellerDenyButton = event.target.closest("[data-wtb-seller-deny-id]");
  if (wtbSellerDenyButton) {
    const offerId = wtbSellerDenyButton.dataset.wtbSellerDenyId;

    if (!(await showConfirm("Deny this offer?"))) return;

    wtbSellerDenyButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/seller-deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to deny the offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbSellerDenyButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: seller counters back on the store/buyer's
  // current counter, reusing the existing (already band-validated)
  // seller-counter endpoint. Asks for the price through showPrompt with a
  // money field: euro sign, numeric keyboard on mobile, and a check on the
  // amount before it reaches the server.
  // NEW — additive only: retry a fresh, never-countered offer that
  // was denied outright, using the pre-existing edit-after-denial
  // endpoint (already Portal-safe — seller_record_id, no secret).
  // NEW — additive only: retry a counter round that dead-ended in
  // denial, validated against the store's last real position (band
  // rule enforced server-side — a too-low attempt gets a clear error).
  const wtbRetryCounterButton = event.target.closest("[data-wtb-retry-counter-id]");
  if (wtbRetryCounterButton) {
    const offerId = wtbRetryCounterButton.dataset.wtbRetryCounterId;
    const priceInput = await showPrompt("Your new counter offer (€):", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    wtbRetryCounterButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/retry-counter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price, seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to submit retry");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbRetryCounterButton.disabled = false;
    }

    return;
  }

  const wtbRetryFreshOfferButton = event.target.closest("[data-wtb-retry-fresh-offer-id]");
  if (wtbRetryFreshOfferButton) {
    const offerId = wtbRetryFreshOfferButton.dataset.wtbRetryFreshOfferId;
    const vatType = wtbRetryFreshOfferButton.dataset.vatType;
    const deniedAmountText = wtbRetryFreshOfferButton.dataset.deniedAmount;
    const deniedAmount = Number(String(deniedAmountText).replace(/[^\d.,-]/g, "").replace(",", "."));

    const priceInput = await showPrompt(`Your new offer (€, must be at least €2.50 lower than the denied €${deniedAmount || "?"}):`, { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    wtbRetryFreshOfferButton.disabled = true;

    try {
      const response = await fetch(`/api/seller-offers/${offerId}/edit-after-denial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller_record_id: dashboardSeller.id,
          offer_amount: price,
          vat_type: vatType,
          previous_denied_amount: deniedAmount
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to submit new offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbRetryFreshOfferButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: delete a fresh, never-countered denied offer,
  // reusing the pre-existing wtb-open-offers delete endpoint (same
  // Seller Offers table).
  const wtbDeleteFreshOfferButton = event.target.closest("[data-wtb-delete-fresh-offer-id]");
  if (wtbDeleteFreshOfferButton) {
    const offerId = wtbDeleteFreshOfferButton.dataset.wtbDeleteFreshOfferId;

    if (!(await showConfirm("Delete this offer? This can't be undone."))) return;

    wtbDeleteFreshOfferButton.disabled = true;

    try {
      const response = await fetch(
        `/api/dashboard/wtb-open-offers/${offerId}?${new URLSearchParams({ seller_record_id: dashboardSeller.id }).toString()}`,
        { method: "DELETE" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbDeleteFreshOfferButton.disabled = false;
    }

    return;
  }

  const wtbSellerCounterButton = event.target.closest("[data-wtb-seller-counter-id]");
  if (wtbSellerCounterButton) {
    const offerId = wtbSellerCounterButton.dataset.wtbSellerCounterId;
    // FIXED — a real, confirmed bug found via his live testing: this
    // always called the Store Orders seller-counter endpoint,
    // regardless of whether the item was actually a Member WTB round
    // — for Member WTB, that endpoint operates on the wrong table/
    // scope entirely (no "Order" link exists on a Member WTB round),
    // producing a nonsensical cross-seller threshold and the wrong
    // error text ("for this order" instead of "for this WTB"). Now
    // routes to the correct endpoint based on the item's own type.
    const isMemberWtb = wtbSellerCounterButton.dataset.wtbSellerCounterIsMemberWtb === "1";
    const priceInput = await showPrompt("Your counter offer (€):", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    wtbSellerCounterButton.disabled = true;

    try {
      const endpoint = isMemberWtb
        ? `/api/dashboard/wtb-counter-offers/${offerId}/seller-counter-mwtb`
        : `/api/counter-offers/${offerId}/seller-counter`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price, seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to submit counter");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbSellerCounterButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: accept the store/buyer's previous counter
  // instead of waiting on a response to the seller's own pending one.
  // NEW — additive only: Buying's Accept — works for fresh, seller_counter,
  // my_counter, and denied items alike, since it always just accepts
  // whichever seller is currently cheapest overall (reuses the existing,
  // already-Portal-safe buying/accept-offer endpoint).
  const buyingAcceptCurrentLowestButton = event.target.closest("[data-buying-accept-current-lowest-id]");
  if (buyingAcceptCurrentLowestButton) {
    const memberWtbRecordId = buyingAcceptCurrentLowestButton.dataset.buyingAcceptCurrentLowestId;
    if (!memberWtbRecordId) return;

    if (!(await showConfirm("Accept the current lowest offer?"))) return;

    buyingAcceptCurrentLowestButton.disabled = true;

    // FIXED — this always accepted the raw, un-negotiated listing
    // price, ignoring the specific negotiated amount shown on the
    // button itself (e.g. "Accept €92.10" on Countered/Denied) —
    // silently accepting a different price than what was displayed.
    // Now passes the actual negotiated payout when one exists (empty
    // for a genuinely fresh, never-countered offer, where there's
    // nothing to override).
    const overridePayout = buyingAcceptCurrentLowestButton.dataset.buyingAcceptPayout;
    const overrideVatType = buyingAcceptCurrentLowestButton.dataset.buyingAcceptVatType;
    // NEW — additive only: needed so the backend can correctly close
    // OTHER sellers' competing negotiations on the same Member WTB
    // without also closing the round actually being accepted.
    const acceptedRecordId = buyingAcceptCurrentLowestButton.dataset.buyingAcceptRecordId;
    // FIXED — CRITICAL: without this, the backend fell back to a
    // stale Airtable field to decide WHICH seller gets the deal,
    // completely ignoring which specific row's Accept button was
    // clicked — could silently create a deal channel with the wrong
    // seller. Now sends the exact seller offer this button represents.
    const sellerOfferRecordId = buyingAcceptCurrentLowestButton.dataset.buyingAcceptSellerOfferId;

    try {
      const response = await fetch("/api/dashboard/buying/accept-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_wtb_record_id: memberWtbRecordId,
          ...(overridePayout ? { override_price: Number(overridePayout), override_vat_type: overrideVatType } : {}),
          ...(acceptedRecordId ? { counter_offer_record_id: acceptedRecordId } : {}),
          ...(sellerOfferRecordId ? { seller_offer_record_id: sellerOfferRecordId } : {})
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to accept offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingAcceptCurrentLowestButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: Buying's Counter — for "fresh" items, creates
  // the first-ever round; for "seller_counter" items, counters the
  // existing round.
  const buyingCounterButton = event.target.closest("[data-buying-counter-id]");
  if (buyingCounterButton) {
    const kind = buyingCounterButton.dataset.buyingCounterKind;

    // NEW — additive only: his explicit correction — the Counter
    // button stays visible even when there's no room, so clicking it
    // shows a clear explanation (why: the gap between the buyer's own
    // previous position and this seller's ask is too small for
    // another step) instead of a Counter button that quietly did
    // nothing, or a wasted round trip to the server just to find out.
    if (buyingCounterButton.dataset.buyingCounterNoRoom === "1") {
      showAlert("No room to counter — the gap between your own previous position on this WTB and this seller's ask is too small for another step. Please accept or deny.");
      return;
    }

    const priceInput = await showPrompt("Your counter offer (€):", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    buyingCounterButton.disabled = true;

    try {
      let response;
      if (kind === "fresh") {
        response = await fetch("/api/dashboard/buying-counter-offers/create-from-fresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            member_wtb_record_id: buyingCounterButton.dataset.buyingCounterId,
            seller_offer_record_id: buyingCounterButton.dataset.buyingSellerOfferId,
            price,
            seller_record_id: dashboardSeller.id
          })
        });
      } else {
        response = await fetch(`/api/dashboard/buying-counter-offers/${buyingCounterButton.dataset.buyingCounterId}/buyer-counter`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ price, seller_record_id: dashboardSeller.id })
        });
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to submit counter");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingCounterButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: Buying's Deny — for "fresh" items, uses the
  // existing simple deny-offer endpoint (no Counter Offers round
  // exists yet); for "seller_counter" items, uses the new buyer-deny
  // (reopens the prior round, matching member_wtb_counter_deny:).
  const buyingDenyButton = event.target.closest("[data-buying-deny-id]");
  if (buyingDenyButton) {
    const kind = buyingDenyButton.dataset.buyingDenyKind;

    if (!(await showConfirm("Deny this offer?"))) return;

    buyingDenyButton.disabled = true;

    try {
      let response;
      if (kind === "fresh") {
        // FIXED — a real, confirmed gap: this used to call
        // /api/dashboard/buying/deny-offer, which only flips an
        // "Offer Sent?" flag and does nothing to the actual
        // negotiation — no reopening of other sellers, no reflection
        // of the buyer's real floor. Now uses the correct endpoint,
        // which creates a proper denial round at the buyer's own
        // historical floor and reopens any other seller with a stale,
        // superseded position at that same floor.
        response = await fetch(`/api/dashboard/buying-offers/${buyingDenyButton.dataset.buyingDenyId}/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seller_record_id: dashboardSeller.id,
            seller_offer_record_id: buyingDenyButton.dataset.buyingDenySellerOfferId
          })
        });
      } else {
        response = await fetch(`/api/dashboard/buying-counter-offers/${buyingDenyButton.dataset.buyingDenyId}/buyer-deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seller_record_id: dashboardSeller.id })
        });
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to deny offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingDenyButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: buyer edits their own pending counter (raise it).
  const buyingEditCounterButton = event.target.closest("[data-buying-edit-counter-id]");
  if (buyingEditCounterButton) {
    const offerId = buyingEditCounterButton.dataset.buyingEditCounterId;
    const priceInput = await showPrompt("Your new counter offer (€):", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    buyingEditCounterButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/buying-counter-offers/${offerId}/buyer-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price, seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to edit counter");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingEditCounterButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: buyer retries after a dead-end denial.
  const buyingRetryCounterButton = event.target.closest("[data-buying-retry-counter-id]");
  if (buyingRetryCounterButton) {
    const offerId = buyingRetryCounterButton.dataset.buyingRetryCounterId;
    const priceInput = await showPrompt("Your new counter offer (€):", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    buyingRetryCounterButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/buying-counter-offers/${offerId}/retry-counter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price, seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to submit retry");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingRetryCounterButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: buyer deletes their own counter or a denied one.
  const buyingCancelOfferButton = event.target.closest("[data-buying-cancel-offer-id]");
  if (buyingCancelOfferButton) {
    const offerId = buyingCancelOfferButton.dataset.buyingCancelOfferId;

    if (!(await showConfirm("Delete this offer? This can't be undone."))) return;

    buyingCancelOfferButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/buying-counter-offers/${offerId}/buyer-cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingCancelOfferButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: Delete on a "fresh_denied" item (a genuinely
  // fresh, never-countered offer denied outright — his exact
  // fresh_no_floor scenario). This item's id is a Seller Offer
  // record, not a Counter Offers round, so it needs its own endpoint
  // rather than reusing buyer-cancel above.
  const buyingDeleteDeniedButton = event.target.closest("[data-buying-delete-denied-id]");
  if (buyingDeleteDeniedButton) {
    const sellerOfferId = buyingDeleteDeniedButton.dataset.buyingDeleteDeniedId;

    if (!(await showConfirm("Delete this offer? This can't be undone."))) return;

    buyingDeleteDeniedButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/buying-offers/${sellerOfferId}/buyer-delete-denied`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingDeleteDeniedButton.disabled = false;
    }

    return;
  }

  const wtbAcceptPreviousButton = event.target.closest("[data-wtb-accept-previous-id]");
  if (wtbAcceptPreviousButton) {
    const offerId = wtbAcceptPreviousButton.dataset.wtbAcceptPreviousId;
    const originalLabel = wtbAcceptPreviousButton.textContent;

    if (!(await showConfirm("Accept the buyer's previous offer instead of waiting for a response to your counter?"))) {
      return;
    }

    wtbAcceptPreviousButton.disabled = true;
    wtbAcceptPreviousButton.textContent = "Accepting...";

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/accept-previous`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to accept the previous offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbAcceptPreviousButton.disabled = false;
      wtbAcceptPreviousButton.textContent = originalLabel;
    }

    return;
  }

  // NEW — additive only: delete the seller's own pending counter
  // (Counter Offers table record), which has no existing delete path.
  // NEW — additive only: edit the seller's own already-placed counter
  // to a lower amount, using the pre-existing (now Portal-wrapped)
  // edit endpoint.
  const wtbEditCounterButton = event.target.closest("[data-wtb-edit-counter-id]");
  if (wtbEditCounterButton) {
    const offerId = wtbEditCounterButton.dataset.wtbEditCounterId;
    const priceInput = await showPrompt("Your new counter offer (€):", { money: true, validate: kcMoneyCheck, confirmLabel: "Confirm" });

    if (!priceInput) return;

    const price = Number(priceInput);

    if (!Number.isFinite(price) || price <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }

    wtbEditCounterButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/seller-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price, seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to edit the counter");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbEditCounterButton.disabled = false;
    }

    return;
  }

  const wtbCancelCounterButton = event.target.closest("[data-wtb-cancel-counter-id]");
  if (wtbCancelCounterButton) {
    const offerId = wtbCancelCounterButton.dataset.wtbCancelCounterId;
    if (!offerId) return;

    if (!(await showConfirm("Delete this counter? This can't be undone."))) return;

    wtbCancelCounterButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete counter");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbCancelCounterButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: Delete for a denied WTB counter offer.
  const wtbCancelOfferButton = event.target.closest("[data-wtb-cancel-offer-id]");
  if (wtbCancelOfferButton) {
    const offerId = wtbCancelOfferButton.dataset.wtbCancelOfferId;
    if (!offerId) return;

    if (!(await showConfirm("Delete this offer? This can't be undone."))) return;

    wtbCancelOfferButton.disabled = true;

    try {
      const response = await fetch(`/api/dashboard/wtb-counter-offers/${offerId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_record_id: dashboardSeller.id })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to delete offer");
      }

      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      wtbCancelOfferButton.disabled = false;
    }

    return;
  }

  if (buyingDeleteButton) {
    await handleCancelBuyingWtb(buyingDeleteButton);
    return;
  }

  if (buyingAcceptOfferButton) {
    buyingAcceptOfferButton.disabled = true;
    buyingAcceptOfferButton.textContent = "Accepting...";
  
    try {
      const response = await fetch("/api/dashboard/buying/accept-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_wtb_record_id: buyingAcceptOfferButton.dataset.buyingAcceptOfferId
        })
      });
  
      const data = await response.json();
  
      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to accept offer");
      }
  
      showAlert("Offer accepted. We are now waiting for the seller to process the deal.");
  
      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
      buyingAcceptOfferButton.disabled = false;
      buyingAcceptOfferButton.textContent = "Accept";
    }
  
    return;
  }
  
  if (buyingDenyOfferButton) {
    buyingDenyOfferButton.disabled = true;
    buyingDenyOfferButton.textContent = "Denying...";
  
    try {
      const response = await fetch("/api/dashboard/buying/deny-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          member_wtb_record_id: buyingDenyOfferButton.dataset.buyingDenyOfferId
        })
      });
  
      const data = await response.json();
  
      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to deny offer");
      }

      showAlert("Offer declined.");
  
      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      showAlert(err.message);
    } finally {
      buyingDenyOfferButton.disabled = false;
    }
  
    return;
  }
});

document.querySelectorAll("[data-edit-offer-close]").forEach((button) => {
  button.addEventListener("click", closeEditOfferModal);
});

document.querySelectorAll("[data-consignment-add-close]").forEach((button) => {
  button.addEventListener("click", closeConsignmentAddStockModal);
});

document.querySelectorAll("[data-consignment-csv-close]").forEach((button) => {
  button.addEventListener("click", closeConsignmentCsvModal);
});

document.querySelectorAll("[data-consignment-edit-close]").forEach((button) => {
  button.addEventListener("click", closeConsignmentEditStockModal);
});

consignmentCsvDuplicateBackBtn?.addEventListener("click", () => {
  closeConsignmentCsvDuplicateModal();
});

document.querySelectorAll("[data-issue-close]").forEach((button) => {
  button.addEventListener("click", closeIssueModal);
});

document.querySelectorAll("[data-view-issue-close]").forEach((button) => {
  button.addEventListener("click", closeViewIssueModal);
});

document.querySelectorAll("[data-label-instructions-close]").forEach((button) => {
  button.addEventListener("click", () => {
    labelInstructionsModal?.classList.add("hidden");
    pendingLabelUrl = "";
  });
});

confirmLabelDownloadBtn?.addEventListener("click", () => {
  if (!pendingLabelUrl) return;

  window.open(pendingLabelUrl, "_blank", "noopener");

  labelInstructionsModal?.classList.add("hidden");
  pendingLabelUrl = "";
});

editOfferForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  editOfferError.textContent = "";

  const orderRecordId = editOfferOrderRecordId.value;
  const vatType = editOfferVatType.value;
  const cleanOffer = Number(editOfferAmount.value);

  if (!Number.isInteger(cleanOffer) || cleanOffer <= 0) {
    editOfferError.textContent = "Please enter a valid whole number.";
    return;
  }

  const submitBtn = editOfferForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving...";

  try {
    const offerId = editOfferForm.dataset.offerId || "";
    const memberWtbRecordId = editOfferForm.dataset.memberWtbRecordId || "";
    
    const endpoint = memberWtbRecordId
      ? `/api/dashboard/wtb-open-offers/${offerId}/edit`
      : "/api/place-offer";
    
    const body = memberWtbRecordId
      ? {
          seller_record_id: dashboardSeller.id,
          offer_amount: cleanOffer,
          vat_type: vatType
        }
      : {
          orderRecordId,
          sellerRecordId: dashboardSeller.id,
          offerAmount: cleanOffer,
          vatType
        };
    
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to update offer");
    }

    closeEditOfferModal();

    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    editOfferError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Offer";
  }
});

consignmentAddSizeRowBtn?.addEventListener("click", () => {
  const previousRow = [...consignmentSizeRows.querySelectorAll(".consignment-size-row")].at(-1);
  const previousPrice = previousRow?.querySelector(".consignment-price-input")?.value || "";

  const newRow = createConsignmentSizeRow();

  const priceInput = newRow.querySelector(".consignment-price-input");
  if (priceInput) {
    priceInput.value = previousPrice;
  }

  consignmentSizeRows.appendChild(newRow);

  newRow.querySelector(".consignment-size-input")?.focus();
});

consignmentSizeRows?.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".consignment-remove-size-btn");

  if (!removeButton) return;

  if (consignmentSizeRows.querySelectorAll(".consignment-size-row").length <= 1) {
    return;
  }
  
  removeButton.closest(".consignment-size-row")?.remove();
});

consignmentAddStockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  consignmentAddStockError.textContent = "";

  const submitter = event.submitter;
  const submitBtn = submitter || consignmentAddStockForm.querySelector('button[type="submit"]');

  submitBtn.disabled = true;
  submitBtn.textContent = "Adding...";

  try {
    await submitConsignmentStockRows();

    closeConsignmentAddStockModal();

    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    consignmentAddStockError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent =
      submitBtn === consignmentAddAnotherProductBtn
        ? "+ Add another product"
        : "Confirm";
  }
});

consignmentAddAnotherProductBtn?.addEventListener("click", async () => {
  consignmentAddStockError.textContent = "";

  consignmentAddAnotherProductBtn.disabled = true;
  consignmentAddAnotherProductBtn.textContent = "Adding...";

  try {
    await submitConsignmentStockRows();

    resetConsignmentAddStockForm();
    consignmentAddStockSuccess.textContent = "Previous product added successfully.";
    setTimeout(() => {
      consignmentAddStockSuccess.textContent = "";
    }, 2500);
    await loadDashboardData();
    await loadDashboardCounts();

    consignmentSkuInput.focus();
  } catch (err) {
    consignmentAddStockError.textContent = err.message;
  } finally {
    consignmentAddAnotherProductBtn.disabled = false;
    consignmentAddAnotherProductBtn.textContent = "+ Add another product";
  }
});

consignmentEditStockForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  consignmentEditStockError.textContent = "";

  const inventoryId = consignmentEditStockId.value;
  const sellingPrice = cleanWholeNumberInput(consignmentEditSellingPriceInput.value);
  const quantity = cleanWholeNumberInput(consignmentEditQuantityInput.value);

  consignmentEditSellingPriceInput.value = sellingPrice;
  consignmentEditQuantityInput.value = quantity;

  const submitBtn = consignmentEditStockForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving...";

  try {
    const response = await fetch(`/api/consignment/inventory/${inventoryId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        selling_price_suggested: sellingPrice,
        quantity
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to update stock");
    }

    closeConsignmentEditStockModal();

    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    consignmentEditStockError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save";
  }
});

consignmentCsvForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  consignmentCsvPreview.textContent = "";
  consignmentCsvError.textContent = "";

  consignmentCsvMode.value =
    document.querySelector('input[name="consignmentCsvModeChoice"]:checked')?.value || "add";

  const file = consignmentCsvFileInput.files?.[0];

  if (!file) {
    consignmentCsvError.textContent = "Please choose a CSV file.";
    return;
  }

  try {
    const text = await file.text();
    const result = parseConsignmentCsv(text);

    const duplicates = getDuplicateCsvSkuSizeRows(result.rows);
    
    if (duplicates.length) {
      openConsignmentCsvDuplicateModal(duplicates);
      return;
    }

    if (result.errors.length) {
      consignmentCsvError.innerHTML = result.errors
        .slice(0, 12)
        .map((error) => `<div>${escapeHtml(error)}</div>`)
        .join("");

      return;
    }

    const endpoint =
      consignmentCsvMode.value === "replace"
        ? "/api/consignment/inventory/csv-replace"
        : "/api/consignment/inventory/csv-add";
    
    const submitBtn = consignmentCsvForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    consignmentCsvFileInput.disabled = true;
    consignmentCsvPreview.textContent =
      `Uploading ${result.rows.length} rows. Large uploads may take several minutes. Please do not close this page or upload the file again.`;
    submitBtn.textContent = "Uploading...";
    
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          seller_record_id: dashboardSeller.id,
          seller_id: dashboardSeller.seller_id,
          rows: result.rows
        })
      });
    
      const data = await response.json();
    
      if (!response.ok) {
        if (response.status === 409 && data.job) {
          closeConsignmentCsvModal();
          await loadCsvImportStatus();
          startCsvImportStatusPolling();
          return;
        }
      
        throw new Error(data.details || data.message || data.error || "Failed to upload CSV");
      }
          
      consignmentCsvPreview.textContent =
        data.message ||
        (
          consignmentCsvMode.value === "replace"
            ? `${data.count || result.rows.length} rows received. Replacement processing has started.`
            : `${data.count || result.rows.length} rows received. Processing has started.`
        );
      
      await loadCsvImportStatus();
      startCsvImportStatusPolling();
      
      setTimeout(() => {
        closeConsignmentCsvModal();
      }, 2500);
    } finally {
      submitBtn.disabled = false;
      consignmentCsvFileInput.disabled = false;
      submitBtn.textContent = "Upload";
    }
  } catch (err) {
    consignmentCsvError.textContent = err.message;
  }
});

issueForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  issueError.textContent = "";

  const inventoryId = issueInventoryId.value;
  const cleanNotes = issueNotes.value.trim();

  if (!cleanNotes) {
    issueError.textContent = "Please describe the issue.";
    return;
  }

  const submitBtn = issueForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting...";

  try {
    const response = await fetch(
      `/api/dashboard/history/${inventoryId}/issue`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          seller_record_id: dashboardSeller.id,
          issue_notes: cleanNotes
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to report issue");
    }

    closeIssueModal();

    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    issueError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Issue";
  }
});

dashboardLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  dashboardLoginError.textContent = "";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: dashboardLoginEmail.value,
        password: dashboardLoginPassword.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Login failed");
    }

    dashboardSeller = data.seller;
    localStorage.setItem("kc_seller", JSON.stringify(dashboardSeller));

    dashboardLoginEmail.value = "";
    dashboardLoginPassword.value = "";
    
    const afterLoginRedirect = localStorage.getItem("kc_after_login_redirect");
    
    if (afterLoginRedirect) {
      localStorage.removeItem("kc_after_login_redirect");
      window.location.href = afterLoginRedirect;
      return;
    }
    
    syncAuthUi();

    // FIXED - dit ontbrak, en daardoor deed de popup precies niets voor de
    // persoon die hem het hardst nodig heeft: wie NET inlogt.
    //
    // De controle hing alleen aan de sessie-hervalidatie, en die begint met
    // "geen seller in localStorage? dan klaar". Bij een verse login is dat
    // op het moment van laden nog zo, dus die keerde meteen om en er werd
    // nooit gekeken. Pas bij de volgende pagina-lading verscheen de popup.
    //
    // Het antwoord van de login draagt discord_id en discord_in_server al
    // met zich mee, dus er is hier geen extra verzoek voor nodig.
    window.kcDiscordGate?.schedule(data.seller);
  } catch (err) {
    dashboardLoginError.textContent = err.message;
  }
});

dashboardForgotPasswordBtn.addEventListener("click", async () => {
  dashboardLoginError.textContent = "";
  dashboardLoginError.style.color = "#ff7b7b";

  const email = dashboardLoginEmail.value.trim();

  if (!email) {
    dashboardLoginError.textContent = "Enter your email first.";
    return;
  }

  dashboardForgotPasswordBtn.disabled = true;
  dashboardForgotPasswordBtn.textContent = "Sending...";

  try {
    const response = await fetch("/api/forgot-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || "Failed to send reset email");
    }

    dashboardLoginError.style.color = "#58d86a";
    dashboardLoginError.textContent = "If this email exists, a password link has been sent.";
  } catch (err) {
    dashboardLoginError.style.color = "#ff7b7b";
    dashboardLoginError.textContent = err.message;
  } finally {
    dashboardForgotPasswordBtn.disabled = false;
    dashboardForgotPasswordBtn.textContent = "First time login or forgot password?";
  }
});

dashboardLogoutBtn.addEventListener("click", async () => {
  // De sessiecookie is httpOnly, dus alleen de server kan hem wissen.
  // Zonder deze call bleef de seller server-side ingelogd.
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (err) {
    console.error("Logout call failed:", err);
  }

  localStorage.removeItem("kc_seller");
  dashboardSeller = null;
  syncAuthUi();
});

dashboardRefreshBtn.addEventListener("click", async () => {
  renderTableShell();

  try {
    await loadDashboardData();
    await loadDashboardCounts();
  } catch (err) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${skeletonColumns.length}">
          <div class="dashboard-empty-state">
            <strong>${escapeHtml(err.message)}</strong>
          </div>
        </td>
      </tr>
    `;
  }
});

// CHANGED — this refetched the whole list on every keystroke and then
// filtered on nothing, so you always got everything back. Filtering can
// happen on the rows already there, which also saves a request per
// keystroke.
dashboardSearchInput.addEventListener("input", () => {
  filterVisibleRows();
});

// NEW — a cross to clear the search field in one go. Built here rather than
// in the HTML, so no extra file has to ship.
(function () {
  const veld = dashboardSearchInput;
  const rowEl = veld && veld.closest(".dashboard-search-wrap");
  if (!veld || !rowEl) return;

  const btnEl = document.createElement("button");
  btnEl.type = "button";
  btnEl.className = "search-clear";
  btnEl.setAttribute("aria-label", "Clear search");
  btnEl.textContent = "\u00d7";
  rowEl.appendChild(btnEl);

  function syncClearButton() {
    rowEl.classList.toggle("has-text", !!veld.value);
  }

  btnEl.addEventListener("click", () => {
    veld.value = "";
    syncClearButton();
    filterVisibleRows();
    veld.focus();
  });

  veld.addEventListener("input", syncClearButton);
  syncClearButton();
})();


document.addEventListener(
  "click",
  async (event) => {
    const payButton = event.target.closest(
      "[data-member-wtb-pay-id]"
    );

    if (!payButton) return;

    if (payButton.dataset.processing === "true") {
      return;
    }

    const memberWtbRecordId =
      payButton.dataset.memberWtbPayId;

    if (
      !memberWtbRecordId ||
      !dashboardSeller?.id
    ) {
      showDashboardToast(
        "Payment could not be opened.",
        "error"
      );

      return;
    }

    payButton.dataset.processing = "true";
    payButton.disabled = true;

    const originalText =
      payButton.textContent;

    payButton.textContent = "Opening...";

    try {
      const response = await fetch(
        "/api/dashboard/buying/payment-link",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            member_wtb_record_id:
              memberWtbRecordId,
            buyer_record_id:
              dashboardSeller.id
          })
        }
      );

      const data = await response
        .json()
        .catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Payment could not be opened"
        );
      }

      if (!data.payment_url) {
        throw new Error(
          "No Mollie payment link was returned"
        );
      }

      window.location.href = data.payment_url;
    } catch (err) {
      showDashboardToast(
        err.message,
        "error"
      );

      payButton.dataset.processing = "false";
      payButton.disabled = false;
      payButton.textContent = originalText;
    }
  }
);

renderSubnav();
bindNavigation();
bindConsignmentInputCleaning();
syncDashboardUi();
syncAuthUi();

if (dashboardSeller) {
  loadDashboardCounts().catch(console.error);
}

function showDashboardToast(message, type = "success") {
  document.querySelector(".dashboard-toast")?.remove();

  const toast = document.createElement("div");
  toast.className = `dashboard-toast ${type}`;

  toast.innerHTML = `
    <div class="dashboard-toast-icon">${type === "success" ? "✓" : "!"}</div>
    <div class="dashboard-toast-text">${escapeHtml(message)}</div>
  `;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 250);
  }, 2600);
}
/* Discord verplicht - het venster en de logica staan in
 * public/discord-gate.js, gedeeld met de home page. Hier alleen de twee
 * momenten waarop we weten wie er kijkt. */

// Sessie-revalidatie. localStorage ("kc_seller") overleeft het verlopen of
// wissen van de sessiecookie, waardoor de UI ingelogd bleef lijken terwijl elke
// schrijfactie een 401 kreeg. Deze check brengt beide weer in lijn.
(async () => {
  if (!dashboardSeller) return;

  try {
    const response = await fetch("/api/session");

    if (response.status === 401) {
      localStorage.removeItem("kc_seller");
      dashboardSeller = null;
      syncAuthUi();
      return;
    }

    if (!response.ok) return;

    const data = await response.json();

    if (data?.seller) {
      dashboardSeller = data.seller;
      localStorage.setItem("kc_seller", JSON.stringify(dashboardSeller));
      syncAuthUi();

      // Bewust op wat /api/session zojuist teruggaf, niet op localStorage.
      // Wie na het inloggen uit de server stapt staat daar nog als lid in.
      window.kcDiscordGate?.schedule(data.seller);
    }
  } catch (err) {
    // Netwerkfout: laat de bestaande staat met rust.
  }
})();

// De Discord-koppeling stuurt de seller hier terug met ?discord of
// ?discord_error. Zonder deze melding landt hij op een dashboard dat er
// precies hetzelfde uitziet als daarvoor en weet hij niet of het gelukt is.
(() => {
  const discordParams = new URLSearchParams(window.location.search);
  const discordOk = discordParams.get("discord");
  const discordFout = discordParams.get("discord_error");

  if (!discordOk && !discordFout) return;

  const DISCORD_FOUTEN = {
    cancelled: "You cancelled the Discord link. You can try again whenever you want.",
    invalid_state: "That link expired. Start the Discord link again from your dashboard.",
    not_configured: "Discord linking is not configured yet. Please contact support.",
    bot_missing_permission:
      "We could not add you to the server. Please contact support — this is on our side, not yours.",
    seller_has_other_discord:
      "Your profile is already linked to a different Discord account. Contact support if that is wrong.",
    failed: "Something went wrong while linking Discord. Please try again."
  };

  let bericht;
  let geslaagd = false;

  if (discordOk === "linked") {
    bericht = "Discord linked. You have been added to the Kickz Caviar server.";
    geslaagd = true;
  } else if (discordOk === "already_member") {
    bericht = "Discord linked. You were already in the server.";
    geslaagd = true;
  } else if (discordFout === "already_linked") {
    // Het Seller ID erbij, zodat de seller weet met welk profiel hij moet
    // inloggen in plaats van alleen te horen dát het misging.
    const bestaandSellerId = discordParams.get("seller_id");

    bericht = bestaandSellerId
      ? "That Discord account is already linked to seller " + bestaandSellerId +
        ". Log in with that profile instead — you do not need a second one."
      : "That Discord account is already linked to another seller profile. Log in with that profile instead.";
  } else {
    bericht = DISCORD_FOUTEN[discordFout] || "Something went wrong while linking Discord.";
  }

  const balk = document.createElement("div");
  balk.className = "discord-banner " + (geslaagd ? "is-ok" : "is-off");
  balk.textContent = bericht;

  const sluit = document.createElement("button");
  sluit.type = "button";
  sluit.className = "discord-banner-close";
  sluit.setAttribute("aria-label", "Dismiss");
  sluit.textContent = "×";
  sluit.addEventListener("click", () => balk.remove());
  balk.appendChild(sluit);

  document.body.prepend(balk);

  // De parameters uit de URL halen, anders komt de melding bij elke refresh
  // terug alsof er opnieuw iets gebeurd is.
  for (const key of ["discord", "discord_error", "seller_id"]) discordParams.delete(key);

  const rest = discordParams.toString();
  window.history.replaceState({}, "", window.location.pathname + (rest ? "?" + rest : ""));
})();
