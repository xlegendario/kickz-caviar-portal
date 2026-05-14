const dealsGrid = document.getElementById("dealsGrid");

const marketTabs = document.querySelectorAll(".market-tab");

let currentType = "quick";
let currentDeals = [];
let nextOffset = "";
let hasMore = false;
let isLoading = false;

async function loadDeals(type = "quick", reset = true) {
  if (isLoading) return;

  try {
    isLoading = true;

    if (reset) {
      currentDeals = [];
      nextOffset = "";
      hasMore = false;

      dealsGrid.innerHTML = `
        <div class="loading-state">
          Loading deals...
        </div>
      `;
    }

    const params = new URLSearchParams({
      type,
      page_size: "40"
    });

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
            ${deal.current_payout_margin || "-"}
          </span>
        </div>

        <div class="payout-box">
          <span class="payout-label">Max</span>
          <span class="payout-value">
            ${deal.max_payout_margin || "-"}
          </span>
        </div>

      </div>
    `
    : `
      <div class="deal-payouts">

        <div class="payout-box">
          <span class="payout-label">Max Offer</span>
          <span class="payout-value">
            ${deal.max_offer || "-"}
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

function renderDeals() {
  if (!currentDeals.length) {
    dealsGrid.innerHTML = `
      <div class="empty-state">
        No deals available.
      </div>
    `;
    return;
  }

  dealsGrid.innerHTML = currentDeals
    .map(renderDealCard)
    .join("");

  renderLoadingMore();
}

function renderLoadingMore() {
  document.getElementById("loadingMore")?.remove();

  if (!hasMore) return;

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

marketTabs.forEach((tab, index) => {

  tab.addEventListener("click", () => {

    marketTabs.forEach((t) => {
      t.classList.remove("active");
    });

    tab.classList.add("active");

    currentType = index === 0 ? "quick" : "wtb";

    loadDeals(currentType);

  });

});

loadDeals();

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
const loginModal = document.getElementById("loginModal");
const closeLoginModal = document.getElementById("closeLoginModal");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");

const claimModal = document.getElementById("claimModal");
const closeClaimModal = document.getElementById("closeClaimModal");
const confirmClaimBtn = document.getElementById("confirmClaimBtn");
const claimError = document.getElementById("claimError");
const vatOptions = document.querySelectorAll(".vat-option");

let selectedDeal = null;
let selectedVatType = "Margin";

let currentSeller = JSON.parse(localStorage.getItem("kc_seller") || "null");

function updateLoginState() {
  if (currentSeller) {
    loginBtn.textContent = currentSeller.discord || currentSeller.seller_id || "Account";
  } else {
    loginBtn.textContent = "Login";
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
  if (currentSeller) {
    const shouldLogout = confirm(`Logged in as ${currentSeller.discord}. Logout?`);

    if (shouldLogout) {
      localStorage.removeItem("kc_seller");
      currentSeller = null;
      updateLoginState();
    }

    return;
  }

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

  alert(`Offer flow coming next for deal: ${dealId}`);
}

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
