const dealsGrid = document.getElementById("dealsGrid");

const marketTabs = document.querySelectorAll(".market-tab");
const priceViewButtons = document.querySelectorAll(".price-view-btn");

const searchInput = document.getElementById("searchInput");
const brandFilter = document.getElementById("brandFilter");
const sortFilter = document.getElementById("sortFilter");

let searchQuery = "";
let selectedBrand = "";
let selectedSort = localStorage.getItem("kc_sort") || "newest";
sortFilter.value = selectedSort;

let currentType = localStorage.getItem("kc_market_type") || "quick";
let priceView = localStorage.getItem("kc_price_view") || "margin";
let layoutView = localStorage.getItem("kc_layout_view") || "cards";

if (!["quick", "wtb"].includes(currentType)) {
  currentType = "quick";
}

if (!["margin", "vat0"].includes(priceView)) {
  priceView = "margin";
}
let currentDeals = [];
let nextOffset = "";
let hasMore = false;
let isLoading = false;

async function loadDeals(type = "quick", reset = true) {
  if (isLoading) return;

  try {
    isLoading = true;

    if (reset) {
      document.getElementById("loadingMore")?.remove();
    
      currentDeals = [];
      nextOffset = "";
      hasMore = false;

      dealsGrid.innerHTML = `
        <div class="loading-state">
          Searching deals...
        </div>
      `;
    }

    const params = new URLSearchParams({
      type,
      page_size: "40",
      sort: selectedSort,
      price_view: priceView
    });
    
    if (selectedBrand) {
      params.set("brand", selectedBrand);
    }
    
    if (searchQuery) {
      params.set("search", searchQuery);
    }

    if (!reset && nextOffset) {
      params.set("offset", nextOffset);
    }

    const response = await fetch(`/api/deals?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load deals");
    }

    currentDeals = reset
      ? data.deals
      : [...currentDeals, ...data.deals];

    nextOffset = data.next_offset || "";
    hasMore = !!data.has_more;

    renderDeals();

  } catch (err) {
    console.error(err);

    dealsGrid.innerHTML = `
      <div class="empty-state">
        Failed to load deals.
      </div>
    `;
  } finally {
    isLoading = false;
    renderLoadingMore();
  }
}

function renderDealCard(deal) {

  const isQuick = currentType === "quick";
  const isClaimProcessing = deal.fulfillment_status === "Claim Processing";

  const payoutHtml = isQuick
    ? `
      <div class="deal-payouts">

        <div class="payout-box">
          <span class="payout-label">Current</span>
          <span class="payout-value">
            ${priceView === "vat0" ? deal.current_payout_vat0 || "-" : deal.current_payout_margin || "-"}
          </span>
        </div>

        <div class="payout-box">
          <span class="payout-label">Max</span>
          <span class="payout-value">
            ${priceView === "vat0" ? deal.max_payout_vat0 || "-" : deal.max_payout_margin || "-"}
          </span>
        </div>

      </div>
    `
    : `
      <div class="deal-payouts">

        <div class="payout-box">
          <span class="payout-label">Current Offer</span>
          <span class="payout-value">
            ${priceView === "vat0" ? deal.current_offer_vat0 || "No offer yet" : deal.current_offer_margin || "No offer yet"}
          </span>
        </div>

      </div>
    `;

  return `
    <article class="deal-card">

      <div class="deal-image-wrap">

        ${
          deal.image_url
            ? `
              <img
                src="${deal.image_url}"
                class="deal-image"
              />
            `
            : `
              <div class="image-placeholder">
                <div class="placeholder-icon"><span></span></div>
              </div>
            `
        }

      </div>

      <div class="deal-body">

        <div class="deal-top">

          <span class="deal-badge ${isQuick ? "quick" : "offer"}">
            ${isQuick ? "Quick Deal" : "Want To Buy"}
          </span>

          <span class="deal-time">
            ${isQuick ? deal.time_to_max : "Offer Eligible"}
          </span>

        </div>

        <h3 class="deal-title">
          ${deal.product || "-"}
        </h3>

        <div class="deal-meta">
          ${deal.sku || "-"} • ${deal.size || "-"}
        </div>

        ${payoutHtml}

        <button
          class="deal-btn ${!isQuick ? "offer-btn" : ""} ${isClaimProcessing ? "disabled-btn" : ""}"
          type="button"
          ${isClaimProcessing ? "disabled" : ""}
          onclick="${isClaimProcessing ? "" : isQuick ? `openClaimModal('${deal.id}')` : `openOfferFlow('${deal.id}')`}"
        >
          ${isClaimProcessing ? "Claim in Progress..." : isQuick ? "Claim Deal" : "Make Offer"}
        </button>

      </div>

    </article>
  `;
}

function renderDealTable(deals) {
  const isQuick = currentType === "quick";

  return `
    <div class="table-wrap ${isQuick ? "quick-table" : "wtb-table"}">

      <div class="table-head">
        <div></div>
        <div>Product</div>
        <div>SKU</div>
        <div>Size</div>
        <div>Deal Type</div>
        <div>${isQuick ? "Current Payout" : "Current Offer"}</div>
        ${isQuick ? "<div>Max Payout</div>" : ""}
        ${isQuick ? "<div>Timer</div>" : ""}
        <div></div>
      </div>

      ${deals.map((deal) => {
        const isClaimProcessing = deal.fulfillment_status === "Claim Processing";

        return `
          <div class="table-row">

            <div class="table-image-cell">
              ${
                deal.image_url
                  ? `<img src="${deal.image_url}" class="table-image" />`
                  : `<div class="table-image-placeholder"></div>`
              }
            </div>

            <div class="table-product">${deal.product || "-"}</div>

            <div>${deal.sku || "-"}</div>

            <div>${deal.size || "-"}</div>

            <div>
              ${isQuick ? "Quick Deal" : "Want To Buy"}
            </div>

            <div>
              ${
                isQuick
                  ? priceView === "vat0"
                    ? deal.current_payout_vat0 || "-"
                    : deal.current_payout_margin || "-"
                  : priceView === "vat0"
                    ? deal.current_offer_vat0 || "No offer yet"
                    : deal.current_offer_margin || "No offer yet"
              }
            </div>

            ${
              isQuick
                ? `
                  <div>
                    ${
                      priceView === "vat0"
                        ? deal.max_payout_vat0 || "-"
                        : deal.max_payout_margin || "-"
                    }
                  </div>
                `
                : ""
            }

            ${
              isQuick
                ? `<div>${deal.time_to_max || "-"}</div>`
                : ""
            }

            <div>
              <button
                class="table-btn ${!isQuick ? "offer-btn" : ""} ${isClaimProcessing ? "disabled-btn" : ""}"
                type="button"
                ${isClaimProcessing ? "disabled" : ""}
                onclick="${
                  isClaimProcessing
                    ? ""
                    : isQuick
                      ? `openClaimModal('${deal.id}')`
                      : `openOfferFlow('${deal.id}')`
                }"
              >
                ${
                  isClaimProcessing
                    ? "In Progress"
                    : isQuick
                      ? "Claim"
                      : "Offer"
                }
              </button>
            </div>

          </div>
        `;
      }).join("")}

    </div>
  `;
}

function getFilteredDeals() {
  return currentDeals.filter((deal) => {
    const query = searchQuery.toLowerCase();

    const matchesSearch =
      !query ||
      [deal.product, deal.sku, deal.brand, deal.size]
        .join(" ")
        .toLowerCase()
        .includes(query);

    const matchesBrand =
      !selectedBrand || deal.brand === selectedBrand;

    return matchesSearch && matchesBrand;
  });
}

function renderDeals() {
  const filteredDeals = getFilteredDeals();

  if (!filteredDeals.length) {
    document.getElementById("loadingMore")?.remove();
    hasMore = false;
  
    dealsGrid.innerHTML = `
      <div class="empty-state">
        No deals found.
      </div>
    `;
    return;
  }

  dealsGrid.innerHTML =
    layoutView === "table"
      ? renderDealTable(filteredDeals)
      : filteredDeals.map(renderDealCard).join("");

  renderLoadingMore();
}

function renderLoadingMore() {
  document.getElementById("loadingMore")?.remove();

  if (!hasMore || searchQuery) return;

  dealsGrid.insertAdjacentHTML(
    "afterend",
    `
      <div id="loadingMore" class="loading-more">
        <span>Loading more</span>
        <span class="dots">
          <span>.</span><span>.</span><span>.</span>
        </span>
      </div>
    `
  );
}

function syncMarketUi() {
  marketTabs.forEach((tab) => {
    const tabType = tab.getAttribute("data-market-type");
    tab.classList.toggle("active", tabType === currentType);
  });

  priceViewButtons.forEach((button) => {
    const buttonView = button.getAttribute("data-price-view");
    button.classList.toggle("active", buttonView === priceView);
  });

  document.querySelectorAll(".view-btn").forEach((button) => {
    const view = button.dataset.view;
    button.classList.toggle("active", view === layoutView);
  });
}

marketTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const selectedType = tab.getAttribute("data-market-type");

    if (!selectedType) return;

    currentType = selectedType;

    localStorage.setItem("kc_market_type", currentType);

    selectedBrand = "";
    brandFilter.value = "";
    
    syncMarketUi();
    loadBrands();
    loadDeals(currentType, true);
  });
});

priceViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    priceView = button.dataset.priceView;

    localStorage.setItem("kc_price_view", priceView);

    syncMarketUi();
    loadDeals(currentType, true);
  });
});

document.querySelectorAll(".view-btn").forEach((button) => {
  button.addEventListener("click", () => {
    layoutView = button.dataset.view;

    localStorage.setItem("kc_layout_view", layoutView);

    syncMarketUi();
    renderDeals();
  });
});

syncMarketUi();
loadDeals(currentType);

async function loadBrands() {
  try {
    const response = await fetch(`/api/brands?type=${currentType}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load brands");
    }

    brandFilter.innerHTML = `<option value="">All Brands</option>`;

    data.brands.forEach((brand) => {
      const option = document.createElement("option");
      option.value = brand;
      option.textContent = brand;
      brandFilter.appendChild(option);
    });
  } catch (err) {
    console.error(err);
  }
}

loadBrands();

brandFilter.addEventListener("change", () => {
  selectedBrand = brandFilter.value;
  loadDeals(currentType, true);
});

sortFilter.addEventListener("change", () => {
  selectedSort = sortFilter.value;
  localStorage.setItem("kc_sort", selectedSort);
  loadDeals(currentType, true);
});

function editDistance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();

  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
    }
  }

  return dp[a.length][b.length];
}

function getForgivingSearchQuery(query) {
  const cleanQuery = query.toLowerCase().trim();

  if (cleanQuery.length < 4) return query;

  const brands = [...brandFilter.options]
    .map((option) => option.value)
    .filter(Boolean);

  const closestBrand = brands.find((brand) => {
    const cleanBrand = brand.toLowerCase();
    return editDistance(cleanQuery, cleanBrand) <= 2;
  });

  return closestBrand || query;
}

let searchTimer = null;

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);

  searchTimer = setTimeout(() => {
    searchQuery = getForgivingSearchQuery(searchInput.value.trim());
    loadDeals(currentType, true);
  }, 350);
});

window.addEventListener("scroll", () => {
  if (!hasMore || isLoading) return;

  const distanceFromBottom =
    document.documentElement.scrollHeight -
    window.innerHeight -
    window.scrollY;

  if (distanceFromBottom < 500) {
    loadDeals(currentType, false);
  }
});

const loginBtn = document.querySelector(".login-btn");
const signupBtn = document.querySelector(".signup-btn");
const profileBtn = document.querySelector(".profile-btn");
const loginModal = document.getElementById("loginModal");
const closeLoginModal = document.getElementById("closeLoginModal");
const loginForm = document.getElementById("loginForm");
const forgotPasswordBtn = document.getElementById("forgotPasswordBtn");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");

const claimModal = document.getElementById("claimModal");
const closeClaimModal = document.getElementById("closeClaimModal");
const confirmClaimBtn = document.getElementById("confirmClaimBtn");
const claimError = document.getElementById("claimError");
const vatOptions = document.querySelectorAll(".vat-option");

const offerModal = document.getElementById("offerModal");
const closeOfferModal = document.getElementById("closeOfferModal");
const confirmOfferBtn = document.getElementById("confirmOfferBtn");
const offerAmountInput = document.getElementById("offerAmountInput");
const offerError = document.getElementById("offerError");
const offerVatOptions = document.querySelectorAll(".offer-vat-option");
offerAmountInput.addEventListener("input", () => {
  offerAmountInput.value = offerAmountInput.value.replace(/\D/g, "");
});

let selectedOfferDeal = null;
let selectedOfferVatType = "Margin";

let selectedDeal = null;
let selectedVatType = "Margin";

let currentSeller = JSON.parse(localStorage.getItem("kc_seller") || "null");

function updateLoginState() {
  if (currentSeller) {
    loginBtn.classList.add("hidden");
    signupBtn.classList.add("hidden");
    profileBtn.classList.remove("hidden");
  } else {
    loginBtn.classList.remove("hidden");
    signupBtn.classList.remove("hidden");
    profileBtn.classList.add("hidden");
    loginBtn.textContent = "LOGIN";
  }
}

function openLoginModal() {
  loginError.textContent = "";
  loginModal.classList.remove("hidden");
}

function closeModal() {
  loginModal.classList.add("hidden");
}

loginBtn.addEventListener("click", () => {
  openLoginModal();
});

closeLoginModal.addEventListener("click", closeModal);

loginModal.addEventListener("click", (event) => {
  if (event.target === loginModal) {
    closeModal();
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  loginError.textContent = "";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: loginEmail.value,
        password: loginPassword.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Login failed");
    }

    currentSeller = data.seller;

    localStorage.setItem("kc_seller", JSON.stringify(currentSeller));

    updateLoginState();
    closeModal();

    loginEmail.value = "";
    loginPassword.value = "";
  } catch (err) {
    loginError.textContent = err.message;
  }
});

updateLoginState();

function openClaimModal(dealId) {
  if (!currentSeller) {
    openLoginModal();
    return;
  }

  selectedDeal = currentDeals.find((deal) => deal.id === dealId);

  if (!selectedDeal) {
    alert("Deal not found. Please refresh and try again.");
    return;
  }

  selectedVatType = "Margin";
  claimError.textContent = "";

  vatOptions.forEach((option) => {
    option.classList.toggle("active", option.dataset.vat === selectedVatType);
  });

  claimModal.classList.remove("hidden");
}

function closeClaimFlow() {
  claimModal.classList.add("hidden");
  selectedDeal = null;
}

closeClaimModal.addEventListener("click", closeClaimFlow);

claimModal.addEventListener("click", (event) => {
  if (event.target === claimModal) {
    closeClaimFlow();
  }
});

vatOptions.forEach((option) => {
  option.addEventListener("click", () => {
    selectedVatType = option.dataset.vat;

    vatOptions.forEach((item) => {
      item.classList.remove("active");
    });

    option.classList.add("active");
  });
});

confirmClaimBtn.addEventListener("click", async () => {
  if (!selectedDeal || !currentSeller) return;

  claimError.textContent = "";

  confirmClaimBtn.disabled = true;
  confirmClaimBtn.textContent = "Claiming...";
  claimError.textContent = "";
  
  try {
    const response = await fetch("/api/claim-deal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recordId: selectedDeal.id,
        sellerRecordId: currentSeller.id,
        sellerId: currentSeller.seller_id,
        sellerDiscordId: currentSeller.discord_id,
        vatType: selectedVatType
      })
    });
  
    const data = await response.json();
  
    if (!response.ok) {
      throw new Error(data.error || "Claim failed");
    }
  
    closeClaimFlow();
  
    currentDeals = [];
    nextOffset = "";
    hasMore = false;
  
    await loadDeals(currentType);
  
    showSuccessToast("Deal claimed successfully");
  } catch (err) {
    claimError.textContent = err.message;
  } finally {
    confirmClaimBtn.disabled = false;
    confirmClaimBtn.textContent = "Confirm Claim";
  }
});

function openOfferFlow(dealId) {
  if (!currentSeller) {
    openLoginModal();
    return;
  }

  selectedOfferDeal = currentDeals.find((deal) => deal.id === dealId);

  if (!selectedOfferDeal) {
    alert("Deal not found. Please refresh and try again.");
    return;
  }

  selectedOfferVatType = priceView === "vat0" ? "VAT0" : "Margin";
  offerAmountInput.value = "";
  offerError.textContent = "";
  updateOfferPlaceholder();

  offerVatOptions.forEach((option) => {
    option.classList.toggle("active", option.dataset.vat === selectedOfferVatType);
  });

  offerModal.classList.remove("hidden");
}

function closeOfferFlow() {
  offerModal.classList.add("hidden");
  selectedOfferDeal = null;
}

closeOfferModal.addEventListener("click", closeOfferFlow);

offerModal.addEventListener("click", (event) => {
  if (event.target === offerModal) {
    closeOfferFlow();
  }
});

offerVatOptions.forEach((option) => {
  option.addEventListener("click", () => {
    selectedOfferVatType = option.dataset.vat;

    offerVatOptions.forEach((item) => {
      item.classList.remove("active");
    });

    option.classList.add("active");
    updateOfferPlaceholder();
  });
});

function updateOfferPlaceholder() {
  if (!selectedOfferDeal) return;

  const currentOffer =
    selectedOfferVatType === "VAT0"
      ? selectedOfferDeal.current_offer_vat0
      : selectedOfferDeal.current_offer_margin;

  offerAmountInput.placeholder = currentOffer
    ? `Current offer: ${currentOffer}`
    : "Enter your offer";
}

confirmOfferBtn.addEventListener("click", async () => {
  if (!selectedOfferDeal || !currentSeller) return;

  const offerAmount = Number(offerAmountInput.value);

  offerError.textContent = "";

  if (!Number.isInteger(offerAmount) || offerAmount <= 0) {
    offerError.textContent = "Enter a valid whole euro amount.";
    return;
  }

  confirmOfferBtn.disabled = true;
  confirmOfferBtn.textContent = "Submitting...";

  try {
    const response = await fetch("/api/place-offer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        orderRecordId: selectedOfferDeal.id,
        sellerRecordId: currentSeller.id,
        offerAmount,
        vatType: selectedOfferVatType
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Offer failed");
    }

    closeOfferFlow();

    currentDeals = [];
    nextOffset = "";
    hasMore = false;

    await loadDeals(currentType);

    showSuccessToast("Offer submitted successfully");
  } catch (err) {
    offerError.textContent = err.message;
  } finally {
    confirmOfferBtn.disabled = false;
    confirmOfferBtn.textContent = "Submit Offer";
  }
});

function showSuccessToast(message) {
  const existing = document.querySelector(".success-toast");

  if (existing) {
    existing.remove();
  }

  const toast = document.createElement("div");

  toast.className = "success-toast";

  toast.innerHTML = `
    <div class="success-toast-icon">✓</div>
    <div class="success-toast-text">${message}</div>
  `;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");

    setTimeout(() => {
      toast.remove();
    }, 250);
  }, 2600);
}
