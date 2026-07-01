import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await request.json();
    const { payment, licenseType, items } = body || {};
    if (!payment?.orderId || !payment?.paymentId || !payment?.signature) return json({ error: "Missing payment verification details" }, 400);
    if (!['personal', 'commercial'].includes(licenseType)) return json({ error: "Invalid license type" }, 400);
    if (!Array.isArray(items) || !items.length) return json({ error: "Order has no products" }, 400);

    const razorpayKeyId = Deno.env.get("RAZORPAY_KEY_ID")!;
    const razorpaySecret = Deno.env.get("RAZORPAY_KEY_SECRET")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!razorpayKeyId || !razorpaySecret) return json({ error: "Payment is not available yet." });
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Payment service is not configured" }, 500);

    const authorization = request.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Login is required" }, 401);
    const accountUser = userData.user;
    const customerName = accountUser.user_metadata?.full_name || accountUser.user_metadata?.name || accountUser.email || "CrowMint customer";
    const customerEmail = accountUser.email || "";

    const encoder = new TextEncoder();
    const signingKey = await crypto.subtle.importKey("raw", encoder.encode(razorpaySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signatureBytes = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(`${payment.orderId}|${payment.paymentId}`));
    const expectedSignature = [...new Uint8Array(signatureBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (expectedSignature !== payment.signature) return json({ error: "Payment signature verification failed" }, 401);

    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(payment.paymentId)}`, {
      headers: { Authorization: `Basic ${btoa(`${razorpayKeyId}:${razorpaySecret}`)}` },
    });
    const paymentRecord = await paymentResponse.json();
    if (!paymentResponse.ok || paymentRecord.order_id !== payment.orderId || !["authorized", "captured"].includes(paymentRecord.status)) {
      return json({ error: "Payment is not successful" }, 402);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: existing } = await admin.from("orders").select("id,order_id,product_id,license_type").eq("order_id", payment.orderId).eq("user_id", accountUser.id);
    if (existing?.length) {
      const { data: existingProducts } = await admin.from("products").select("id,name,file_name,file_path").in("id", existing.map(order => order.product_id));
      if (!existingProducts?.length || existingProducts.some(product => !product.file_path)) return json({ error: "Product file is not available. Please contact support." });
      const { data: existingSigned, error: existingSignedError } = await admin.storage.from("product-files").createSignedUrls(existingProducts.map(product => product.file_path), 3600);
      if (existingSignedError || !existingSigned?.length || existingSigned.some(file => !file.signedUrl)) return json({ error: "Product file is not available. Please contact support." });
      return json({ orders: existing, duplicate: true, downloads: existingProducts.map((product, index) => ({ url: existingSigned[index].signedUrl, fileName: product.file_name || product.name })) });
    }

    const productIds = [...new Set(items.map((item: { productId: string }) => String(item.productId)))];
    const { data: products, error: productError } = await admin.from("products").select("id,name,image_url,personal_price,commercial_price,file_name,file_path,status").in("id", productIds);
    if (productError) throw productError;
    if (!products || products.length !== productIds.length || products.some(product => product.status !== "published")) return json({ error: "One or more products are unavailable" }, 409);
    if (products.some(product => !product.file_path)) return json({ error: "Product file is not available. Please contact support." });

    const pricedProducts = productIds.map(id => {
      const product = products.find(row => String(row.id) === id)!;
      const price = Number(licenseType === "commercial" ? product.commercial_price : product.personal_price);
      return { product, price };
    });
    const catalogTotal = pricedProducts.reduce((sum, item) => sum + item.price, 0);
    const expectedAmount = Math.round(catalogTotal * 100);
    if (paymentRecord.currency !== "INR" || Number(paymentRecord.amount) !== expectedAmount || expectedAmount <= 0) {
      return json({ error: "Payment amount does not match this order" }, 409);
    }
    const paidTotal = Number(paymentRecord.amount) / 100;
    let allocated = 0;
    const purchaseDate = new Date().toISOString();
    const orderRows = pricedProducts.map((item, index) => {
      const amount = index === pricedProducts.length - 1
        ? Number((paidTotal - allocated).toFixed(2))
        : Number((catalogTotal ? paidTotal * item.price / catalogTotal : 0).toFixed(2));
      allocated += amount;
      return {
        order_id: payment.orderId,
        user_id: accountUser.id,
        payment_id: payment.paymentId,
        customer_name: customerName,
        customer_email: customerEmail.toLowerCase(),
        product_id: String(item.product.id),
        product_name: item.product.name,
        license_type: licenseType,
        amount_paid: amount,
        purchase_date: purchaseDate,
        payment_status: "success",
      };
    });

    const { data: orders, error: orderError } = await admin.from("orders").insert(orderRows).select("id,order_id,product_id,license_type");
    if (orderError) throw orderError;

    const licenseRows = orders.map(order => ({ order_row_id: order.id, order_id: order.order_id, product_id: order.product_id, customer_email: customerEmail.toLowerCase(), license_type: order.license_type, status: "active" }));
    const downloadRows = orders.map(order => ({ order_row_id: order.id, order_id: order.order_id, product_id: order.product_id, download_count: 0, max_downloads: 5 }));
    const { error: licenseError } = await admin.from("licenses").insert(licenseRows);
    const { error: downloadError } = licenseError ? { error: null } : await admin.from("downloads").insert(downloadRows);
    if (licenseError || downloadError) {
      await admin.from("orders").delete().in("id", orders.map(order => order.id));
      throw licenseError || downloadError;
    }

    const purchaseRows = pricedProducts.map(item => ({
      user_id: accountUser.id,
      product_id: String(item.product.id),
      product_name: item.product.name,
      product_image: item.product.image_url,
      file_name: item.product.file_name,
      file_path: item.product.file_path,
      purchase_type: "paid",
      status: "owned",
      license_type: licenseType,
      order_id: payment.orderId,
    }));
    const { error: purchaseError } = await admin.from("purchases").upsert(purchaseRows, { onConflict: "user_id,product_id", ignoreDuplicates: true });
    if (purchaseError) throw purchaseError;

    const { data: signedFiles, error: signedError } = await admin.storage.from("product-files").createSignedUrls(products.map(product => product.file_path), 3600);
    if (signedError || !signedFiles?.length || signedFiles.some(file => !file.signedUrl)) return json({ error: "Product file is not available. Please contact support." });
    const downloads = products.map((product, index) => ({ url: signedFiles[index].signedUrl, fileName: product.file_name || product.name }));
    return json({ orders, downloads });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to complete order" }, 500);
  }
});
