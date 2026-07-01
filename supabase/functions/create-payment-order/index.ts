import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { licenseType, productIds } = await request.json();
    if (!["personal", "commercial"].includes(licenseType)) return json({ error: "Select a valid license" }, 400);
    if (!Array.isArray(productIds) || !productIds.length) return json({ error: "No products selected" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const razorpayKeyId = Deno.env.get("RAZORPAY_KEY_ID")!;
    const razorpaySecret = Deno.env.get("RAZORPAY_KEY_SECRET")!;
    if (!razorpayKeyId || !razorpaySecret) return json({ error: "Payment is not available yet." });
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Payment service is not configured" }, 500);

    const authorization = request.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return json({ error: "Login is required" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const uniqueIds = [...new Set(productIds.map(String))];
    const { data: products, error: productError } = await admin.from("products").select("id,name,personal_price,commercial_price,file_path,status").in("id", uniqueIds);
    if (productError) throw productError;
    if (!products || products.length !== uniqueIds.length || products.some(product => product.status !== "published")) return json({ error: "One or more products are unavailable" }, 409);
    if (products.some(product => !product.file_path)) return json({ error: "Product file is not available. Please contact support." });

    const amount = products.reduce((sum, product) => sum + Math.round(Number(licenseType === "commercial" ? product.commercial_price : product.personal_price) * 100), 0);
    if (amount <= 0) return json({ error: "Payment is not required for this order" }, 400);
    const receipt = `cm_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const razorpayResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${razorpayKeyId}:${razorpaySecret}`)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount, currency: "INR", receipt, notes: { source: "crowmint" } }),
    });
    const order = await razorpayResponse.json();
    if (!razorpayResponse.ok) return json({ error: order.error?.description || "Unable to create payment order" }, 502);
    return json({ keyId: razorpayKeyId, orderId: order.id, amount: order.amount });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to create payment order" }, 500);
  }
});
