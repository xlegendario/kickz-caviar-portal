const dashboardConfig = {
  quick: {
    label: "Quick Deals",
    tabs: [
      { key: "open_claims", label: "Open Claims", description: "Claimed quick deals waiting for confirmation." },
      { key: "confirmed", label: "Confirmed", description: "Confirmed quick deals allocated to you." },
      { key: "label_requested", label: "Label Requested", description: "Quick deals where a shipping label has been requested." },
      { key: "ready_to_ship", label: "Ready To Ship", description: "Quick deals ready to ship." },
      { key: "shipped", label: "Shipped", description: "Quick deals marked as shipped." },
      { key: "delivered", label: "Delivered", description: "Delivered quick deals waiting for payout." }
    ]
  },
  wtb: {
    label: "Want To Buys",
    tabs: [
      { key: "open_offers", label: "Open Offers", description: "Your active offers on want-to-buy orders." },
      { key: "accepted", label: "Accepted", description: "Offers accepted as current winning seller offer." },
      { key: "confirmed", label: "Confirmed", description: "Confirmed WTB sales allocated to you." },
      { key: "label_requested", label: "Label Requested", description: "WTB sales where a shipping label has been requested." },
      { key: "ready_to_ship", label: "Ready To Ship", description: "WTB sales ready to ship." },
      { key: "shipped", label: "Shipped", description: "WTB sales marked as shipped." },
      { key: "delivered", label: "Delivered", description: "Delivered WTB sales waiting for payout." }
    ]
  },
  history: {
    label: "History",
    tabs: [
      { key: "paid", label: "Paid", description: "Paid inventory units connected to your seller account." }
    ]
  }
};

const skeletonColumns = ["Order", "Product", "SKU", "Size", "Status", "Payout / Offer", "Date", "Action"];

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
const dashboardStats = document.getElementById("dashboardStats");
const dashboardSubtabTitle = document.getElementById("dashboardSubtabTitle");
const dashboardSubtabDescription = document.getElementById("dashboardSubtabDescription");
const dashboardTableHead = document.getElementById("dashboardTableHead");
const dashboardTableBody = document.getElementById("dashboardTableBody");
const dashboardRefreshBtn = document.getElementById("dashboardRefreshBtn");
const dashboardSearchInput = document.getElementById("dashboardSearchInput");

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
  document.querySelectorAll("[data-dashboard-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = safeSection(button.dataset.dashboardSection);
      setActiveView(section, dashboardConfig[section].tabs[0].key);
    });
  });

  document.querySelectorAll(".dashboard-subnav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveView(button.dataset.section, button.dataset.tab);
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
  dashboardSubtabDescription.textContent = tabConfig.description;

  document.querySelectorAll("[data-dashboard-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.dashboardSection === activeSection);
  });

  document.querySelectorAll(".dashboard-subnav-btn").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.section === activeSection && button.dataset.tab === activeTab
    );
  });

  renderStats();
  renderTableShell();
}

function renderStats() {
  const cards = dashboardConfig[activeSection].tabs.slice(0, 4);

  dashboardStats.innerHTML = cards.map((tab) => `
    <article class="dashboard-stat-card ${tab.key === activeTab ? "active" : ""}">
      <div class="dashboard-stat-label">${tab.label}</div>
      <div class="dashboard-stat-value">0</div>
    </article>
  `).join("");
}

function renderTableShell() {
  dashboardTableHead.innerHTML = skeletonColumns.map((column) => `<th>${column}</th>`).join("");
  dashboardTableBody.innerHTML = `
    <tr>
      <td colspan="${skeletonColumns.length}">
        <div class="dashboard-empty-state">
          <div class="dashboard-empty-icon">◇</div>
          <strong>No data connected yet</strong>
          <span>This subtab is ready. The Airtable query and exact columns can be connected next.</span>
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
    dashboardSellerName.textContent = dashboardSeller.discord || dashboardSeller.email || "Seller";
    dashboardSellerId.textContent = dashboardSeller.seller_id || dashboardSeller.id || "Seller account";
  } else {
    dashboardLoginPanel.classList.remove("hidden");
    dashboardContent.classList.add("hidden");
    dashboardLogoutBtn.classList.add("hidden");
    dashboardSellerName.textContent = "Not logged in";
    dashboardSellerId.textContent = "Login required";
  }
}

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

dashboardLogoutBtn.addEventListener("click", () => {
  localStorage.removeItem("kc_seller");
  dashboardSeller = null;
  syncAuthUi();
});

dashboardRefreshBtn.addEventListener("click", () => {
  renderTableShell();
});

dashboardSearchInput.addEventListener("input", () => {
  renderTableShell();
});

renderSubnav();
bindNavigation();
syncDashboardUi();
syncAuthUi();
