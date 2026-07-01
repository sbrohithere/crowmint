(function () {
  const config = window.CROWMINT_CONFIG || {};
  let client;

  function configured() {
    return Boolean(config.supabaseUrl && config.supabaseAnonKey) &&
      !config.supabaseUrl.startsWith("YOUR_") && !config.supabaseAnonKey.startsWith("YOUR_");
  }

  async function getClient() {
    if (!configured()) throw new Error("Supabase authentication is not configured.");
    if (!window.supabase?.createClient) throw new Error("Supabase authentication could not be loaded.");
    if (!client) client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return client;
  }

  function safeNext(value) {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
  }

  async function user() {
    const supabase = await getClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data.user || null;
  }

  async function requireUser() {
    const current = await user();
    if (current) return current;
    const next = location.pathname + location.search + location.hash;
    location.href = `/login/?next=${encodeURIComponent(next)}`;
    return null;
  }

  async function logout() {
    const supabase = await getClient();
    await supabase.auth.signOut();
    location.href = "/";
  }

  function message(text, type = "") {
    const panel = document.getElementById("accountMessage");
    if (!panel) return;
    panel.textContent = text;
    panel.className = `account-message ${type}`.trim();
    panel.hidden = !text;
  }

  function setButtonLoading(button, loading, loadingText) {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = loading;
    button.setAttribute("aria-busy", String(loading));
    button.textContent = loading ? loadingText : button.dataset.label;
  }

  async function googleLogin(next) {
    const supabase = await getClient();
    localStorage.setItem("crowmint-auth-return", safeNext(next));
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${location.origin}/login/`,
        scopes: "openid email profile",
        queryParams: { prompt: "select_account" }
      }
    });
    if (error) throw error;
  }

  async function initLogin() {
    const params = new URLSearchParams(location.search);
    const next = safeNext(params.get("next") || localStorage.getItem("crowmint-auth-return") || "/profile/");
    const supabase = await getClient();
    const existing = await user();
    if (existing && !params.has("reset")) {
      localStorage.removeItem("crowmint-auth-return");
      location.href = next;
      return;
    }
    document.getElementById("googleAuth").addEventListener("click", async event => {
      message(""); setButtonLoading(event.currentTarget, true, "Connecting to Google…");
      try { await googleLogin(next); } catch (error) { message(error.message || "Google login failed. Please try again.", "error"); setButtonLoading(event.currentTarget, false); }
    });
    document.getElementById("loginForm").addEventListener("submit", async event => {
      event.preventDefault(); message("");
      const submitButton = event.currentTarget.querySelector('[type="submit"]');
      setButtonLoading(submitButton, true, "Logging in…");
      const values = new FormData(event.currentTarget);
      const { error } = await supabase.auth.signInWithPassword({ email: values.get("email").trim(), password: values.get("password") });
      if (error) { message("Login failed. Check your email and password.", "error"); setButtonLoading(submitButton, false); return; }
      location.href = next;
    });
    document.getElementById("forgotPassword").addEventListener("click", async event => {
      event.preventDefault();
      const email = document.querySelector('[name="email"]').value.trim();
      if (!email) { message("Enter your email address first.", "error"); return; }
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/login/?reset=1` });
      message(error ? error.message : "Password reset email sent.", error ? "error" : "success");
    });
    if (params.has("reset")) {
      document.getElementById("resetPanel").hidden = false;
      document.getElementById("resetForm").addEventListener("submit", async event => {
        event.preventDefault();
        const password = new FormData(event.currentTarget).get("newPassword");
        const { error } = await supabase.auth.updateUser({ password });
        message(error ? error.message : "Password updated. You can continue to your account.", error ? "error" : "success");
      });
    }
  }

  async function initSignup() {
    const params = new URLSearchParams(location.search);
    const next = safeNext(params.get("next") || "/profile/");
    const supabase = await getClient();
    document.getElementById("googleAuth").addEventListener("click", async event => {
      message(""); setButtonLoading(event.currentTarget, true, "Connecting to Google…");
      try { await googleLogin(next); } catch (error) { message(error.message || "Google signup failed. Please try again.", "error"); setButtonLoading(event.currentTarget, false); }
    });
    document.getElementById("signupForm").addEventListener("submit", async event => {
      event.preventDefault(); message("");
      const submitButton = event.currentTarget.querySelector('[type="submit"]');
      setButtonLoading(submitButton, true, "Creating account…");
      const values = new FormData(event.currentTarget);
      const fullName = values.get("fullName").trim();
      const { data, error } = await supabase.auth.signUp({
        email: values.get("email").trim(), password: values.get("password"),
        options: { data: { full_name: fullName } }
      });
      if (error) { message(error.message, "error"); setButtonLoading(submitButton, false); return; }
      if (!data.session) { message("Account created. Email confirmation must be disabled in Supabase Auth settings for immediate login.", "success"); setButtonLoading(submitButton, false); return; }
      location.href = next;
    });
  }

  async function initProfile() {
    const current = await requireUser(); if (!current) return;
    const supabase = await getClient();
    let { data: profile, error: profileLoadError } = await supabase
      .from("profiles")
      .select("full_name,email")
      .eq("id", current.id)
      .maybeSingle();
    if (profileLoadError) throw profileLoadError;

    if (!profile) {
      const defaultName = current.user_metadata?.full_name || current.user_metadata?.name || "CrowMint customer";
      const { data: createdProfile, error: createProfileError } = await supabase
        .from("profiles")
        .upsert({
          id: current.id,
          email: current.email,
          full_name: defaultName,
          updated_at: new Date().toISOString()
        }, { onConflict: "id" })
        .select("full_name,email")
        .maybeSingle();
      if (createProfileError) throw createProfileError;
      profile = createdProfile || { full_name: defaultName, email: current.email };
    }
    const nameDisplay = document.getElementById("profileName");
    const nameInput = document.getElementById("profileNameInput");
    const nameForm = document.getElementById("profileNameForm");
    const nameRow = document.querySelector(".profile-name-row");
    const currentName = profile?.full_name || current.user_metadata?.full_name || "CrowMint customer";
    nameDisplay.textContent = currentName;
    nameInput.value = currentName;
    document.getElementById("profileEmail").textContent = profile?.email || current.email;
    const setEditing = editing => {
      nameRow.hidden = editing;
      nameForm.hidden = !editing;
      if (editing) { nameInput.value = nameDisplay.textContent; nameInput.focus(); }
    };
    document.getElementById("editProfileName").addEventListener("click", () => setEditing(true));
    document.getElementById("cancelProfileName").addEventListener("click", () => { message(""); setEditing(false); });
    nameForm.addEventListener("submit", async event => {
      event.preventDefault(); message("");
      const fullName = nameInput.value.trim();
      if (!fullName) { message("Name cannot be empty.", "error"); nameInput.focus(); return; }
      const saveButton = event.currentTarget.querySelector('[type="submit"]');
      setButtonLoading(saveButton, true, "Saving…");
      const { error: profileError } = await supabase
        .from("profiles")
        .upsert({
          id: current.id,
          email: current.email,
          full_name: fullName,
          updated_at: new Date().toISOString()
        }, { onConflict: "id" });
      if (profileError) { message(profileError.message, "error"); setButtonLoading(saveButton, false); return; }
      const { data: refreshedProfile, error: refreshError } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", current.id)
        .maybeSingle();
      if (refreshError) { message(refreshError.message, "error"); setButtonLoading(saveButton, false); return; }
      const { error: authError } = await supabase.auth.updateUser({ data: { ...current.user_metadata, full_name: fullName } });
      nameDisplay.textContent = refreshedProfile?.full_name || fullName;
      setButtonLoading(saveButton, false);
      setEditing(false);
      message(authError ? "Name saved, but the account menu may update after your next login." : "Name updated successfully.", authError ? "" : "success");
    });

    const passwordButton = document.getElementById("changePasswordButton");
    const passwordForm = document.getElementById("profilePasswordForm");
    const newPasswordInput = document.getElementById("newPasswordInput");
    const confirmPasswordInput = document.getElementById("confirmPasswordInput");
    const identityProviders = new Set((current.identities || []).map(identity => identity.provider));
    const canChangePassword = identityProviders.has("email") ||
      (identityProviders.size === 0 && current.app_metadata?.provider === "email");
    const setPasswordEditing = editing => {
      passwordForm.hidden = !editing;
      if (editing) newPasswordInput.focus();
      else {
        passwordForm.reset();
        passwordButton.focus();
      }
    };
    passwordButton.addEventListener("click", () => {
      message("");
      if (!canChangePassword) {
        passwordForm.hidden = true;
        message("Password change is only available for email/password accounts.", "");
        return;
      }
      setPasswordEditing(true);
    });
    document.getElementById("cancelPasswordChange").addEventListener("click", () => {
      message("");
      setPasswordEditing(false);
    });
    passwordForm.addEventListener("submit", async event => {
      event.preventDefault();
      message("");
      const newPassword = newPasswordInput.value;
      const confirmPassword = confirmPasswordInput.value;
      if (!newPassword) {
        message("Password cannot be empty.", "error");
        newPasswordInput.focus();
        return;
      }
      if (newPassword.length < 6) {
        message("Password must be at least 6 characters.", "error");
        newPasswordInput.focus();
        return;
      }
      if (newPassword !== confirmPassword) {
        message("New Password and Confirm Password must match.", "error");
        confirmPasswordInput.focus();
        return;
      }
      const saveButton = event.currentTarget.querySelector('[type="submit"]');
      setButtonLoading(saveButton, true, "Saving…");
      try {
        const { error: passwordError } = await supabase.auth.updateUser({ password: newPassword });
        if (passwordError) throw passwordError;
        passwordForm.reset();
        passwordForm.hidden = true;
        message("Password updated successfully.", "success");
      } catch (passwordError) {
        message(passwordError.message || "Unable to update password.", "error");
      } finally {
        setButtonLoading(saveButton, false);
      }
    });
    document.getElementById("logoutButton").addEventListener("click", logout);
  }

  function formatDate(value) { return value ? new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"; }
  function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }
  function storageFileName(filePath) {
    const lastSegment = String(filePath || "").split("/").pop() || "crowmint-download";
    let decoded = lastSegment;
    try { decoded = decodeURIComponent(lastSegment); } catch { /* Keep the Storage object name as-is. */ }
    return decoded.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, "") || "crowmint-download";
  }

  async function downloadPurchase(purchase) {
    const supabase = await getClient();
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id,file_path,status")
      .eq("id", purchase.product_id)
      .maybeSingle();
    if (productError) throw new Error(`Supabase product lookup failed: ${productError.message}`);
    if (!product?.file_path) throw new Error(`Supabase product "${purchase.product_name}" has an empty file_path.`);
    const downloadName = storageFileName(product.file_path);
    const { data, error } = await supabase.storage.from("product-files").createSignedUrl(product.file_path, 3600, { download: downloadName });
    if (error) throw new Error(`Supabase Storage error: ${error.message}`);
    if (!data?.signedUrl) throw new Error("Supabase Storage did not return a signed download URL.");
    const link = document.createElement("a"); link.href = data.signedUrl; link.download = downloadName; link.rel = "noopener";
    document.body.appendChild(link); link.click(); link.remove();
  }

  async function initPurchases() {
    const current = await requireUser(); if (!current) return;
    const supabase = await getClient();
    const { data, error } = await supabase.from("purchases").select("*").order("claimed_at", { ascending: false });
    const list = document.getElementById("purchaseList");
    if (error) { list.innerHTML = `<div class="account-empty">${escapeHtml(error.message)}</div>`; return; }
    if (!data?.length) { list.innerHTML = '<div class="account-empty">No purchases yet.</div>'; return; }
    list.innerHTML = data.map(item => `<article class="purchase-card">
      <img src="${escapeHtml(item.product_image || "../assets/crowmint-icon.png")}" alt="">
      <div>
        <span class="library-label">${escapeHtml(item.purchase_type === "paid" ? "Owned license" : "Free license")}</span>
        <h2>${escapeHtml(item.product_name)}</h2>
        <div class="account-meta"><span>License</span><strong>${escapeHtml(item.purchase_type === "paid" ? "Digital product" : "Free claim")}</strong></div>
        <div class="account-meta"><span>Purchase date</span><strong>${escapeHtml(formatDate(item.claimed_at))}</strong></div>
      </div>
      <button class="primary-button" type="button" data-download-purchase="${escapeHtml(item.id)}">Download</button>
    </article>`).join("");
    list.addEventListener("click", async event => {
      const button = event.target.closest("[data-download-purchase]"); if (!button) return;
      const purchase = data.find(item => String(item.id) === button.dataset.downloadPurchase);
      try { button.disabled = true; await downloadPurchase(purchase); } catch (downloadError) { alert(downloadError.message); } finally { button.disabled = false; }
    });
  }

  async function initOrders() {
    const current = await requireUser(); if (!current) return;
    const supabase = await getClient();
    const { data, error } = await supabase.from("orders").select("id,order_id,product_name,amount_paid,payment_status,purchase_date").order("purchase_date", { ascending: false });
    const list = document.getElementById("orderList");
    if (error) { list.innerHTML = `<div class="account-empty">${escapeHtml(error.message)}</div>`; return; }
    if (!data?.length) { list.innerHTML = '<div class="account-empty">No order history yet.</div>'; return; }
    list.innerHTML = `<div class="orders-table-wrap"><table class="orders-table">
      <thead><tr><th>Order ID</th><th>Product</th><th>Amount</th><th>Status</th><th>Date</th><th></th></tr></thead>
      <tbody>${data.map(item => `<tr>
        <td class="order-id">${escapeHtml(item.order_id || "No payment ID")}</td>
        <td><strong>${escapeHtml(item.product_name)}</strong></td>
        <td><strong>Rs ${Number(item.amount_paid || 0).toLocaleString("en-IN")}</strong></td>
        <td><span class="status-pill ${item.payment_status === "failed" ? "failed" : item.payment_status === "pending" ? "pending" : ""}">${escapeHtml(item.payment_status === "free_claim" ? "Free Claim" : item.payment_status)}</span></td>
        <td>${escapeHtml(formatDate(item.purchase_date))}</td>
        <td>${item.payment_status === "failed" ? '<a class="primary-button" href="/">Try Again</a>' : ''}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  async function initHeader() {
    const toggle = document.getElementById("accountToggle"), menu = document.getElementById("accountMenu");
    if (!toggle || !menu) return;
    const current = configured() ? await user() : null;
    menu.innerHTML = current
      ? '<a href="/profile/">Profile</a><a href="/purchases/">Purchases</a><a href="/orders/">Order History</a><button type="button" data-account-logout>Logout</button>'
      : '<a href="/login/">Login</a><a href="/signup/">Signup</a>';
    toggle.querySelector("span").textContent = current ? (current.user_metadata?.full_name?.split(" ")[0] || "Account") : "Login / Signup";
    toggle.addEventListener("click", () => { menu.hidden = !menu.hidden; });
    menu.querySelector("[data-account-logout]")?.addEventListener("click", logout);
    document.addEventListener("click", event => { if (!event.target.closest(".account-menu-wrap")) menu.hidden = true; });
  }

  async function init() {
    try {
      const page = document.body.dataset.accountPage;
      if (page === "login") await initLogin();
      else if (page === "signup") await initSignup();
      else if (page === "profile") await initProfile();
      else if (page === "purchases") await initPurchases();
      else if (page === "orders") await initOrders();
      else await initHeader();
    } catch (error) { message(error.message, "error"); }
  }

  window.CrowMintAccount = { getClient, user, requireUser, logout, downloadPurchase, initHeader, safeNext };
  document.addEventListener("DOMContentLoaded", init);
})();
