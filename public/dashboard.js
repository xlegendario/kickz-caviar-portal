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

function safeSection(section) {
  return dashboardConfig[section] ? section : "quick";
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
  history: {}
};

let quickCountsCache = {};

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

  dashboardCountsCache = data || { quick: {}, wtb: {}, history: {} };
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
            <span>
              At this moment there are no open offers in this stage.
            </span>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  dashboardTableBody.innerHTML = offers.map((offer) => `
    <tr>
      <td>
        <div
          class="dashboard-status-dot ${
            offer.status === "Lowest"
              ? "dashboard-status-dot-lowest"
              : "dashboard-status-dot-beaten"
          }"
        ></div>
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
        
          <button
            class="dashboard-delete-btn"
            type="button"
            data-delete-offer-id="${escapeHtml(offer.id)}"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18"/>
              <path d="M8 6V4h8v2"/>
              <path d="M19 6l-1 14H6L5 6"/>
            </svg>
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
                <a
                  class="dashboard-download-btn"
                  href="${escapeHtml(item.label_url)}"
                  target="_blank"
                  rel="noopener"
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

async function loadDashboardData() {
  if (!dashboardSeller) return;

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
  
    renderOpenClaimsRows(data.items || []);
  
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
  
    renderOpenClaimsRows(data.items || []);
  
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
    document.getElementById("sellerDashboard")?.classList.remove("auth-only");
    document.querySelector(".dashboard-sidebar")?.classList.remove("hidden");
    document.querySelector(".dashboard-topbar")?.classList.remove("hidden");
    dashboardSellerName.textContent = dashboardSeller.discord || dashboardSeller.email || "Seller";
    dashboardSellerId.textContent = dashboardSeller.seller_id || dashboardSeller.id || "Seller account";
    loadDashboardData().catch(console.error);
    loadDashboardCounts().catch(console.error);
  } else {
    dashboardLoginPanel.classList.remove("hidden");
    dashboardContent.classList.add("hidden");
    dashboardLogoutBtn.classList.add("hidden");
    document.getElementById("sellerDashboard")?.classList.add("auth-only");
    document.querySelector(".dashboard-sidebar")?.classList.add("hidden");
    document.querySelector(".dashboard-topbar")?.classList.add("hidden");
    dashboardSellerName.textContent = "Not logged in";
    dashboardSellerId.textContent = "Login required";
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
  editOfferAmount.focus();
  editOfferAmount.select();
}

function closeEditOfferModal() {
  editOfferModal.classList.add("hidden");
}

function openIssueModal(inventoryId) {
  issueError.textContent = "";
  issueInventoryId.value = inventoryId || "";
  issueNotes.value = "";

  issueModal.classList.remove("hidden");
  issueNotes.focus();
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

    const data = await response.json();

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

dashboardTableBody.addEventListener("click", async (event) => {
  const issueButton = event.target.closest("[data-report-issue-id]");
  const viewIssueButton = event.target.closest("[data-issue-note]");
  const solveIssueButton = event.target.closest("[data-solve-issue-id]");
  const editButton = event.target.closest("[data-edit-offer-id]");
  const deleteButton = event.target.closest("[data-delete-offer-id]");
  
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

document.querySelectorAll("[data-issue-close]").forEach((button) => {
  button.addEventListener("click", closeIssueModal);
});

document.querySelectorAll("[data-view-issue-close]").forEach((button) => {
  button.addEventListener("click", closeViewIssueModal);
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
syncDashboardUi();
syncAuthUi();

if (dashboardSeller) {
  loadDashboardCounts().catch(console.error);
}
