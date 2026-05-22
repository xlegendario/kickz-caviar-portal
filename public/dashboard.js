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
      { key: "open_offers", label: "Open Offers" },
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
      { key: "offers", label: "Offers" },
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

let dashboardSeller = JSON.parse(localStorage.getItem("kc_seller") || "null");
let activeSection = localStorage.getItem("kc_dashboard_section") || "quick";
let activeTab = localStorage.getItem("kc_dashboard_tab") || "open_claims";

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

let pendingLabelUrl = "";

function canAccessSection(section) {
  if (section !== "consignment") return true;
  return dashboardSeller?.consignor === true;
}

function syncConsignmentAccess() {
  const section = document.querySelector("[data-consignment-nav-section]");
  section?.classList.toggle("hidden", !canAccessSection("consignment"));

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

    wrap.innerHTML = config.tabs.map((tab) => `
      <button class="dashboard-subnav-btn" type="button" data-section="${section}" data-tab="${tab.key}">
        <span>${tab.label}</span>
        <span class="dashboard-subnav-count" data-count-key="${section}:${tab.key}">0</span>
      </button>
    `).join("");
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

  localStorage.setItem("kc_dashboard_section", activeSection);
  localStorage.setItem("kc_dashboard_tab", activeTab);

  syncDashboardUi();
}

function getActiveTabConfig() {
  return dashboardConfig[activeSection].tabs.find((tab) => tab.key === activeTab);
}

function syncDashboardUi() {
  activeSection = safeSection(activeSection);
  activeTab = safeTab(activeSection, activeTab);

  const sectionConfig = dashboardConfig[activeSection];
  const tabConfig = getActiveTabConfig();

  dashboardTitle.textContent = sectionConfig.label;
  dashboardSubtabTitle.textContent = tabConfig.label;
  dashboardSubtabDescription.textContent = "";

  document.querySelectorAll("[data-dashboard-section]").forEach((button) => {
    const isActiveSection = button.dataset.dashboardSection === activeSection;
    const subnav = document.querySelector(`[data-subnav="${button.dataset.dashboardSection}"]`);

    if (isActiveSection) {
      button.classList.add("open");
      subnav?.classList.add("open");
    }
  });

  document.querySelectorAll(".dashboard-subnav-btn").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.section === activeSection && button.dataset.tab === activeTab
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
  history: {}
};

let quickCountsCache = {};
let statsOpen = false;

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
    history: {},
    ...(data || {})
  };
  quickCountsCache = dashboardCountsCache.quick || {};

  Object.entries(dashboardCountsCache).forEach(([section, counts]) => {
    Object.entries(counts || {}).forEach(([key, value]) => {
      document.querySelectorAll(`[data-count-key="${section}:${key}"]`)
        .forEach((el) => {
          el.textContent = value || 0;
        });
    });

    const total = Object.values(counts || {})
      .reduce((sum, value) => sum + Number(value || 0), 0);

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

function parseCsvLine(line) {
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

    if (char === "," && !insideQuotes) {
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

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
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
    const values = parseCsvLine(line);

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

function renderWtbAcceptedRows(items) {
  dashboardTableBody
    .closest(".dashboard-table")
    ?.classList.remove("open-offers-table");

  dashboardTableHead.innerHTML = wtbAcceptedColumns
    .map((column) => `<th>${column}</th>`)
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
      thirdLabel: "Status",
      thirdValue: () => "Processing..."
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
      <td>${escapeHtml(item.status || "-")}</td>
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
                      data-edit-offer-id="${escapeHtml(offer.id)}"
                      data-order-record-id="${escapeHtml(offer.order_record_id)}"
                      data-vat-type="${escapeHtml(offer.vat_type)}"
                      data-current-offer="${escapeHtml(offer.offer_raw)}"
                      data-current-lowest="${escapeHtml(offer.current_lowest || "-")}"
                    >
                      Edit
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
            data-edit-offer-id="${escapeHtml(offer.id)}"
            data-order-record-id="${escapeHtml(offer.order_record_id)}"
            data-vat-type="${escapeHtml(offer.vat_type)}"
            data-current-offer="${escapeHtml(offer.offer_raw)}"
            data-current-lowest="${escapeHtml(offer.current_lowest || "-")}"
          >
            Edit
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

        <button
          class="dashboard-mobile-btn dashboard-mobile-request-label-btn"
          type="button"
          data-request-label-id="${escapeHtml(item.order_record_id || "")}"
        >
          Request Label
        </button>
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

        <button
          class="dashboard-issue-btn dashboard-request-label-btn"
          type="button"
          data-request-label-id="${escapeHtml(item.order_record_id || "")}"
        >
          Request Label
        </button>
      </div>
    `;
  });
}

async function loadDashboardData() {
  if (!dashboardSeller) return;

  document.getElementById("consignmentInventoryActions")?.remove();

  if (activeSection === "consignment" && activeTab === "inventory") {
    document.getElementById("consignmentInventoryActions")?.remove();
    
    dashboardSubtabDescription.innerHTML = "";
    dashboardRefreshBtn.insertAdjacentHTML("beforebegin", `
      <div class="consignment-inventory-actions" id="consignmentInventoryActions">
        <button class="dashboard-issue-submit-btn" type="button" id="consignmentOpenAddStockBtn">
          + Add Stock
        </button>
    
        <button class="dashboard-refresh-btn" type="button" id="consignmentOpenCsvUploadBtn">
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
  
    renderConsignmentInventoryRows(data.items || []);
  
    dashboardCountsCache.consignment.inventory = data.count || 0;
    renderStats();
  
    return;
  }
  
  if (activeSection === "consignment") {
    renderTableShell();
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
    syncConsignmentAccess();
    loadDashboardData().catch(console.error);
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
  const requestLabelButton = event.target.closest("[data-request-label-id]");

  if (requestLabelButton) {
    const orderRecordId = requestLabelButton.dataset.requestLabelId;
  
    if (!orderRecordId) {
      alert("Missing order record ID.");
      return;
    }
  
    requestLabelButton.disabled = true;
    requestLabelButton.textContent = "REQUESTING...";
  
    try {
      const response = await fetch("/api/dashboard/request-label", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          order_record_id: orderRecordId
        })
      });
  
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

  if (deleteButton) {
    await handleDeleteOffer(deleteButton);
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
    const response = await fetch("/api/place-offer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        orderRecordId,
        sellerRecordId: dashboardSeller.id,
        offerAmount: cleanOffer,
        vatType
      })
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
        throw new Error(data.details || data.error || "Failed to upload CSV");
      }
    
      consignmentCsvPreview.textContent =
        consignmentCsvMode.value === "replace"
          ? `${data.count || result.rows.length} rows replaced successfully.`
          : `${data.count || result.rows.length} rows uploaded successfully.`;
      
      await loadDashboardData();
      await loadDashboardCounts();
      
      closeConsignmentCsvModal();
    } finally {
      submitBtn.disabled = false;
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
  renderTableShell();
});

renderSubnav();
bindNavigation();
bindConsignmentInputCleaning();
syncDashboardUi();
syncAuthUi();

if (dashboardSeller) {
  loadDashboardCounts().catch(console.error);
}
