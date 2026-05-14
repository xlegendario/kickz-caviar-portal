const dealsGrid = document.getElementById("dealsGrid");

const marketTabs = document.querySelectorAll(".market-tab");

let currentType = "quick";

async function loadDeals(type = "quick") {
  try {

    dealsGrid.innerHTML = `
      <div class="loading-state">
        Loading deals...
      </div>
    `;

    const response = await fetch(`/api/deals?type=${type}`);

    const data = await response.json();

    if (!data.deals?.length) {
      dealsGrid.innerHTML = `
        <div class="empty-state">
          No deals available.
        </div>
      `;
      return;
    }

    dealsGrid.innerHTML = data.deals
      .map(renderDealCard)
      .join("");

  } catch (err) {
    console.error(err);

    dealsGrid.innerHTML = `
      <div class="empty-state">
        Failed to load deals.
      </div>
    `;
  }
}

function renderDealCard(deal) {

  const isQuick = deal.auto_offer_accept === "Yes";

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

                <div class="placeholder-icon">
                  🖼️
                </div>
              
                <div class="placeholder-text">
                  Image Not Available
                </div>
              
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

        <button class="deal-btn ${!isQuick ? "offer-btn" : ""}">
          ${isQuick ? "Claim Deal" : "Make Offer"}
        </button>

      </div>

    </article>
  `;
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
