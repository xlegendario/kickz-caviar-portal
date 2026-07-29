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
      { key: "offers", label: "Offers" },
      { key: "accepted", label: "Accepted" },
      { key: "payment_required", label: "Payment Required" },
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
  "Order ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Payout",
  "VAT Type",
  "Date",
  "Action"
];

const consignmentInventoryColumns = [
  "Product",
  "SKU",
  "Size",
  "Brand",
  "VAT Type",
  "Selling Price",
  "Lowest Price",
  "Quantity",
  "Action"
];

const consignmentOfferColumns = [
  "Order ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
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

      const showWarning =
        section === "buying" &&
        tab.key === "delivered" &&
        Number(dashboardCountsCache?.buying?.delivered_payment_warning || 0) > 0;

      return `
        <button class="dashboard-subnav-btn" type="button" data-section="${section}" data-tab="${tab.key}">
          <span>${tab.label}</span>
          <span class="dashboard-subnav-meta">
            ${showWarning ? `<span class="dashboard-subnav-warning">⚠</span>` : ""}
            <span class="dashboard-subnav-count" data-count-key="${section}:${tab.key}">${count}</span>
          </span>
        </button>
      `;
    }).join("");
  });
}

function bindNavigation() {
    dashboardMobileMenuBtn?.addEventListener("click", () => {
    dashboardSidebar?.classList.add("open");
    dashboardSidebarBackdrop?.classList.add("open");
  });

  dashboardSidebarBackdrop?.addEventListener("click", () => {
    dashboardSidebar?.classList.remove("open");
    dashboardSidebarBackdrop?.classList.remove("open");
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
  
      dashboardSidebar?.classList.remove("open");
      dashboardSidebarBackdrop?.classList.remove("open");
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
  
    button.classList.toggle("open", isActiveSection);
    subnav?.classList.toggle("open", isActiveSection);
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

function setConsignmentCount(key, value) {
  const count = Number(value || 0);

  dashboardCountsCache.consignment = {
    ...(dashboardCountsCache.consignment || {}),
    [key]: count
  };

  document.querySelectorAll(`[data-count-key="consignment:${key}"]`)
    .forEach((el) => {
      el.textContent = count;
    });

  const total = Object.values(dashboardCountsCache.consignment || {})
    .reduce((sum, item) => sum + Number(item || 0), 0);

  document.querySelectorAll('[data-count-group="consignment"]')
    .forEach((el) => {
      el.textContent = total;
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

      dashboardSidebar?.classList.remove("open");
      dashboardSidebarBackdrop?.classList.remove("open");
    });
  });

  Object.entries(dashboardCountsCache).forEach(([section, counts]) => {
    const total = Object.entries(counts || {})
      .filter(([key]) => key !== "delivered_payment_warning")
      .reduce((sum, [, value]) => sum + Number(value || 0), 0);

    document.querySelectorAll(`[data-count-group="${section}"]`)
      .forEach((el) => {
        el.textContent = total;
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
  return window.innerWidth <= 768;
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

const buyingOpenWtbColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Max Price",
  "Current Lowest",
  "Status",
  "Date",
  "Action"
];

const buyingOffersColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Max Price",
  "Offer",
  "Status",
  "Date",
  "Action"
];

const buyingAcceptedColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Offer",
  "Status",
  "Date"
];

const buyingPaymentRequiredColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Amount",
  "Status",
  "Date",
  "Action"
];

const wtbAcceptedColumns = [
  "Order ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Payout",
  "VAT Type",
  "Date",
  "Status"
];

const buyingConfirmedColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Amount",
  "Payment",
  "Status",
  "Date",
  "Action"
];

const buyingLabelRequestedColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Amount",
  "Status",
  "Date",
  "Action"
];

const buyingReadyToShipColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Amount",
  "Tracking",
  "Status",
  "Date",
  "Action"
];

const buyingShippedColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Amount",
  "Status",
  "Date",
  "Action"
];

const buyingDeliveredColumns = [
  "WTB ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Amount",
  "Status",
  "Date",
  "Action"
];

function renderConsignmentInventoryRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = consignmentInventoryColumns
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.product_name || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${item.selling_price_suggested ? `€${escapeHtml(item.selling_price_suggested)}` : "-"}</td>
      <td>${item.lowest_suggested_price ? `€${escapeHtml(item.lowest_suggested_price)}` : "-"}</td>
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
    const deniedColumns = ["Order ID", "Product", "SKU", "Size", "Brand", "Your Offer", "Denied", "Actions"];

    dashboardTableHead.innerHTML = deniedColumns.map((c) => `<th>${c}</th>`).join("");

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
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${escapeHtml(item.product_name || "-")}</td>
          <td>${escapeHtml(item.sku || "-")}</td>
          <td>${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.brand || "-")}</td>
          <td>${item.consignor_counter_price ? `€${escapeHtml(item.consignor_counter_price)}` : (item.seller_price ? `€${escapeHtml(item.seller_price)}` : "-")}</td>
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
    const counterColumns = ["Order ID", "Product", "SKU", "Size", "Brand", "Your Offer", "Buyer's Last Offer", "Date", "Actions"];

    dashboardTableHead.innerHTML = counterColumns.map((c) => `<th>${c}</th>`).join("");

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
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${escapeHtml(item.product_name || "-")}</td>
          <td>${escapeHtml(item.sku || "-")}</td>
          <td>${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.brand || "-")}</td>
          <td>${item.consignor_counter_price ? `€${escapeHtml(item.consignor_counter_price)}` : (item.seller_price ? `€${escapeHtml(item.seller_price)}` : "-")}</td>
          <td>${item.previous_store_price ? `€${escapeHtml(item.previous_store_price)}` : "-"}</td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product_name || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${item.seller_price ? `€${escapeHtml(item.seller_price)}` : "-"}</td>
      <td>${item.offer_price ? `€${escapeHtml(item.offer_price)}` : "-"}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>${item.created_at ? escapeHtml(new Date(item.created_at).toLocaleDateString("en-GB")) : "-"}</td>
      <td>
        <div class="dashboard-action-row">
          <button
            class="dashboard-confirm-btn"
            type="button"
            data-consignment-confirm-offer-id="${escapeHtml(item.id || "")}"
          >
            Accept
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.offer || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-offer">Waiting for seller</span></td>
      <td>${escapeHtml(item.date || "-")}</td>
    </tr>
  `).join("");
}

function renderBuyingOpenWtbRows(items) {
  dashboardTableBody.closest(".dashboard-table")?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = buyingOpenWtbColumns
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.max_price || "-")}</td>
      <td>${escapeHtml(item.current_lowest || "-")}</td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.max_price || "-")}</td>
      <td>${escapeHtml(item.offer || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-offer">Offer Received</span></td>
      <td>${escapeHtml(item.date || "-")}</td>
      <td>
        <div class="dashboard-action-row">
          <button class="dashboard-confirm-btn" type="button" data-buying-accept-offer-id="${escapeHtml(item.member_wtb_record_id || "")}">
            Accept
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.amount || "-")}</td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.amount || "-")}</td>
      <td>${escapeHtml(item.payment_status || "-")}</td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.amount || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-payment">Waiting for Label</span></td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.amount || "-")}</td>
      <td>${escapeHtml(item.tracking_number || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-open">Ready to Ship</span></td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.amount || "-")}</td>
      <td><span class="dashboard-status-pill dashboard-status-open">Shipped</span></td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.amount || "-")}</td>
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
    .map((column) => `<th>${column === "Status" ? "Action" : column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.offer || "-")}</td>
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
  "Order ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Offer",
  "VAT Type",
  "Current Lowest",
  "Date",
  "Action"
];

const wtbCounterOfferColumns = [
  "Order ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
  "Original Offer",
  "Counter Payout",
  "VAT Type",
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(offer.order_id || "-")}</td>
      <td>${escapeHtml(offer.product || "-")}</td>
      <td>${escapeHtml(offer.sku || "-")}</td>
      <td>${escapeHtml(offer.size || "-")}</td>
      <td>${escapeHtml(offer.brand || "-")}</td>
      <td>${escapeHtml(offer.offer || "-")}</td>
      <td>${escapeHtml(offer.vat_type || "-")}</td>
      <td>${escapeHtml(offer.current_lowest || "-")}</td>
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
function renderWtbUnifiedOfferRows(items) {
  setMobileTableMode(false);

  const isDenied = activeOfferStatusFilter === "denied";
  const columns = isDenied
    ? ["Order ID", "Product", "SKU", "Size", "Brand", "Your Offer", "Denied", "Actions"]
    : ["", "Order ID", "Product", "SKU", "Size", "Brand", "Your Offer", (activeOfferStatusFilter === "counter" ? "Counter Offer" : "Buyer's Last Offer"), "VAT Type", "Current Lowest", "Date", "Actions"];

  dashboardTableHead.innerHTML = columns.map((c) => `<th>${c}</th>`).join("");

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
      return `
        <tr>
          <td>${escapeHtml(item.order_id || "-")}</td>
          <td>${escapeHtml(item.product || "-")}</td>
          <td>${escapeHtml(item.sku || "-")}</td>
          <td>${escapeHtml(item.size || "-")}</td>
          <td>${escapeHtml(item.brand || "-")}</td>
          <td>${escapeHtml(amount || "-")}</td>
          <td>${dateValue ? escapeHtml(new Date(dateValue).toLocaleDateString("en-GB")) : "-"}</td>
          <td>
            <div class="dashboard-action-row">
              <button class="dashboard-deny-btn" type="button" data-wtb-cancel-offer-id="${escapeHtml(item.id || "")}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }

    // The dot indicator and Current Lowest column now apply to BOTH
    // "fresh" AND "own_counter" items — the backend computes the same
    // same-VAT-scale comparison for both, so a seller mid-counter can
    // still see if someone else has undercut them in the meantime.
    const hasLowestData = item._kind === "fresh" || item._kind === "own_counter";
    const dotCell = hasLowestData
      ? `<div class="dashboard-status-dot ${item.status === "Lowest" ? "dashboard-status-dot-lowest" : "dashboard-status-dot-beaten"}"></div>`
      : "";

    const currentLowestCell = hasLowestData ? (item.current_lowest || "-") : "-";
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
      // Edit for an already-placed counter isn't wired up yet (needs
      // its own investigation into the Store Orders counter-edit
      // flow). Accept-Previous and Delete are available now.
      actionsCell = `
        ${item.previous_record_id ? `
          <button class="dashboard-confirm-btn" type="button" data-wtb-accept-previous-id="${escapeHtml(item.id || "")}">${item.previous_store_price ? `Accept ${escapeHtml(item.previous_store_price)}` : "Accept Previous"}</button>
        ` : ""}
        <button class="dashboard-deny-btn" type="button" data-wtb-cancel-counter-id="${escapeHtml(item.id || "")}">Delete</button>
      `;
    } else {
      // "counter" — store/buyer just moved, seller must respond.
      // Real Accept/Counter/Deny actions for this aren't wired up yet.
      actionsCell = `<span class="dashboard-status-pill">Awaiting you</span>`;
    }

    return `
      <tr>
        <td>${dotCell}</td>
        <td>${escapeHtml(item.order_id || "-")}</td>
        <td>${escapeHtml(item.product || "-")}</td>
        <td>${escapeHtml(item.sku || "-")}</td>
        <td>${escapeHtml(item.size || "-")}</td>
        <td>${escapeHtml(item.brand || "-")}</td>
        <td>${escapeHtml(amount || "-")}</td>
        <td>${escapeHtml(buyersLastOfferCell)}</td>
        <td>${escapeHtml(item.vat_type || "-")}</td>
        <td>${escapeHtml(currentLowestCell)}</td>
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

function renderWtbCounterOfferRows(items) {
  dashboardTableHead.innerHTML = wtbCounterOfferColumns
    .map((column) => `<th>${column}</th>`)
    .join("");

  if (!items.length) {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${wtbCounterOfferColumns.length}">
          <div class="dashboard-empty-state">
            <div class="dashboard-empty-icon">◇</div>
            <strong>No counter offers yet</strong>
            <span>Counter offers from stores will appear here.</span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  dashboardTableBody.innerHTML = items.map((item) => `
    <tr>
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.original_offer || "-")}</td>
      <td>${escapeHtml(item.counter_payout || "-")}</td>
      <td>${escapeHtml(item.vat_type || "-")}</td>
      <td>
        <div class="dashboard-table-actions">
          <button
            class="dashboard-action-btn accept"
            type="button"
            data-counter-offer-accept-id="${escapeHtml(item.id)}"
          >
            Accept
          </button>

          <button
            class="dashboard-action-btn danger"
            type="button"
            data-counter-offer-deny-id="${escapeHtml(item.id)}"
          >
            Deny
          </button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderReadyToShipRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = skeletonColumns
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.payout || "-")}</td>
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.payout || "-")}</td>
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
  "Order ID",
  "Product",
  "SKU",
  "Size",
  "Brand",
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(item.order_id || "-")}</td>
      <td>${escapeHtml(item.product || "-")}</td>
      <td>${escapeHtml(item.sku || "-")}</td>
      <td>${escapeHtml(item.size || "-")}</td>
      <td>${escapeHtml(item.brand || "-")}</td>
      <td>${escapeHtml(item.payout || "-")}</td>
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
      .map((column) => `<th>${column}</th>`)
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
    .map((column) => `<th>${column}</th>`)
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
      <td>${escapeHtml(claim.order_id || "-")}</td>
      <td>${escapeHtml(claim.product || "-")}</td>
      <td>${escapeHtml(claim.sku || "-")}</td>
      <td>${escapeHtml(claim.size || "-")}</td>
      <td>${escapeHtml(claim.brand || "-")}</td>
      <td>${escapeHtml(claim.payout || "-")}</td>
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

  if (job.status === "completed") {
    el.textContent = `✅ Import completed`;
    el.classList.add("completed");
  
    csvImportCompletedHideTimer = setTimeout(() => {
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

  if (activeSection === "buying" && activeTab === "offers") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${buyingOffersColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading offers...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/buying-offers?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying offers");
    }
  
    renderBuyingOfferRows(data.items || []);
  
    dashboardCountsCache.buying.offers = data.count || 0;
  
    document
      .querySelectorAll('[data-count-key="buying:offers"]')
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

  if (activeSection === "consignment" && activeTab === "offers") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${consignmentOfferColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading consignment offers...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      filter: activeOfferStatusFilter
    });
  
    const response = await fetch(
      `/api/consignment/offers?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load consignment offers"
      );
    }
  
    renderConsignmentOfferRows(data.items || []);
  
    // FIXED — must NOT write into dashboardCountsCache.consignment
    // directly: that object gets summed for the sidebar's total badge
    // (see setConsignmentCount), so adding offers_counter/offers_denied
    // keys there would inflate that total. Pill counts live in their
    // own cache instead; the legacy "offers" key (sidebar total, via
    // setConsignmentCount) only updates from the Open count, same as
    // before this pill row existed.
    dashboardPillCountsCache["consignment:offers"] = {
      ...(dashboardPillCountsCache["consignment:offers"] || {}),
      [activeOfferStatusFilter]: data.count || 0
    };

    if (activeOfferStatusFilter === "open") {
      setConsignmentCount("offers", data.count || 0);
    }

    document
      .querySelectorAll(`[data-pill-count-key="consignment:offers:${activeOfferStatusFilter}"]`)
      .forEach((el) => {
        el.textContent = data.count || 0;
      });
  
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
  
    if (activeTab === "ready_to_ship") {
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
  
  if (activeSection === "consignment") {
    renderTableShell();
    return;
  }

  if (activeSection === "wtb" && activeTab === "offers") {
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
          seller_id: dashboardSeller.seller_id
        }).toString()}`),
        fetch(`/api/dashboard/wtb-counter-offers?${new URLSearchParams({
          seller_record_id: dashboardSeller.id,
          filter: "open"
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

      renderWtbUnifiedOfferRows(merged);

      const count = merged.length;
      dashboardPillCountsCache["wtb:offers"] = {
        ...(dashboardPillCountsCache["wtb:offers"] || {}),
        open: count
      };
      document
        .querySelectorAll('[data-pill-count-key="wtb:offers:open"]')
        .forEach((el) => { el.textContent = count; });

      return;
    }

    // "counter" (displayed as "Countered") and "denied" both come from
    // the same Counter Offers query, just filtered differently.
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id,
      filter: activeOfferStatusFilter === "denied" ? "denied" : "countered"
    });

    const response = await fetch(`/api/dashboard/wtb-counter-offers?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load offers");
    }

    renderWtbUnifiedOfferRows(
      (data.items || []).map((item) => ({ ...item, _kind: activeOfferStatusFilter === "denied" ? "denied" : "counter" }))
    );

    const count = data.count || 0;
    dashboardPillCountsCache["wtb:offers"] = {
      ...(dashboardPillCountsCache["wtb:offers"] || {}),
      [activeOfferStatusFilter]: count
    };
    document
      .querySelectorAll(`[data-pill-count-key="wtb:offers:${activeOfferStatusFilter}"]`)
      .forEach((el) => { el.textContent = count; });

    return;
  }

  if (activeSection === "wtb" && activeTab === "counter_offers") {
    dashboardTableBody.innerHTML = `
      <tr>
        <td colspan="${wtbCounterOfferColumns.length}">
          <div class="dashboard-empty-state">
            <strong>Loading counter offers...</strong>
          </div>
        </td>
      </tr>
    `;
  
    const params = new URLSearchParams({
      seller_record_id: dashboardSeller.id
    });
  
    const response = await fetch(
      `/api/dashboard/wtb-counter-offers?${params.toString()}`
    );
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(
        data.details ||
        data.error ||
        "Failed to load counter offers"
      );
    }
  
    renderWtbCounterOfferRows(data.items || []);
  
    const countEl = document.querySelector(
      '[data-count-key="wtb:counter_offers"]'
    );
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }
  
    dashboardCountsCache.wtb.counter_offers = data.count || 0;
    renderStats();
  
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
  
    if (countEl) {
      countEl.textContent = data.count || 0;
    }

    document.querySelectorAll('[data-count-group="history"]')
    .forEach((el) => {
      el.textContent = data.count || 0;
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
  dashboardTableHead.innerHTML = skeletonColumns.map((column) => `<th>${column}</th>`).join("");
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

function openConsignmentAddStockModal() {
  consignmentAddStockError.textContent = "";
  consignmentAddStockSuccess.textContent = "";
  resetConsignmentAddStockForm();
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

  const confirmed = window.confirm(
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
    alert(err.message);
  } finally {
    button.disabled = false;
  }
}

async function handleCancelBuyingWtb(button) {
  const memberWtbRecordId = button.dataset.buyingDeleteWtbId;

  const confirmed = window.confirm(
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
    alert(err.message);
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
    const counterAcceptButton = event.target.closest("[data-counter-offer-accept-id]");

    if (counterAcceptButton) {
      const counterOfferId = counterAcceptButton.dataset.counterOfferAcceptId;
    
      counterAcceptButton.disabled = true;
      counterAcceptButton.textContent = "Accepting...";
    
      try {
        const response = await fetch(`/api/dashboard/wtb-counter-offers/${counterOfferId}/accept`, {
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
          throw new Error(data.details || data.error || "Failed to accept counter offer");
        }
    
        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        alert(err.message);
      } finally {
        counterAcceptButton.disabled = false;
        counterAcceptButton.textContent = "Accept";
      }
    
      return;
    }
    
    const counterDenyButton = event.target.closest("[data-counter-offer-deny-id]");
    
    if (counterDenyButton) {
      const counterOfferId = counterDenyButton.dataset.counterOfferDenyId;
    
      counterDenyButton.disabled = true;
    
      try {
        const response = await fetch(`/api/dashboard/wtb-counter-offers/${counterOfferId}/deny`, {
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
          throw new Error(data.details || data.error || "Failed to deny counter offer");
        }
    
        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        alert(err.message);
      } finally {
        counterDenyButton.disabled = false;
      }
    
      return;
    }

    const consignmentCounterOfferButton = event.target.closest("[data-consignment-counter-offer-id]");

    if (consignmentCounterOfferButton) {
      const offerId = consignmentCounterOfferButton.dataset.consignmentCounterOfferId;
      // FIXED — this always called /counter, even when responding to a
      // store's counter-back (is_counter_offer=true on the item),
      // which needs /consignor-counter instead (a different endpoint
      // that creates a new chained round rather than updating round 1
      // in place).
      const isStoreCounterBack = consignmentCounterOfferButton.dataset.isCounterOffer === "true";

      const raw = window.prompt("Enter your requested payout. Example: 250");
    
      if (!raw) return;
    
      const counterPrice = Number(
        String(raw)
          .replace(/[^\d.,-]/g, "")
          .replace(",", ".")
      );
    
      if (!Number.isFinite(counterPrice) || counterPrice <= 0) {
        alert("Please enter a valid counter price. Example: 250");
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
    
        alert(`Counter offer sent to store. Store offer: €${Number(data.store_offer_price).toFixed(2)} (${data.store_offer_vat_type})`);
    
        await loadDashboardData();
        await loadDashboardCounts();
      } catch (err) {
        alert("Could not submit counter offer. Please try again or contact support.");
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
        alert(err.message);
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
        alert(err.message);
      } finally {
        consignmentDenyOfferButton.disabled = false;
      }
  
      return;
    }

    // NEW — additive only: Edit a pending counter (Countered pill).
    const consignmentOfferEditButton = event.target.closest("[data-consignment-offer-edit-id]");

    if (consignmentOfferEditButton) {
      const offerId = consignmentOfferEditButton.dataset.consignmentOfferEditId;

      const raw = window.prompt("Enter your new counter. Example: 250");
      if (!raw) return;

      const newPrice = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(newPrice) || newPrice <= 0) {
        alert("Please enter a valid price. Example: 250");
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
        alert(err.message);
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

      if (!confirm("Accept the store's previous offer instead of waiting for a response to your counter?")) {
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
        alert(err.message);
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

      if (!confirm("Remove this offer? This can't be undone.")) return;

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
        alert(err.message);
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

      const raw = window.prompt("Enter your new, higher counter. Example: 250");
      if (!raw) return;

      const retryPrice = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));

      if (!Number.isFinite(retryPrice) || retryPrice <= 0) {
        alert("Please enter a valid price. Example: 250");
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
        alert(err.message);
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
      alert(err.message);
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
      alert("Missing order or Member WTB record ID.");
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
      alert(err.message || "Failed to request label");
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
    const confirmed = window.confirm("Mark this issue as solved?");
  
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
      alert(data.details || data.error || "Failed to solve issue");
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

    if (!confirm("Delete this offer? This can't be undone.")) return;

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
      alert(err.message);
      deleteButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: accept the store/buyer's previous counter
  // instead of waiting on a response to the seller's own pending one.
  const wtbAcceptPreviousButton = event.target.closest("[data-wtb-accept-previous-id]");
  if (wtbAcceptPreviousButton) {
    const offerId = wtbAcceptPreviousButton.dataset.wtbAcceptPreviousId;
    const originalLabel = wtbAcceptPreviousButton.textContent;

    if (!confirm("Accept the buyer's previous offer instead of waiting for a response to your counter?")) {
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
      alert(err.message);
      wtbAcceptPreviousButton.disabled = false;
      wtbAcceptPreviousButton.textContent = originalLabel;
    }

    return;
  }

  // NEW — additive only: delete the seller's own pending counter
  // (Counter Offers table record), which has no existing delete path.
  const wtbCancelCounterButton = event.target.closest("[data-wtb-cancel-counter-id]");
  if (wtbCancelCounterButton) {
    const offerId = wtbCancelCounterButton.dataset.wtbCancelCounterId;
    if (!offerId) return;

    if (!confirm("Delete this counter? This can't be undone.")) return;

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
      alert(err.message);
      wtbCancelCounterButton.disabled = false;
    }

    return;
  }

  // NEW — additive only: Delete for a denied WTB counter offer.
  const wtbCancelOfferButton = event.target.closest("[data-wtb-cancel-offer-id]");
  if (wtbCancelOfferButton) {
    const offerId = wtbCancelOfferButton.dataset.wtbCancelOfferId;
    if (!offerId) return;

    if (!confirm("Delete this offer? This can't be undone.")) return;

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
      alert(err.message);
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
  
      alert("Offer accepted. We are now waiting for the seller to process the deal.");
  
      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      alert(err.message);
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

      alert("Offer declined.");
  
      await loadDashboardData();
      await loadDashboardCounts();
    } catch (err) {
      alert(err.message);
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

dashboardLogoutBtn.addEventListener("click", () => {
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

dashboardSearchInput.addEventListener("input", () => {
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
