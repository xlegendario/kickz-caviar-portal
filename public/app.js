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
  return kcDialog("alert", message, options);
}

function showConfirm(message, options) {
  return kcDialog("confirm", message, options);
}

function showPrompt(message, options) {
  return kcDialog("prompt", message, options);
}

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
const openMemberWtbModalBtn = document.getElementById("openMemberWtbModalBtn");
const memberWtbChoiceModal = document.getElementById("memberWtbChoiceModal");
const closeMemberWtbChoiceModal = document.getElementById("closeMemberWtbChoiceModal");
const openSingleMemberWtbBtn = document.getElementById("openSingleMemberWtbBtn");
const openBulkMemberWtbBtn = document.getElementById("openBulkMemberWtbBtn");
const memberWtbModal = document.getElementById("memberWtbModal");
const closeMemberWtbModal = document.getElementById("closeMemberWtbModal");
const submitMemberWtbBtn = document.getElementById("submitMemberWtbBtn");
const memberWtbSkuInput = document.getElementById("memberWtbSkuInput");
const memberWtbSizeInput = document.getElementById("memberWtbSizeInput");
const memberWtbMaxPriceInput = document.getElementById("memberWtbMaxPriceInput");
const memberWtbInventoryTypeInput = document.getElementById("memberWtbInventoryTypeInput");
const memberWtbError = document.getElementById("memberWtbError");
const memberWtbCsvModal = document.getElementById("memberWtbCsvModal");
const closeMemberWtbCsvModal = document.getElementById("closeMemberWtbCsvModal");
const memberWtbCsvInventoryTypeInput = document.getElementById("memberWtbCsvInventoryTypeInput");
const memberWtbCsvInput = document.getElementById("memberWtbCsvInput");
const submitMemberWtbCsvBtn = document.getElementById("submitMemberWtbCsvBtn");
const memberWtbCsvPreview = document.getElementById("memberWtbCsvPreview");
const memberWtbCsvError = document.getElementById("memberWtbCsvError");
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
// Deep-link naar een tab: /?tab=wtb of /?tab=quick. Zonder dit opent de site
// altijd op wat er in localStorage staat, en kon je vanuit Discord dus niet
// rechtstreeks naar de WTB's linken.
const kcTabParam = new URLSearchParams(window.location.search).get("tab");

let currentType =
  kcTabParam === "wtb" || kcTabParam === "quick"
    ? kcTabParam
    : localStorage.getItem("kc_market_type") || "quick";

let priceView = localStorage.getItem("kc_price_view") || "margin";
let layoutView = localStorage.getItem("kc_layout_view") || "cards";
if (!["quick", "wtb"].includes(currentType)) {
  currentType = "quick";
}

// Een deep-link naar de WTB's moet ook de Selling-sectie openen; anders sta je
// in Buying en zie je de tab niet eens.
if (kcTabParam === "wtb" || kcTabParam === "quick") {
  currentMainMode = "selling";
  localStorage.setItem("kc_main_mode", "selling");
  localStorage.setItem("kc_market_type", currentType);
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
let pendingBuyingProductKey = null;
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
    if (currentMainMode !== "buying") {
      return;
    }
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
    showAlert("Product not found. Please refresh and try again.");
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

// NEW — the same typed number means something different per filter, and
// the member cannot see the VAT type of the item behind an offer. On
// "All Inventory" the backend reads the amount as ALL-IN and divides the
// 21% out for VAT0/VAT21 units (getMemberWtbNetSalePrice); on "B2B Only"
// it is already excl. VAT and nothing is divided. The hint only appears
// where the amount can still be recalculated — on B2B and Margin it
// cannot, so there is nothing to warn about.
// Which scale a Want To Buy amount is read in, and why.
//
// Naming the buying type is the point: the dropdown that decides this sits
// right above the hint, so a member who reads "excl. VAT" and did not mean
// that has an obvious next move. Without it the scale reads as a rule about
// us rather than a consequence of their own choice.
function getMemberWtbScaleHint(inventoryType, forCsv) {
  const subject = forCsv ? "prices in this file are" : "your price is";

  if (inventoryType === "b2b") {
    return `With buying type B2B Only, ${subject} read as excl. VAT.`;
  }

  if (inventoryType === "private") {
    return `With buying type Margin Only, ${subject} read as incl. VAT.`;
  }

  return `With buying type All Types, ${subject} read as incl. VAT. ` +
    "If it matches a B2B seller the invoice amount is recalculated as a VAT0 price.";
}

function getBuyingOfferInputCopy() {
  if (buyingInventoryType === "b2b") {
    return {
      label: "Your offer:",
      placeholder: "Enter your price (excl. VAT)",
      hint: ""
    };
  }

  if (buyingInventoryType === "private") {
    return {
      label: "Your offer:",
      placeholder: "Enter your price (incl. VAT)",
      hint: ""
    };
  }

  return {
    label: "Your offer:",
    placeholder: "Enter your price (incl. VAT)",
    hint: "If your offer matches a B2B seller, the invoice amount will be recalculated as VAT0 price."
  };
}
function openBuyingActionFlow(action, productKey, sizeValue) {
  if (!currentSeller) {
    pendingBuyingProductKey = productKey;
  
    closeBuyingProductFlow();
    openLoginModal();
    return;
  }
  const product = currentBuyingProducts.find((item) => item.key === productKey);
  const size = product?.sizes?.find((item) => String(item.size) === String(sizeValue));
  if (!product || !size) {
    showAlert("Product or size not found. Please refresh and try again.");
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
  const sourceCount = Number(size.source_count || 0);
  
  const buyNote =
    sourceCount > 1
      ? "The seller must confirm availability before the purchase is finalized. Other matching sources may be contacted if needed."
      : "The seller must confirm availability before the purchase is finalized.";
  
  const offerNote =
    sourceCount > 1
      ? "Offer sent to all matching sources."
      : "Offer sent to matching source.";

  // Read at render time, so the copy always matches the filter that is
  // active right now. The modal is rebuilt on every open, so switching
  // filters and reopening picks up the new wording by itself.
  const offerInputCopy = getBuyingOfferInputCopy();
  
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
          <p class="buying-action-note">
            ${escapeHtml(offerNote)}
          </p>
    
          <label class="buying-offer-label">
            ${escapeHtml(offerInputCopy.label)}
            <input id="buyingOfferAmountInput" class="offer-input" type="text" inputmode="numeric" placeholder="${escapeHtml(offerInputCopy.placeholder)}" />
          </label>

          ${
            offerInputCopy.hint
              ? `<p class="buying-offer-scale-hint">${escapeHtml(offerInputCopy.hint)}</p>`
              : ""
          }
        `
        : `
          <p class="buying-action-note">
            ${escapeHtml(buyNote)}
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
  const inventoryTypeButton = event.target.closest("[data-buying-inventory-type]");
  if (inventoryTypeButton) {
    buyingInventoryType = inventoryTypeButton.dataset.buyingInventoryType || "all";
    localStorage.setItem("kc_buying_inventory_type", buyingInventoryType);
    // NEW — close an open offer modal on a filter switch. Its labels are
    // rendered for the filter that was active when it opened, so leaving
    // it up would show "incl. VAT" while the member has just moved to
    // B2B Only. Cheaper and safer than re-rendering it in place.
    closeBuyingActionFlow();
    loadBuyingProducts({ force: true });
    return;
  }
  // NEW - the Selling card's buttons. They used to carry an inline
  // onclick; both cards render into this same grid, so one listener covers
  // them.
  const dealButton = event.target.closest("[data-deal-action]");

  if (dealButton) {
    const dealId = dealButton.dataset.dealId;
    if (!dealId) return;

    if (dealButton.dataset.dealAction === "claim") openClaimModal(dealId);
    else openOfferFlow(dealId);

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
function cleanMemberWtbSkuInput(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
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
function parseMemberWtbCsv(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one WTB row.");
  }
  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter)
    .map((header) =>
      String(header || "")
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase()
    );
  const requiredColumns = ["sku", "size", "max price"];
  const missingColumns = requiredColumns.filter(
    (column) => !headers.includes(column)
  );
  if (missingColumns.length) {
    throw new Error(`Missing required columns: ${missingColumns.join(", ")}`);
  }
  const columnIndex = (name) => headers.indexOf(name);
  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line, delimiter);
    return {
      row_number: index + 2,
      sku: cleanMemberWtbSkuInput(values[columnIndex("sku")]),
      size: String(values[columnIndex("size")] || "").trim(),
      max_price: Number(String(values[columnIndex("max price")] || "").replace(/[^\d]/g, ""))
    };
  });
  const errors = [];
  rows.forEach((row) => {
    if (!row.sku) errors.push(`Row ${row.row_number}: missing SKU`);
    if (!row.size) errors.push(`Row ${row.row_number}: missing Size`);
    if (!Number.isInteger(row.max_price) || row.max_price <= 0) {
      errors.push(`Row ${row.row_number}: invalid Max Price`);
    }
  });
  return {
    rows,
    errors
  };
}
function openMemberWtbChoiceModalFlow() {
  if (!currentSeller) {
    openLoginModal();
    return;
  }
  memberWtbChoiceModal?.classList.remove("hidden");
}
function closeMemberWtbChoiceModalFlow() {
  memberWtbChoiceModal?.classList.add("hidden");
}
function openMemberWtbModalFlow() {
  closeMemberWtbChoiceModalFlow();
  memberWtbError.textContent = "";
  memberWtbSkuInput.value = "";
  memberWtbSizeInput.value = "";
  memberWtbMaxPriceInput.value = "";
  memberWtbInventoryTypeInput.value = buyingInventoryType || "all";
  refreshMemberWtbScaleHint();
  memberWtbModal?.classList.remove("hidden");
  setTimeout(() => memberWtbSkuInput?.focus(), 50);
}
function closeMemberWtbModalFlow() {
  memberWtbModal?.classList.add("hidden");
  memberWtbError.textContent = "";
}
function openMemberWtbCsvModalFlow() {
  closeMemberWtbChoiceModalFlow();
  if (memberWtbCsvInventoryTypeInput) {
    memberWtbCsvInventoryTypeInput.value = buyingInventoryType || "all";
    refreshMemberWtbCsvScaleHint();
  }
  if (memberWtbCsvInput) memberWtbCsvInput.value = "";
  if (memberWtbCsvPreview) memberWtbCsvPreview.textContent = "";
  if (memberWtbCsvError) memberWtbCsvError.textContent = "";
  memberWtbCsvModal?.classList.remove("hidden");
}
function closeMemberWtbCsvModalFlow() {
  memberWtbCsvModal?.classList.add("hidden");
  if (memberWtbCsvPreview) memberWtbCsvPreview.textContent = "";
  if (memberWtbCsvError) memberWtbCsvError.textContent = "";
}
openMemberWtbModalBtn?.addEventListener("click", openMemberWtbChoiceModalFlow);
closeMemberWtbChoiceModal?.addEventListener("click", closeMemberWtbChoiceModalFlow);
openSingleMemberWtbBtn?.addEventListener("click", openMemberWtbModalFlow);
openBulkMemberWtbBtn?.addEventListener("click", openMemberWtbCsvModalFlow);
closeMemberWtbModal?.addEventListener("click", closeMemberWtbModalFlow);
closeMemberWtbCsvModal?.addEventListener("click", closeMemberWtbCsvModalFlow);
memberWtbChoiceModal?.addEventListener("click", (event) => {
  if (event.target === memberWtbChoiceModal) {
    closeMemberWtbChoiceModalFlow();
  }
});
memberWtbModal?.addEventListener("click", (event) => {
  if (event.target === memberWtbModal) {
    closeMemberWtbModalFlow();
  }
});
memberWtbCsvModal?.addEventListener("click", (event) => {
  if (event.target === memberWtbCsvModal) {
    closeMemberWtbCsvModalFlow();
  }
});
memberWtbSkuInput?.addEventListener("input", () => {
  memberWtbSkuInput.value = cleanMemberWtbSkuInput(memberWtbSkuInput.value);
});
// Both modals keep their hint in step with their own dropdown. Written once
// so the single and the bulk flow can never end up saying different things
// about the same choice.
function refreshMemberWtbScaleHint() {
  const target = document.getElementById("memberWtbScaleHint");
  if (!target || !memberWtbInventoryTypeInput) return;

  target.textContent = getMemberWtbScaleHint(memberWtbInventoryTypeInput.value, false);
}

function refreshMemberWtbCsvScaleHint() {
  const select = document.getElementById("memberWtbCsvInventoryTypeInput");
  const target = document.getElementById("memberWtbCsvScaleHint");
  if (!select || !target) return;

  target.textContent = getMemberWtbScaleHint(select.value, true);
}

memberWtbInventoryTypeInput?.addEventListener("change", refreshMemberWtbScaleHint);

document
  .getElementById("memberWtbCsvInventoryTypeInput")
  ?.addEventListener("change", refreshMemberWtbCsvScaleHint);

memberWtbMaxPriceInput?.addEventListener("input", () => {
  memberWtbMaxPriceInput.value = memberWtbMaxPriceInput.value.replace(/\D/g, "");
});
submitMemberWtbBtn?.addEventListener("click", async () => {
  if (!currentSeller) {
    openLoginModal();
    return;
  }
  const sku = cleanMemberWtbSkuInput(memberWtbSkuInput.value);
  const size = memberWtbSizeInput.value.trim();
  const maxPrice = Number(memberWtbMaxPriceInput.value);
  memberWtbError.textContent = "";
  if (!sku || !size || !Number.isInteger(maxPrice) || maxPrice <= 0) {
    memberWtbError.textContent = "Enter SKU, size and a valid max price.";
    return;
  }
  submitMemberWtbBtn.disabled = true;
  submitMemberWtbBtn.textContent = "Submitting...";
  try {
    const response = await fetch("/api/member-wtb/open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        seller_record_id: currentSeller.id,
        seller_id: currentSeller.seller_id,
        sku,
        size,
        max_price: maxPrice,
        inventory_type: memberWtbInventoryTypeInput.value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to place Want To Buy");
    }
    closeMemberWtbModalFlow();
    showSuccessToast("Want To Buy placed successfully");
  } catch (err) {
    memberWtbError.textContent = err.message;
  } finally {
    submitMemberWtbBtn.disabled = false;
    submitMemberWtbBtn.textContent = "Submit Want To Buy";
  }
});
submitMemberWtbCsvBtn?.addEventListener("click", async () => {
  if (!currentSeller) {
    openLoginModal();
    return;
  }
  if (memberWtbCsvError) memberWtbCsvError.textContent = "";
  if (memberWtbCsvPreview) memberWtbCsvPreview.textContent = "";
  const file = memberWtbCsvInput?.files?.[0];
  if (!file) {
    memberWtbCsvError.textContent = "Please choose a CSV file.";
    return;
  }
  try {
    const text = await file.text();
    const result = parseMemberWtbCsv(text);
    if (result.errors.length) {
      memberWtbCsvError.innerHTML = result.errors
        .slice(0, 12)
        .map((error) => `<div>${escapeHtml(error)}</div>`)
        .join("");
      return;
    }
    submitMemberWtbCsvBtn.disabled = true;
    submitMemberWtbCsvBtn.textContent = "Uploading...";
    memberWtbCsvInput.disabled = true;

    // Queued as one job instead of posted row by row.
    //
    // The old loop meant a member had to keep the tab open for the whole
    // file. Closing it stopped the import halfway with nothing on screen
    // saying where, and re-uploading then duplicated everything that had
    // already gone through - nothing dedupes want-to-buys. The same worker
    // that handles consignment stock now runs it, so it survives a closed
    // tab and resumes where it stopped.
    const queued = await fetch("/api/member-wtb/csv-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seller_record_id: currentSeller.id,
        seller_id: currentSeller.seller_id,
        inventory_type: memberWtbCsvInventoryTypeInput.value,
        created_from: "Buying Portal CSV",
        rows: result.rows
      })
    });

    const queuedData = await queued.json().catch(() => ({}));

    if (!queued.ok) {
      // The server answers with every bad row at once, one per line.
      memberWtbCsvError.innerHTML = String(queuedData.error || "Upload failed")
        .split(/\n/)
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join("");
      return;
    }

    closeMemberWtbCsvModalFlow();
    showSuccessToast(
      `${queuedData.count} Want To Buys queued — they are being posted now`
    );
    if (currentMainMode === "buying") {
      loadBuyingProducts({ force: true });
    }
  } catch (err) {
    memberWtbCsvError.textContent = err.message;
  } finally {
    submitMemberWtbCsvBtn.disabled = false;
    submitMemberWtbCsvBtn.textContent = "Upload CSV";
    memberWtbCsvInput.disabled = false;
  }
});
submitBuyingActionBtn?.addEventListener("click", async () => {
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
  submitBuyingActionBtn.disabled = true;
  submitBuyingActionBtn.textContent = "Submitting...";
  try {
    const endpoint =
      selectedBuyingAction.action === "offer"
        ? "/api/buying/offers"
        : "/api/buying/requests";
    
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        seller_record_id: currentSeller.id,
        seller_id: currentSeller.seller_id,
        sku: selectedBuyingAction.product.sku,
        size: selectedBuyingAction.size.size,
        inventory_type: selectedBuyingAction.inventoryType,
        offer_price: offerAmount
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || data.details || "Failed to submit purchase request");
    }
    closeBuyingActionFlow();
    closeBuyingProductFlow();
    showSuccessToast(
      selectedBuyingAction.action === "offer"
        ? "Offer submitted"
        : "Purchase request submitted"
    );
    if (currentMainMode === "buying") {
      loadBuyingProducts({ force: true });
    }
  } catch (err) {
    buyingActionError.textContent = err.message;
  } finally {
    submitBuyingActionBtn.disabled = false;
    submitBuyingActionBtn.textContent = "Submit";
  }
});
let dealsRequestSeq = 0;
async function loadDeals(type = "quick", reset = true) {
  if (isLoading) return;
  const requestSeq = ++dealsRequestSeq;
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
    if (currentMainMode !== "selling") {
      return;
    }
    if (!response.ok) {
      throw new Error(data.details || data.error || "Failed to load deals");
    }
    if (requestSeq !== dealsRequestSeq) {
      return;
    }
    currentDeals = reset
      ? data.deals
      : [...currentDeals, ...data.deals];
    nextOffset = data.next_offset || "";
    hasMore = !!data.has_more;
    renderDeals();
  } catch (err) {
    console.error(err);
    if (requestSeq === dealsRequestSeq) {
      dealsGrid.innerHTML = `
        <div class="empty-state">
          Failed to load deals.
        </div>
      `;
    }
  } finally {
    if (requestSeq === dealsRequestSeq) {
      isLoading = false;
      renderLoadingMore();
    }
  }
}
function renderDealCard(deal) {
  const isQuick = (deal.deal_type || currentType) === "quick";
  const isClaimProcessing = deal.fulfillment_status === "Claim Processing";
  const payoutHtml = isQuick
    ? `
      <div class="deal-payouts">
        <div class="payout-box">
          <span class="payout-label">Current</span>
          <span class="payout-value">
            ${escapeHtml(priceView === "vat0" ? deal.current_payout_vat0 || "-" : deal.current_payout_margin || "-")}
          </span>
        </div>
        <div class="payout-box">
          <span class="payout-label">Max</span>
          <span class="payout-value">
            ${escapeHtml(priceView === "vat0" ? deal.max_payout_vat0 || "-" : deal.max_payout_margin || "-")}
          </span>
        </div>
      </div>
    `
    : `
      <div class="deal-payouts">
        <div class="payout-box">
          <span class="payout-label">Current Offer</span>
          <span class="payout-value">
            ${escapeHtml(priceView === "vat0" ? deal.current_offer_vat0 || "No offer yet" : deal.current_offer_margin || "No offer yet")}
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
                src="${escapeHtml(deal.image_url)}"
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
            <!-- FIXED (A5) - no fallback here, so a missing time_to_max put
                 the literal word "undefined" on the card. The Buying card
                 right next to it guards every field with || "-". -->
            ${isQuick ? escapeHtml(deal.time_to_max || "-") : "Offer Eligible"}
          </span>
        </div>
        <h3 class="deal-title">
          ${escapeHtml(deal.product || "-")}
        </h3>
        <div class="deal-meta">
          ${escapeHtml(deal.sku || "-")} • ${escapeHtml(deal.size || "-")}
        </div>
        ${payoutHtml}
        <!-- CHANGED (C1) - the id went straight into an inline onclick, so
             an apostrophe in it broke out of the attribute and took the
             handler with it. The Buying card in this same file already uses
             a data attribute plus one delegated listener; this now does the
             same. -->
        <button
          class="deal-btn ${!isQuick ? "offer-btn" : ""} ${isClaimProcessing ? "disabled-btn" : ""}"
          type="button"
          ${isClaimProcessing ? "disabled" : ""}
          data-deal-id="${escapeHtml(deal.id || "")}"
          data-deal-action="${isQuick ? "claim" : "offer"}"
        >
          ${isClaimProcessing ? "Claim in Progress..." : isQuick ? "Claim Deal" : "Make Offer"}
        </button>
      </div>
    </article>
  `;
}
function renderDealTable(deals) {
  return `
    <div class="table-wrap ${currentType === "quick" ? "quick-table" : "wtb-table"}">
      <div class="table-head">
        <div></div>
        <div>Product</div>
        <div>SKU</div>
        <div>Size</div>
        <div>Deal Type</div>
        <div>Current</div>
        <div>Max Payout</div>
        <div>Timer</div>
        <div></div>
      </div>
      ${deals.map((deal) => {
        const isQuick = (deal.deal_type || currentType) === "quick";
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
                : "<div></div>"
            }
            ${
              isQuick
                ? `<div>${deal.time_to_max || "-"}</div>`
                : "<div></div>"
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
  openMemberWtbModalBtn?.classList.toggle("hidden", currentMainMode !== "buying");
  heroConsignorCta?.classList.toggle(
    "hidden",
    currentMainMode !== "selling" || currentSeller?.consignor === true
  );
  
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
syncMarketUi();
if (currentMainMode === "buying") {
  loadBuyingProducts({ force: true });
} else {
  loadDeals(currentType);
}
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
    currentMainMode !== "selling" || currentSeller?.consignor === true
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
    
    if (pendingBuyingProductKey) {
      const productKey = pendingBuyingProductKey;
      pendingBuyingProductKey = null;
    
      setTimeout(() => {
        openBuyingProductModal(productKey);
      }, 250);
    }
    
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
    showAlert("Deal not found. Please refresh and try again.");
    return;
  }
  // FIXED — a real, confirmed bug found via his live report: this
  // never checked what TYPE the deal actually is before opening the
  // Quick Deal claim flow — combined with the render-time bug (fixed
  // above, deal.deal_type now used instead of the global tab state),
  // this is the second half of the same defense: even if a stale
  // render somehow slipped through, the actual claim action itself
  // now refuses to proceed on a deal that isn't genuinely a Quick
  // Deal (deal_type !== "quick"), rather than trusting the button
  // that was clicked.
  if (selectedDeal.deal_type && selectedDeal.deal_type !== "quick") {
    showAlert("This listing is a Want To Buy, not a Quick Deal. Please refresh and use Make Offer instead.");
    selectedDeal = null;
    loadDeals(currentType, true);
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
    showAlert("Deal not found. Please refresh and try again.");
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
        vatType: selectedOfferVatType,
        sourceType: selectedOfferDeal.source_type || "order"
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const failure = new Error(data.error || data.details || "Offer failed");
      // De Discord-gate stuurt een code en een link mee; zonder deze twee
      // regels blijft daar alleen kale tekst van over en kan de seller er
      // niets mee.
      failure.code = data.code || "";
      // De nieuwe middleware onderscheidt "nooit gekoppeld" van "eruit
      // gestapt" via reason; zonder deze regel valt dat verschil weg en
      // staat er "Link Discord" op een knop die "Rejoin" hoort te zeggen.
      failure.reason = data.reason || "";
      failure.details = data.details || "";
      failure.linkUrl = data.link_url || "";
      throw failure;
    }
    closeOfferFlow();
    currentDeals = [];
    nextOffset = "";
    hasMore = false;
    await loadDeals(currentType);
    showSuccessToast("Offer submitted successfully");
  } catch (err) {
    if (err.linkUrl) {
      offerError.innerHTML = "";

      const line = document.createElement("div");
      line.textContent = err.message;
      offerError.appendChild(line);

      if (err.details) {
        const detail = document.createElement("div");
        detail.className = "offer-error-detail";
        detail.textContent = err.details;
        offerError.appendChild(detail);
      }

      const link = document.createElement("a");
      link.className = "offer-error-action";
      link.href = err.linkUrl;

      // Het Discord-logo erbij, net als in het dashboard en op de
      // offer-pagina. Dit was een kale gouden knop, en goud is de kleur van
      // onze eigen acties - deze stuurt je ergens anders heen.
      link.innerHTML =
        '<svg viewBox="0 0 127.14 96.36" aria-hidden="true" focusable="false">' +
        '<path fill="currentColor" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>' +
        "<span></span>";

      // Twee redenen om geweigerd te worden, twee codes: de oude guard stuurt
      // discord_left_server, de nieuwe middleware discord_not_linked met een
      // reason erbij. Allebei nakijken, anders leest iemand die de server
      // heeft verlaten "Link Discord" terwijl hij al gekoppeld is.
      const eruitGestapt =
        err.code === "discord_left_server" || err.reason === "left_server";

      link.querySelector("span").textContent = eruitGestapt
        ? "Rejoin Discord"
        : "Link Discord";

      offerError.appendChild(link);
    } else {
      offerError.textContent = err.message;
    }
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

// NEW — additive: dialogs did not behave. The page behind them scrolled
// along, and Escape closed nothing. Both belong to the dialog itself rather
// than to whatever opens it, so this sits in one place for every dialog in
// this portal.
(function () {
  const VENSTERS = ".modal-backdrop";
  const SLUITKNOPPEN = ".modal-close";

  function openDialogs() {
    return Array.from(document.querySelectorAll(VENSTERS))
      .filter((v) => getComputedStyle(v).display !== "none" && !v.classList.contains("hidden"));
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

  syncOpenState();
})();
// Sessie-revalidatie. localStorage ("kc_seller") overleeft het verlopen of
// wissen van de sessiecookie, waardoor de UI ingelogd bleef lijken terwijl elke
// schrijfactie een 401 kreeg. Deze check brengt beide weer in lijn.
(async () => {
  if (!currentSeller) return;

  try {
    const response = await fetch("/api/session");

    if (response.status === 401) {
      localStorage.removeItem("kc_seller");
      currentSeller = null;
      updateLoginState();
      return;
    }

    if (!response.ok) return;

    const data = await response.json();

    if (data?.seller) {
      currentSeller = data.seller;
      localStorage.setItem("kc_seller", JSON.stringify(currentSeller));
      updateLoginState();
    }
  } catch (err) {
    // Netwerkfout: laat de bestaande staat met rust.
  }
})();
