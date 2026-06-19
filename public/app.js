const dealsGrid = document.getElementById("dealsGrid");

const mainToggleButtons = document.querySelectorAll("[data-main-mode]");
const buyingProductModal = document.getElementById("buyingProductModal");
const closeBuyingProductModal = document.getElementById("closeBuyingProductModal");
const buyingProductModalContent = document.getElementById("buyingProductModalContent");

const buyingActionModal = document.getElementById("buyingActionModal");
const closeBuyingActionModal = document.getElementById("closeBuyingActionModal");
const cancelBuyingActionBtn = document.getElementById("cancelBuyingActionBtn");
const submitBuyingActionBtn = document.getElementById("submitBuyingActionBtn");
const buyingActionTitle = document.getElementById("buyingActionTitle");
const buyingActionContent = document.getElementById("buyingActionContent");
const buyingActionError = document.getElementById("buyingActionError");

const marketTabs = document.querySelectorAll(".market-tab");
const priceViewButtons = document.querySelectorAll(".price-view-btn");

const searchInput = document.getElementById("searchInput");
const brandFilter = document.getElementById("brandFilter");
const sortFilter = document.getElementById("sortFilter");

const forgotForm = document.getElementById("forgotForm");
const forgotEmail = document.getElementById("forgotEmail");
const forgotError = document.getElementById("forgotError");
const backToLoginBtn = document.getElementById("backToLoginBtn");

const heroConsignorCta = document.getElementById("heroConsignorCta");

let searchQuery = searchInput?.value?.trim() || "";
let selectedBrand = "";
let currentMainMode = localStorage.getItem("kc_main_mode") || "selling";

let sellingSort = localStorage.getItem("kc_selling_sort") || "newest";
let buyingSort = localStorage.getItem("kc_buying_sort") || "az";
let selectedSort = currentMainMode === "buying" ? buyingSort : sellingSort;

sortFilter.value = selectedSort;
let currentBuyingProducts = [];
let buyingInventoryType = localStorage.getItem("kc_buying_inventory_type") || "all";

if (!["all", "b2b", "private"].includes(buyingInventoryType)) {
  buyingInventoryType = "all";
}

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
let isBuyingLoading = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderBuyingInventoryTypeFilter() {
  return `
    <div class="buying-inventory-filter">
      <button class="buying-inventory-filter-btn ${buyingInventoryType === "all" ? "active" : ""}" type="button" data-buying-inventory-type="all">
        All Inventory
      </button>
      <button class="buying-inventory-filter-btn ${buyingInventoryType === "b2b" ? "active" : ""}" type="button" data-buying-inventory-type="b2b">
        B2B Only
      </button>
      <button class="buying-inventory-filter-btn ${buyingInventoryType === "private" ? "active" : ""}" type="button" data-buying-inventory-type="private">
        Margin Only
      </button>
    </div>
  `;
}

let selectedBuyingAction = null;
let pendingBuyingReload = false;
let buyingRequestSeq = 0;

async function loadBuyingProducts(options = {}) {
  if (isBuyingLoading) {
    if (options.force) pendingBuyingReload = true;
    return;
  }

  const requestSeq = ++buyingRequestSeq;

  try {
    isBuyingLoading = true;

    currentBuyingProducts = [];

    dealsGrid.innerHTML = `
      <div class="loading-state">
        <span>Searching<br>stock...</span>
      </div>
    `;

    const params = new URLSearchParams();

    if (searchQuery) params.set("search", searchQuery);
    if (selectedBrand) params.set("brand", selectedBrand);
    params.set("inventory_type", buyingInventoryType);

    if (selectedSort === "az" || selectedSort === "za") {
      params.set("sort", selectedSort);
    } else if (selectedSort === "payout_high") {
      params.set("sort", "price_high");
    } else {
      params.set("sort", "price_low");
    }

    const response = await fetch(`/api/buying/products?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load buying products");
    }

    if (requestSeq !== buyingRequestSeq || pendingBuyingReload) {
      return;
    }
    
    currentBuyingProducts = data.products || [];
    
    renderBuyingProducts();
  } catch (err) {
    console.error(err);

    dealsGrid.innerHTML = `
      <div class="empty-state">
        Failed to load buying stock.
      </div>
    `;
  } finally {
    isBuyingLoading = false;
    document.getElementById("loadingMore")?.remove();
    
    if (requestSeq === buyingRequestSeq && pendingBuyingReload) {
      pendingBuyingReload = false;
      loadBuyingProducts({ force: true });
    }
  }
}

function renderBuyingProductCard(product) {
  return `
    <article class="deal-card buying-card">
      <div class="deal-image-wrap">
        ${
          product.image_url
            ? `<img
                src="${escapeHtml(product.image_url)}"
                class="deal-image"
                onerror="this.closest('.deal-image-wrap').innerHTML = '<div class=&quot;image-placeholder&quot;><div class=&quot;placeholder-icon&quot;><span></span></div></div>'"
              />`
            : `
              <div class="image-placeholder">
                <div class="placeholder-icon"><span></span></div>
              </div>
            `
        }
      </div>

      <div class="deal-body">
        <div class="deal-top">
          <span class="deal-badge buying">Buy Stock</span>
          <span class="deal-time">${escapeHtml(product.fastest_delivery_time || "-")}</span>
        </div>

        <h3 class="deal-title">${escapeHtml(product.product_name || "-")}</h3>

        <div class="deal-meta">
          ${escapeHtml(product.sku || "-")} ${product.brand ? `• ${escapeHtml(product.brand)}` : ""}
        </div>

        <div class="deal-payouts">
          <div class="payout-box">
            <span class="payout-label">From</span>
            <span class="payout-value">${escapeHtml(product.from_price_display || "-")}</span>
          </div>

          <div class="payout-box">
            <span class="payout-label">Sizes</span>
            <span class="payout-value">${Number(product.size_count || 0)}</span>
          </div>
        </div>

        <button
          class="deal-btn buying-view-sizes-btn"
          type="button"
          data-product-key="${escapeHtml(product.key)}"
        >
          View Sizes
        </button>
      </div>
    </article>
  `;
}

function renderBuyingProducts() {
  if (!currentBuyingProducts.length) {
    dealsGrid.innerHTML = `
      <div class="empty-state">
        No buying stock found.
      </div>
    `;
    return;
  }

  const b2bNotice = buyingInventoryType === "b2b"
    ? `
      <div class="buying-b2b-notice">
        B2B Only selected — prices shown excl. VAT.
      </div>
    `
    : "";

  dealsGrid.innerHTML = `
    ${renderBuyingInventoryTypeFilter()}
    ${b2bNotice}
    ${currentBuyingProducts.map(renderBuyingProductCard).join("")}
  `;
}

function openBuyingProductModal(productKey) {
  const product = currentBuyingProducts.find((item) => item.key === productKey);

  if (!product) {
    alert("Product not found. Please refresh and try again.");
    return;
  }

  buyingProductModalContent.innerHTML = `
    <div class="buying-modal-header">
      <div class="buying-modal-image-wrap">
        ${
          product.image_url
            ? `<img
                src="${escapeHtml(product.image_url)}"
                class="buying-modal-image"
                onerror="this.closest('.buying-modal-image-wrap').innerHTML = '<div class=&quot;table-image-placeholder&quot;></div>'"
              />`
            : `<div class="table-image-placeholder"></div>`
        }
      </div>

      <div class="buying-modal-title-block">
        <h2>${escapeHtml(product.product_name || "-")}</h2>
        <p>${escapeHtml(product.sku || "-")} ${product.brand ? `• ${escapeHtml(product.brand)}` : ""}</p>
      </div>
    </div>

    <div class="buying-size-table">
      <div class="buying-size-table-head">
        <div>Size</div>
        <div>Lowest Price</div>
        <div>ETA</div>
        <div>Sources</div>
        <div>Available Qty</div>
        <div>Actions</div>
      </div>
    
      ${(product.sizes || []).map((size) => `
        <div class="buying-size-table-row">
          <div class="buying-size-main">
            ${escapeHtml(size.size || "-")}
          </div>
    
          <div class="buying-size-price">
            ${escapeHtml(size.lowest_price_display || "-")}
            ${
              buyingInventoryType === "b2b"
                ? `<span class="buying-price-note">excl. VAT</span>`
                : ""
            }
          </div>
    
          <div class="buying-size-sub">
            ${escapeHtml(size.fastest_delivery_time || "-")}
          </div>
    
          <div class="buying-size-sub">
            ${Number(size.source_count || 0)}
          </div>
    
          <div class="buying-size-sub">
            ${Number(size.available_qty || 0)}
          </div>
    
          <div class="buying-size-actions">
            <button
              class="table-btn buying-action-btn"
              type="button"
              data-buying-action="buy"
              data-product-key="${escapeHtml(product.key)}"
              data-size="${escapeHtml(size.size || "")}"
            >
              Buy
            </button>
            
            <button
              class="table-btn offer-btn buying-action-btn"
              type="button"
              data-buying-action="offer"
              data-product-key="${escapeHtml(product.key)}"
              data-size="${escapeHtml(size.size || "")}"
            >
              Offer
            </button>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  buyingProductModal.classList.remove("hidden");
}

function closeBuyingProductFlow() {
  buyingProductModal.classList.add("hidden");
  buyingProductModalContent.innerHTML = "";
}

function getBuyingInventoryTypeLabel() {
  if (buyingInventoryType === "b2b") return "B2B Only";
  if (buyingInventoryType === "private") return "Margin Only";
  return "All Inventory";
}

function openBuyingActionFlow(action, productKey, sizeValue) {
  if (!currentSeller) {
    openLoginModal();
    return;
  }

  const product = currentBuyingProducts.find((item) => item.key === productKey);
  const size = product?.sizes?.find((item) => String(item.size) === String(sizeValue));

  if (!product || !size) {
    alert("Product or size not found. Please refresh and try again.");
    return;
  }

  selectedBuyingAction = {
    action,
    product,
    size,
    inventoryType: buyingInventoryType
  };

  buyingActionError.textContent = "";
  buyingActionTitle.textContent = action === "buy" ? "Purchase Summary" : "Make Offer";

  const priceNote = buyingInventoryType === "b2b" ? " excl. VAT" : "";

  buyingActionContent.innerHTML = `
    <div class="buying-action-summary">
      <div>
        <span>Product</span>
        <strong>${escapeHtml(product.product_name || "-")}</strong>
      </div>

      <div>
        <span>SKU</span>
        <strong>${escapeHtml(product.sku || "-")}</strong>
      </div>

      <div>
        <span>Size</span>
        <strong>${escapeHtml(size.size || "-")}</strong>
      </div>

      <div>
        <span>${action === "buy" ? "Estimated Purchase Price" : "Current Lowest Price"}</span>
        <strong>${escapeHtml(size.lowest_price_display || "-")}${priceNote}</strong>
      </div>

      <div>
        <span>Inventory Type</span>
        <strong>${escapeHtml(getBuyingInventoryTypeLabel())}</strong>
      </div>

      <div>
        <span>Available Sources</span>
        <strong>${Number(size.source_count || 0)}</strong>
      </div>
    </div>

    ${
      action === "offer"
        ? `
          <label class="buying-offer-label">
            Your Offer
            <input id="buyingOfferAmountInput" class="offer-input" type="text" inputmode="numeric" placeholder="Enter your offer" />
          </label>
        `
        : `
          <p class="buying-action-note">
            Final seller confirmation is required before the purchase is completed.
          </p>
        `
    }
  `;

  buyingActionModal.classList.remove("hidden");

  document.getElementById("buyingOfferAmountInput")?.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "");
  });
}

function closeBuyingActionFlow() {
  buyingActionModal.classList.add("hidden");
  buyingActionContent.innerHTML = "";
  buyingActionError.textContent = "";
  selectedBuyingAction = null;
}

window.openBuyingProductModal = openBuyingProductModal;

dealsGrid.addEventListener("click", (event) => {
  const buyingActionButton = event.target.closest(".buying-action-btn");

  if (buyingActionButton) {
    openBuyingActionFlow(
      buyingActionButton.dataset.buyingAction,
      buyingActionButton.dataset.productKey,
      buyingActionButton.dataset.size
    );
    return;
  }
  
  const inventoryTypeButton = event.target.closest("[data-buying-inventory-type]");

  if (inventoryTypeButton) {
    buyingInventoryType = inventoryTypeButton.dataset.buyingInventoryType || "all";
    localStorage.setItem("kc_buying_inventory_type", buyingInventoryType);
    loadBuyingProducts({ force: true });
    return;
  }

  const button = event.target.closest(".buying-view-sizes-btn");

  if (!button) return;

  openBuyingProductModal(button.dataset.productKey);
});

buyingProductModalContent?.addEventListener("click", (event) => {
  const buyingActionButton = event.target.closest(".buying-action-btn");

  if (!buyingActionButton) return;

  openBuyingActionFlow(
    buyingActionButton.dataset.buyingAction,
    buyingActionButton.dataset.productKey,
    buyingActionButton.dataset.size
  );
});

closeBuyingProductModal?.addEventListener("click", closeBuyingProductFlow);

buyingProductModal?.addEventListener("click", (event) => {
  if (event.target === buyingProductModal) {
    closeBuyingProductFlow();
  }
});

closeBuyingActionModal?.addEventListener("click", closeBuyingActionFlow);
cancelBuyingActionBtn?.addEventListener("click", closeBuyingActionFlow);

buyingActionModal?.addEventListener("click", (event) => {
  if (event.target === buyingActionModal) {
    closeBuyingActionFlow();
  }
});

submitBuyingActionBtn?.addEventListener("click", () => {
  if (!selectedBuyingAction || !currentSeller) return;

  const offerInput = document.getElementById("buyingOfferAmountInput");

  const offerAmount =
    selectedBuyingAction.action === "offer"
      ? Number(offerInput?.value || 0)
      : null;

  buyingActionError.textContent = "";

  if (
    selectedBuyingAction.action === "offer" &&
    (!Number.isInteger(offerAmount) || offerAmount <= 0)
  ) {
    buyingActionError.textContent = "Enter a valid whole euro amount.";
    return;
  }

  console.log("Buying action submitted:", {
    action: selectedBuyingAction.action,
    sellerRecordId: currentSeller.id,
    sellerId: currentSeller.seller_id,
    sku: selectedBuyingAction.product.sku,
    productName: selectedBuyingAction.product.product_name,
    size: selectedBuyingAction.size.size,
    inventoryType: selectedBuyingAction.inventoryType,
    displayedPrice: selectedBuyingAction.size.lowest_price_display,
    offerAmount
  });

  closeBuyingActionFlow();

  showSuccessToast(
    selectedBuyingAction.action === "buy"
      ? "Purchase request prepared"
      : "Offer prepared"
  );
});

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
          <span>Searching<br>deals...</span>
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
  mainToggleButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mainMode === currentMainMode);
  });

  document.querySelector(".hero h2").textContent =
    currentMainMode === "buying"
      ? "Buy stock directly from the Kickz Caviar network"
      : "Sell inventory directly to Kickz Caviar";

  document.querySelector(".hero p").textContent =
    currentMainMode === "buying"
      ? "Browse available stock, view sizes and source inventory for your business."
      : "Claim Quick Deals instantly or place offers on active Want To Buys.";

  document.querySelector(".market-top-row").classList.toggle("hidden", currentMainMode === "buying");
  document.querySelector(".view-toggle").classList.toggle("hidden", currentMainMode === "buying");
  
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

mainToggleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentMainMode = button.dataset.mainMode || "selling";
    localStorage.setItem("kc_main_mode", currentMainMode);

    selectedBrand = "";
    brandFilter.value = "";
    searchQuery = "";
    searchInput.value = "";
    selectedSort = currentMainMode === "buying" ? buyingSort : sellingSort;
    sortFilter.value = selectedSort;

    syncMarketUi();

    if (currentMainMode === "buying") {
      loadBuyingProducts({ force: true });
    } else {
      loadBrands();
      loadDeals(currentType, true);
    }
  });
});

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
    if (currentMainMode === "buying") return;

    priceView = button.dataset.priceView;

    localStorage.setItem("kc_price_view", priceView);

    syncMarketUi();
    loadDeals(currentType, true);
  });
});

document.querySelectorAll(".view-btn").forEach((button) => {
  button.addEventListener("click", () => {
    if (currentMainMode === "buying") return;

    layoutView = button.dataset.view;

    localStorage.setItem("kc_layout_view", layoutView);

    syncMarketUi();
    renderDeals();
  });
});

searchQuery = "";
searchInput.value = "";

syncMarketUi();

if (currentMainMode === "buying") {
  loadBuyingProducts({ force: true });
} else {
  loadDeals(currentType);
}

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

  if (currentMainMode === "buying") {
    loadBuyingProducts({ force: true });
  } else {
    loadDeals(currentType, true);
  }
});

sortFilter.addEventListener("change", () => {
  selectedSort = sortFilter.value;

  if (currentMainMode === "buying") {
    buyingSort = selectedSort;
    localStorage.setItem("kc_buying_sort", buyingSort);
    loadBuyingProducts({ force: true });
  } else {
    sellingSort = selectedSort;
    localStorage.setItem("kc_selling_sort", sellingSort);
    loadDeals(currentType, true);
  }
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
    if (currentMainMode === "buying") {
      loadBuyingProducts({ force: true });
    } else {
      loadDeals(currentType, true);
    }
  }, 350);
});

window.addEventListener("scroll", () => {
  if (currentMainMode === "buying") return;
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
  heroConsignorCta?.classList.toggle(
    "hidden",
    currentSeller?.consignor === true
  );
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

forgotPasswordBtn.addEventListener("click", () => {
  loginForm.classList.add("hidden");
  forgotForm.classList.remove("hidden");

  loginError.textContent = "";
  forgotError.textContent = "";

  forgotEmail.value = loginEmail.value.trim();
  forgotEmail.focus();
});

backToLoginBtn.addEventListener("click", () => {
  forgotForm.classList.add("hidden");
  loginForm.classList.remove("hidden");

  forgotError.textContent = "";
  loginError.textContent = "";
});

forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  forgotError.textContent = "";
  forgotError.style.color = "#ff7b7b";

  try {
    const response = await fetch("/api/forgot-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: forgotEmail.value.trim()
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.details || "Failed to send password link");
    }

    forgotError.style.color = "#58d86a";
    forgotError.textContent = "If this email exists, a password link has been sent.";
  } catch (err) {
    forgotError.style.color = "#ff7b7b";
    forgotError.textContent = err.message;
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
