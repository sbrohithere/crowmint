// -----------------------------------------------------------------------------
// SUPABASE CATALOG + LOCAL CART
// -----------------------------------------------------------------------------

const runtimeConfig = window.CROWMINT_CONFIG || {};
const SUPABASE_URL = runtimeConfig.supabaseUrl || "YOUR_SUPABASE_PROJECT_URL";
const SUPABASE_ANON_KEY = runtimeConfig.supabaseAnonKey || "YOUR_SUPABASE_ANON_KEY";
const RAZORPAY_ENABLED = runtimeConfig.razorpayEnabled === true;

let supabaseClient = null;
let supabaseSdkPromise = null;

const ADMIN_SESSION_KEY = "crowmint-admin-session";
let currentAdminUser = null;

function isApprovedAdmin(user) {
  return Boolean(user?.email);
}

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem("crowmint-cart"));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

const products = [];
const categories = [];
const discounts = [];
const state = { category: "All", search: "", sort: "featured", cart: loadCart(), productDiscounts: {} };

function saveStore() {
  localStorage.setItem("crowmint-cart", JSON.stringify(state.cart));
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY) &&
    !SUPABASE_URL.startsWith("YOUR_") &&
    !SUPABASE_ANON_KEY.startsWith("YOUR_");
}

function loadSupabaseSdk() {
  if (window.supabase?.createClient) return Promise.resolve();
  if (supabaseSdkPromise) return supabaseSdkPromise;
  supabaseSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return supabaseSdkPromise;
}

async function getSupabaseClient() {
  await loadSupabaseSdk();
  if (!supabaseClient) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabaseClient;
}

const el = id => document.getElementById(id);
const productGrid = el("productGrid");
const categoryTabs = el("categoryTabs");
const money = value => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 0
}).format(value);

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function storageFileName(filePath) {
  const lastSegment = String(filePath || "").split("/").pop() || "crowmint-download";
  let decoded = lastSegment;
  try { decoded = decodeURIComponent(lastSegment); } catch { /* Keep the Storage object name as-is. */ }
  return decoded.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, "") || "crowmint-download";
}

function mapProduct(row) {
  return { id: row.id, name: row.name, price: Number(row.price ?? row.personal_price), personalPrice: Number(row.personal_price ?? row.price), commercialPrice: Number(row.commercial_price ?? row.price), isFree: Boolean(row.is_free), freeForFirstEnabled: Boolean(row.free_for_first_enabled), freeForFirstLimit: Number(row.free_for_first_limit || 0), freeForFirstClaimedCount: Number(row.free_for_first_claimed_count || 0), category: row.category, image: row.image_url, previewImages: row.preview_images || [], description: row.description, included: row.included, fileType: row.file_type, fileName: row.file_name, filePath: row.file_path || "", version: row.version, supportContact: row.support_contact, refundPolicy: row.refund_policy, faqs: row.faqs || [], status: row.status, allowDiscounts: row.allow_discounts, createdAt: row.created_at };
}

function productIdentity(product) {
  return `${String(product.name || "").trim().toLowerCase()}::${String(product.category || "").trim().toLowerCase()}`;
}

function canonicalPublishedProducts(rows) {
  const canonical = new Map();
  rows.map(mapProduct).forEach(product => {
    if (!product.filePath) return;
    const key = productIdentity(product);
    const current = canonical.get(key);
    if (!current || new Date(product.createdAt || 0) > new Date(current.createdAt || 0)) canonical.set(key, product);
  });
  return [...canonical.values()];
}

function reconcileCartWithCatalog() {
  const byId = new Map(products.map(product => [String(product.id), product]));
  const byIdentity = new Map(products.map(product => [productIdentity(product), product]));
  const reconciled = state.cart.map(item => {
    const current = byId.get(String(item.id)) || byIdentity.get(productIdentity(item));
    if (!current?.filePath) return null;
    const license = item.selectedLicense || "personal";
    const price = license === "commercial"
      ? Number(current.commercialPrice ?? current.price)
      : Number(current.personalPrice ?? current.price);
    return { ...current, price, selectedLicense: license, cartKey: `${current.id}:${license}`, discountAmount: item.discountAmount || 0, discountCode: item.discountCode || null };
  }).filter(Boolean);
  state.cart = [...new Map(reconciled.map(item => [item.cartKey, item])).values()];
  saveStore();
}

function isFreeProduct(product) {
  return product.isFree || (Number(product.personalPrice ?? product.price) === 0 && Number(product.commercialPrice ?? product.price) === 0);
}

function hasFreeFirstAvailability(product) {
  return product.freeForFirstEnabled && product.freeForFirstLimit > 0 && product.freeForFirstClaimedCount < product.freeForFirstLimit;
}

function canClaimWithoutPayment(product) {
  return isFreeProduct(product) || hasFreeFirstAvailability(product);
}

function freeFirstBadge(product) {
  return product.freeForFirstEnabled && product.freeForFirstLimit > 0
    ? `<span class="offer-badge">Free for first ${escapeHtml(product.freeForFirstLimit)} customers</span>` : "";
}

async function initializeMarketplaceData() {
  if (!isSupabaseConfigured()) {
    renderRoute();
    productGrid.innerHTML = `<div class="empty-state"><div class="empty-state-content"><h3>Marketplace is not configured.</h3><p>Add the Supabase URL and anon key near the top of script.js.</p></div></div>`;
    return;
  }
  try {
    const client = await getSupabaseClient();
    const [productResult, categoryResult] = await Promise.all([
      client.from("products").select("*").eq("status", "published").order("created_at", { ascending: false }),
      client.from("categories").select("name").order("name")
    ]);
    if (productResult.error) throw productResult.error;
    if (categoryResult.error) throw categoryResult.error;
    products.splice(0, products.length, ...canonicalPublishedProducts(productResult.data || []));
    reconcileCartWithCatalog();
    categories.splice(0, categories.length, ...(categoryResult.data || []).map(row => row.name));
    renderRoute();
    await resumePendingCartCheckout();
  } catch (error) {
    renderRoute();
    productGrid.innerHTML = `<div class="empty-state"><div class="empty-state-content"><h3>Unable to load the marketplace.</h3><p>${escapeHtml(error.message)}</p></div></div>`;
  }
}

function ratingMarkup(product, detailed = false) {
  if (!product.rating || !product.reviews) return `<span class="new-product">New product</span>`;
  return `<span class="rating">★ ${escapeHtml(product.rating)} <span>${detailed ? `${escapeHtml(product.reviews)} reviews` : `(${escapeHtml(product.reviews)})`}</span></span>`;
}

function renderCategories() {
  const visibleCategories = ["All", ...categories];
  if (!visibleCategories.includes(state.category)) state.category = "All";
  categoryTabs.innerHTML = visibleCategories.map(category => `
    <button type="button" class="category-tab ${state.category === category ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>
  `).join("");
}

function visibleProducts() {
  const query = state.search.toLowerCase();
  return products.filter(product => {
    const isPublished = product.status === "published";
    const matchesCategory = state.category === "All" || product.category === state.category;
    const searchable = `${product.name} ${product.category} ${product.description}`.toLowerCase();
    return isPublished && matchesCategory && searchable.includes(query);
  }).sort((a, b) => {
    if (state.sort === "price-low") return a.price - b.price;
    if (state.sort === "price-high") return b.price - a.price;
    if (state.sort === "rating") return (b.rating || 0) - (a.rating || 0);
    return b.createdAt - a.createdAt;
  });
}

function renderProducts() {
  const matches = visibleProducts();
  const publishedProducts = products.filter(product => product.status === "published");
  el("resultsText").textContent = publishedProducts.length
    ? `${matches.length} ${matches.length === 1 ? "product" : "products"} available`
    : "Products from independent creators";

  if (!matches.length) {
    const isEmptyStore = publishedProducts.length === 0;
    productGrid.innerHTML = `<div class="empty-state"><div class="empty-state-content">
      <span class="eyebrow">${isEmptyStore ? "Your marketplace" : "No results"}</span>
      <h3>${isEmptyStore ? "No products added yet." : "No products match your search."}</h3>
      <p>${isEmptyStore ? "New digital products will appear here as soon as they are published." : "Try another search or choose a different category."}</p>
    </div></div>`;
    return;
  }

  productGrid.innerHTML = matches.map((product, index) => `
    <article class="product-card">
      <a class="product-image-wrap product-image-link" href="#product/${encodeURIComponent(product.id)}" aria-label="View ${escapeHtml(product.name)} details">
        <img class="product-image" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">
        <div class="product-badges" aria-label="Product highlights">
          <span class="download-badge">Featured</span>
          ${index < 4 ? '<span class="download-badge new-badge">New</span>' : ""}
          ${canClaimWithoutPayment(product) ? '<span class="download-badge free-badge">Free</span>' : ""}
        </div>
      </a>
      <div class="product-body">
        <span class="product-category">${escapeHtml(product.category)}</span>
        ${freeFirstBadge(product)}
        <h3 class="product-name">${escapeHtml(product.name)}</h3>
        <p class="product-description">${escapeHtml(product.description)}</p>
        <div class="product-meta">
          <strong class="product-price">${money(product.price)}</strong>
          ${ratingMarkup(product)}
        </div>
        <div class="card-actions">
          <a class="secondary-button" href="#product/${encodeURIComponent(product.id)}">View Details</a>
          <button class="primary-button" type="button" data-get-now="${escapeHtml(product.id)}">Get Now</button>
        </div>
      </div>
    </article>`).join("");
}

function renderProductPage(product) {
  if (!product) {
    el("productPageContent").innerHTML = `<div class="missing-product"><h1>Product not found</h1><p>This product may have been removed.</p></div>`;
    return;
  }

  const previewImages = [product.image, ...(product.previewImages || [])].filter(Boolean);
  const previewMarkup = previewImages.map((image, index) => `
    <img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)} preview ${index + 1}" loading="lazy">
  `).join("");
  const faqs = Array.isArray(product.faqs) ? product.faqs.filter(item => item?.question && item?.answer) : [];
  const personalPrice = Number(product.personalPrice ?? product.price);
  const commercialPrice = Number(product.commercialPrice ?? product.price);
  const isFree = isFreeProduct(product);
  const refundPolicy = "No refunds after download. If the file does not work, CrowMint support will help resolve the issue.";
  const supportContact = product.supportContact || "crowmintofficial@gmail.com";
  const faqMarkup = faqs.map(item => `
    <details class="faq-accordion-item">
      <summary>${escapeHtml(item.question)}<span aria-hidden="true">+</span></summary>
      <div class="faq-answer"><p>${escapeHtml(item.answer)}</p></div>
    </details>
  `).join("");

  const openedFromCart = sessionStorage.getItem("crowmint-return-to-cart") === "1";
  el("productPageContent").innerHTML = `
    ${openedFromCart ? '<button class="back-link back-to-cart-link" type="button" data-back-to-cart>← Back to Cart</button>' : ""}
    <div class="product-detail-main">
      <div class="product-gallery">
        <div class="gallery-main"><img id="mainProductImage" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}"></div>
        ${previewImages.length > 1 ? `<div class="gallery-thumbs">${previewImages.map((image, index) => `
          <button class="gallery-thumb ${index === 0 ? "active" : ""}" type="button" data-gallery-image="${escapeHtml(image)}" aria-label="Show preview ${index + 1}"><img src="${escapeHtml(image)}" alt=""></button>
        `).join("")}</div>` : ""}
      </div>
      <aside class="product-detail-info" aria-label="Purchase options">
        <span class="eyebrow">${escapeHtml(product.category)} · Digital product</span>
        ${freeFirstBadge(product)}
        <h1>${escapeHtml(product.name)}</h1>
        <div class="detail-rating">${ratingMarkup(product, true)}</div>
        <strong class="detail-price">${isFree ? `Price: ${money(0)}` : `From ${money(personalPrice)}`}</strong>
        <p class="detail-description">${escapeHtml(product.description)}</p>
        <fieldset class="license-selector">
          <legend>Choose a license</legend>
          <label><input type="radio" name="productLicense" value="personal"><span><strong>Personal License</strong><small>Personal use only; no client work, redistribution, or reselling</small></span><b>${money(personalPrice)}</b></label>
          <label><input type="radio" name="productLicense" value="commercial"><span><strong>Commercial License</strong><small>Client, freelance, and commercial work; no redistribution or reselling</small></span><b>${money(commercialPrice)}</b></label>
        </fieldset>
        <p class="license-warning">Commercial use requires a commercial license. Using a personal license for commercial work may result in copyright claims.</p>
        <button class="discount-reveal" type="button" data-product-discount-reveal>Have a discount code?</button>
        <form class="discount-form product-discount-form" id="productDiscountForm" hidden>
          <input name="code" autocomplete="off" placeholder="Enter code"><button class="secondary-button" type="submit">Apply</button>
          <p class="discount-message" id="productDiscountMessage" role="status" hidden></p>
        </form>
        <p class="license-error" id="licenseError" hidden>Please choose a Personal or Commercial license first.</p>
        <div class="detail-actions">
          <button class="primary-button" type="button" data-buy="${escapeHtml(product.id)}">Get Now</button>
          <button class="secondary-button" type="button" data-cart="${escapeHtml(product.id)}">Add to Cart</button>
        </div>
        <div class="instant-note">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"/></svg>
          <span><strong>Instant digital download</strong><br>No physical item will be shipped. Your files are available after ${isFree ? "checkout" : "payment"}.</span>
        </div>
      </aside>
    </div>

    <div class="detail-sections">
      <section class="detail-section">
        <h2>Product overview</h2>
        <p>${escapeHtml(product.description)}</p>
      </section>
      <section class="detail-section">
        <h2>Preview images</h2>
        <div class="preview-grid">${previewMarkup}</div>
      </section>
      <section class="detail-section">
        <h2>What’s included</h2>
        <p>${escapeHtml(product.included)}</p>
      </section>
      <section class="detail-section">
        <h2>File information</h2>
        <div class="detail-facts">
          <div class="detail-fact"><span>Version</span><strong>${escapeHtml(product.version || "Not specified")}</strong></div>
          <div class="detail-fact"><span>File type</span><strong>${escapeHtml(product.fileType)}</strong></div>
          <div class="detail-fact"><span>File name</span><strong>${escapeHtml(product.fileName)}</strong></div>
          <div class="detail-fact"><span>Delivery</span><strong>Instant download</strong></div>
        </div>
      </section>
      <section class="detail-section">
        <h2>License options</h2>
        <div class="license-rules-grid">
          <article class="license-rule-card"><h3>Personal License · ${money(personalPrice)}</h3><ul><li>Personal use only</li><li>No client work</li><li>No redistribution</li><li>No reselling</li></ul></article>
          <article class="license-rule-card"><h3>Commercial License · ${money(commercialPrice)}</h3><ul><li>Client work allowed</li><li>Freelance work allowed</li><li>Commercial projects allowed</li><li>No redistribution</li><li>No reselling</li></ul></article>
        </div>
      </section>
      <section class="detail-section">
        <h2>Support info</h2>
        <p>Contact <a href="mailto:crowmintofficial@gmail.com">crowmintofficial@gmail.com</a> or Instagram <a href="https://instagram.com/CrowMintofficial" target="_blank" rel="noopener">@CrowMintofficial</a>. Support replies within 24–48 hours.</p>
      </section>
      <section class="detail-section">
        <h2>Refund policy</h2>
        <p>${escapeHtml(refundPolicy)}</p>
      </section>
      ${faqs.length ? `<section class="detail-section faq-detail-section">
        <h2>Frequently asked questions</h2>
        <div class="faq-accordion">${faqMarkup}</div>
      </section>` : ""}
    </div>`;
}

function isAdminRoute() {
  return false;
}

function leaveAdminRoute() {
  location.hash = "";
}

function renderRoute() {
  const match = location.hash.match(/^#product\/(.+)$/);
  const isProductRoute = Boolean(match);
  if (location.hash === "#admin") {
    history.replaceState(null, "", location.pathname + location.search);
    closeOverlays();
    renderCategories();
    renderProducts();
    return;
  }
  if (!el("adminLoginModal").hidden || !el("adminModal").hidden) closeOverlays();
  el("marketplaceView").hidden = isProductRoute;
  el("productView").hidden = !isProductRoute;

  if (isProductRoute) {
    const id = decodeURIComponent(match[1]);
    renderProductPage(products.find(product => String(product.id) === id && product.status === "published"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    renderCategories();
    renderProducts();
  }
}

function renderAdminCategories() {
  const categoryList = el("adminCategoryList");
  const categorySelect = el("adminCategorySelect");
  if (!categoryList || !categorySelect || !isApprovedAdmin(currentAdminUser)) return;

  categoryList.innerHTML = categories.length ? categories.map(category => `
    <span class="admin-category-chip">${escapeHtml(category)}<button type="button" data-remove-category="${escapeHtml(category)}" aria-label="Remove ${escapeHtml(category)}">×</button></span>
  `).join("") : `<span class="category-empty">No categories added yet.</span>`;

  categorySelect.innerHTML = categories.length
    ? `<option value="">Select a category</option>${categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`
    : `<option value="">Add a category first</option>`;
}

function renderProtectedAdmin() {
  if (!isApprovedAdmin(currentAdminUser)) {
    el("adminProtectedContent").replaceChildren();
    return;
  }

  el("adminProtectedContent").innerHTML = `
    <div class="admin-heading-row">
      <div><span class="eyebrow">Store management</span><h2 id="adminTitle">Admin panel</h2></div>
      <button class="text-button" type="button" data-admin-signout>Sign out</button>
    </div>
    <p class="admin-session">Signed in as ${escapeHtml(currentAdminUser.email)}</p>
    <p class="modal-subtitle">Manage categories and add products to your marketplace.</p>
    <section class="category-manager" aria-labelledby="categoryManagerTitle">
      <h3 id="categoryManagerTitle">Categories</h3>
      <form id="categoryForm" class="category-form">
        <label class="sr-only" for="newCategory">New category</label>
        <input id="newCategory" name="categoryName" required placeholder="Add a category">
        <button class="secondary-button" type="submit">Add category</button>
      </form>
      <div class="admin-category-list" id="adminCategoryList"></div>
    </section>
    <div class="section-divider"></div>
    <h3>Add a digital product</h3>
    <form id="adminForm" class="admin-form">
      <label>Product name<input name="name" required placeholder="e.g. Brand Planner"></label>
      <div class="form-row">
        <label>Price (₹)<input name="price" type="number" min="0" step="1" required placeholder="499"></label>
        <label>Category<select name="category" id="adminCategorySelect" required></select></label>
      </div>
      <label>Product image URL<input name="image" type="url" required placeholder="https://example.com/product-image.jpg"></label>
      <label>Description<textarea name="description" rows="3" required placeholder="Describe the product and who it is for."></textarea></label>
      <label>What’s included<textarea name="included" rows="2" required placeholder="e.g. 12 editable templates, quick-start guide"></textarea></label>
      <div class="form-row">
        <label>File type<input name="fileType" required placeholder="PDF, ZIP, DOCX..."></label>
        <label>File name<input name="fileName" required placeholder="brand-planner.zip"></label>
      </div>
      <label>Preview image URLs <span class="optional">Optional, one per line</span><textarea name="previewImages" rows="2" placeholder="https://example.com/preview-2.jpg"></textarea></label>
      <button class="primary-button" type="submit">Add Product</button>
    </form>`;
  renderAdminCategories();
}

function showLoginError(message) {
  const error = el("adminLoginError");
  error.textContent = message;
  error.hidden = !message;
}

function openAdminLogin() {
  closeOverlays();
  el("backdrop").hidden = false;
  el("adminLoginModal").hidden = false;
  el("adminLoginForm").reset();
  showLoginError("");
  document.body.style.overflow = "hidden";
}

function openAdminPanel() {
  if (!isApprovedAdmin(currentAdminUser)) {
    openAdminLogin();
    return;
  }
  closeOverlays();
  renderProtectedAdmin();
  el("backdrop").hidden = false;
  el("adminModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function openOverlay(type) {
  closeOverlays();
  el("backdrop").hidden = false;
  document.body.style.overflow = "hidden";
  if (type === "cart") {
    renderCart();
    el("cartDrawer").classList.add("open");
    el("cartDrawer").setAttribute("aria-hidden", "false");
  }
}

function closeOverlays() {
  el("backdrop").hidden = true;
  el("adminLoginModal").hidden = true;
  el("adminModal").hidden = true;
  el("cartDrawer").classList.remove("open");
  el("cartDrawer").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function initializeAdminAuth() {
  try { currentAdminUser = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY)); } catch { currentAdminUser = null; }
  if (isAdminRoute() && currentAdminUser) openAdminPanel();
}

function addToCart(id, openCart = false, license = null) {
  const product = products.find(item => String(item.id) === String(id));
  if (!product || !license) return;
  const selectedPrice = license === "commercial"
    ? Number(product.commercialPrice ?? product.price)
    : Number(product.personalPrice ?? product.price);
  const cartKey = `${product.id}:${license}`;
  const discount = state.productDiscounts[product.id];
  const discountAmount = discount ? Math.min(selectedPrice, discount.discount_type === "percentage" ? selectedPrice * (Number(discount.discount_value) / 100) : Number(discount.discount_value)) : 0;
  if (!state.cart.some(item => item.cartKey === cartKey)) {
    state.cart.push({ ...product, price: selectedPrice, selectedLicense: license, cartKey, discountAmount, discountCode: discount?.code || null });
  }
  saveStore();
  el("downloadSuccess").hidden = true;
  el("cartCount").textContent = state.cart.length;
  showToast(`${product.name} added to cart`);
  if (openCart) openOverlay("cart");
}

function beginProductAccess(id, license = "personal") {
  el("checkoutTerms").checked = false;
  el("checkoutError").hidden = true;
  addToCart(id, true, license);
}

async function executeProductAccess(product, license) {
  const price = Number(license === "commercial" ? product.commercialPrice ?? product.price : product.personalPrice ?? product.price);
  const item = { ...product, price, selectedLicense: license, cartKey: `${product.id}:${license}`, discountAmount: 0, discountCode: null };
  if (canClaimWithoutPayment(item)) {
    showToast("Preparing your download…");
    throw new Error("Products must be accessed from the cart.");
    return;
  }
  throw new Error("Products must be accessed from the cart.");
}

async function resumePendingCartCheckout() {
  if (sessionStorage.getItem("crowmint-pending-cart") === "1") {
    const currentUser = await window.CrowMintAccount.user().catch(() => null);
    if (!currentUser) return;
    sessionStorage.removeItem("crowmint-pending-cart");
    el("checkoutTerms").checked = true;
    updateCheckoutButton();
    setTimeout(() => {
      openOverlay("cart");
      el("checkoutForm").requestSubmit();
    }, 0);
    return;
  }
  sessionStorage.removeItem("crowmint-pending-acquisition");
}

function renderCart() {
  el("cartItems").innerHTML = state.cart.length ? state.cart.map(item => `
    <div class="cart-item" data-cart-product="${escapeHtml(item.id)}" tabindex="0" role="link" aria-label="View ${escapeHtml(item.name)} details">
      <img src="${escapeHtml(item.image)}" alt="">
      <div class="cart-item-copy">
        <h3>${escapeHtml(item.name)}</h3>
        <span class="cart-item-license">${item.selectedLicense === "commercial" ? "Commercial" : "Personal"} License</span>
        ${item.discountAmount ? `<span class="item-discount">${escapeHtml(item.discountCode)} -${money(item.discountAmount)}</span>` : ""}
      </div>
      <div class="cart-item-side">
        <strong class="cart-item-price">${money(item.price)}</strong>
        <button class="remove-button" type="button" data-remove="${escapeHtml(item.cartKey)}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button>
      </div>
    </div>
  `).join("") : `<div class="cart-empty"><strong>Your cart is empty.</strong><br>Add a product to see it here.</div>`;

  const subtotal = state.cart.reduce((sum, item) => sum + item.price, 0);
  const discountAmount = state.cart.reduce((sum, item) => sum + (item.discountAmount || 0), 0);
  const total = Math.max(0, subtotal - discountAmount);

  el("cartSubtotal").textContent = money(subtotal);
  el("cartDiscount").textContent = `−${money(discountAmount)}`;
  el("cartDiscountRow").hidden = discountAmount <= 0;
  el("cartTotal").textContent = money(total);
  if (!state.cart.length) el("checkoutForm").reset();
  updateCheckoutButton();
}

function updateCheckoutButton() {
  const form = el("checkoutForm");
  const hasPaidProducts = state.cart.some(item => !canClaimWithoutPayment(item));
  el("checkoutButton").textContent = state.cart.length && !hasPaidProducts ? "Get Now" : "Proceed to Get Now";
  el("checkoutButton").disabled = !state.cart.length || !form.checkValidity();
}

function applyCheckoutLicense(license) {
  if (!license) return;
  const updatedItems = state.cart.map(item => {
    const price = license === "commercial"
      ? Number(item.commercialPrice ?? item.price)
      : Number(item.personalPrice ?? item.price);
    const discount = state.productDiscounts[item.id];
    const discountAmount = discount
      ? Math.min(price, discount.discount_type === "percentage" ? price * (Number(discount.discount_value) / 100) : Number(discount.discount_value))
      : 0;
    return { ...item, selectedLicense: license, price, discountAmount, cartKey: `${item.id}:${license}` };
  });
  state.cart = [...new Map(updatedItems.map(item => [String(item.id), item])).values()];
  saveStore();
  renderCart();
}

async function recordSuccessfulOrder(payment, items = state.cart) {
  if (!payment?.orderId || !payment?.paymentId || !payment?.signature) {
    throw new Error("Payment verification details are required before an order can be saved.");
  }
  if (!items.length) throw new Error("Checkout details are incomplete.");
  const currentUser = await window.CrowMintAccount.requireUser();
  if (!currentUser) return [];
  const licenseType = items[0]?.selectedLicense || "personal";
  const client = await getSupabaseClient();
  const { data, error } = await client.functions.invoke("complete-order", { body: {
    payment: { orderId: payment.orderId, paymentId: payment.paymentId, signature: payment.signature },
    userId: currentUser.id,
    licenseType,
    items: items.map(item => ({
      productId: String(item.id),
      productName: item.name,
      amountPaid: Math.max(0, Number(item.price) - Number(item.discountAmount || 0))
    }))
  }});
  const functionError = await resolveFunctionError(error, data, "Unable to verify payment.");
  if (functionError) throw functionError;
  if (!data?.orders?.length) throw new Error("The verified order was not returned by the payment service.");

  startDownloads(data.downloads || []);
  showDownloadSuccess(data.downloads || []);
  showToast("Your download is starting.");

  const deliveredKeys = new Set(items.map(item => item.cartKey));
  state.cart = state.cart.filter(item => !deliveredKeys.has(item.cartKey));
  saveStore();
  renderCart();
  el("cartCount").textContent = state.cart.length;
  return data.orders;
}

let lastDownloads = [];
const FILE_UNAVAILABLE_MESSAGE = "Product file is not available. Please contact support.";
const PAYMENTS_UNAVAILABLE_MESSAGE = "Payment is not available yet.";

function displayCheckoutError(message) {
  const panel = el("checkoutError");
  panel.textContent = message;
  panel.hidden = false;
}

async function resolveFunctionError(error, data, fallbackMessage) {
  if (data?.error) return new Error(data.error);
  if (!error) return null;
  try {
    const response = error.context;
    const payload = response?.clone ? await response.clone().json() : null;
    if (payload?.error) return new Error(payload.error);
  } catch {
    // Supabase may not expose JSON for network-level failures.
  }
  return new Error(error.message || fallbackMessage);
}

function startDownloads(downloads) {
  if (!downloads.length) throw new Error(FILE_UNAVAILABLE_MESSAGE);
  downloads.forEach(download => {
    const link = document.createElement("a");
    link.href = download.url;
    link.download = download.fileName || "crowmint-download";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
}

function showDownloadSuccess(downloads) {
  lastDownloads = downloads;
  const panel = el("downloadSuccess");
  panel.hidden = false;
  panel.innerHTML = `<strong>Your download is starting.</strong>${downloads.map((download, index) => `<button class="secondary-button" type="button" data-download-again="${index}">Download Again${downloads.length > 1 ? `: ${escapeHtml(download.fileName || `File ${index + 1}`)}` : ""}</button>`).join("")}`;
}

async function completeFreeCheckout(items = state.cart) {
  if (!items.length) throw new Error("No free products were selected for download.");
  const currentUser = await window.CrowMintAccount.requireUser();
  if (!currentUser) return;
  const client = await getSupabaseClient();
  const downloads = await Promise.all(items.map(async item => {
    const { data: productRecord, error: productError } = await client
      .from("products")
      .select("id,file_path,file_name,status")
      .eq("id", item.id)
      .eq("status", "published")
      .maybeSingle();
    if (productError) throw new Error(`Unable to load "${item.name}": ${productError.message}`);
    if (!productRecord?.file_path) throw new Error(`Supabase product "${item.name}" has an empty file_path.`);

    // This Postgres RPC records the claim in Purchases/Orders. It is not an
    // Edge Function; file delivery still comes directly from Supabase Storage.
    const { data: purchase, error: claimError } = await client.rpc("claim_free_product", {
      p_product_id: String(item.id),
      p_license_type: item.selectedLicense || "personal"
    });
    if (claimError) {
      throw new Error(`Free product claim failed for "${item.name}": ${claimError.message}`);
    }
    const downloadName = storageFileName(productRecord.file_path);
    const { data, error } = await client.storage
      .from("product-files")
      .createSignedUrl(productRecord.file_path, 3600, { download: downloadName });
    if (error) throw new Error(`Supabase Storage error for "${item.name}": ${error.message}`);
    if (!data?.signedUrl) throw new Error(`Supabase Storage did not return a download URL for "${item.name}".`);
    return { url: data.signedUrl, fileName: downloadName, filePath: productRecord.file_path };
  }));

  startDownloads(downloads);
  showDownloadSuccess(downloads);
  showToast("Your download is starting.");
  const deliveredKeys = new Set(items.map(item => item.cartKey));
  state.cart = state.cart.filter(item => !deliveredKeys.has(item.cartKey));
  saveStore();
  renderCart();
  el("cartCount").textContent = state.cart.length;
}

let razorpaySdkPromise = null;
function loadRazorpaySdk() {
  if (window.Razorpay) return Promise.resolve();
  if (razorpaySdkPromise) return razorpaySdkPromise;
  razorpaySdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Secure payment could not be loaded."));
    document.head.appendChild(script);
  });
  return razorpaySdkPromise;
}

async function startPaidCheckout(items = state.cart) {
  if (!RAZORPAY_ENABLED) throw new Error(PAYMENTS_UNAVAILABLE_MESSAGE);
  const currentUser = await window.CrowMintAccount.requireUser();
  if (!currentUser) return;
  const client = await getSupabaseClient();
  const licenseType = items[0]?.selectedLicense || "personal";
  const { data, error } = await client.functions.invoke("create-payment-order", { body: {
    licenseType,
    productIds: items.map(item => String(item.id))
  }});
  if (data?.error) throw new Error(data.error);
  if (error) throw new Error(PAYMENTS_UNAVAILABLE_MESSAGE);
  if (!data?.keyId || !data?.orderId || !data?.amount) throw new Error(PAYMENTS_UNAVAILABLE_MESSAGE);
  await loadRazorpaySdk();

  return new Promise((resolve, reject) => {
    const payment = new window.Razorpay({
      key: data.keyId,
      order_id: data.orderId,
      amount: data.amount,
      currency: "INR",
      name: "CrowMint",
      description: "Digital product purchase",
      prefill: { name: currentUser.user_metadata?.full_name || "", email: currentUser.email || "" },
      theme: { color: "#087a57" },
      handler: async response => {
        try {
          const orders = await recordSuccessfulOrder({ orderId: response.razorpay_order_id, paymentId: response.razorpay_payment_id, signature: response.razorpay_signature }, items);
          resolve(orders);
        } catch (completionError) { reject(completionError); }
      },
      modal: { ondismiss: () => reject(new Error("Payment was cancelled.")) }
    });
    payment.on("payment.failed", async response => {
      const description = response.error?.description || "Payment failed.";
      await client.functions.invoke("record-payment-failure", { body: {
        orderId: response.error?.metadata?.order_id || data.orderId,
        paymentId: response.error?.metadata?.payment_id || null,
        productIds: items.map(item => String(item.id)),
        licenseType,
        message: description
      }}).catch(() => null);
      reject(new Error(description));
    });
    payment.open();
  });
}

// Call this only from a payment success flow after server-side verification.
window.CrowMintCheckout = Object.freeze({ completeVerifiedPayment: recordSuccessfulOrder });

let toastTimer;
function showToast(message) {
  el("toast").textContent = message;
  el("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el("toast").classList.remove("show"), 2200);
}

categoryTabs.addEventListener("click", event => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  state.category = button.dataset.category;
  renderCategories();
  renderProducts();
});

productGrid.addEventListener("click", event => {
  const getNow = event.target.closest("[data-get-now]");
  if (getNow) beginProductAccess(getNow.dataset.getNow, "personal");
});

el("productPageContent").addEventListener("click", async event => {
  const backToCart = event.target.closest("[data-back-to-cart]");
  if (backToCart) { location.hash = ""; return; }
  const cart = event.target.closest("[data-cart]");
  const buy = event.target.closest("[data-buy]");
  const galleryImage = event.target.closest("[data-gallery-image]");
  const revealDiscount = event.target.closest("[data-product-discount-reveal]");
  if (revealDiscount) el("productDiscountForm").hidden = false;
  if (cart || buy) {
    const productId = (cart || buy).dataset.cart || (cart || buy).dataset.buy;
    const currentProduct = products.find(item => String(item.id) === String(productId));
    const selectedLicense = document.querySelector('input[name="productLicense"]:checked')?.value || (currentProduct && canClaimWithoutPayment(currentProduct) ? "personal" : null);
    const error = el("licenseError");
    error.hidden = Boolean(selectedLicense);
    if (selectedLicense) {
      if (buy) beginProductAccess(productId, selectedLicense);
      else addToCart(productId, false, selectedLicense);
    }
  }
  if (galleryImage) {
    el("mainProductImage").src = galleryImage.dataset.galleryImage;
    document.querySelectorAll(".gallery-thumb").forEach(button => button.classList.toggle("active", button === galleryImage));
  }
});

el("productPageContent").addEventListener("submit", async event => {
  if (event.target.id !== "productDiscountForm") return;
  event.preventDefault();
  const message = el("productDiscountMessage");
  const productId = location.hash.match(/^#product\/(.+)$/)?.[1];
  const code = new FormData(event.target).get("code").trim().toUpperCase();
  const data = discounts.find(discount => discount.active && String(discount.productId) === String(productId) && discount.code.toUpperCase() === code);
  message.hidden = false;
  if (!data) { message.className = "discount-message error"; message.textContent = "This code is invalid for this product."; return; }
  state.productDiscounts[productId] = data;
  message.className = "discount-message success";
  message.textContent = `${data.code} will apply to this product.`;
});

el("cartItems").addEventListener("click", event => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    state.cart = state.cart.filter(item => item.cartKey !== remove.dataset.remove);
    el("cartCount").textContent = state.cart.length;
    renderCart();
    return;
  }
  if (window.matchMedia("(max-width: 768px)").matches) openProductFromCart(event.target.closest("[data-cart-product]"), event);
});
el("cartItems").addEventListener("dblclick", event => {
  if (window.matchMedia("(min-width: 769px)").matches) openProductFromCart(event.target.closest("[data-cart-product]"), event);
});
el("cartItems").addEventListener("keydown", event => {
  if (event.key === "Enter") openProductFromCart(event.target.closest("[data-cart-product]"), event);
});

function openProductFromCart(row, event) {
  if (!row || event.target.closest("button, input, label, select, textarea, a, [data-cart-action]")) return;
  sessionStorage.setItem("crowmint-return-to-cart", "1");
  closeOverlays();
  location.hash = `#product/${encodeURIComponent(row.dataset.cartProduct)}`;
}
el("downloadSuccess").addEventListener("click", event => {
  const button = event.target.closest("[data-download-again]");
  if (!button) return;
  const download = lastDownloads[Number(button.dataset.downloadAgain)];
  if (download) startDownloads([download]);
});

el("checkoutForm").addEventListener("input", () => {
  updateCheckoutButton();
  el("checkoutError").hidden = true;
});

el("adminModal").addEventListener("click", async event => {
  if (!isApprovedAdmin(currentAdminUser)) return;

  const signOut = event.target.closest("[data-admin-signout]");
  if (signOut) {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    currentAdminUser = null;
    el("adminProtectedContent").replaceChildren();
    if (isAdminRoute()) openAdminLogin(); else closeOverlays();
    showToast("Signed out securely");
    return;
  }

  const remove = event.target.closest("[data-remove-category]");
  if (!remove) return;
  const category = remove.dataset.removeCategory;
  if (products.some(product => product.category === category)) {
    showToast("Move or remove products in this category first.");
    return;
  }
  categories.splice(categories.indexOf(category), 1);
  saveStore();
  renderAdminCategories();
  renderCategories();
});

el("adminModal").addEventListener("submit", event => {
  event.preventDefault();
  if (!isApprovedAdmin(currentAdminUser)) {
    closeOverlays();
    showToast("Admin authentication required.");
    return;
  }

  if (event.target.id === "categoryForm") {
    const input = el("newCategory");
    const category = input.value.trim();
    if (categories.some(item => item.toLowerCase() === category.toLowerCase())) {
      showToast("That category already exists.");
      return;
    }
    categories.push(category);
    saveStore();
    input.value = "";
    renderAdminCategories();
    renderCategories();
    showToast(`${category} category added`);
    return;
  }

  if (event.target.id !== "adminForm") return;
  const data = new FormData(event.target);
  const name = data.get("name").trim();
  const previewImages = data.get("previewImages").split(/[\n,]+/).map(url => url.trim()).filter(Boolean);

  products.push({
    id: String(Date.now()),
    createdAt: Date.now(),
    name,
    price: Number(data.get("price")),
    category: data.get("category"),
    image: data.get("image").trim(),
    description: data.get("description").trim(),
    included: data.get("included").trim(),
    fileType: data.get("fileType").trim(),
    fileName: data.get("fileName").trim(),
    previewImages,
    rating: null,
    reviews: 0
  });

  saveStore();
  state.category = "All";
  state.search = "";
  el("searchInput").value = "";
  event.target.reset();
  closeOverlays();
  renderCategories();
  renderProducts();
  showToast(`${name} added to the marketplace`);
});

el("adminLoginForm").addEventListener("submit", event => {
  event.preventDefault();
  showLoginError("");

  const submitButton = el("adminLoginSubmit");
  const data = new FormData(event.currentTarget);
  const email = data.get("email").trim();
  if (!email || !data.get("password")) {
    showLoginError("Enter your email and password.");
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Signing in…";

  submitButton.disabled = false;
  submitButton.textContent = "Sign in securely";
  currentAdminUser = { email };
  sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(currentAdminUser));
  openAdminPanel();
});

el("searchInput").addEventListener("input", event => {
  if (location.hash) location.hash = "";
  state.search = event.target.value.trim();
  renderProducts();
});
el("sortSelect").addEventListener("change", event => { state.sort = event.target.value; renderProducts(); });
el("categoriesButton").addEventListener("click", () => {
  if (location.hash) location.hash = "";
  setTimeout(() => categoryTabs.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
});
el("cartButton").addEventListener("click", () => openOverlay("cart"));
el("backToProducts").addEventListener("click", () => { location.hash = ""; });
el("backdrop").addEventListener("click", () => { if (isAdminRoute()) leaveAdminRoute(); else closeOverlays(); });
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => {
  if (button.closest("#adminLoginModal, #adminModal") && isAdminRoute()) leaveAdminRoute();
  else closeOverlays();
}));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (isAdminRoute()) leaveAdminRoute(); else closeOverlays();
  }
});
el("checkoutForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.cart.length) { showToast("Your cart is empty."); return; }
  if (!event.currentTarget.reportValidity() || !el("checkoutTerms").checked) {
    el("checkoutError").textContent = "Accept the Terms and Conditions to continue.";
    el("checkoutError").hidden = false;
    return;
  }
  const currentUser = await window.CrowMintAccount.user().catch(() => null);
  if (!currentUser) {
    sessionStorage.setItem("crowmint-pending-cart", "1");
    location.href = `/login/?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    return;
  }
  el("checkoutError").hidden = true;
  const freeItems = state.cart.filter(item => canClaimWithoutPayment(item));
  const paidItems = state.cart.filter(item => !canClaimWithoutPayment(item));
  if (paidItems.length) {
    const button = el("checkoutButton");
    button.disabled = true;
    button.textContent = "Opening payment…";
    try {
      if (freeItems.length) await completeFreeCheckout(freeItems);
      await startPaidCheckout();
    } catch (error) {
      displayCheckoutError(error.message || "Unable to start payment.");
    } finally {
      updateCheckoutButton();
    }
    return;
  }
  const button = el("checkoutButton");
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    await completeFreeCheckout(freeItems);
  } catch (error) {
    displayCheckoutError(error.message || FILE_UNAVAILABLE_MESSAGE);
  } finally {
    updateCheckoutButton();
  }
});
el("footerPolicies").addEventListener("click", event => {
  const toggle = event.target.closest(".footer-accordion-toggle");
  if (!toggle || !window.matchMedia("(max-width: 768px)").matches) return;
  const section = toggle.closest("section");
  const willOpen = !section.classList.contains("is-open");
  el("footerPolicies").querySelectorAll("section.is-open").forEach(item => {
    item.classList.remove("is-open");
    item.querySelector(".footer-accordion-toggle").setAttribute("aria-expanded", "false");
  });
  if (willOpen) {
    section.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
  }
});
window.addEventListener("hashchange", () => {
  renderRoute();
  if (!location.hash.startsWith("#product/") && sessionStorage.getItem("crowmint-return-to-cart") === "1") {
    sessionStorage.removeItem("crowmint-return-to-cart");
    setTimeout(() => openOverlay("cart"), 0);
  }
});

// PAYMENT CONNECTION POINT: create and verify payment on a trusted backend,
// then call CrowMintCheckout.completeVerifiedPayment with the verified result.

initializeMarketplaceData();
